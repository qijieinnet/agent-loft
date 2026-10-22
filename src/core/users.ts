// 用户：Web 登录的账号。
//
// 这是「信任型」多用户：账号分开的是会话列表、授权、通知和设置权限，不是安全边界 ——
// 所有 agent 都以同一个系统用户运行，谁都能让 agent 去读这台机器上的任何东西。
// 只把账号给你信任的人（README「多用户」）。
//
// 归属规则（ownedBy）：
//   - 有主的东西（Web 会话、agent 会话、推送订阅）只属于主人；
//   - 主人已经被删掉了，归管理员；
//   - 没有主的（飞书会话、终端里开的 agent 会话、升级前就有的 Web 会话）归管理员。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { dataDir, readJson, writeJsonAtomic } from "../home.js";
import { config } from "./config.js";

export type Role = "admin" | "member";

export type User = {
  id: string;
  /** 登录名，不区分大小写，唯一 */
  name: string;
  role: Role;
  passwordHash: string;
  createdAt: number;
  disabled?: boolean;
};

export type PublicUser = Omit<User, "passwordHash">;

type StoreShape = { users: User[] };

const usersPath = path.join(dataDir, "users.json");
/** 用户增删改、停用、改密码：登录态要重新校验 */
export const userEvents = new EventEmitter<{ changed: [] }>();

let cache: User[] | null = null;
let loadedMtime = 0;

function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** 上次看文件有没有变的时间：广播事件时每个连接都要查归属，别每次都 stat 一下 */
let checkedAt = 0;
const RECHECK_MS = 1000;

function load(): User[] {
  // 终端里 agent-loft user … 会改这个文件：变了就重新读（最多晚 1 秒发现）
  const now = Date.now();
  if (cache && cache.length > 0 && now - checkedAt < RECHECK_MS) return cache;
  checkedAt = now;
  const mtime = mtimeOf(usersPath);
  if (!cache || mtime !== loadedMtime) {
    const raw = readJson<StoreShape>(usersPath, { users: [] });
    cache = Array.isArray(raw.users) ? raw.users.filter((u) => u && typeof u.id === "string" && typeof u.name === "string") : [];
    loadedMtime = mtime;
  }
  migrateLegacy(cache);
  return cache;
}

function save(list: User[]): void {
  cache = list;
  writeJsonAtomic(usersPath, { users: list });
  loadedMtime = mtimeOf(usersPath);
  userEvents.emit("changed");
}

/**
 * 升级前只有一个登录密码（config.web.passwordHash）：变成一个叫 admin 的管理员，密码不变。
 * 不改动旧字段 —— 万一回退到老版本还能照常登录；之后改密码时再把它清掉（见 setUserPassword）。
 */
function migrateLegacy(list: User[]): void {
  if (list.length > 0) return;
  let legacy = "";
  try {
    legacy = config().web.passwordHash;
  } catch {
    return;
  }
  if (!legacy) return;
  list.push({ id: newId(), name: "admin", role: "admin", passwordHash: legacy, createdAt: Date.now() });
  writeJsonAtomic(usersPath, { users: list });
  loadedMtime = mtimeOf(usersPath);
  console.log("[用户] 已把原来的登录密码迁移为管理员账号 admin");
}

function newId(): string {
  return `u_${crypto.randomBytes(5).toString("hex")}`;
}

