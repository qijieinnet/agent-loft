// 读 pi 的会话记录：data/pi/sessions/<时间>_<会话 id>.jsonl（格式见 pi 文档 session-format.md）。
//
// 第一行是头 { type: "session", id, cwd, timestamp }，后面每行一条记录，靠 id / parentId 连成一棵树：
// 分叉、回退不删旧记录，只是从更早的一条接着往下写。当前分支 = 从最后一条往上找到根（pi 打开文件时也这么定）。
//   { type: "message", id, parentId, message: { role: "user" | "assistant" | "toolResult" | "system", content, timestamp } }
//   { type: "session_info", name }  会话名称
//   { type: "compaction", summary }  上下文压缩
// 自己读文件，不用 SDK：列会话、读历史不必为此加载 pi。认不出的记录一律跳过。
import fs from "node:fs";
import path from "node:path";
import { stripContext } from "../../core/expert-prompt.js";
import { splitAttachmentNote } from "../../core/uploads.js";
import type { HistoryMessage, SessionSummary } from "../../core/types.js";
import { summarize } from "../claude/session.js";
import { SESSIONS_DIR } from "./sdk.js";
import { describePiStep } from "./steps.js";

/** 会话 id 会拼进路径，先验形（pi 自己的规则，见 assertValidSessionId） */
export const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;

type Entry = {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  cwd?: string;
  name?: string;
  message?: { role?: string; content?: unknown; timestamp?: number };
};

function sessionsDir(): string {
  return SESSIONS_DIR;
}

/** 按会话 id 找记录文件：文件名是「时间_id.jsonl」 */
export function sessionFile(id: string): string | undefined {
  if (!SESSION_ID.test(id)) return undefined;
  let names: string[];
  try {
    names = fs.readdirSync(sessionsDir());
  } catch {
    return undefined;
  }
  const hit = names.filter((n) => n.endsWith(`_${id}.jsonl`)).sort().pop();
  return hit ? path.join(sessionsDir(), hit) : undefined;
}

export function readEntries(file: string): Entry[] {
  const out: Entry[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as Entry;
      if (v && typeof v === "object") out.push(v);
    } catch {
      // 写到一半的最后一行
    }
  }
  return out;
}

/** 当前分支：从最后一条往上走到根，再倒过来 */
export function activeBranch(entries: Entry[]): Entry[] {
  const body = entries.filter((e) => e.type !== "session" && typeof e.id === "string");
  const byId = new Map(body.map((e) => [e.id!, e]));
  const out: Entry[] = [];
  const seen = new Set<string>();
  for (let e = body[body.length - 1]; e && !seen.has(e.id!); e = e.parentId ? byId.get(e.parentId) : undefined) {
    seen.add(e.id!);
    out.push(e);
  }
  return out.reverse();
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => !!b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text)
    .join("\n");
}

function userText(e: Entry): string {
  return splitAttachmentNote(stripContext(textOf(e.message?.content))).text;
}

function tsOf(e: Entry): number | undefined {
  if (typeof e.message?.timestamp === "number") return e.message.timestamp;
  const t = e.timestamp ? Date.parse(e.timestamp) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

function nameOf(entries: Entry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type === "session_info") return e.name?.trim() || undefined;
  }
  return undefined;
}

export function sessionTitleOf(id: string): string | undefined {
  const file = sessionFile(id);
  if (!file) return undefined;
  try {
    return nameOf(readEntries(file));
  } catch {
    return undefined;
  }
}

export function sessionCwd(id: string): string | undefined {
  const file = sessionFile(id);
  if (!file) return undefined;
  try {
    return readEntries(file).find((e) => e.type === "session")?.cwd;
  } catch {
    return undefined;
  }
}

