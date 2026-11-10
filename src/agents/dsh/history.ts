// 读 dsh 的会话记录：$DSH_HOME/sessions/<按 cwd 编的目录>/<会话 id>/session.v4.jsonl.zstd。
//
// ACP 恢复会话时不回放历史，会话列表也不带标题和时间，只能读 dsh 落的盘。
// 文件是追加写的：每次 flush 追加一个 zstd frame。Node 的 zstdDecompressSync 只解第一个 frame，
// 所以自己按 frame 头切开再逐个解（splitFrames）。最后一个 frame 可能还在写，解不开就跳过。
//
// 每行一条事件，用到的几种：
//   { type: "session", id, createdAt, cwd, origin?: "subagent", parentSession? }   第一行
//   { type: "user/message", data: { content: [{ type: "text", text }], source: { kind: "user" | ... }, id } }
//   { type: "assistant/message", data: { message: { content: [{ type: "text" | "reasoning" | "tool-call", ... }], id }, usage } }
//   { type: "session/title", data: { title, source: { kind: "fallback" | "provider" } } }
//   { type: "model/selection", data: { provider, model, reasoningEffort } }
//   { type: "turn/start" | "turn/end", data: { turn } }
// 这是 dsh 的内部格式，认不出的事件一律跳过，别因为它升级了就整段读不出来。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { stripContext } from "../../core/expert-prompt.js";
import type { HistoryMessage, SessionSummary, TokenUsage } from "../../core/types.js";
import { splitAttachmentNote } from "../../core/uploads.js";
import { summarize } from "../claude/session.js";
import { TodoTracker } from "../claude/todos.js";
import { sessionsRoot } from "./sdk.js";
import { describeDshStep, todoName } from "./steps.js";

/** 会话 id 会拼进路径，先验形 */
export const SESSION_ID = /^[A-Za-z0-9_-]{8,80}$/;
const LOG_NAME = "session.v4.jsonl.zstd";

export type DshEvent = { type?: string; seq?: number; time?: number; data?: Record<string, unknown>; [k: string]: unknown };

// ---------- zstd frame ----------

const ZSTD_MAGIC = 0xfd2fb528;

/** 按 zstd 帧格式（RFC 8878）切出每个 frame；格式不对就停在那里 */
export function splitFrames(buf: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const magic = buf.readUInt32LE(pos);
    // 可跳过的帧：0x184D2A50 ~ 0x184D2A5F
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      if (pos + 8 > buf.length) break;
      pos += 8 + buf.readUInt32LE(pos + 4);
      continue;
    }
    if (magic !== ZSTD_MAGIC) break;
    const start = pos;
    let p = pos + 4;
    if (p >= buf.length) break;
    const fhd = buf[p]!;
    p += 1;
    const fcsFlag = fhd >> 6;
    const single = (fhd >> 5) & 1;
    const checksum = (fhd >> 2) & 1;
    const dictFlag = fhd & 3;
    if (!single) p += 1;
    p += [0, 1, 2, 4][dictFlag]!;
    p += fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag]!;
    let last = false;
    while (!last) {
      if (p + 3 > buf.length) return frames;
      const header = buf[p]! | (buf[p + 1]! << 8) | (buf[p + 2]! << 16);
      p += 3;
      last = (header & 1) === 1;
      const type = (header >> 1) & 3;
      const size = header >>> 3;
      if (type === 3) return frames;
      p += type === 1 ? 1 : size;
    }
    if (checksum) p += 4;
    if (p > buf.length) break;
    frames.push(buf.subarray(start, p));
    pos = p;
  }
  return frames;
}

/** 解出整份记录的文本 */
export function decodeLog(buf: Buffer): string {
  const parts: string[] = [];
  for (const f of splitFrames(buf)) {
    try {
      parts.push(zlib.zstdDecompressSync(f).toString("utf8"));
    } catch {
      // 写到一半的 frame
    }
  }
  return parts.join("");
}

