import { sql, transaction } from "../../core/db.js";
import { failedDelegationId } from "../../core/web-bot-delegation.js";
import { fireDueBotReminders, hasBotAccess } from "../../core/web-bot-reminders.js";
import { botPushDevices, sendBotPush } from "./push.js";

type Notice = {
  id: number;
  userId: string;
  threadId: string;
  accessId: string;
  kind: string;
  eventId: string;
  createdAt: number;
  messageId: number | null;
};
type Device = Notice & { endpoint: string; sessionId: string; attempts: number; expiresAt: number };

function prepareDeliveries(now: number): void {
  transaction(() => {
    const events = sql("SELECT * FROM bot_notice_events ORDER BY id LIMIT 64").all() as Notice[];
    for (const event of events) {
      sql("DELETE FROM bot_notice_events WHERE id=?").run(event.id);
      const expiresAt = event.createdAt + 86400_000;
      if (expiresAt <= now || !hasBotAccess(event)) continue;
      for (const device of botPushDevices(event.userId)) {
        sql(
          "INSERT INTO bot_notice_devices(userId,threadId,accessId,eventId,kind,messageId,endpoint,sessionId,nextAt,expiresAt) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ).run(
          event.userId,
          event.threadId,
          event.accessId,
          event.eventId,
          event.kind,
          event.messageId,
          device.endpoint,
          device.sessionId,
          now,
          expiresAt,
        );
      }
    }
  });
}

export async function deliverBotNotices(now = Date.now()): Promise<void> {
  fireDueBotReminders(now);
  prepareDeliveries(now);
  const devices = transaction(() => {
    const rows = sql("SELECT * FROM bot_notice_devices WHERE nextAt<=? ORDER BY nextAt LIMIT 24").all(now) as Device[];
    for (const row of rows) sql("UPDATE bot_notice_devices SET nextAt=? WHERE id=?").run(now + 60000, row.id);
    return rows;
  });
  await Promise.all(
    devices.map(async (row) => {
      const read =
        row.messageId &&
        sql("SELECT 1 FROM bot_device_reads WHERE sessionId=? AND threadId=? AND through>=?").get(
          row.sessionId,
          row.threadId,
          row.messageId,
        );
      const delegationId = failedDelegationId(row);
      const alreadyOpened = delegationId && sql("SELECT seen FROM bot_inbox WHERE userId=? AND threadId=? AND accessId=? AND eventId=? AND kind=?")
        .get(row.userId, row.threadId, row.accessId, row.eventId, row.kind)?.seen;
      let done = row.expiresAt <= now || !!read || !!alreadyOpened || !hasBotAccess(row);
      if (!done) {
        done = await sendBotPush(row.userId, row.endpoint, row.sessionId, {
          title: "我的 Bot",
          body:
            delegationId ? "有一项协作未完成，点此查看。" : row.kind === "test" ? "本机通知测试成功，点此返回对话。" : row.kind === "reminder" ? "你有一条到时提醒" : row.kind === "followup" ? "你跟进的事情有了更新" : "你有一条新回复",
          tag: "bot:" + row.kind + ":" + row.threadId + ":" + row.eventId,
          url: "/bot/?thread=" + encodeURIComponent(row.threadId) + (delegationId ? "&delegation=" + delegationId : row.messageId ? "&message=" + row.messageId : ""),
        }).catch(() => false);
      }
      if (done || row.attempts >= 7) sql("DELETE FROM bot_notice_devices WHERE id=?").run(row.id);
      else
        sql("UPDATE bot_notice_devices SET attempts=attempts+1,nextAt=? WHERE id=?").run(now + 15000 * 2 ** row.attempts, row.id);
    }),
  );
}

let timer: ReturnType<typeof setInterval> | undefined;
let running: Promise<void> | undefined;

export function startBotDelivery(): void {
  if (timer) return;
  sql("DELETE FROM bot_device_reads WHERE updatedAt<?").run(Date.now() - 30 * 86400_000);
  const tick = () => {
    running ??= deliverBotNotices()
      .catch((error) => console.error("[Bot] 提醒投递失败", error))
      .finally(() => {
        running = undefined;
      });
  };
  timer = setInterval(tick, 5000);
  timer.unref();
  tick();
}

export async function stopBotDelivery(): Promise<void> {
  clearInterval(timer);
  timer = undefined;
  await running;
}
