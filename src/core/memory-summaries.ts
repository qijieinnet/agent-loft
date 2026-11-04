// 摘要层：夹在「一句话的记忆条目」和「原始聊天」之间，回答「那件事的来龙去脉」这类问题。
//
//   - conv：一段对话的摘要。整理记忆时顺带写（同一次调用，不多占额度），对话继续聊就更新；
//   - month：一个月的摘要。月份过去之后，由这个月的对话摘要合成（见 memory-curator.ts 的 rollupMonths）。
//
// 只有在整理范围内的对话才有摘要。删对话时它的摘要一起删，它跨过的每个月的月度摘要也立刻删掉
// （不是标记过期等重新合成：关着整理的人可能永远等不到，被删的内容不能一直留着、还能被搜到）。
// 还剩对话摘要的月份，下次合成时会重新生成。
import { sql, transaction } from "./db.js";
import { ftsIndexText, ftsMatch } from "./fts.js";

export type MemorySummary = {
  id: number;
  kind: "conv" | "month";
  /** conv：对话 key；month：YYYY-MM */
  scope: string;
  title: string;
  text: string;
  /** 对话的工作目录，同一个项目的对话放在一起看 */
  project?: string;
  fromTs: number;
  toTs: number;
  updatedAt: number;
};

export const SUMMARY_LIMITS = { title: 80, conv: 600, month: 1500 };

type Row = {
  id: number;
  kind: "conv" | "month";
  scope: string;
  title: string;
  text: string;
  project: string | null;
  from_ts: number;
  to_ts: number;
  updated_at: number;
};

const COLUMNS = "id, kind, scope, title, text, project, from_ts, to_ts, updated_at";

function toSummary(r: Row): MemorySummary {
  return {
    id: r.id,
    kind: r.kind,
    scope: r.scope,
    title: r.title,
    text: r.text,
    ...(r.project ? { project: r.project } : {}),
    fromTs: r.from_ts,
    toTs: r.to_ts,
    updatedAt: r.updated_at,
  };
}

