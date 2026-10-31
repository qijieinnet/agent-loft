// 飞书渠道：按配置拉起 / 停掉机器人。Web 上改了机器人配置，这里就地对账，不用重启进程。
import { config, onConfigChange, type FeishuBotConfig } from "../../core/config.js";
import { watchPairing } from "../../core/pairing.js";
import { FeishuBot } from "./bot.js";

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

export function startFeishu(): void {
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
  for (const bot of bots.values()) bot.stop();
  bots.clear();
}

export function feishuBots(): FeishuBot[] {
  return [...bots.values()];
}
