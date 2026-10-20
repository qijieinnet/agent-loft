// Web 登录鉴权。
//
// 这个页面能让 agent 在这台机器上执行命令，等同于一个远程 shell，所以：
//   - 密码用 scrypt 哈希存，不存明文；
//   - 首次没有密码时，必须拿终端 / 日志里打印的一次性设置码才能设密码
//     （否则谁先打开页面谁就成了主人）；
//   - 登录态是随机 token，服务端只存它的哈希，HttpOnly cookie；
//   - 同一 IP 连续输错会被锁一段时间。
import crypto from "node:crypto";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";
import { config, saveConfig } from "../../core/config.js";
import { dataDir, readJson, writeJsonAtomic } from "../../home.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 登录态被撤销（退出、改密码、踢设备）时通知 WebSocket 那边立刻断开对应连接 */
export const authEvents = new EventEmitter<{ revoked: [] }>();
const sessionsPath = path.join(dataDir, "web-sessions.json");
const setupTokenPath = path.join(dataDir, "web-setup-token");

export type WebSession = {
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
  for (const [id, s] of Object.entries(sessions)) if (s.expiresAt < now) delete sessions[id];
  return sessions;
}

function saveSessions(): void {
  writeJsonAtomic(sessionsPath, sessions ?? {});
  loadedMtime = mtimeOf(sessionsPath);
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// ---------- 密码 ----------

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

export function hasPassword(): boolean {
  return !!config().web.passwordHash;
}

export function setPassword(password: string): void {
  if (password.length < 8) throw new Error("密码至少 8 位");
  const cfg = structuredClone(config());
  cfg.web.passwordHash = hashPassword(password);
  saveConfig(cfg);
  // 改密码 = 所有已登录设备下线
  sessions = {};
  saveSessions();
  fs.rmSync(setupTokenPath, { force: true });
  authEvents.emit("revoked");
}

// ---------- 首次设置码 ----------

/** 没有密码时生成（或沿用）一次性设置码，打印到日志里。 */
export function ensureSetupToken(): string | null {
  if (hasPassword()) return null;
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

// ---------- 登录态 ----------

export function createSession(ip: string, userAgent: string): string {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  loadSessions()[sha256(token)] = { createdAt: now, expiresAt: now + SESSION_TTL_MS, lastSeen: now, ip, userAgent };
  saveSessions();
  return token;
}

export function validateSession(token: string | undefined): WebSession | undefined {
  if (!token || !hasPassword()) return undefined;
  const s = loadSessions()[sha256(token)];
  if (!s) return undefined;
  const now = Date.now();
  if (now - s.lastSeen > 60_000) {
    s.lastSeen = now;
    saveSessions();
  }
  return s;
}

export function destroySession(token: string | undefined): void {
  if (!token) return;
  delete loadSessions()[sha256(token)];
  saveSessions();
  authEvents.emit("revoked");
}

export function listSessions(): (WebSession & { id: string })[] {
  return Object.entries(loadSessions()).map(([id, s]) => ({ id: id.slice(0, 12), ...s }));
}

export function revokeSession(idPrefix: string): boolean {
  const all = loadSessions();
  const hit = Object.keys(all).find((id) => id.startsWith(idPrefix));
  if (!hit) return false;
  delete all[hit];
  saveSessions();
  authEvents.emit("revoked");
  return true;
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