/** cwd 为 undefined 时列全部。没说过话的不列 */
export function listSessionFiles(cwd: string | undefined, limit: number): SessionSummary[] {
  let names: string[];
  try {
    names = fs.readdirSync(sessionsDir());
  } catch {
    return [];
  }
  const files: { id: string; file: string; mtime: number }[] = [];
  for (const n of names) {
    const m = /_([^_]+)\.jsonl$/.exec(n);
    if (!m || !SESSION_ID.test(m[1]!)) continue;
    const file = path.join(sessionsDir(), n);
    try {
      files.push({ id: m[1]!, file, mtime: fs.statSync(file).mtimeMs });
    } catch {
      // 刚被删
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out: SessionSummary[] = [];
  for (const f of files.slice(0, 300)) {
    if (out.length >= limit) break;
    let entries: Entry[];
    try {
      entries = readEntries(f.file);
    } catch {
      continue;
    }
    const at = entries.find((e) => e.type === "session")?.cwd;
    if (cwd && at && path.resolve(at) !== path.resolve(cwd)) continue;
    const first = entries.find((e) => e.type === "message" && e.message?.role === "user" && userText(e));
    if (!first) continue;
    out.push({ id: f.id, title: nameOf(entries) ?? summarize(userText(first), 60), ...(at ? { cwd: at } : {}), updatedAt: f.mtime });
  }
  return out;
}

/** 整理成「一问一答」：用户一条，助手把这一轮的文字拼成一条，工具调用、思考挂成过程摘要 */
export function readHistoryFile(id: string): HistoryMessage[] {
  const file = sessionFile(id);
  if (!file) return [];
  const out: HistoryMessage[] = [];
  let assistant: HistoryMessage | null = null;
  const flush = () => {
    if (assistant && (assistant.text.trim() || assistant.steps?.length)) out.push(assistant);
    assistant = null;
  };
  for (const e of activeBranch(readEntries(file))) {
    if (e.type === "compaction") {
      assistant ??= { role: "assistant", text: "", steps: [] };
      assistant.steps!.push("🗜️ 上下文已压缩");
      continue;
    }
    if (e.type !== "message" || !e.message) continue;
    const role = e.message.role;
    const ts = tsOf(e);
    if (role === "user") {
      const { text, attachments } = splitAttachmentNote(stripContext(textOf(e.message.content)));
      if (!text && attachments.length === 0) continue;
      flush();
      out.push({ role: "user", text, anchor: e.id!, ...(attachments.length ? { attachments } : {}), ...(ts !== undefined ? { ts } : {}) });
    } else if (role === "assistant") {
      assistant ??= { role: "assistant", text: "", steps: [] };
      assistant.anchor = e.id!;
      if (ts !== undefined) assistant.ts = ts;
      const blocks = Array.isArray(e.message.content) ? (e.message.content as { type?: string; text?: string; thinking?: string; redacted?: boolean; name?: string; arguments?: unknown }[]) : [];
      for (const b of blocks) {
        if (b.type === "text" && b.text?.trim()) assistant.text += (assistant.text ? "\n\n" : "") + b.text;
        else if (b.type === "thinking" && !b.redacted) {
          const t = summarize(b.thinking ?? "");
          if (t) assistant.steps!.push(`💭 ${t}`);
        } else if (b.type === "toolCall" && b.name) {
          assistant.steps!.push(`🔧 ${describePiStep(b.name, b.arguments)}`);
        }
      }
    }
  }
  flush();
  return out;
}

/** 回退：要保留到哪条记录（指定的用户消息的上一条）；是第一条用户消息就返回 null */
export function rewindParent(id: string, userAnchor: string): string | null | undefined {
  const file = sessionFile(id);
  if (!file) return undefined;
  const branch = activeBranch(readEntries(file));
  const i = branch.findIndex((e) => e.id === userAnchor);
  if (i < 0) return undefined;
  // 往前找最近的一条对话消息：前面只有模型、思考程度这类设置记录的，就算第一条
  for (let j = i - 1; j >= 0; j--) {
    const e = branch[j]!;
    if (e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant" || e.message?.role === "toolResult")) return e.id!;
  }
  return null;
}
