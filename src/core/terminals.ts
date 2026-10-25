// 网页终端：服务端起 shell（node-pty），页面用 WebSocket 连上来收发。
//
// shell 属于人，不属于页面：关掉页面、手机切到后台、断线都不结束它，重连后按 since 补上错过的输出；
// 没有页面连着超过 terminal.keepAliveMin 分钟才结束。同一个终端可以同时开在几个页面上。
//
// 谁能用：管理员；成员要管理员在 设置 → 用户 里单独开「远程控制」（users.json 的 remote）。
// 和 agent 不同，这里没有授权卡 —— 拿到终端就是拿到这台机器上 agent-loft 这个系统用户的 shell。
// 权限收回、用户被停用或删除、设置里关掉终端时，他开着的 shell 立刻结束。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import type { IPty } from "node-pty";
import { agentEnvironment } from "./agent-env.js";
import { config, onConfigChange } from "./config.js";
import { canUseRemote, getUser, userEvents, type User } from "./users.js";

// ---------- node-pty ----------

type PtyModule = typeof import("node-pty");

/** node-pty 是原生模块、可选依赖：装不上（没有编译工具）时终端整个不可用，其他功能照常 */
let ptyModule: PtyModule | null | undefined;
let ptyError = "";

function loadPty(): PtyModule | null {
  if (ptyModule !== undefined) return ptyModule;
  try {
    ptyModule = createRequire(import.meta.url)("node-pty") as PtyModule;
  } catch (err) {
    ptyModule = null;
    ptyError = err instanceof Error ? err.message.split("\n")[0]! : String(err);
  }
  return ptyModule;
}

/** 终端能不能用；不能用时 reason 写给管理员看 */
export function terminalAvailability(): { available: boolean; reason?: string } {
  if (loadPty()) return { available: true };
  return { available: false, reason: `没装好 node-pty（${ptyError}）。在 agent-loft 的安装目录里运行 npm install node-pty 后重启` };
}

/** 这个人现在能不能用终端 */
export function canUseTerminal(user: Pick<User, "role" | "disabled" | "remote"> | undefined): boolean {
  return config().remote.terminal && canUseRemote(user);
}

// ---------- 输出记录 ----------

/** 每个终端留多少输出（字符），断线重连、换个页面打开时补发 */
const LOG_LIMIT = 512 * 1024;

/**
 * 最近的输出，加上从开始到现在一共输出了多少（total）。
 * 页面记着自己收到第几个字符了（since），重连时只补后面的；早于记录开头的补不了，整屏重画。
 */
export class OutputLog {
  private buf = "";
  total = 0;

  constructor(private readonly limit = LOG_LIMIT) {}

  append(data: string): void {
    this.buf += data;
    this.total += data.length;
    if (this.buf.length > this.limit * 1.25) {
      // 从换行处截：别从一个转义序列中间开始重放
      const cut = this.buf.length - this.limit;
      const nl = this.buf.indexOf("\n", cut);
      this.buf = this.buf.slice(nl >= 0 && nl - cut < 4096 ? nl + 1 : cut);
    }
  }

  /** since 之后的输出；reset：页面得先清屏，data 是能补的全部 */
  since(since: number): { reset: boolean; data: string } {
    const start = this.total - this.buf.length;
    if (Number.isInteger(since) && since >= start && since <= this.total) return { reset: false, data: this.buf.slice(since - start) };
    return { reset: true, data: this.buf };
  }
}

// ---------- 终端 ----------

/** 连着这个终端的一个页面。由 Web 渠道实现（见 channels/web/terminal.ts） */
export type TermPeer = {
  send(msg: unknown): void;
  close(code: number, reason: string): void;
};

