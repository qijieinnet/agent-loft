// 每个 agent 会话累计消耗的 token（页面右上角「更多」里显示分布）。
//
// Claude 每轮结束报一次这个会话的累计值（恢复 / 分叉来的会话也接着原来的总数算）；Codex 每次模型请求报一次增量。
// 都按会话 id 记在这里：页面重新加载、服务重启后还在。
// 按 agent 会话算，不按对话：/new、恢复旧会话、切 agent 之后显示的都是现在这个会话的。
// Codex 升级前跑过的轮次没有记录，从升级后开始算。
//
// 另外按天记一本账（usage-daily.json，设置 →「用量」按日 / 月 / 年统计）：每次报上来的增量记到当天、
// 按「谁的对话 + 哪个 agent + 什么模型」分开。只从有这本账开始算，之前的用量没有日期，不补。
// 没报费用的（Codex）查的时候按模型单价估一个（见 pricing.ts）。
import path from "node:path";
import { dataDir, readJson, writeJsonAtomic } from "../home.js";
import { estimateCost } from "./pricing.js";
import type { TokenUsage } from "./types.js";

export type UsageTotals = Required<Omit<TokenUsage, "costUsd">> & { costUsd?: number; at: number };
type Store = Record<string, UsageTotals>;

/** 一天里某个人用某个 agent 的合计 */
export type DailyTotals = Required<Omit<TokenUsage, "costUsd">> & { costUsd?: number };
/** 按天的账：日期（服务器本地时间 YYYY-MM-DD）→「owner\tagent\tmodel」→ 合计。没有主人、不知道模型的是空串 */
type Ledger = Record<string, Record<string, DailyTotals>>;
/** 查询结果的一行。estimated：costUsd 是按单价估的，不是 agent 报的 */
export type DailyRow = DailyTotals & { day: string; owner?: string; agent: string; model?: string; estimated?: true };

const FILE = () => path.join(dataDir, "usage.json");
const DAILY_FILE = () => path.join(dataDir, "usage-daily.json");
const MAX_SESSIONS = 1000;
/** 按天的账留多久（天） */
const MAX_DAYS = 3 * 366;

let store: Store | null = null;
let ledger: Ledger | null = null;
let timer: NodeJS.Timeout | null = null;

function load(): Store {
  return (store ??= readJson<Store>(FILE(), {}));
}

function loadLedger(): Ledger {
  return (ledger ??= readJson<Ledger>(DAILY_FILE(), {}));
}

function write(): void {
  const s = load();
  // 只留最近用过的会话
  const keys = Object.keys(s).sort((a, b) => s[b]!.at - s[a]!.at);
  for (const k of keys.slice(MAX_SESSIONS)) delete s[k];
  writeJsonAtomic(FILE(), s);
  const l = loadLedger();
  const days = Object.keys(l).sort();
  for (const d of days.slice(0, Math.max(0, days.length - MAX_DAYS))) delete l[d];
  writeJsonAtomic(DAILY_FILE(), l);
}

/** 本地时间的 YYYY-MM-DD */
export function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function persistSoon(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    write();
  }, 1000);
  timer.unref();
}

/** 退出前把还没写的落盘 */
export function flushUsage(): void {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
  write();
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

const FIELDS = ["input", "cacheRead", "cacheWrite", "output", "reasoning"] as const;

/**
 * cumulative：报的是累计值，每项取较大的（累计值只增不减；恢复的会话万一没从原来的总数接着算，
 * 宁可先少算，也不把之前的再加一遍）。否则是增量，加上去。
 * by：这次用量算谁的、哪个 agent 的（记进按天的账；不给就只记会话的）
 */
export function recordUsage(
  sessionId: string | undefined,
  usage: TokenUsage,
  cumulative = false,
  by?: { owner?: string; agent: string; model?: string },
): void {
  if (!sessionId) return;
  const s = load();
  const t = (s[sessionId] ??= { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, at: 0 });
  const delta: DailyTotals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  for (const f of FIELDS) {
    const next = cumulative ? Math.max(t[f], num(usage[f])) : t[f] + num(usage[f]);
    delta[f] = next - t[f];
    t[f] = next;
  }
  const cost = num(usage.costUsd);
  if (cost) {
    const next = cumulative ? Math.max(t.costUsd ?? 0, cost) : (t.costUsd ?? 0) + cost;
    if (next > (t.costUsd ?? 0)) delta.costUsd = next - (t.costUsd ?? 0);
    t.costUsd = next;
  }
  t.at = Date.now();
  if (by) addDaily(t.at, by, delta);
  persistSoon();
}

function addDaily(at: number, by: { owner?: string; agent: string; model?: string }, delta: DailyTotals): void {
  if (!FIELDS.some((f) => delta[f] > 0) && !delta.costUsd) return;
  const day = (loadLedger()[dayOf(at)] ??= {});
  const d = (day[`${by.owner ?? ""}\t${by.agent}\t${by.model ?? ""}`] ??= { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 });
  for (const f of FIELDS) d[f] += delta[f];
  if (delta.costUsd) d.costUsd = (d.costUsd ?? 0) + delta.costUsd;
}

/** 按天的账里 from ~ to（含两头，YYYY-MM-DD）的行；visible 按主人过滤 */
export function dailyUsage(from: string, to: string, visible?: (owner: string | undefined) => boolean): DailyRow[] {
  const rows: DailyRow[] = [];
  for (const [day, buckets] of Object.entries(loadLedger())) {
    if (day < from || day > to) continue;
    for (const [k, v] of Object.entries(buckets)) {
      const [o = "", agent = "", model = ""] = k.split("\t");
      const owner = o || undefined;
      if (visible && !visible(owner)) continue;
      const row: DailyRow = { day, ...(owner ? { owner } : {}), agent, ...(model ? { model } : {}), ...v };
      if (!row.costUsd) {
        const est = estimateCost(model, row);
        if (est) Object.assign(row, { costUsd: est, estimated: true });
      }
      rows.push(row);
    }
  }
  return rows.sort((a, b) => a.day.localeCompare(b.day));
}

export function usageOf(sessionId: string | undefined): UsageTotals | undefined {
  return sessionId ? load()[sessionId] : undefined;
}