export function readEvents(file: string): DshEvent[] {
  const out: DshEvent[] = [];
  for (const line of decodeLog(fs.readFileSync(file)).split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as unknown;
      if (r && typeof r === "object") out.push(r as DshEvent);
    } catch {
      // 半行
    }
  }
  return out;
}

// ---------- 找文件 ----------

/** 按会话 id 找记录文件。目录名是 dsh 按 cwd 编的，不去复刻规则，挨个目录找 */
export function sessionFile(id: string): string | undefined {
  if (!SESSION_ID.test(id)) return undefined;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(sessionsRoot());
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    const file = path.join(sessionsRoot(), d, id, LOG_NAME);
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

// ---------- 取字段 ----------

function textOf(content: unknown, type = "text"): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && (c as { type?: string }).type === type && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
    .filter((t) => t.trim())
    .join("\n");
}

function argsOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function header(events: DshEvent[]): DshEvent | undefined {
  return events[0]?.type === "session" ? events[0] : undefined;
}

/** 用户亲手发的消息（不是运行时上下文、子 agent 结果、时间提示这些塞进来的） */
function userText(e: DshEvent): string | undefined {
  if (e.type !== "user/message") return undefined;
  const d = e.data as { content?: unknown; source?: { kind?: string } } | undefined;
  if (d?.source?.kind !== "user") return undefined;
  return textOf(d.content);
}

function cleanTitle(raw: string): string | undefined {
  const t = stripContext(raw).replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
}

/** 模型起的标题（最后一次为准）；只有截首句的 fallback 时返回 undefined */
function titleIn(events: DshEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== "session/title") continue;
    const d = e.data as { title?: unknown; source?: { kind?: string } } | undefined;
    if (d?.source?.kind === "fallback") continue;
    if (typeof d?.title === "string" && d.title.trim()) return cleanTitle(d.title);
  }
  return undefined;
}

function firstPrompt(events: DshEvent[]): string | undefined {
  for (const e of events) {
    const raw = userText(e);
    if (raw === undefined) continue;
    const t = splitAttachmentNote(stripContext(raw)).text;
    if (t) return cleanTitle(t);
  }
  return undefined;
}

/** 最后用的模型服务商：ACP profile 只认它自己有适配器的（默认只有 deepseek-official），别的恢复不了 */
function lastProvider(events: DshEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "model/selection" && typeof e.data?.provider === "string") return e.data.provider;
  }
  return undefined;
}

export function sessionTitleOf(id: string): string | undefined {
  const file = sessionFile(id);
  return file ? titleIn(readEvents(file)) : undefined;
}

export function sessionCwd(id: string): string | undefined {
  const file = sessionFile(id);
  if (!file) return undefined;
  const cwd = header(readEvents(file))?.cwd;
  return typeof cwd === "string" ? cwd : undefined;
}

/**
 * 最近的会话；cwd 给了就只要这个目录的。子 agent 的会话、没说过话的、
 * 用了 ACP 认不了的服务商的（比如在 dsh web 里配的别家模型）不列
 */
