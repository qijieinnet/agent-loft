// 微信 ClawBot 绑定：agent-loft 用户 ↔ 他扫码连上的那个微信。
//
// 和飞书不一样，这里没有「机器人」和「绑定码」：用户登录 Web 后自己扫码，扫码的人就是这个账号的主人，
// 这条微信对话也只认扫码的这个微信号（ClawBot 本身只能由账号所有者私聊使用）。
//
// 重新扫码后 iLink 的 bot id 会变，所以当前会话指向跟着 agent-loft 用户保存，不跟 bot 走。
//
// 这个文件里有 bot token，权限 0600，也不进 config.json（配置接口要给管理员看，token 是个人的）。
import { EventEmitter } from "node:events";
import path from "node:path";
import { dataDir, readJson, writeJsonAtomic } from "../home.js";
import { listConversations } from "./store.js";

export type WeixinAccount = {
  /** agent-loft 用户 */
  userId: string;
  botId: string;
  botToken: string;
  baseUrl: string;
  /** 扫码的微信号。只有它发来的消息才处理 */
  ilinkUserId: string;
  boundAt: number;
  /** 长轮询游标：重启后接着收，不重复也不丢 */
  cursor: string;
  /** 最近一条入站消息带的会话令牌，回复时要原样带回去 */
  contextToken?: string;
  lastInboundAt?: number;
  /** 上一条入站消息之后发出去了多少条（微信限制每条入站之后能发的条数） */
  sentSinceInbound: number;
  /** 当前接收微信消息的对话；旧绑定未设置时沿用 weixin:<用户 id>。 */
  conversationKey?: string;
};

const storePath = path.join(dataDir, "weixin-accounts.json");

let cache: Record<string, WeixinAccount> | undefined;

function load(): Record<string, WeixinAccount> {
  cache ??= readJson<Record<string, WeixinAccount>>(storePath, {});
  return cache;
}

function save(): void {
  writeJsonAtomic(storePath, load());
}

/** changed：绑定多了、少了或者换了凭据。游标、令牌这些运行时字段变化不发 */
export const weixinAccountEvents = new EventEmitter<{ changed: [] }>();

/** 这个用户当前的微信对话。旧对话保留原 key，开新会话只更换这个指向。 */
export function weixinKey(userId: string): string {
  return load()[userId]?.conversationKey
    ?? listConversations().filter((c) => c.channel === "weixin" && c.channelId === userId).sort((a, b) => b.createdAt - a.createdAt)[0]?.key
    ?? `weixin:${userId}`;
}

export function getWeixinAccount(userId: string): WeixinAccount | undefined {
  return load()[userId];
}

export function listWeixinAccounts(): WeixinAccount[] {
  return Object.values(load());
}

/**
 * 记下一次扫码的结果。微信上一个号只连一个 ClawBot（再次绑定会自动解绑前一个），
 * 所以别的 agent-loft 用户手里同一个微信号的旧绑定已经失效，一起清掉。
 */
export function bindWeixinAccount(params: { userId: string; botId: string; botToken: string; baseUrl: string; ilinkUserId: string }): WeixinAccount {
  const all = load();
  for (const [userId, account] of Object.entries(all)) {
    if (userId !== params.userId && account.ilinkUserId === params.ilinkUserId) delete all[userId];
  }
  const conversationKey = all[params.userId]?.conversationKey;
  const account: WeixinAccount = { ...params, boundAt: Date.now(), cursor: "", sentSinceInbound: 0, ...(conversationKey ? { conversationKey } : {}) };
  all[params.userId] = account;
  save();
  weixinAccountEvents.emit("changed");
  return account;
}

export function patchWeixinAccount(userId: string, patch: Partial<Pick<WeixinAccount, "cursor" | "contextToken" | "lastInboundAt" | "sentSinceInbound" | "conversationKey">>): void {
  const account = load()[userId];
  if (!account) return;
  Object.assign(account, patch);
  save();
}

export function removeWeixinAccount(userId: string): boolean {
  const all = load();
  if (!all[userId]) return false;
  delete all[userId];
  save();
  weixinAccountEvents.emit("changed");
  return true;
}