type Term = {
  id: string;
  owner: string;
  cwd: string;
  shell: string;
  createdAt: number;
  pty: IPty;
  log: OutputLog;
  peers: Set<TermPeer>;
  cols: number;
  rows: number;
  /** 没有页面连着时开始计时，到点结束 shell */
  idleTimer: NodeJS.Timeout | null;
  /** 还没发出去的输出：pty 一次只吐几十个字节，攒一下再发 */
  pending: string;
  flushTimer: NodeJS.Timeout | null;
};

export type TermInfo = { id: string; cwd: string; shell: string; createdAt: number; attached: number };

const PER_USER = 10;
const TOTAL = 50;

const terms = new Map<string, Term>();
/** 某人的终端开了 / 结束了：他开着的页面重新拉列表 */
export const terminalEvents = new EventEmitter<{ changed: [owner: string] }>();

function info(t: Term): TermInfo {
  return { id: t.id, cwd: t.cwd, shell: path.basename(t.shell), createdAt: t.createdAt, attached: t.peers.size };
}

export function listTerminals(owner: string): TermInfo[] {
  return [...terms.values()].filter((t) => t.owner === owner).sort((a, b) => a.createdAt - b.createdAt).map(info);
}

/** 只给主人：别人的终端 id 拿到了也当不存在 */
export function getTerminal(id: string, owner: string): TermInfo | undefined {
  const t = terms.get(id);
  return t && t.owner === owner ? info(t) : undefined;
}

function defaultShell(): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: process.env.COMSPEC || "powershell.exe", args: [] };
  const candidates = [process.env.SHELL, "/bin/bash", "/bin/zsh", "/bin/sh"].filter((s): s is string => !!s);
  const file = candidates.find((s) => path.isAbsolute(s) && fs.existsSync(s)) ?? "/bin/sh";
  // 登录 shell：systemd / launchd 下 PATH 很短，读一遍 profile 才像平时开的终端
  return { file, args: ["-l"] };
}

function usableDir(dir: unknown): string | undefined {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) return undefined;
  try {
    return fs.statSync(dir).isDirectory() ? path.resolve(dir) : undefined;
  } catch {
    return undefined;
  }
}

function clampSize(n: unknown, fallback: number, max: number): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v >= 2 ? Math.min(v, max) : fallback;
}

export function createTerminal(user: User, opts: { cwd?: unknown; cols?: unknown; rows?: unknown }): TermInfo {
  if (!canUseTerminal(user)) throw new Error("你没有使用终端的权限");
  const pty = loadPty();
  if (!pty) throw new Error(terminalAvailability().reason);
  if (listTerminals(user.id).length >= PER_USER) throw new Error(`最多同时开 ${PER_USER} 个终端，先关掉几个`);
  if (terms.size >= TOTAL) throw new Error("服务器上开着的终端太多了");
  const cwd = usableDir(opts.cwd) ?? usableDir(config().workspaceRoot) ?? os.homedir();
  const cols = clampSize(opts.cols, 80, 500);
  const rows = clampSize(opts.rows, 24, 200);
  const shell = defaultShell();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(agentEnvironment())) if (typeof v === "string") env[k] = v;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  if (!env.LANG && !env.LC_ALL) env.LANG = "C.UTF-8";
  const proc = pty.spawn(shell.file, shell.args, { name: "xterm-256color", cols, rows, cwd, env });
  const t: Term = {
    id: `t_${crypto.randomBytes(6).toString("hex")}`,
    owner: user.id,
    cwd,
    shell: shell.file,
    createdAt: Date.now(),
    pty: proc,
    log: new OutputLog(),
    peers: new Set(),
    cols,
    rows,
    idleTimer: null,
    pending: "",
    flushTimer: null,
  };
  terms.set(t.id, t);
  proc.onData((data) => {
    t.log.append(data);
    t.pending += data;
    t.flushTimer ??= setTimeout(() => flush(t), 8);
  });
  proc.onExit(({ exitCode }) => {
    flush(t);
    finish(t, `shell 已退出（${exitCode}）`, exitCode);
  });
  armIdle(t);
  console.log(`[终端] ${user.name} 开了终端 ${t.id}（${cwd}）`);
  terminalEvents.emit("changed", t.owner);
  return info(t);
}