export function listSessionFiles(cwd: string | undefined, limit: number, providers?: Set<string>): SessionSummary[] {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(sessionsRoot());
  } catch {
    return [];
  }
  const files: { id: string; file: string; mtime: number }[] = [];
  for (const d of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(sessionsRoot(), d));
    } catch {
      continue;
    }
    for (const id of names) {
      if (!SESSION_ID.test(id)) continue;
      const file = path.join(sessionsRoot(), d, id, LOG_NAME);
      try {
        files.push({ id, file, mtime: fs.statSync(file).mtimeMs });
      } catch {
        // 不是会话目录
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out: SessionSummary[] = [];
  // 最多看 200 个，别为了凑数把整个目录读一遍
  for (const f of files.slice(0, 200)) {
    if (out.length >= limit) break;
    let events: DshEvent[];
    try {
      events = readEvents(f.file);
    } catch {
      continue;
    }
    const h = header(events);
    if (!h || h.origin === "subagent") continue;
    const at = typeof h.cwd === "string" ? h.cwd : undefined;
    if (cwd && at && path.resolve(at) !== path.resolve(cwd)) continue;
    const provider = lastProvider(events);
    if (providers && provider && !providers.has(provider)) continue;
    const prompt = firstPrompt(events);
    if (!prompt) continue;
    out.push({ id: f.id, title: titleIn(events) ?? prompt, ...(at ? { cwd: at } : {}), updatedAt: f.mtime });
  }
  return out;
}

/**
 * 整理成「一问一答」：用户一条，助手把这一轮的文字拼成一条，工具调用挂成过程摘要。
 * 和 Claude 的 readHistory 一个口径（见 claude/driver.ts）。
 */
export function readHistoryEvents(events: DshEvent[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  let assistant: HistoryMessage | null = null;
  const todos = new TodoTracker();
  const flush = () => {
    if (assistant && (assistant.text.trim() || assistant.steps?.length)) out.push(assistant);
    assistant = null;
  };
  for (const e of events) {
    const raw = userText(e);
    if (raw !== undefined) {
      const { text, attachments } = splitAttachmentNote(stripContext(raw));
      flush();
      if (!text && attachments.length === 0) continue;
      const id = (e.data as { id?: unknown }).id;
      out.push({
        role: "user",
        text,
        ...(typeof id === "string" ? { anchor: id } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(typeof e.time === "number" ? { ts: e.time } : {}),
      });
      continue;
    }
    if (e.type === "assistant/message") {
      const msg = (e.data as { message?: { content?: unknown; id?: unknown } } | undefined)?.message;
      if (!msg) continue;
      assistant ??= { role: "assistant", text: "", steps: [] };
      if (typeof msg.id === "string") assistant.anchor = msg.id;
      if (typeof e.time === "number") assistant.ts = e.time;
      const blocks = Array.isArray(msg.content) ? (msg.content as Record<string, unknown>[]) : [];
      for (const b of blocks) {
        if (b.type === "reasoning" && typeof b.text === "string" && b.text.trim()) {
          assistant.steps!.push(`💭 ${summarize(b.text)}`);
        } else if (b.type === "tool-call" && typeof b.name === "string") {
          const input = argsOf(b.arguments);
          const todo = todos.use(todoName(b.name), input, typeof b.id === "string" ? b.id : undefined);
          if (todo?.changed) assistant.todos = todos.list;
          assistant.steps!.push(todo ? todo.step : `🔧 ${describeDshStep(b.name, input)}`);
        }
      }
      const text = textOf(blocks);
      if (text.trim()) assistant.text += (assistant.text ? "\n\n" : "") + text;
      continue;
    }
    if (e.type === "turn/end") flush();
  }
  flush();
  return out;
}

export function readHistoryFile(id: string): HistoryMessage[] {
  const file = sessionFile(id);
  return file ? readHistoryEvents(readEvents(file)) : [];
}

/**
 * 最近一轮（最后一个 turn/start 之后）的 token 用量。ACP 只报上下文占用，不报每一轮花了多少，
 * 这一轮结束后从记录里加出来。inputTokens 是没命中缓存的部分（实测 input + cacheRead + output = total）
 */
export function lastTurnUsage(events: DshEvent[]): TokenUsage | undefined {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === "turn/start") {
      start = i;
      break;
    }
  }
  if (start < 0) return undefined;
  const u: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const e of events.slice(start)) {
    if (e.type !== "assistant/message") continue;
    const usage = (e.data as { usage?: Record<string, unknown> } | undefined)?.usage;
    if (!usage) continue;
    const n = (k: string) => (typeof usage[k] === "number" ? (usage[k] as number) : 0);
    u.input += n("inputTokens");
    u.cacheRead += n("cacheReadTokens");
    u.cacheWrite += n("cacheWriteTokens");
    u.output += n("outputTokens");
  }
  return u.input + u.cacheRead + u.cacheWrite + u.output > 0 ? u : undefined;
}
