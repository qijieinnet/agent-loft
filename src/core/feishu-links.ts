// 飞书账号 ↔ agent-loft 用户的绑定。
//
// 绑定之后，这个飞书账号和机器人的私聊就是这个用户的个人会话：归他所有（Web 上别人看不到），
// 用他的记忆，/sessions 只列他的会话，/web 只能接上他自己的 Web 会话。
// 群聊不受影响：群里不止一个人，照旧是管理员的地盘，也不用记忆。
//
// 绑定必须由用户本人完成：在 Web 上（已登录）生成绑定码，再用飞书在私聊里发 /bind 绑定码。
// 两边都证明了身份，才算数。不提供「管理员直接指定」—— 那样管理员把自己的飞书绑到成员名下，
// 就能在飞书里读到成员的记忆。管理员只能解除绑定（只会让人失去访问，不会多出访问）。
//
// open_id 是按飞书应用分的：同一个人在不同机器人上 open_id 不同，所以按 (机器人, open_id) 记。
import crypto from "node:crypto";
import path from "node:path";
import { dataDir, readJson, writeJsonAtomic } from "../home.js";
import { getUser, type User } from "./users.js";

export type FeishuLink = { botId: string; openId: string; userId: string; boundAt: number };

type Store = Record<string, Record<string, { userId: string; boundAt: number }>>;

const storePath = path.join(dataDir, "feishu-links.json");

function read(): Store {
  return readJson<Store>(storePath, {});
}

const norm = (openId: string) => openId.trim().toLowerCase();

/** 这个飞书账号绑定的用户（还在、没被停用的）。没绑定返回 undefined */
export function linkedUser(botId: string, openId: string | undefined): User | undefined {
  if (!openId) return undefined;
  const userId = read()[botId]?.[norm(openId)]?.userId;
  const user = getUser(userId);
  return user && !user.disabled ? user : undefined;
}

export function listLinks(userId?: string): FeishuLink[] {
  return Object.entries(read()).flatMap(([botId, links]) =>
    Object.entries(links)
      .filter(([, l]) => !userId || l.userId === userId)
      .map(([openId, l]) => ({ botId, openId, userId: l.userId, boundAt: l.boundAt })),
  );
}

/** 解除一个绑定。onlyUser 给了的话，只能解除属于他的 */
export function unlink(botId: string, openId: string, onlyUser?: string): boolean {
  const store = read();
  const id = norm(openId);
  const link = store[botId]?.[id];
  if (!link || (onlyUser && link.userId !== onlyUser)) return false;
  delete store[botId]![id];
  if (Object.keys(store[botId]!).length === 0) delete store[botId];
  writeJsonAtomic(storePath, store);
  return true;
}

/** 解除这个用户的所有绑定（删用户、管理员解除时） */
export function unlinkUser(userId: string): number {
  const store = read();
  let n = 0;
  for (const [botId, links] of Object.entries(store)) {
    for (const [openId, l] of Object.entries(links)) {
      if (l.userId !== userId) continue;
      delete links[openId];
      n++;
    }
    if (Object.keys(links).length === 0) delete store[botId];
  }
  if (n > 0) writeJsonAtomic(storePath, store);
  return n;
}

// ---------- 绑定码 ----------
//
// 只在内存里：十分钟有效，服务重启就作废（重新生成一个就行）。

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS = 10 * 60 * 1000;
const codes = new Map<string, { userId: string; expiresAt: number }>();

function sweep(now = Date.now()): void {
  for (const [code, c] of codes) if (c.expiresAt <= now) codes.delete(code);
}

/** 给这个用户生成一个绑定码。之前没用掉的作废，同一时间每人只有一个 */
export function createLinkCode(userId: string): { code: string; expiresAt: number } {
  sweep();
  for (const [code, c] of codes) if (c.userId === userId) codes.delete(code);
  const code = Array.from(crypto.randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  const expiresAt = Date.now() + CODE_TTL_MS;
  codes.set(code, { userId, expiresAt });
  return { code, expiresAt };
}

/**
 * 飞书里发了 /bind 绑定码：认领它，把 (机器人, open_id) 绑到生成这个码的用户上。
 * 一个飞书账号只能绑一个用户，再绑就是换人（码证明了新主人的身份）。
 */
export function redeemLinkCode(code: string, botId: string, openId: string): User {
  sweep();
  const key = code.trim().toUpperCase();
  const entry = codes.get(key);
  if (!entry) throw new Error("绑定码不对或已过期。请在 Web 上（设置 → 我的账号）重新生成一个。");
  const user = getUser(entry.userId);
  if (!user || user.disabled) {
    codes.delete(key);
    throw new Error("生成这个绑定码的用户已经不存在或被停用了。");
  }
  codes.delete(key);
  const store = read();
  (store[botId] ??= {})[norm(openId)] = { userId: user.id, boundAt: Date.now() };
  writeJsonAtomic(storePath, store);
  return user;
}

/** 测试用 */
export function resetLinkCodesForTest(): void {
  codes.clear();
}
