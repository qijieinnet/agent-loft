// Web 登录鉴权。
//
// 这个页面能让 agent 在这台机器上执行命令，等同于一个远程 shell，所以：
//   - 密码用 scrypt 哈希存，不存明文（账号见 core/users.ts）；
//   - 一个用户都没有时，必须拿终端 / 日志里打印的一次性设置码才能建第一个管理员
//     （否则谁先打开页面谁就成了主人）；
//   - 登录态是随机 token，服务端只存它的哈希，HttpOnly cookie；
//   - 同一 IP 连续输错会被锁一段时间。
import crypto from "node:crypto";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";
import { config, saveConfig } from "../../core/config.js";
import { createUser, getUser, hasUsers, legacyOwnerId, updateUser, userEvents, type PublicUser, type User } from "../../core/users.js";
import { dataDir, readJson, writeJsonAtomic } from "../../home.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 登录态被撤销（退出、改密码、踢设备、用户被停用 / 删除）时通知 WebSocket 那边立刻断开对应连接 */
export const authEvents = new EventEmitter<{ revoked: [] }>();
userEvents.on("changed", () => authEvents.emit("revoked"));
const sessionsPath = path.join(dataDir, "web-sessions.json");
const setupTokenPath = path.join(dataDir, "web-setup-token");

export type WebSession = {
  /** 升级前的登录态没有这个字段：读的时候认给迁移出来的那个管理员（legacyOwnerId） */
  userId?: string;
  createdAt: number;
  expiresAt: number;
  lastSeen: number;
  ip: string;
  userAgent: string;
};

let sessions: Record<string, WebSession> | null = null;
let loadedMtime = 0;

function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function loadSessions(): Record<string, WebSession> {
  // 终端里 agent-loft passwd 会清空登录态：文件变了就重新读，让被踢的设备立刻失效
  const mtime = mtimeOf(sessionsPath);
  if (!sessions || mtime !== loadedMtime) {
    sessions = readJson<Record<string, WebSession>>(sessionsPath, {});
    loadedMtime = mtime;
  }
  const now = Date.now();
  let stamped = false;
  for (const [id, s] of Object.entries(sessions)) {
    if (s.expiresAt < now) delete sessions[id];
    else if (!s.userId) {
      // 升级前的登录态：认给迁移出来的管理员，并且记下来，之后那个管理员被删了也不会换人
      const owner = legacyOwnerId();
      if (owner) {
        s.userId = owner;
        stamped = true;
      }
    }
  }
  if (stamped) saveSessions();
  return sessions;
}

