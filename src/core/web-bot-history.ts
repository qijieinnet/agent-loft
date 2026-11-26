// Model retrieval is scoped to the conversation receiving the answer, including adjacent messages.
import { sql } from "./db.js";
import { getBotThread, WebBotError } from "./web-bots.js";

function boundary(raw: unknown, fallback: number) {
  if (raw === undefined) return fallback;
  const value = typeof raw === "string" && /(?:Z|[+-]\d\d:\d\d)$/i.test(raw) ? Date.parse(raw) : NaN;
  if (!Number.isFinite(value)) throw new WebBotError(400, "历史搜索的时间需要带时区。");
  return value;
}

export function recallMessages(user: string, thread: string, before: number, input: Record<string, unknown>) {
  getBotThread(user, thread);
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const from = boundary(input.from, 0), until = boundary(input.until, Number.MAX_SAFE_INTEGER);
  if ((!query && input.from === undefined && input.until === undefined) || query.length > 160 || from >= until ||
    Object.keys(input).some(key => !["query", "from", "until"].includes(key))) throw new WebBotError(400, "请用关键词或时间范围查找旧消息。");
  const hits = sql(`SELECT id FROM web_bot_messages WHERE thread=? AND id<? AND status='done'
    AND createdAt>=? AND createdAt<? AND instr(lower(text), lower(?))>0 ORDER BY id DESC LIMIT 5`).all(thread, before, from, until, query);
  const result = new Map<number, { id: number; role: string; author: string | null; time: string; text: string }>();
  for (const hit of hits) {
    const rows = sql(`SELECT id, role, authorName, createdAt, substr(text, max(1,instr(lower(text),lower(?))-100),600) AS excerpt
      FROM web_bot_messages WHERE thread=? AND status='done' AND id IN (
        (SELECT max(id) FROM web_bot_messages WHERE thread=? AND id<? AND status='done'),
        ?, (SELECT min(id) FROM web_bot_messages WHERE thread=? AND id>? AND id<? AND status='done')
      ) ORDER BY id`).all(query, thread, thread, Number(hit.id), Number(hit.id), thread, Number(hit.id), before);
    for (const row of rows) result.set(Number(row.id), {
      id: Number(row.id), role: String(row.role), author: row.authorName ? String(row.authorName) : null,
      time: new Date(Number(row.createdAt)).toISOString(), text: String(row.excerpt),
    });
  }
  return [...result.values()].sort((a, b) => a.id - b.id);
}

export function saveMessageSources(reply: number, sources: number[]) {
  for (const source of sources) sql(`INSERT OR IGNORE INTO web_bot_message_sources(reply, source)
    SELECT r.id,s.id FROM web_bot_messages r JOIN web_bot_messages s ON r.thread=s.thread
    WHERE r.id=? AND s.id=? AND s.id<r.id`).run(reply, source);
}

export function messageSources(thread: string, first: number, last: number) {
  const grouped = new Map<number, { id: number; excerpt: string }[]>();
  const rows = sql(`SELECT ref.reply,s.id,substr(s.text,1,54) AS excerpt FROM web_bot_message_sources ref
    JOIN web_bot_messages r ON r.id=ref.reply JOIN web_bot_messages s ON s.id=ref.source AND s.thread=r.thread
    WHERE r.thread=? AND ref.reply BETWEEN ? AND ? ORDER BY ref.reply,s.id`).all(thread, first, last);
  for (const row of rows) {
    const reply = Number(row.reply), list = grouped.get(reply) ?? [];
    list.push({ id: Number(row.id), excerpt: String(row.excerpt) });
    grouped.set(reply, list);
  }
  return grouped;
}
