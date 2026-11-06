// 读 WorkBuddy（CodeBuddy Code）的会话记录：~/.codebuddy/projects/<项目目录>/<会话 id>.jsonl。
//
// SDK 没有列会话、读历史的接口，只能读 CLI 落的盘。每行一条记录，常见的几种：
//   { type: "message", role: "user" | "assistant", content: [{ type: "input_text" | "output_text", text }], id, timestamp, cwd }
//   { type: "function_call", name, arguments: "<JSON 字符串>", callId }
//   { type: "function_call_result", callId, output }
//   { type: "reasoning", content: [{ type: "input_text", text }] }
//   { type: "ai-title", aiTitle } / { type: "topic", topic }
// 这是 CLI 的内部格式，认不出的记录一律跳过，别因为它升级了就整段读不出来。
import fs from "node:fs";
import path from "node:path";
import { stripContext } from "../../core/expert-prompt.js";
import { splitAttachmentNote } from "../../core/uploads.js";
import type { HistoryMessage, SessionSummary } from "../../core/types.js";
import { describeToolUse, summarize } from "../claude/session.js";
import { resultText, TodoTracker } from "../claude/todos.js";
import { codebuddyHome } from "./sdk.js";

/** 会话 id 会拼进路径，先验形 */
export const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

type Record_ = {
  type?: string;
  role?: string;
  id?: string;
  timestamp?: number | string;
  cwd?: string;
  content?: unknown;
  name?: string;
  arguments?: unknown;
  callId?: string;
  output?: unknown;
  aiTitle?: string;
  topic?: string;
  providerData?: { isSynthetic?: boolean; parentToolUseId?: string; agent?: string } | null;
  isSidechain?: boolean;
};

function projectsDir(): string {
  return path.join(codebuddyHome(), "projects");
}

