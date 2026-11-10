// 飞书渠道：按配置拉起 / 停掉机器人。Web 上改了机器人配置，这里就地对账，不用重启进程。
import { config, onConfigChange, type FeishuBotConfig } from "../../core/config.js";
import { listLinks } from "../../core/feishu-links.js";
import { hub, type TaskTurnEnd } from "../../core/hub.js";
import { watchPairing } from "../../core/pairing.js";
import { getConversation } from "../../core/store.js";
import { findTask, taskPush } from "../../core/tasks.js";
import { FeishuBot } from "./bot.js";
import { replyCard } from "./cards.js";

const bots = new Map<string, FeishuBot>();

function fingerprint(cfg: FeishuBotConfig): string {
  // allowFrom / agents 变了不必重连，直接换配置对象即可；凭据变了才要重建连接
  return JSON.stringify([cfg.appId, cfg.appSecret, cfg.domain, cfg.enabled]);
}

function reconcile(list: FeishuBotConfig[]): void {
  const wanted = new Map(list.filter((b) => b.enabled && b.appId && b.appSecret).map((b) => [b.id, b]));
  for (const [id, bot] of bots) {
    const next = wanted.get(id);
    if (!next || fingerprint(next) !== fingerprint(bot.cfg)) {
      bot.stop();
      bots.delete(id);
      console.log(`[飞书] 已停止机器人 ${bot.cfg.name}`);
    }
  }
  for (const [id, cfg] of wanted) {
    const existing = bots.get(id);
    if (existing) {
      delete existing.cfg.experts;
      delete existing.cfg.defaultExpert;
      Object.assign(existing.cfg, cfg);
      continue;
    }
    const bot = new FeishuBot({ ...cfg });
    bots.set(id, bot);
    bot.start();
    console.log(`[飞书] 已启动机器人 ${cfg.name}（agent：${cfg.agents.join("、")}）`);
  }
}

/**
 * 定时任务选了推送到飞书：把结果发到主人绑定的飞书私聊。
 * 任务本来就发在飞书对话里的不用再发（那边已经显示了）。绑了多个机器人的，用任务指定的那个，没指定发第一个在线的。
 */
function onTaskResult(e: TaskTurnEnd): void {
  if (e.status !== "notified") return;
  const task = findTask(e.taskId);
  if (!task || !taskPush(task).includes("feishu")) return;
  if (getConversation(e.key)?.channel === "feishu") return;
  // 指定了机器人就只用它（它不在线就不发，不悄悄换成别的机器人）；没指定用第一个在线的
  const link = listLinks(task.owner).find((l) => bots.has(l.botId) && (!task.feishuBot || l.botId === task.feishuBot));
  if (!link) {
    console.warn(`[飞书] 定时任务「${task.title}」要推送到飞书，但${task.feishuBot ? "指定的机器人不在线或已解绑" : "主人没有绑定在线的飞书机器人"}`);
    return;
  }
  void bots.get(link.botId)!.client.sendCard(link.openId, replyCard(`⏰ **${e.title}**\n\n${e.text}`), "open_id");
}

export function startFeishu(): void {
  hub.off("task", onTaskResult);
  hub.on("task", onTaskResult);
  reconcile(config().feishu.bots);
  onConfigChange((next, prev) => {
    reconcile(next.feishu.bots);
    // 命令顺序 / 隐藏改了，或者机器人能用的 agent 变了：重新同步飞书指令面板
    const commandsChanged = JSON.stringify(next.commands) !== JSON.stringify(prev.commands);
    for (const bot of bots.values()) {
      const before = prev.feishu.bots.find((b) => b.id === bot.id);
      const agentsChanged =
        !before || JSON.stringify([before.agents, before.defaultAgent, before.experts, before.defaultExpert]) !== JSON.stringify([bot.cfg.agents, bot.cfg.defaultAgent, bot.cfg.experts, bot.cfg.defaultExpert]);
      if (commandsChanged || agentsChanged) bot.slash.request();
    }
  });
  // 配对被批准（Web 上点的，或终端里另一个进程批的）：通知等着的人
  watchPairing((channelId, _userId, chatId) => {
    if (chatId) bots.get(channelId)?.notifyApproved(chatId);
  });
}

export function stopFeishu(): void {
  hub.off("task", onTaskResult);
  for (const bot of bots.values()) bot.stop();
  bots.clear();
}

export function feishuBots(): FeishuBot[] {
  return [...bots.values()];
}
