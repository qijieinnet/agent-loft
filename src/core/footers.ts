// 每轮回复的「用时 / 费用 / tokens」脚注。
//
// 它只在一轮结束的那一刻随 result 事件出现，agent 自己的会话记录里没有。页面重新加载
// （手机切回前台、刷新）读的是 agent 的记录，脚注就丢了。所以在这里按会话记下来，
// 读历史时再按回复正文的结尾对回去。
import path from "node:path";
import { dataDir, readJson, writeJsonAtomic } from "../home.js";
import type { HistoryMessage } from "./types.js";

/** t：回复正文（去掉空白后）的结尾；f：脚注 */
type Entry = { t: string; f: string };
type Store = Record<string, { at: number; entries: Entry[] }>;

const FILE = () => path.join(dataDir, "footers.json");
const MAX_SESSIONS = 300;
const MAX_PER_SESSION = 1000;
/** 存下来比对用的正文结尾长度 */
const TAIL = 80;

let store: Store | null = null;
let timer: NodeJS.Timeout | null = null;

function load(): Store {
  return (store ??= readJson<Store>(FILE(), {}));
}

function persistSoon(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const s = load();
    // 只留最近用过的会话
    const keys = Object.keys(s).sort((a, b) => s[b]!.at - s[a]!.at);
    for (const k of keys.slice(MAX_SESSIONS)) delete s[k];
    writeJsonAtomic(FILE(), s);
  }, 1000);
  timer.unref();
}

// 空白全去掉：实时的 result 和落盘的记录在换行、空格上可能不完全一致
const squash = (text: string): string => text.replace(/\s+/g, "");

/**
 * Claude 的 result 只是这一轮最后一段文字，而记录里同一轮的多段文字会拼在一起，
 * 所以比的是「记录里的正文以它结尾」。
 */
function endsWithTail(text: string, tail: string): boolean {
  return squash(text).endsWith(tail);
}

export function recordFooter(sessionId: string | undefined, text: string, footer: string): void {
  const t = squash(text).slice(-TAIL);
  if (!sessionId || !t || !footer) return;
  const s = load();
  const slot = (s[sessionId] ??= { at: 0, entries: [] });
  slot.at = Date.now();
  slot.entries.push({ t, f: footer });
  if (slot.entries.length > MAX_PER_SESSION) slot.entries.splice(0, slot.entries.length - MAX_PER_SESSION);
  persistSoon();
}

/** 给历史里的助手消息按顺序配上脚注。同样的正文（比如两次都回「好的」）按先后一一对应 */
export function attachFooters(sessionId: string, messages: HistoryMessage[]): HistoryMessage[] {
  const entries = load()[sessionId]?.entries;
  if (!entries?.length) return messages;
  let next = 0;
  return messages.map((m) => {
    if (m.role !== "assistant" || next >= entries.length) return m;
    if (!m.text.trim()) return m;
    const found = entries.findIndex((e, i) => i >= next && endsWithTail(m.text, e.t));
    if (found < 0) return m;
    next = found + 1;
    return { ...m, footer: entries[found]!.f };
  });
}

/** 分叉出的新会话沿用原会话的脚注：它的记录是原会话的前一段，attachFooters 按顺序配得上 */
export function copyFooters(from: string, to: string): void {
  const src = load()[from];
  if (!src?.entries.length) return;
  load()[to] = { at: Date.now(), entries: src.entries.map((e) => ({ ...e })) };
  persistSoon();
}

/** 测试用 */
export function resetFootersForTest(): void {
  store = null;
}