function flush(t: Term): void {
  if (t.flushTimer) clearTimeout(t.flushTimer);
  t.flushTimer = null;
  if (!t.pending) return;
  const msg = { t: "o", d: t.pending };
  t.pending = "";
  for (const peer of t.peers) peer.send(msg);
}

/** 没有页面连着了：keepAliveMin 分钟后结束 */
function armIdle(t: Term): void {
  if (t.idleTimer) clearTimeout(t.idleTimer);
  t.idleTimer = null;
  if (t.peers.size > 0) return;
  const ms = Math.max(1, config().remote.keepAliveMin) * 60_000;
  t.idleTimer = setTimeout(() => killTerminal(t.id, "没有页面连着，已超时结束"), ms);
  t.idleTimer.unref();
}

/** 从表里拿掉、告诉连着的页面。shell 自己退出和被结束都走这里 */
function finish(t: Term, reason: string, code: number | null): void {
  if (terms.get(t.id) !== t) return;
  terms.delete(t.id);
  if (t.idleTimer) clearTimeout(t.idleTimer);
  if (t.flushTimer) clearTimeout(t.flushTimer);
  for (const peer of t.peers) {
    peer.send({ t: "x", code, reason });
    peer.close(4000, "终端已结束");
  }
  t.peers.clear();
  terminalEvents.emit("changed", t.owner);
}

export function killTerminal(id: string, reason = "已关闭"): boolean {
  const t = terms.get(id);
  if (!t) return false;
  finish(t, reason, null);
  try {
    t.pty.kill();
  } catch {
    // 已经退出了
  }
  return true;
}

/** 页面连上来：先补上 since 之后的输出 */
export function attachTerminal(id: string, owner: string, peer: TermPeer, since: number): boolean {
  const t = terms.get(id);
  if (!t || t.owner !== owner) return false;
  flush(t);
  const { reset, data } = t.log.since(since);
  peer.send({ t: "a", reset, d: data, total: t.log.total, cwd: t.cwd });
  t.peers.add(peer);
  armIdle(t);
  return true;
}

export function detachTerminal(id: string, peer: TermPeer): void {
  const t = terms.get(id);
  if (!t || !t.peers.delete(peer)) return;
  armIdle(t);
}

export function writeTerminal(id: string, data: string): void {
  const t = terms.get(id);
  if (t && data) t.pty.write(data);
}

/** 几个页面开着同一个终端、窗口大小不一样：以最后调整的那个为准 */
export function resizeTerminal(id: string, cols: unknown, rows: unknown): void {
  const t = terms.get(id);
  if (!t) return;
  const c = clampSize(cols, t.cols, 500);
  const r = clampSize(rows, t.rows, 200);
  if (c === t.cols && r === t.rows) return;
  t.cols = c;
  t.rows = r;
  try {
    t.pty.resize(c, r);
  } catch {
    // 正在退出
  }
}

/**
 * 权限变了（用户改了、设置里关了）：现在不能用终端的人，shell 立刻结束。
 * 用户改动由 userEvents 通知；终端里 agent-loft user … 直接改文件的没有事件，Web 的心跳会再调一次
 */
export function enforceTerminalAccess(): void {
  for (const t of [...terms.values()]) {
    if (!canUseTerminal(getUser(t.owner))) killTerminal(t.id, "终端权限已被收回");
  }
}

let watching = false;
/** 启动 Web 渠道时调用一次 */
export function watchTerminalAccess(): void {
  if (watching) return;
  watching = true;
  userEvents.on("changed", enforceTerminalAccess);
  onConfigChange(() => enforceTerminalAccess());
}

/** 服务停止：结束所有 shell */
export function killAllTerminals(): void {
  for (const id of [...terms.keys()]) killTerminal(id, "服务已停止");
}