function publicUser(u: User): PublicUser {
  const { passwordHash: _hidden, ...rest } = u;
  return { ...rest };
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

/** 用户名不存在时也算一遍 scrypt，响应时间上看不出用户名对不对 */
let dummyHash: string | null = null;
const dummy = () => (dummyHash ??= hashPassword(crypto.randomBytes(12).toString("hex")));

function checkPassword(password: string): void {
  if (password.length < 8) throw new Error("密码至少 8 位");
  if (password.length > 256) throw new Error("密码太长了");
}

function checkName(name: string): string {
  const n = name.trim();
  if (!/^[\p{L}\p{N}_.@-]{1,32}$/u.test(n)) throw new Error("用户名 1～32 个字符，只能用文字、数字和 _ . @ -");
  return n;
}

// ---------- 查询 ----------

export function hasUsers(): boolean {
  return load().length > 0;
}

export function listUsers(): PublicUser[] {
  return load().map(publicUser);
}

export function getUser(id: string | undefined): User | undefined {
  if (!id) return undefined;
  return load().find((u) => u.id === id);
}

export function findUserByName(name: string): User | undefined {
  const n = name.trim().toLowerCase();
  return load().find((u) => u.name.toLowerCase() === n);
}

/** 可以登录的用户（没被停用） */
export function activeUsers(): User[] {
  return load().filter((u) => !u.disabled);
}

/** 有没有普通成员（没有的话，飞书那边什么都不用滤） */
export function hasMembers(): boolean {
  return load().some((u) => u.role !== "admin");
}

export function isAdmin(user: Pick<User, "role"> | undefined): boolean {
  return user?.role === "admin";
}

/**
 * 升级前的登录态、推送订阅没有记是谁的：都算最早的那个管理员的（就是迁移出来的 admin）。
 */
export function legacyOwnerId(): string | undefined {
  return load()
    .filter((u) => u.role === "admin" && !u.disabled)
    .sort((a, b) => a.createdAt - b.createdAt)[0]?.id;
}

/** 归属规则，见文件开头 */
export function ownedBy(user: Pick<User, "id" | "role">, owner: string | undefined): boolean {
  if (owner) return owner === user.id || (user.role === "admin" && !getUser(owner));
  return user.role === "admin";
}

/** 管理员能看到的（飞书那边是管理员的地盘：/web 只列这些，也只能接上这些） */
export function adminVisible(owner: string | undefined): boolean {
  if (!owner) return true;
  const u = getUser(owner);
  return !u || u.role === "admin";
}

/**
 * 校验登录。name 没给、并且只有一个能登录的用户时就是他 —— 单用户时登录页和以前一样只要密码。
 */
export function verifyLogin(name: string | undefined, password: string): User | undefined {
  const active = activeUsers();
  const user = name?.trim() ? active.find((u) => u.name.toLowerCase() === name.trim().toLowerCase()) : active.length === 1 ? active[0] : undefined;
  const ok = verifyPassword(password, user?.passwordHash ?? dummy());
  return ok ? user : undefined;
}

// ---------- 修改 ----------

/** 改完之后至少还要有一个能登录的管理员 */
function assertAdminLeft(list: User[]): void {
  if (!list.some((u) => u.role === "admin" && !u.disabled)) throw new Error("至少要保留一个能登录的管理员");
}

export function createUser(params: { name: string; password: string; role?: Role }): PublicUser {
  const list = load();
  const name = checkName(params.name);
  if (list.some((u) => u.name.toLowerCase() === name.toLowerCase())) throw new Error(`用户名「${name}」已经有人用了`);
  checkPassword(params.password);
  const user: User = {
    id: newId(),
    name,
    role: params.role === "admin" ? "admin" : "member",
    passwordHash: hashPassword(params.password),
    createdAt: Date.now(),
  };
  save([...list, user]);
  return publicUser(user);
}

export function updateUser(id: string, patch: { name?: string; role?: Role; disabled?: boolean; password?: string }): PublicUser {
  const list = load().map((u) => ({ ...u }));
  const user = list.find((u) => u.id === id);
  if (!user) throw new Error("用户不存在");
  if (patch.name !== undefined) {
    const name = checkName(patch.name);
    if (list.some((u) => u.id !== id && u.name.toLowerCase() === name.toLowerCase())) throw new Error(`用户名「${name}」已经有人用了`);
    user.name = name;
  }
  if (patch.role !== undefined) user.role = patch.role === "admin" ? "admin" : "member";
  if (patch.disabled !== undefined) {
    if (patch.disabled) user.disabled = true;
    else delete user.disabled;
  }
  if (patch.password !== undefined) {
    checkPassword(patch.password);
    user.passwordHash = hashPassword(patch.password);
  }
  assertAdminLeft(list);
  save(list);
  return publicUser(user);
}

export function removeUser(id: string): PublicUser {
  const list = load();
  const user = list.find((u) => u.id === id);
  if (!user) throw new Error("用户不存在");
  const rest = list.filter((u) => u.id !== id);
  assertAdminLeft(rest);
  save(rest);
  return publicUser(user);
}

/** 测试用：换了 AGENT_LOFT_HOME 之后重新读 */
export function resetUsersForTest(): void {
  cache = null;
  loadedMtime = 0;
  checkedAt = 0;
}