/** 按会话 id 找记录文件。项目目录名是 CLI 按 cwd 编出来的，不去复刻规则，直接挨个目录找 */
export function sessionFile(id: string): string | undefined {
  if (!SESSION_ID.test(id)) return undefined;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projectsDir());
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    const file = path.join(projectsDir(), d, `${id}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

function readRecords(file: string): Record_[] {
  const out: Record_[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as unknown;
      if (r && typeof r === "object") out.push(r as Record_);
    } catch {
      // 写到一半的最后一行
    }
  }
  return out;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
    .filter((t) => t.trim())
    .join("\n");
}

function tsOf(r: Record_): number | undefined {
  const t = typeof r.timestamp === "number" ? r.timestamp : Date.parse(r.timestamp ?? "");
  return Number.isFinite(t) ? t : undefined;
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

/** 子 agent、系统塞进来的消息不算对话 */
function isSide(r: Record_): boolean {
  return !!(r.isSidechain || r.providerData?.parentToolUseId);
}

function cleanTitle(raw: string): string | undefined {
  const t = stripContext(raw).replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
}

/** CLI 生成的标题（最后一次的为准）；没有就返回 undefined */
function titleIn(records: Record_[]): string | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!;
    if (r.type === "ai-title" && typeof r.aiTitle === "string" && r.aiTitle.trim()) return cleanTitle(r.aiTitle);
    if (r.type === "topic" && typeof r.topic === "string" && r.topic.trim()) return cleanTitle(r.topic);
  }
  return undefined;
}

function firstPrompt(records: Record_[]): string | undefined {
  for (const r of records) {
    if (r.type !== "message" || r.role !== "user" || isSide(r) || r.providerData?.isSynthetic) continue;
    const t = splitAttachmentNote(stripContext(textOf(r.content))).text;
    if (t && !t.startsWith("<")) return cleanTitle(t);
  }
  return undefined;
}

function cwdIn(records: Record_[]): string | undefined {
  return records.find((r) => typeof r.cwd === "string" && r.cwd)?.cwd;
}

export function sessionTitleOf(id: string): string | undefined {
  const file = sessionFile(id);
  return file ? titleIn(readRecords(file)) : undefined;
}

/** 最近的会话；cwd 给了就只要这个目录的 */
export function listSessionFiles(cwd: string | undefined, limit: number): SessionSummary[] {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projectsDir());
  } catch {
    return [];
  }
  const files: { id: string; file: string; mtime: number }[] = [];
  for (const d of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(projectsDir(), d));
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const id = n.slice(0, -6);
      if (!SESSION_ID.test(id)) continue;
      const file = path.join(projectsDir(), d, n);
      try {
        files.push({ id, file, mtime: fs.statSync(file).mtimeMs });
      } catch {
        // 刚被删
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out: SessionSummary[] = [];
  // 按目录筛要读文件内容才知道 cwd：最多看 200 个，别为了凑数把整个目录读一遍
  for (const f of files.slice(0, 200)) {
    if (out.length >= limit) break;
    let records: Record_[];
    try {
      records = readRecords(f.file);
    } catch {
      continue;
    }
    const at = cwdIn(records);
    if (cwd && at && path.resolve(at) !== path.resolve(cwd)) continue;
    // 只有系统记录、没说过话的（比如没登录时的探测）不列
    const prompt = firstPrompt(records);
    if (!prompt) continue;
    out.push({ id: f.id, title: titleIn(records) ?? prompt, ...(at ? { cwd: at } : {}), updatedAt: f.mtime });
  }
  return out;
}

/**
 * 整理成「一问一答」：用户一条，助手把这一轮的文字拼成一条，工具调用、思考挂成过程摘要。
 * 和 Claude 的 readHistory 一个口径（见 claude/driver.ts）。
 */
export function readHistoryFile(id: string): HistoryMessage[] {
  const file = sessionFile(id);
  if (!file) return [];
  const out: HistoryMessage[] = [];
  let assistant: HistoryMessage | null = null;
  const todos = new TodoTracker();
  const flush = () => {
    if (assistant && (assistant.text.trim() || assistant.steps?.length)) out.push(assistant);
    assistant = null;
  };
  for (const r of readRecords(file)) {
    if (isSide(r)) continue;
    const ts = tsOf(r);
    if (r.type === "message" && r.role === "user") {
      if (r.providerData?.isSynthetic) continue;
      const { text, attachments } = splitAttachmentNote(stripContext(textOf(r.content)));
      if (!text && attachments.length === 0) continue;
      if (text.startsWith("<command-") || text.startsWith("<local-command") || text.startsWith("<task-notification>") || text.startsWith("<system-reminder>")) {
        flush();
        continue;
      }
      flush();
      out.push({ role: "user", text, ...(r.id ? { anchor: r.id } : {}), ...(attachments.length ? { attachments } : {}), ...(ts !== undefined ? { ts } : {}) });
    } else if (r.type === "message" && r.role === "assistant") {
      assistant ??= { role: "assistant", text: "", steps: [] };
      if (r.id) assistant.anchor = r.id;
      if (ts !== undefined) assistant.ts = ts;
      const text = textOf(r.content);
      if (text.trim()) assistant.text += (assistant.text ? "\n\n" : "") + text;
    } else if (r.type === "function_call" && r.name) {
      assistant ??= { role: "assistant", text: "", steps: [] };
      const input = argsOf(r.arguments);
      const todo = todos.use(r.name, input, r.callId);
      if (todo?.changed) assistant.todos = todos.list;
      assistant.steps!.push(todo ? todo.step : `🔧 ${describeToolUse(r.name, input)}`);
    } else if (r.type === "function_call_result" && r.callId) {
      if (todos.result(r.callId, resultText(r.output), undefined, false) && assistant) assistant.todos = todos.list;
    } else if (r.type === "reasoning") {
      const t = summarize(textOf(r.content));
      if (t) {
        assistant ??= { role: "assistant", text: "", steps: [] };
        assistant.steps!.push(`💭 ${t}`);
      }
    }
  }
  flush();
  return out;
}
