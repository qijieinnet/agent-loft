import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { sql, transaction } from "./db.js";
import { getBotThread, WebBotError } from "./web-bots.js";

export function openToolCall(message: number, service: string, name: string, args?: string) {
  const id = randomUUID();
  const saved = sql(`INSERT INTO web_bot_calls(id,message,service,name,status,args,expires)
    SELECT ?,id,?,?,?,?,? FROM web_bot_messages WHERE id=? AND status='pending' AND worker=?`)
    .run(id, service, name, args === undefined ? "ready" : "pending", args ?? null, Date.now() + 120000, message, process.pid);
  if (!saved.changes) throw new WebBotError(409, "本轮对话已结束。");
  return id;
}

export function decideToolCall(user: string, thread: string, id: string, approve: boolean) {
  transaction(() => {
    const { accessId } = getBotThread(user, thread);
    const row = sql(`SELECT c.status,c.expires FROM web_bot_calls c JOIN web_bot_messages m ON m.id=c.message
      WHERE c.id=? AND m.thread=? AND m.authorId=? AND m.authorAccess=? AND m.status='pending'`).get(id, thread, user, accessId);
    if (!row) throw new WebBotError(404, "没有可处理的请求。");
    if (row.status !== "pending" || Number(row.expires) <= Date.now()) throw new WebBotError(409, "这次请求已处理或已过期。");
    sql("UPDATE web_bot_calls SET status=?,args=NULL WHERE id=?").run(approve ? "approved" : "denied", id);
  });
}

export async function waitToolDecision(id: string, signal: AbortSignal, check: () => void) {
  for (;;) {
    signal.throwIfAborted();
    check();
    const row = sql("SELECT status,expires FROM web_bot_calls WHERE id=?").get(id);
    if (row?.status === "approved") return;
    if (row?.status === "denied") throw new WebBotError(409, "你已拒绝这次工具调用。");
    if (row?.status !== "pending") throw new WebBotError(409, "这次工具调用已取消。");
    if (Number(row.expires) <= Date.now()) {
      sql("UPDATE web_bot_calls SET status='expired',args=NULL WHERE id=? AND status='pending'").run(id);
      throw new WebBotError(409, "等待确认已超时。");
    }
    await delay(400, undefined, { signal });
  }
}

export function startToolCall(id: string) {
  if (!sql("UPDATE web_bot_calls SET status='running' WHERE id=? AND status IN ('approved','ready')").run(id).changes)
    throw new WebBotError(409, "这次调用已失效。");
}

export function endToolCall(id: string, state: "done" | "failed" | "unknown", detail = "") {
  sql(`UPDATE web_bot_calls SET args=NULL,detail=?,status=CASE WHEN status IN ('running','ready') THEN ? ELSE 'cancelled' END
    WHERE id=? AND status IN ('ready','approved','pending','running')`).run(detail.length > 1200 ? detail.slice(0, 1199) + "…" : detail, state, id);
}

export function threadCalls(user: string, thread: string, first: number, last: number) {
  const { accessId } = getBotThread(user, thread);
  const rows = sql(`SELECT c.id,c.message,c.service,c.name,c.status,c.detail, EXISTS(SELECT 1 FROM web_bot_call_images WHERE call=c.id) AS image, CASE WHEN m.authorId=? AND m.authorAccess=?
    AND m.status='pending' AND c.status='pending' AND c.expires>? THEN c.args END AS args
    FROM web_bot_calls c JOIN web_bot_messages m ON m.id=c.message WHERE m.thread=? AND c.message BETWEEN ? AND ? ORDER BY c.rowid`)
    .all(user, accessId, Date.now(), thread, first, last);
  const grouped = new Map<number, typeof rows>();
  for (const row of rows) {
    const key = Number(row.message);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(row);
  }
  return grouped;
}

export function callImage(user: string, thread: string, id: string) {
  getBotThread(user, thread);
  const row = sql(`SELECT i.data FROM web_bot_call_images i JOIN web_bot_calls c ON c.id=i.call
    JOIN web_bot_messages m ON m.id=c.message WHERE i.call=? AND m.thread=?`).get(id, thread);
  if (!row) throw new WebBotError(404, "图片已不可用。");
  return Buffer.from(row.data as Uint8Array);
}
export function saveCallImage(id: string, data: Buffer) {
  sql("INSERT OR REPLACE INTO web_bot_call_images VALUES(?,?)").run(id, data);
}
