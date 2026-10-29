// 聊天记录索引：给「参考以前的聊天」（search_past_chats）和「聊完自动整理记忆」用。
//
// 每个用户一份，data/history/<用户 id>.jsonl，一行一句（用户说的 / agent 的最终回复）。
// 只收有主人的对话（见 personal.ts 的 memoryOwnerOf），按主人分开存 —— 搜索只在自己的里面搜。
// 来源两个：
//   - 实时：hub 的事件流（见 startHistoryCapture），从现在起说的话；
//   - 回填：第一次用时把已有对话从 agent 的记录里读一遍（见 memory-curator.ts），只做一次。
//
// 为什么不用 SQLite 全文索引：FTS5 的 trigram 分词搜不到两个字的中文词（「豆豆」），
// 个人的聊天量直接扫文件就够快（几万句也是毫秒级），也省得 MCP 子进程每次打实验性 API 的警告。
import fs from "node:fs";
import path from "node:path";
import { dataDir, readJson, writeJsonAtomic } from "../home.js";

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

const historyDir = path.join(dataDir, "history");
/** 一句话最多存这么多字：长篇代码、整页网页没必要全存 */
const TEXT_MAX = 4000;

function base(userId: string): string {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(userId)) throw new Error("用户 id 不合法");
  return path.join(historyDir, userId);
}

export function appendRecords(userId: string, records: HistoryRecord[]): void {
  if (records.length === 0) return;
  fs.mkdirSync(historyDir, { recursive: true, mode: 0o700 });
  const lines = records.map((r) => JSON.stringify({ ...r, t: r.t.slice(0, TEXT_MAX) })).join("\n");
  fs.appendFileSync(`${base(userId)}.jsonl`, `${lines}\n`, { mode: 0o600 });
}

export function readRecords(userId: string): HistoryRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(`${base(userId)}.jsonl`, "utf8");
  } catch {
    return [];
  }
  const out: HistoryRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as HistoryRecord;
      if (typeof r.k === "string" && typeof r.t === "string" && (r.r === "u" || r.r === "a")) out.push(r);
    } catch {
      // 写到一半被打断的行：跳过
    }
  }
  return out;
}

function rewriteRecords(userId: string, records: HistoryRecord[]): void {
  fs.mkdirSync(historyDir, { recursive: true, mode: 0o700 });
  const target = `${base(userId)}.jsonl`;
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, records.map((r) => JSON.stringify({ ...r, t: r.t.slice(0, TEXT_MAX) })).join("\n") + (records.length ? "\n" : ""), { mode: 0o600 });
  fs.renameSync(temporary, target);
}

export function removeHistoryRecord(userId: string, key: string, id: string): void {
  rewriteRecords(userId, readRecords(userId).filter((r) => r.k !== key || r.id !== id));
}

/** 回退后只保留当前对话剩下的内容，避免搜索再搜出已经移除的消息 */
export function replaceConversationRecords(userId: string, key: string, records: HistoryRecord[]): void {
  rewriteRecords(userId, [...readRecords(userId).filter((r) => r.k !== key), ...records]);
}

export function readMeta(userId: string): Meta {
  const m = readJson<Partial<Meta>>(`${base(userId)}.meta.json`, {});
  return { ...m, extracted: m.extracted && typeof m.extracted === "object" ? m.extracted : {} };
}

export function patchMeta(userId: string, patch: Partial<Meta>): void {
  writeMeta(userId, { ...readMeta(userId), ...patch });
}

export function writeMeta(userId: string, meta: Meta): void {
  fs.mkdirSync(historyDir, { recursive: true, mode: 0o700 });
  writeJsonAtomic(`${base(userId)}.meta.json`, meta);
}

export function markExtracted(userId: string, key: string, upTo: number): void {
  const meta = readMeta(userId);
  meta.extracted[key] = Math.max(meta.extracted[key] ?? 0, upTo);
  writeMeta(userId, meta);
}

/** 删用户时：整个删掉 */
export function purgeHistory(userId: string): void {
  fs.rmSync(`${base(userId)}.jsonl`, { force: true });
  fs.rmSync(`${base(userId)}.meta.json`, { force: true });
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
  const byKey = new Map<string, HistoryRecord[]>();
  for (const r of readRecords(userId)) {
    if (r.ts <= (meta.extracted[r.k] ?? 0)) continue;
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
  const records = readRecords(userId);
  const now = opts.now ?? Date.now();
  const scored: { i: number; score: number }[] = [];
  records.forEach((r, i) => {
    if (opts.skip?.(r.k)) return;
    const s = scoreText(r.t, query);
    if (s === 0) return;
    // 新的稍微靠前：一个月内的最多加 30%
    const age = Math.max(0, now - r.ts) / (30 * 86400_000);
    scored.push({ i, score: s * (1 + 0.3 * Math.exp(-age)) });
  });
  scored.sort((a, b) => b.score - a.score || records[b.i]!.ts - records[a.i]!.ts);
  const out: SearchHit[] = [];
  const used = new Set<number>();
  const limit = opts.limit ?? 6;
  for (const { i, score } of scored) {
    if (out.length >= limit) break;
    if (used.has(i)) continue;
    const r = records[i]!;
    // 配上同一条对话里紧挨着的另一半：问配答，答配问
    const pairIndex = r.r === "u" ? i + 1 : i - 1;
    const pair = records[pairIndex];
    const partner = pair && pair.k === r.k && pair.r !== r.r ? pair : undefined;
    used.add(i);
    if (partner) used.add(pairIndex);
    const user = r.r === "u" ? r : partner;
    const assistant = r.r === "a" ? r : partner;
    out.push({
      key: r.k,
      ts: r.ts,
      ...(user ? { user: snippet(user.t, query, 300) } : {}),
      ...(assistant ? { assistant: snippet(assistant.t, query, 600) } : {}),
      score,
    });
  }
  return out;
}
