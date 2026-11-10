// 微信渠道：按绑定拉起 / 停掉长轮询。扫码、解绑、停用用户后就地对账，不用重启进程。
import { hub, type TaskTurnEnd } from "../../core/hub.js";
import { findTask, taskPush } from "../../core/tasks.js";
import { getUser, userEvents } from "../../core/users.js";
import { listWeixinAccounts, weixinAccountEvents, type WeixinAccount } from "../../core/weixin-accounts.js";
import { WeixinBot, type WeixinStatus } from "./bot.js";
import { stopWeixinLogins } from "./login.js";

const bots = new Map<string, WeixinBot>();
let started = false;

function reconcile(): void {
  const wanted = new Map<string, WeixinAccount>();
  for (const account of listWeixinAccounts()) {
    const user = getUser(account.userId);
    if (user && !user.disabled) wanted.set(account.userId, account);
  }
  for (const [userId, bot] of bots) {
    const next = wanted.get(userId);
    if (next?.botToken === bot.account.botToken) continue;
    // 绑定没了或者重新扫码：旧 token 已经作废，不用再通知微信
    bot.stop({ silent: true });
    bots.delete(userId);
    console.log(`[微信] 已停止 ${userId} 的连接`);
  }
  for (const [userId, account] of wanted) {
    if (bots.has(userId)) continue;
    const bot = new WeixinBot(account);
    bots.set(userId, bot);
    bot.start();
    console.log(`[微信] 已启动 ${userId} 的连接`);
  }
}

/** 定时任务选了推送到微信：发到主人绑定的微信 */
function onTaskResult(e: TaskTurnEnd): void {
  if (e.status !== "notified") return;
  const task = findTask(e.taskId);
  if (!task || !taskPush(task).includes("weixin")) return;
  const bot = bots.get(task.owner);
  if (!bot) {
    console.warn(`[微信] 定时任务「${task.title}」要推送到微信，但主人没有绑定微信`);
    return;
  }
  // 发在微信正接着的那条对话里：结果已经发过去了
  if (e.key === bot.key) return;
  bot.pushTaskResult(e.title, e.text);
}

export function startWeixin(): void {
  if (started) return;
  started = true;
  hub.on("task", onTaskResult);
  reconcile();
  weixinAccountEvents.on("changed", reconcile);
  userEvents.on("changed", reconcile);
}

export function stopWeixin(): void {
  started = false;
  hub.off("task", onTaskResult);
  weixinAccountEvents.off("changed", reconcile);
  userEvents.off("changed", reconcile);
  stopWeixinLogins();
  for (const bot of bots.values()) bot.stop();
  bots.clear();
}

export function weixinStatus(userId: string): WeixinStatus | undefined {
  return bots.get(userId)?.status;
}