/** 本地月份 YYYY-MM */
export function localMonth(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function reindex(id: number, title: string, text: string): void {
  sql("DELETE FROM memory_summaries_fts WHERE rowid = ?").run(id);
  sql("INSERT INTO memory_summaries_fts (rowid, text) VALUES (?, ?)").run(id, ftsIndexText(`${title}\n${text}`));
}

export function readSummary(userId: string, kind: MemorySummary["kind"], scope: string): MemorySummary | undefined {
  const row = sql(`SELECT ${COLUMNS} FROM memory_summaries WHERE user_id = ? AND kind = ? AND scope = ?`).get(userId, kind, scope) as Row | undefined;
  return row ? toSummary(row) : undefined;
}

/** 写一份摘要，同一范围的覆盖。fromTs 取旧的和新的里更早的那个 */
export function upsertSummary(
  userId: string,
  s: { kind: MemorySummary["kind"]; scope: string; title: string; text: string; project?: string; fromTs: number; toTs: number },
  now = Date.now(),
): MemorySummary {
  const title = s.title.trim().slice(0, SUMMARY_LIMITS.title);
  const text = s.text.trim().slice(0, s.kind === "conv" ? SUMMARY_LIMITS.conv : SUMMARY_LIMITS.month);
  return transaction(() => {
    const old = readSummary(userId, s.kind, s.scope);
    const from = old ? Math.min(old.fromTs, s.fromTs) : s.fromTs;
    const to = old ? Math.max(old.toTs, s.toTs) : s.toTs;
    sql(
      `INSERT INTO memory_summaries (user_id, kind, scope, title, text, project, from_ts, to_ts, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, kind, scope) DO UPDATE SET title = excluded.title, text = excluded.text, project = excluded.project,
         from_ts = excluded.from_ts, to_ts = excluded.to_ts, updated_at = excluded.updated_at`,
    ).run(userId, s.kind, s.scope, title, text, s.project ?? null, from, to, now);
    const saved = readSummary(userId, s.kind, s.scope)!;
    reindex(saved.id, title, text);
    return saved;
  });
}

export function listSummaries(
  userId: string,
  opts: { kind?: MemorySummary["kind"]; after?: number; before?: number; project?: string; limit?: number; offset?: number } = {},
): MemorySummary[] {
  const where = ["user_id = ?"];
  const args: (string | number)[] = [userId];
  if (opts.kind) {
    where.push("kind = ?");
    args.push(opts.kind);
  }
  if (opts.after !== undefined) {
    where.push("to_ts >= ?");
    args.push(opts.after);
  }
  if (opts.before !== undefined) {
    where.push("from_ts < ?");
    args.push(opts.before);
  }
  if (opts.project) {
    where.push("instr(lower(project), ?) > 0");
    args.push(opts.project.toLowerCase());
  }
  const rows = sql(`SELECT ${COLUMNS} FROM memory_summaries WHERE ${where.join(" AND ")} ORDER BY to_ts DESC, id DESC LIMIT ? OFFSET ?`).all(
    ...args,
    Math.max(1, Math.min(500, opts.limit ?? 50)),
    Math.max(0, opts.offset ?? 0),
  ) as Row[];
  return rows.map(toSummary);
}

/** 全部摘要（导出用） */
export function exportSummaries(userId: string): MemorySummary[] {
  const rows = sql(`SELECT ${COLUMNS} FROM memory_summaries WHERE user_id = ? ORDER BY id`).all(userId) as Row[];
  return rows.map(toSummary);
}

export function countSummaries(userId: string): { conv: number; month: number } {
  const rows = sql("SELECT kind, count(*) AS n FROM memory_summaries WHERE user_id = ? GROUP BY kind").all(userId) as { kind: string; n: number }[];
  return { conv: rows.find((r) => r.kind === "conv")?.n ?? 0, month: rows.find((r) => r.kind === "month")?.n ?? 0 };
}

export function searchSummaries(
  userId: string,
  query: string,
  opts: { after?: number; before?: number; limit?: number; skip?: (s: MemorySummary) => boolean } = {},
): MemorySummary[] {
  const match = ftsMatch(query);
  if (!match) return [];
  const where: string[] = [];
  const args: number[] = [];
  if (opts.after !== undefined) {
    where.push(" AND s.to_ts >= ?");
    args.push(opts.after);
  }
  if (opts.before !== undefined) {
    where.push(" AND s.from_ts < ?");
    args.push(opts.before);
  }
  const rows = sql(
    `SELECT s.id, s.kind, s.scope, s.title, s.text, s.project, s.from_ts, s.to_ts, s.updated_at
     FROM memory_summaries_fts CROSS JOIN memory_summaries s ON s.id = memory_summaries_fts.rowid
     WHERE memory_summaries_fts MATCH ? AND s.user_id = ?${where.join("")} ORDER BY memory_summaries_fts.rank LIMIT 50`,
  ).all(match, userId, ...args) as Row[];
  const out = rows.map(toSummary).filter((s) => !opts.skip?.(s));
  return out.slice(0, opts.limit ?? 3);
}

function removeRow(userId: string, s: MemorySummary): void {
  sql("DELETE FROM memory_summaries_fts WHERE rowid = ?").run(s.id);
  sql("DELETE FROM memory_summaries WHERE id = ? AND user_id = ?").run(s.id, userId);
  if (s.kind !== "conv") return;
  // 这段对话跨过的每个月：月度摘要都可能含有它的内容，删掉，还有别的对话的月份下次重新合成
  const months = sql("SELECT id FROM memory_summaries WHERE user_id = ? AND kind = 'month' AND scope >= ? AND scope <= ?").all(userId, localMonth(s.fromTs), localMonth(s.toTs)) as { id: number }[];
  for (const m of months) {
    sql("DELETE FROM memory_summaries_fts WHERE rowid = ?").run(m.id);
    sql("DELETE FROM memory_summaries WHERE id = ?").run(m.id);
  }
}

/** 删一段对话的摘要（对话被删时） */
export function deleteConvSummary(userId: string, key: string): void {
  transaction(() => {
    const s = readSummary(userId, "conv", key);
    if (s) removeRow(userId, s);
  });
}

/** 用户在设置里删一条摘要 */
export function deleteSummary(userId: string, id: number): boolean {
  return transaction(() => {
    const row = sql(`SELECT ${COLUMNS} FROM memory_summaries WHERE id = ? AND user_id = ?`).get(id, userId) as Row | undefined;
    if (!row) return false;
    removeRow(userId, toSummary(row));
    return true;
  });
}

export function purgeSummaries(userId: string): void {
  transaction(() => {
    sql("DELETE FROM memory_summaries_fts WHERE rowid IN (SELECT id FROM memory_summaries WHERE user_id = ?)").run(userId);
    sql("DELETE FROM memory_summaries WHERE user_id = ?").run(userId);
  });
}

/**
 * 该（重新）合成月度摘要的月份，从早到晚。当前月还没过完不算。
 * 要合成的：这个月有对话摘要，且月度摘要还没有、或者比对话摘要旧。
 */
export function monthsToRollup(userId: string, now = Date.now()): string[] {
  const current = localMonth(now);
  const rows = sql("SELECT to_ts, updated_at FROM memory_summaries WHERE user_id = ? AND kind = 'conv'").all(userId) as { to_ts: number; updated_at: number }[];
  const newest = new Map<string, number>();
  for (const r of rows) {
    const month = localMonth(r.to_ts);
    if (month < current) newest.set(month, Math.max(newest.get(month) ?? 0, r.updated_at));
  }
  const byScope = new Map(listSummaries(userId, { kind: "month", limit: 500 }).map((m) => [m.scope, m]));
  return [...newest.entries()]
    .filter(([month, at]) => {
      const m = byScope.get(month);
      return !m || m.updatedAt < at;
    })
    .map(([month]) => month)
    .sort();
}

/** 某个月的全部对话摘要，从早到晚 */
export function convSummariesOfMonth(userId: string, month: string): MemorySummary[] {
  const rows = sql(`SELECT ${COLUMNS} FROM memory_summaries WHERE user_id = ? AND kind = 'conv' ORDER BY to_ts`).all(userId) as Row[];
  return rows.map(toSummary).filter((s) => localMonth(s.toTs) === month);
}
