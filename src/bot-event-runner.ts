// 外部投递在事件落盘后执行。网络重试不重新分析，进程重启也不重放已发起的模型轮次。
import { randomUUID } from "node:crypto";
import { backupEvents } from "./core/backup.js";
import { acceptResult, botEvents, getWatch, reasons, type Incident, type Watch } from "./core/bot-events.js";
import { sql, transaction } from "./core/db.js";
import { listLinks } from "./core/feishu-links.js";
import { hub } from "./core/hub.js";
import { flushStore, getConversation, updateConversation } from "./core/store.js";
import { getUser } from "./core/users.js";
import { feishuBots } from "./channels/feishu/index.js";
import { pushToAll } from "./channels/web/push.js";

export function watchAvailable(w: Watch): boolean {
  const user = getUser(w.owner);
  const c = getConversation(w.conv);
  return !!user && !user.disabled && (w.source !== "backup" || user.role === "admin")
    && !!c && c.owner === user.id && c.assistant === "active" && !c.hidden && !hub.assistantUnavailable(c);
}

function onBackup(runId: string, ok: boolean, error = ""): void {
  const reason = /ENOSPC/i.test(error) ? "disk_full" : /EACCES|EPERM/i.test(error) ? "permission" : /EIO/i.test(error) ? "io" : "unknown";
  try {
    const ids = sql("SELECT id FROM bot_watches WHERE source='backup'").all() as { id: string }[];
    for (const { id } of ids) {
      const w = getWatch(id);
      if (w && watchAvailable(w)) {
        try { acceptResult(w, { runId, status: ok ? "ok" : "failed", reason }); }
        catch (err) { console.error("[bot] 记录本机备份事件失败", err); }
      }
    }
  } catch (err) { console.error("[bot] 读取备份监听失败", err); }
}

async function notify(w: Watch, e: Incident): Promise<void> {
  const title = w.name + " · 备份失败";
  const body = reasons[e.reason] + "（" + e.run + "）";
  if (w.destination === "web") {
    const sent = await pushToAll({ title, body, tag: "bot-event-" + e.id, url: "/#bot-events/" + w.id }, (owner) => owner === w.owner);
    if (!sent) throw new Error("没有设备接受 Web 推送");
    return;
  }
  const link = listLinks(w.owner).find((l) => "feishu:" + l.botId === w.destination);
  const bot = link && feishuBots().find((b) => b.id === link.botId);
  if (!bot || !link) throw new Error("飞书绑定或机器人不可用");
  if (!await bot.client.sendText(link.openId, title + "\n" + body, "open_id", w.id + "-" + e.id)) throw new Error("飞书未确认接收");
}

function analyze(w: Watch, e: Incident): void {
  const parent = getConversation(w.conv)!;
  const key = "web:" + randomUUID();
  // 先保存独立对话与派发记录。外部上报的自由文本和运行编号均不进入模型指令。
  const claimed = transaction(() => {
    const claim = sql("UPDATE bot_incidents SET analysis='submitted',analysis_key=? WHERE id=? AND analysis='pending'").run(key, e.id);
    if (!claim.changes) return false;
    hub.ensure({ key, channel: "web", channelId: "web", defaultAgent: parent.agent, expert: parent.expert,
      owner: w.owner, assistant: "related", cwd: parent.cwd, title: w.name + " · 故障分析" });
    updateConversation(key, { permission: "ask", titleAuto: false });
    flushStore();
    return true;
  });
  if (!claimed) return;
  hub.send(key, { text: "备份失败。监听名称：" + w.name + "。已知原因：" + reasons[e.reason] +
    "。根据这些已知信息说明可能原因和排查步骤，区分推测和事实。这次只给分析建议，不修改系统。", attachments: [] },
    { channel: "bot-event", channelId: w.id, name: "bot 事件" });
}

let timer: NodeJS.Timeout | undefined;
let draining = false;
let again = false;
let generation = 0;
export async function drainBotEvents(): Promise<void> {
  if (draining) { again = true; return; }
  draining = true;
  const started = generation;
  try {
    const now = Date.now();
    const events = sql("SELECT * FROM bot_incidents WHERE (delivery='pending' AND next_try<=?) OR analysis='pending' ORDER BY id LIMIT 32").all(now) as Incident[];
    for (const event of events) {
      if (started !== generation) break;
      const w = getWatch(event.watch);
      if (!w) continue;
      if (!watchAvailable(w)) {
        sql("UPDATE bot_incidents SET delivery=CASE WHEN delivery='pending' THEN 'cancelled' ELSE delivery END, analysis=CASE WHEN analysis='pending' THEN 'cancelled' ELSE analysis END WHERE id=?").run(event.id);
        botEvents.emit("changed", w.owner);
        continue;
      }
      if (event.analysis === "pending") {
        try { analyze(w, event); }
        catch { sql("UPDATE bot_incidents SET analysis='error' WHERE id=?").run(event.id); }
      }
      if (event.delivery === "pending" && event.next_try <= now) {
        // 先认领再交给渠道。进程在发送途中退出时，租约到期即可继续投递。
        const lease = Date.now() + 120_000;
        const claimed = sql("UPDATE bot_incidents SET attempts=attempts+1,next_try=? WHERE id=? AND delivery='pending' AND attempts=? AND next_try<=?")
          .run(lease, event.id, event.attempts, now);
        if (!claimed.changes) continue;
        try {
          await notify(w, event);
          sql("UPDATE bot_incidents SET delivery='sent',error=NULL WHERE id=? AND next_try=?").run(event.id, lease);
        } catch (err) {
          const attempts = event.attempts + 1;
          sql("UPDATE bot_incidents SET delivery=?,error=?,next_try=? WHERE id=? AND next_try=?")
            .run(attempts >= 4 ? "failed" : "pending", err instanceof Error ? err.message : "投递失败", Date.now() + 30_000 * 2 ** (attempts - 1), event.id, lease);
        }
      }
      botEvents.emit("changed", w.owner);
    }
  } finally {
    draining = false;
    if (again && timer) { again = false; wake(); }
  }
}
function wake(): void {
  void drainBotEvents().catch((err) => console.error("[bot] 处理事件失败", err));
}
export function startBotEvents(): void {
  if (timer) return;
  timer = setInterval(wake, 15_000);
  timer.unref();
  botEvents.on("ready", wake);
  backupEvents.on("finished", onBackup);
  wake();
}
export function stopBotEvents(): void {
  generation++;
  again = false;
  clearInterval(timer);
  timer = undefined;
  botEvents.off("ready", wake);
  backupEvents.off("finished", onBackup);
}