function saveSessions(): void {
  writeJsonAtomic(sessionsPath, sessions ?? {});
  loadedMtime = mtimeOf(sessionsPath);
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function ownerOf(s: WebSession): string | undefined {
  return s.userId;
}

// ---------- 首次设置 ----------

/** 还一个用户都没有：页面上要先建管理员 */
export function needsSetup(): boolean {
  return !hasUsers();
}

/**
 * 建第一个管理员（页面上用设置码，或终端里 agent-loft passwd）。
 * 之前残留的登录态全部作废：否则它们没记用户，会被当成升级前的登录态认给这个新管理员。
 */
export function setupFirstAdmin(name: string, password: string): PublicUser {
  if (hasUsers()) throw new Error("已经设置过了");
  const user = createUser({ name: name.trim() || "admin", password, role: "admin" });
  sessions = {};
  saveSessions();
  fs.rmSync(setupTokenPath, { force: true });
  authEvents.emit("revoked");
  return user;
}

/** 一个用户都没有时生成（或沿用）一次性设置码，打印到日志里。 */
export function ensureSetupToken(): string | null {
  if (hasUsers()) return null;
  try {
    const existing = fs.readFileSync(setupTokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // 没有就新建
  }
  const token = crypto.randomBytes(6).toString("hex").toUpperCase();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(setupTokenPath, token, { mode: 0o600 });
  return token;
}

export function checkSetupToken(token: string): boolean {
  const expected = ensureSetupToken();
  if (!expected) return false;
  const a = Buffer.from(token.trim().toUpperCase());
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- 密码 ----------

/**
 * 改某个用户的密码：他所有已登录的设备下线。
 * 升级前那个全局密码（config.web.passwordHash）也一并清掉，旧密码从此不再有效。
 */
export function setUserPassword(userId: string, password: string): void {
  patchUser(userId, { password });
}

/**
 * 改用户（一次写盘，要么全改要么全不改），再处理副作用：
 * 改了密码或者停用了，他所有设备下线；改了密码，升级前的全局密码也作废。
 */
export function patchUser(userId: string, patch: Parameters<typeof updateUser>[1]): PublicUser {
  const updated = updateUser(userId, patch);
  if (patch.password !== undefined || patch.disabled === true) revokeUserSessions(userId);
  if (patch.password !== undefined && config().web.passwordHash) {
    const cfg = structuredClone(config());
    cfg.web.passwordHash = "";
    saveConfig(cfg);
  }
  return updated;
}

// ---------- 登录态 ----------

export function createSession(userId: string, ip: string, userAgent: string): string {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  loadSessions()[sha256(token)] = { userId, createdAt: now, expiresAt: now + SESSION_TTL_MS, lastSeen: now, ip, userAgent };
  saveSessions();
  return token;
}

/** 登录态对应的用户。用户被停用、删掉了也算无效 */
export function sessionUser(token: string | undefined): User | undefined {
  if (!token || !hasUsers()) return undefined;
  const s = loadSessions()[sha256(token)];
  if (!s) return undefined;
  const user = getUser(ownerOf(s));
  if (!user || user.disabled) return undefined;
  const now = Date.now();
  if (now - s.lastSeen > 60_000) {
    s.lastSeen = now;
    saveSessions();
  }
  return user;
}

export function destroySession(token: string | undefined): void {
  if (!token) return;
  delete loadSessions()[sha256(token)];
  saveSessions();
  authEvents.emit("revoked");
}

export type SessionView = WebSession & { id: string; userId?: string; userName?: string };

/** 已登录的设备。给了 userId 就只列这个用户的 */
export function listSessions(userId?: string): SessionView[] {
  return Object.entries(loadSessions())
    .filter(([, s]) => !userId || ownerOf(s) === userId)
    .map(([id, s]) => {
      const owner = ownerOf(s);
      const name = getUser(owner)?.name;
      return { ...s, id: id.slice(0, 12), ...(owner ? { userId: owner } : {}), ...(name ? { userName: name } : {}) };
    });
}

/** 踢掉一个设备。给了 userId 就只能踢这个用户自己的 */
export function revokeSession(idPrefix: string, userId?: string): boolean {
  if (!idPrefix) return false;
  const all = loadSessions();
  const hit = Object.keys(all).find((id) => id.startsWith(idPrefix) && (!userId || ownerOf(all[id]!) === userId));
  if (!hit) return false;
  delete all[hit];
  saveSessions();
  authEvents.emit("revoked");
  return true;
}

/** 某个用户的所有设备下线 */
export function revokeUserSessions(userId: string): void {
  const all = loadSessions();
  for (const [id, s] of Object.entries(all)) if (ownerOf(s) === userId) delete all[id];
  saveSessions();
  authEvents.emit("revoked");
}

// ---------- 防爆破 ----------
//
// 额度在「真要验密码的那一刻」同步扣掉，而不是先查后记：后者中间隔着读请求体的
// await，攻击者攒一大批请求同时提交，每个都能通过检查。

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
/** 全局：就算对方能换 IP，一分钟内总共也只能试这么多次 */
const GLOBAL_MAX_PER_MIN = 30;

const attempts = new Map<string, { count: number; first: number; until: number }>();
let globalWindow = { start: 0, count: 0 };

/**
 * 占用一次尝试额度。返回 0 表示可以验证；否则返回还要等多少毫秒。
 * 同步执行，并发请求之间不会穿插。
 */
export function takeAttempt(ip: string): number {
  const now = Date.now();
  if (now - globalWindow.start >= 60_000) globalWindow = { start: now, count: 0 };
  if (globalWindow.count >= GLOBAL_MAX_PER_MIN) return globalWindow.start + 60_000 - now;

  let a = attempts.get(ip);
  if (a && a.until > now) return a.until - now;
  if (!a || now - a.first > WINDOW_MS) {
    if (attempts.size > 10_000) attempts.clear();
    a = { count: 0, first: now, until: 0 };
    attempts.set(ip, a);
  }
  if (a.count >= MAX_ATTEMPTS) {
    a.until = now + WINDOW_MS;
    return WINDOW_MS;
  }
  a.count += 1;
  globalWindow.count += 1;
  return 0;
}

/** 验证成功：这个 IP 的计数清零（全局窗口不退，防止拿一个正确密码洗额度） */
export function clearAttempts(ip: string): void {
  attempts.delete(ip);
}
