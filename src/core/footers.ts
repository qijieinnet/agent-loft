// 每轮回复的「用时 / 费用 / tokens」脚注。
//
// 它只在一轮结束的那一刻随 result 事件出现，agent 自己的会话记录里没有。页面重新加载
// （手机切回前台、刷新）读的是 agent 的记录，脚注就丢了。所以在这里按会话记下来，
// 读历史时再按回复正文的结尾对回去。存在数据库的 footers 表里（见 db.ts），一轮一行。
import { sql, transaction } from "./db.js";
import type { HistoryMessage } from "./types.js";

/** t：回复正文（去掉空白后）的结尾；f：脚注 */
type Entry = { t: string; f: string };

const MAX_PER_SESSION = 1000;
/** 存下来比对用的正文结尾长度 */
const TAIL = 80;

/** 用时按大小换单位：12.3秒 / 3分12秒 / 1小时5分 */
export function formatDuration(ms: number): string {
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}秒`;
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}小时${m ? `${m}分` : ""}`;
  return `${m}分${s ? `${s}秒` : ""}`;
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
  transaction(() => {
    sql("INSERT INTO footers (session_id, tail, footer, at) VALUES (?, ?, ?, ?)").run(sessionId, t, footer, Date.now());
    // 一个会话只留最近这么多轮
    sql(
      `DELETE FROM footers WHERE session_id = ? AND id <= (
         SELECT id FROM footers WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
    ).run(sessionId, sessionId, MAX_PER_SESSION);
  });
}

function entriesOf(sessionId: string): Entry[] {
  return sql("SELECT tail AS t, footer AS f FROM footers WHERE session_id = ? ORDER BY id").all(sessionId) as Entry[];
}

/** 给历史里的助手消息按顺序配上脚注。同样的正文（比如两次都回「好的」）按先后一一对应 */
export function attachFooters(sessionId: string, messages: HistoryMessage[]): HistoryMessage[] {
  const entries = entriesOf(sessionId);
  if (!entries.length) return messages;
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
  if (from === to || !sql("SELECT 1 FROM footers WHERE session_id = ? LIMIT 1").get(from)) return;
  transaction(() => {
    sql("DELETE FROM footers WHERE session_id = ?").run(to);
    sql("INSERT INTO footers (session_id, tail, footer, at) SELECT ?, tail, footer, ? FROM footers WHERE session_id = ? ORDER BY id").run(to, Date.now(), from);
  });
}
