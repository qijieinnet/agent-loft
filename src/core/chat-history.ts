// 聊天记录索引：给「参考以前的聊天」（search_past_chats）和「聊完自动整理记忆」用。
//
// 存在数据库的 history 表里（见 db.ts），一行一句（用户说的 / agent 的最终回复），按用户分开。
// 只收有主人的对话（见 personal.ts 的 memoryOwnerOf），按主人分开存 —— 搜索只在自己的里面搜。
// 来源两个：
//   - 实时：hub 的事件流（见 startHistoryCapture），从现在起说的话；
//   - 回填：第一次用时把已有对话从 agent 的记录里读一遍（见 memory-curator.ts），只做一次。
//
// 搜索用 FTS5（history_fts，切词方式见 fts.ts）在库里筛出候选，再在这里按命中情况打分。
// 索引不在写入时维护，而是按 index_state 里的进度补（见 syncHistoryIndex）：写入路径不用多一步，
// 导入的、老版本写的也都能补上。英文词中间的片段（lowercase 写的 openclash 搜 clash）FTS 查不到，
// 最近的一段记录再用 instr 扫一遍兜底，扫描量有上限。
import { sql, transaction } from "./db.js";
import { bigrams, ftsIndexText, ftsMatch, isCjk, needles, terms } from "./fts.js";

export type HistoryRecord = {
  /** 实时用户消息的编号，撤销排队消息时用于精确移除 */
  id?: string;
  /** 对话 key */
  k: string;
  /** agent */
  a: string;
  /** u：用户说的；a：agent 的回复 */
  r: "u" | "a";
  t: string;
  ts: number;
};

export type CurationLog = {
  at: number;
  /** 整理了几段对话 */
  conversations: number;
  added: string[];
  updated: string[];
  removed: number;
  /** 用的哪个 agent / 模型 */
  by?: string;
  error?: string;
  /** 这次写了几份对话摘要 */
  summaries?: number;
};

export type Meta = {
  /** 已有对话回填过了 */
  backfilled?: boolean;
  /** 每条对话整理记忆整理到了哪个时刻（这之后的话还没整理过） */
  extracted: Record<string, number>;
  /** 「每天一次」上次跑的是哪天（本地日期 YYYY-MM-DD） */
  lastDaily?: string;
  /** 上次整理的结果，设置页显示 */
  lastCuration?: CurationLog;
  /** 整轮都失败时的退避：连着失败了几轮、下次什么时候再试 */
  curateRetry?: { failures: number; nextAt: number };
  /** 每段对话连着整理失败了几次。到上限的先搁置（不丢），用户点「现在整理」时再试 */
  curateAttempts?: Record<string, number>;
  /** 月度摘要上次检查的日期（本地日期 YYYY-MM-DD），一天查一次 */
  lastRollup?: string;
};

/** 一句话最多存这么多字：长篇代码、整页网页没必要全存 */
export const TEXT_MAX = 8000;
/** 太长时头尾都留：长回复的结论通常在最后 */
const TEXT_TAIL = 2000;

function capText(text: string): string {
  if (text.length <= TEXT_MAX) return text;
  const gap = "\n…（中间省略）…\n";
  return `${text.slice(0, TEXT_MAX - TEXT_TAIL - gap.length)}${gap}${text.slice(-TEXT_TAIL)}`;
}

function checkUser(userId: string): string {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(userId)) throw new Error("用户 id 不合法");
  return userId;
}

type Row = { id: number; conv_key: string; agent: string; role: "u" | "a"; text: string; ts: number; msg_id: string | null };

const COLUMNS = "id, conv_key, agent, role, text, ts, msg_id";

function toRecord(row: Row): HistoryRecord {
  return { ...(row.msg_id ? { id: row.msg_id } : {}), k: row.conv_key, a: row.agent, r: row.role, t: row.text, ts: row.ts };
}

