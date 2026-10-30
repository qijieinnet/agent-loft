// 聊天记录索引：给「参考以前的聊天」（search_past_chats）和「聊完自动整理记忆」用。
//
// 存在数据库的 history 表里（见 db.ts），一行一句（用户说的 / agent 的最终回复），按用户分开。
// 只收有主人的对话（见 personal.ts 的 memoryOwnerOf），按主人分开存 —— 搜索只在自己的里面搜。
// 来源两个：
//   - 实时：hub 的事件流（见 startHistoryCapture），从现在起说的话；
//   - 回填：第一次用时把已有对话从 agent 的记录里读一遍（见 memory-curator.ts），只做一次。
//
// 搜索不用 SQLite 的 FTS5：trigram 分词搜不到两个字的中文词（「豆豆」）。先用 instr 在库里筛出
// 含有某个词的句子，再在这里按命中情况打分，不用把整个人的记录都读出来。
import { sql, transaction } from "./db.js";

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
};

/** 一句话最多存这么多字：长篇代码、整页网页没必要全存 */
const TEXT_MAX = 4000;

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
  for (const r of records) insert.run(userId, r.k, r.a, r.r, r.t.slice(0, TEXT_MAX), r.ts, r.id ?? null);
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
  sql("DELETE FROM history WHERE user_id = ? AND conv_key = ? AND msg_id = ?").run(userId, key, id);
}

/** 回退后只保留当前对话剩下的内容，避免搜索再搜出已经移除的消息 */
export function replaceConversationRecords(userId: string, key: string, records: HistoryRecord[]): void {
  checkUser(userId);
  transaction(() => {
    sql("DELETE FROM history WHERE user_id = ? AND conv_key = ?").run(userId, key);
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

export function patchMeta(userId: string, patch: Partial<Meta>): void {
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
    sql("DELETE FROM history WHERE user_id = ?").run(userId);
    sql("DELETE FROM history_meta WHERE user_id = ?").run(userId);
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
  // 每条对话整理到的时刻在 meta 里，交给 json_each 在库里比，只取还没整理过的
  const rows = sql(
    `SELECT h.id, h.conv_key, h.agent, h.role, h.text, h.ts, h.msg_id FROM history h LEFT JOIN json_each(?) e ON e.key = h.conv_key
     WHERE h.user_id = ? AND h.ts > coalesce(e.value, 0) ORDER BY h.id`,
  ).all(JSON.stringify(meta.extracted), userId) as Row[];
  const byKey = new Map<string, HistoryRecord[]>();
  for (const r of rows.map(toRecord)) {
    let list = byKey.get(r.k);
    if (!list) byKey.set(r.k, (list = []));
    list.push(r);
  }
  const out: { key: string; records: HistoryRecord[]; last: number }[] = [];
  for (const [key, records] of byKey) {
    const last = Math.max(...records.map((r) => r.ts));
    if (now - last >= idleMs) out.push({ key, records, last });
  }
  return out;
}

// ---------- 搜索 ----------

/** 把查询拆成词：按空白和标点切开。中文不切词，长的中文词另外拆成两字一组做模糊匹配 */
function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,，。.!！?？、;；:："'“”‘’()（）[\]【】<>《》/\\|]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

const isCjk = (s: string) => /[㐀-鿿]/.test(s);

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 2 <= s.length; i++) out.push(s.slice(i, i + 2));
  return out;
}

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

export type SearchHit = { key: string; ts: number; user?: string; assistant?: string; score: number };

/**
 * 在这个用户的聊天记录里搜。结果是一问一答为单位，相关的在前（同样相关的新的在前）。
 * skip：不要的对话（被删掉的、当前这条）。
 */
export function searchHistory(
  userId: string,
  query: string,
  opts: { limit?: number; skip?: (key: string) => boolean; now?: number } = {},
): SearchHit[] {
  checkUser(userId);
  // 能得分的句子至少含有一个词（长的中文词是至少含有它的一个两字组合），先在库里筛出来
  const needles = [...new Set(terms(query).flatMap((t) => (isCjk(t) && t.length >= 4 ? [t, ...bigrams(t)] : [t])))].slice(0, 200);
  if (needles.length === 0) return [];
  const rows = sql(
    `SELECT ${COLUMNS} FROM history WHERE user_id = ? AND (${needles.map(() => "instr(lower(text), ?) > 0").join(" OR ")})`,
  ).all(userId, ...needles) as Row[];
  const now = opts.now ?? Date.now();
  const scored: { row: Row; score: number }[] = [];
  for (const row of rows) {
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
  const limit = opts.limit ?? 6;
  const next = sql(`SELECT ${COLUMNS} FROM history WHERE user_id = ? AND id > ? ORDER BY id LIMIT 1`);
  const prev = sql(`SELECT ${COLUMNS} FROM history WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT 1`);
  for (const { row, score } of scored) {
    if (out.length >= limit) break;
    if (used.has(row.id)) continue;
    // 配上同一条对话里紧挨着的另一半：问配答，答配问
    const pair = (row.role === "u" ? next : prev).get(userId, row.id) as Row | undefined;
    const partner = pair && pair.conv_key === row.conv_key && pair.role !== row.role ? pair : undefined;
    used.add(row.id);
    if (partner) used.add(partner.id);
    const user = row.role === "u" ? row : partner;
    const assistant = row.role === "a" ? row : partner;
    out.push({
      key: row.conv_key,
      ts: row.ts,
      ...(user ? { user: snippet(user.text, query, 300) } : {}),
      ...(assistant ? { assistant: snippet(assistant.text, query, 600) } : {}),
      score,
    });
  }
  return out;
}