function insertRecords(userId: string, records: HistoryRecord[]): void {
  const insert = sql("INSERT INTO history (user_id, conv_key, agent, role, text, ts, msg_id) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const r of records) insert.run(userId, r.k, r.a, r.r, capText(r.t), r.ts, r.id ?? null);
}

export function appendRecords(userId: string, records: HistoryRecord[]): void {
  checkUser(userId);
  if (records.length === 0) return;
  transaction(() => insertRecords(userId, records));
}

/** 这个用户的全部记录，按记下的先后 */
export function readRecords(userId: string): HistoryRecord[] {
  checkUser(userId);
  return (sql(`SELECT ${COLUMNS} FROM history WHERE user_id = ? ORDER BY id`).all(userId) as Row[]).map(toRecord);
}

/** 有多少句、来自多少段对话 */
export function countRecords(userId: string): { count: number; conversations: number } {
  checkUser(userId);
  const row = sql("SELECT count(*) AS n, count(DISTINCT conv_key) AS c FROM history WHERE user_id = ?").get(userId) as { n: number; c: number };
  return { count: row.n, conversations: row.c };
}

export function removeHistoryRecord(userId: string, key: string, id: string): void {
  checkUser(userId);
  transaction(() => {
    sql("DELETE FROM history_fts WHERE rowid IN (SELECT id FROM history WHERE user_id = ? AND conv_key = ? AND msg_id = ?)").run(userId, key, id);
    sql("DELETE FROM history WHERE user_id = ? AND conv_key = ? AND msg_id = ?").run(userId, key, id);
  });
}

function deleteConversationRows(userId: string, key: string): void {
  sql("DELETE FROM history_fts WHERE rowid IN (SELECT id FROM history WHERE user_id = ? AND conv_key = ?)").run(userId, key);
  sql("DELETE FROM history WHERE user_id = ? AND conv_key = ?").run(userId, key);
}

/** 对话被删了：这段的聊天记录和整理进度一起删，不只是搜不到 */
export function purgeConversationHistory(userId: string, key: string): void {
  checkUser(userId);
  transaction(() => {
    deleteConversationRows(userId, key);
    const meta = readMeta(userId);
    delete meta.extracted[key];
    if (meta.curateAttempts) delete meta.curateAttempts[key];
    writeMeta(userId, meta);
  });
}

/** 回退后只保留当前对话剩下的内容，避免搜索再搜出已经移除的消息 */
export function replaceConversationRecords(userId: string, key: string, records: HistoryRecord[]): void {
  checkUser(userId);
  transaction(() => {
    deleteConversationRows(userId, key);
    insertRecords(userId, records);
  });
}

export function readMeta(userId: string): Meta {
  checkUser(userId);
  const row = sql("SELECT data FROM history_meta WHERE user_id = ?").get(userId) as { data: string } | undefined;
  let m: Partial<Meta> = {};
  try {
    m = row ? (JSON.parse(row.data) as Partial<Meta>) : {};
  } catch {
    // 坏了就当没有
  }
  return { ...m, extracted: m.extracted && typeof m.extracted === "object" ? m.extracted : {} };
}

export function patchMeta(userId: string, patch: { [K in keyof Meta]?: Meta[K] | undefined }): void {
  writeMeta(userId, { ...readMeta(userId), ...patch });
}

export function writeMeta(userId: string, meta: Meta): void {
  checkUser(userId);
  sql("INSERT OR REPLACE INTO history_meta (user_id, data) VALUES (?, ?)").run(userId, JSON.stringify(meta));
}

export function markExtracted(userId: string, key: string, upTo: number): void {
  transaction(() => {
    const meta = readMeta(userId);
    meta.extracted[key] = Math.max(meta.extracted[key] ?? 0, upTo);
    writeMeta(userId, meta);
  });
}

/** 删用户时：整个删掉 */
export function purgeHistory(userId: string): void {
  checkUser(userId);
  transaction(() => {
    sql("DELETE FROM history_fts WHERE rowid IN (SELECT id FROM history WHERE user_id = ?)").run(userId);
    sql("DELETE FROM history WHERE user_id = ?").run(userId);
    sql("DELETE FROM history_meta WHERE user_id = ?").run(userId);
    sql("DELETE FROM search_stats WHERE user_id = ?").run(userId);
  });
}

/**
 * 还没整理过的对话：最后一句已经过去 idleMs 了（聊完了），而且在上次整理之后又说过话。
 * 返回每条对话上次整理之后的那些句子。
 */
export function pendingConversations(
  userId: string,
  idleMs: number,
  now = Date.now(),
): { key: string; records: HistoryRecord[]; last: number }[] {
  const meta = readMeta(userId);
  // 先只看每段对话的最后一句（走覆盖索引，不读正文），再去读真正要整理的那几段。
  // 不能把 extracted 交给库去 JOIN：json_each 没有索引，句数 × 对话数，几年后要跑几分钟还卡住主进程
  const convs = sql("SELECT conv_key, max(ts) AS last FROM history WHERE user_id = ? GROUP BY conv_key").all(userId) as { conv_key: string; last: number }[];
  const out: { key: string; records: HistoryRecord[]; last: number }[] = [];
  const rows = sql(`SELECT ${COLUMNS} FROM history WHERE user_id = ? AND conv_key = ? AND ts > ? ORDER BY id`);
  for (const { conv_key: key, last } of convs.sort((a, b) => a.last - b.last)) {
    const done = meta.extracted[key] ?? 0;
    if (last <= done || now - last < idleMs) continue;
    out.push({ key, records: (rows.all(userId, key, done) as Row[]).map(toRecord), last });
  }
  return out;
}

// ---------- 搜索 ----------

function occurrences(hay: string, needle: string, cap = 5): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0 && n < cap; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** 一句话和查询的相关程度，0 是不相关 */
export function scoreText(text: string, query: string): number {
  const hay = text.toLowerCase();
  const ts = terms(query);
  if (ts.length === 0) return 0;
  let score = 0;
  let hit = 0;
  for (const term of ts) {
    const n = occurrences(hay, term);
    if (n > 0) {
      hit++;
      score += n * Math.min(term.length, 8);
      continue;
    }
    // 长的中文没整个出现：看两字组合命中了多少（「软路由防污染」能搜到「软路由怎么防 DNS 污染」）
    if (isCjk(term) && term.length >= 4) {
      const grams = bigrams(term);
      const found = grams.filter((g) => hay.includes(g)).length;
      if (found / grams.length >= 0.5) {
        hit += found / grams.length;
        score += found;
      }
    }
  }
  if (score === 0) return 0;
  // 所有词都命中的排前面
  return score * (hit >= ts.length ? 2 : 1);
}

/** 截一段命中位置附近的文字 */
function snippet(text: string, query: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const lower = flat.toLowerCase();
  const first = terms(query)
    .map((t) => lower.indexOf(t))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  const start = Math.max(0, Math.min((first ?? 0) - Math.floor(max / 3), flat.length - max));
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + max)}${start + max < flat.length ? "…" : ""}`;
}

// ---------- 全文索引的进度 ----------

const INDEX_BATCH = 2000;
const INDEX_NAME = "history_fts";

function indexedUpTo(): number {
  return (sql("SELECT upto FROM index_state WHERE name = ?").get(INDEX_NAME) as { upto: number } | undefined)?.upto ?? 0;
}

/** 补一批，一批一个事务：锁拿得短，别的进程不用等太久。返回补了几句 */
function indexBatch(): number {
  const top = (sql("SELECT max(id) AS m FROM history").get() as { m: number | null }).m ?? 0;
  if (top <= indexedUpTo()) return 0;
  return transaction(() => {
    const rows = sql("SELECT id, text FROM history WHERE id > ? ORDER BY id LIMIT ?").all(indexedUpTo(), INDEX_BATCH) as { id: number; text: string }[];
    if (rows.length === 0) return 0;
    const insert = sql("INSERT INTO history_fts (rowid, text) VALUES (?, ?)");
    for (const r of rows) insert.run(r.id, ftsIndexText(r.text));
    sql("INSERT OR REPLACE INTO index_state (name, upto) VALUES (?, ?)").run(INDEX_NAME, rows[rows.length - 1]!.id);
    return rows.length;
  });
}

/** 把还没进索引的句子补进去。搜索前都会调一次，平时只多一次查询 */
export function syncHistoryIndex(): number {
  let total = 0;
  for (let n = indexBatch(); n > 0; n = indexBatch()) total += n;
  return total;
}

/** 启动时用：分批补，每批之间让出事件循环。第一次升级要给全部老记录建索引，不能卡住服务 */
export async function buildHistoryIndex(): Promise<number> {
  let total = 0;
  for (let n = indexBatch(); n > 0; n = indexBatch()) {
    total += n;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return total;
}

export type SearchHit = { key: string; ts: number; user?: string; assistant?: string; score: number; rowId: number };

export type SearchOptions = {
  limit?: number;
  skip?: (key: string) => boolean;
  now?: number;
  /** 只要这个时间之后的（含） */
  after?: number;
  /** 只要这个时间之前的（不含） */
  before?: number;
  /** 同一段对话最多给几条，免得结果全挤在一段里 */
  perConv?: number;
};

/** FTS 交给打分的候选上限：最相关的这么多句，加最新的这么多句 */
const CANDIDATES = 2000;
const CANDIDATES_RECENT = 500;
/** 跳过的太多时最多往后翻这么多句，防止一个词命中全库时翻个没完 */
const SCAN_MAX = 100_000;
/** 兜底扫描最多扫最近这么多句 */
const SCAN_RECENT = 20_000;

/** 英文词中间的片段 FTS 查不到：最近的记录再扫一遍。中文已经按字索引，不用 */
function scanRecent(userId: string, query: string, timeSql: string, timeArgs: number[]): Row[] {
  const latin = needles(query).filter((n) => !isCjk(n));
  if (latin.length === 0) return [];
  const floor = (sql("SELECT id FROM history WHERE user_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?").get(userId, SCAN_RECENT - 1) as { id: number } | undefined)?.id ?? 0;
  return sql(
    `SELECT ${COLUMNS} FROM history WHERE user_id = ? AND id >= ?${timeSql} AND (${latin.map(() => "instr(lower(text), ?) > 0").join(" OR ")})`,
  ).all(userId, floor, ...timeArgs, ...latin) as Row[];
}

/**
 * 在这个用户的聊天记录里搜。结果是一问一答为单位，相关的在前（同样相关的新的在前）。
 * skip：不要的对话（被删掉的、当前这条）。
 */
export function searchHistory(userId: string, query: string, opts: SearchOptions = {}): SearchHit[] {
  checkUser(userId);
  const match = ftsMatch(query);
  if (!match && needles(query).length === 0) return [];
  const limit = opts.limit ?? 6;
  const time: string[] = [];
  const timeArgs: number[] = [];
  if (opts.after !== undefined) {
    time.push(" AND ts >= ?");
    timeArgs.push(opts.after);
  }
  if (opts.before !== undefined) {
    time.push(" AND ts < ?");
    timeArgs.push(opts.before);
  }
  const timeSql = time.join("");
  syncHistoryIndex();
  const byId = new Map<number, Row>();
  if (match) {
    // CROSS JOIN 固定先查索引：普通 JOIN 时规划器会选「扫这个人的全部记录，每行跑一次 FTS」，慢上千倍
    const from = `SELECT h.id, h.conv_key, h.agent, h.role, h.text, h.ts, h.msg_id FROM history_fts CROSS JOIN history h ON h.id = history_fts.rowid
       WHERE history_fts MATCH ? AND h.user_id = ?${timeSql.replace(/ ts /g, " h.ts ")}`;
    // 边读边过滤，名额只算 skip 留下的：不然常见词的候选可能全是要跳过的对话（按专家筛选时、当前对话很长时），结果就空了
    const take = (order: string, quota: number) => {
      let kept = 0;
      let seen = 0;
      for (const r of sql(`${from} ORDER BY ${order}`).iterate(match, userId, ...timeArgs) as Iterable<Row>) {
        if (++seen > SCAN_MAX || kept >= quota) break;
        if (opts.skip?.(r.conv_key)) continue;
        byId.set(r.id, r);
        kept++;
      }
    };
    // 最相关的一批，再加最新的一批：相关度差不多时新的该靠前，不能因为排不进前面就连候选都不是
    take("history_fts.rank", CANDIDATES);
    take("history_fts.rowid DESC", CANDIDATES_RECENT);
  }
  // 候选不够用才扫：常见词候选早就够了，不多花这一遍
  if (byId.size < Math.max(limit, 50)) for (const r of scanRecent(userId, query, timeSql, timeArgs)) byId.set(r.id, r);
  const now = opts.now ?? Date.now();
  const scored: { row: Row; score: number }[] = [];
  for (const row of byId.values()) {
    if (opts.skip?.(row.conv_key)) continue;
    const s = scoreText(row.text, query);
    if (s === 0) continue;
    // 新的稍微靠前：一个月内的最多加 30%
    const age = Math.max(0, now - row.ts) / (30 * 86400_000);
    scored.push({ row, score: s * (1 + 0.3 * Math.exp(-age)) });
  }
  scored.sort((a, b) => b.score - a.score || b.row.ts - a.row.ts || a.row.id - b.row.id);
  const out: SearchHit[] = [];
  const used = new Set<number>();
  const perConv = new Map<string, number>();
  // 配对在同一段对话里找：同时开着几段对话时，用户记录里紧挨着的下一句可能是别的对话的
  const next = sql(`SELECT ${COLUMNS} FROM history WHERE user_id = ? AND conv_key = ? AND id > ? ORDER BY id LIMIT 1`);
  const prev = sql(`SELECT ${COLUMNS} FROM history WHERE user_id = ? AND conv_key = ? AND id < ? ORDER BY id DESC LIMIT 1`);
  for (const { row, score } of scored) {
    if (out.length >= limit) break;
    if (used.has(row.id)) continue;
    if (opts.perConv && (perConv.get(row.conv_key) ?? 0) >= opts.perConv) continue;
    // 配上同一条对话里紧挨着的另一半：问配答，答配问
    const pair = (row.role === "u" ? next : prev).get(userId, row.conv_key, row.id) as Row | undefined;
    const partner = pair && pair.role !== row.role ? pair : undefined;
    used.add(row.id);
    if (partner) used.add(partner.id);
    perConv.set(row.conv_key, (perConv.get(row.conv_key) ?? 0) + 1);
    const user = row.role === "u" ? row : partner;
    const assistant = row.role === "a" ? row : partner;
    out.push({
      key: row.conv_key,
      ts: row.ts,
      ...(user ? { user: snippet(user.text, query, 300) } : {}),
      ...(assistant ? { assistant: snippet(assistant.text, query, 600) } : {}),
      score,
      rowId: row.id,
    });
  }
  return out;
}

/** 读一段对话的原话。around：以这句为中心；否则从 offset 开始（从头数）。total 是这段一共几句 */
export function readConversationRecords(
  userId: string,
  key: string,
  opts: { around?: number; offset?: number; limit?: number } = {},
): { rows: (HistoryRecord & { rowId: number })[]; total: number; offset: number } {
  checkUser(userId);
  const limit = Math.max(1, Math.min(100, Math.round(Number(opts.limit ?? 20)) || 20));
  const total = (sql("SELECT count(*) AS n FROM history WHERE user_id = ? AND conv_key = ?").get(userId, key) as { n: number }).n;
  let offset = Math.max(0, Math.round(Number(opts.offset ?? 0)) || 0);
  if (opts.around !== undefined && Number.isFinite(opts.around)) {
    const before = (sql("SELECT count(*) AS n FROM history WHERE user_id = ? AND conv_key = ? AND id < ?").get(userId, key, opts.around) as { n: number }).n;
    offset = Math.max(0, before - Math.floor(limit / 2));
  }
  const rows = sql(`SELECT ${COLUMNS} FROM history WHERE user_id = ? AND conv_key = ? ORDER BY id LIMIT ? OFFSET ?`).all(userId, key, limit, offset) as Row[];
  return { rows: rows.map((r) => ({ ...toRecord(r), rowId: r.id })), total, offset };
}

/** 按顺序一批批读出全部记录（导出用），不用一次读进内存 */
export function* iterateRecords(userId: string, batch = 1000): Generator<HistoryRecord[]> {
  checkUser(userId);
  const stmt = sql(`SELECT ${COLUMNS} FROM history WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?`);
  let after = 0;
  for (;;) {
    const rows = stmt.all(userId, after, batch) as Row[];
    if (rows.length === 0) return;
    after = rows[rows.length - 1]!.id;
    yield rows.map(toRecord);
  }
}

// ---------- 搜索统计 ----------
//
// agent 搜了多少次、多少次没结果。用来判断关键词加摘要够不够用，要不要上语义检索。

export function recordSearch(userId: string, empty: boolean, day: string): void {
  checkUser(userId);
  sql(
    `INSERT INTO search_stats (user_id, day, searches, empty) VALUES (?, ?, 1, ?)
     ON CONFLICT (user_id, day) DO UPDATE SET searches = searches + 1, empty = empty + excluded.empty`,
  ).run(userId, day, empty ? 1 : 0);
}

export function searchStats(userId: string, sinceDay: string): { searches: number; empty: number } {
  checkUser(userId);
  const row = sql("SELECT coalesce(sum(searches), 0) AS s, coalesce(sum(empty), 0) AS e FROM search_stats WHERE user_id = ? AND day >= ?").get(userId, sinceDay) as { s: number; e: number };
  return { searches: row.s, empty: row.e };
}
