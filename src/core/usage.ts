// 每个 agent 会话累计消耗的 token（页面右上角「更多」里显示分布）。
//
// Claude 每轮结束报一次这个会话的累计值（恢复 / 分叉来的会话也接着原来的总数算）；Codex 每次模型请求报一次增量。
// 都按会话 id 记在这里：页面重新加载、服务重启后还在。
// 按 agent 会话算，不按对话：/new、恢复旧会话、切 agent 之后显示的都是现在这个会话的。
// Codex 升级前跑过的轮次没有记录，从升级后开始算。
//
// 另外按天记一本账（设置 →「用量」按日 / 月 / 年统计）：每次报上来的增量记到当天、
// 按「谁的对话 + 哪个 agent + 什么模型」分开。只从有这本账开始算，之前的用量没有日期，不补。
// 没报费用的（Codex）查的时候按模型单价估一个（见 pricing.ts）。
//
// 两本账都在数据库里（见 db.ts）：usage_sessions 一个会话一行，usage_daily 一天一人一 agent 一模型一行。
import { sql, transaction } from "./db.js";
import { estimateCost } from "./pricing.js";
import type { TokenUsage } from "./types.js";

export type UsageTotals = Required<Omit<TokenUsage, "costUsd">> & { costUsd?: number; at: number };

/** 一天里某个人用某个 agent 的合计 */
export type DailyTotals = Required<Omit<TokenUsage, "costUsd">> & { costUsd?: number };
/** 查询结果的一行。estimated：costUsd 是按单价估的，不是 agent 报的 */
export type DailyRow = DailyTotals & { day: string; owner?: string; agent: string; model?: string; estimated?: true };

type TotalsRow = { input: number; cache_read: number; cache_write: number; output: number; reasoning: number; cost_usd: number | null };

const TOTALS = "input, cache_read, cache_write, output, reasoning, cost_usd";

function fromRow<T extends TotalsRow>(r: T): DailyTotals {
  return {
    input: r.input,
    cacheRead: r.cache_read,
    cacheWrite: r.cache_write,
    output: r.output,
    reasoning: r.reasoning,
    ...(r.cost_usd ? { costUsd: r.cost_usd } : {}),
  };
}

/** 本地时间的 YYYY-MM-DD */
export function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
  transaction(() => {
    const t = usageOf(sessionId) ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, at: 0 };
    const delta = accumulate(t, usage, cumulative);
    t.at = Date.now();
    sql(`INSERT OR REPLACE INTO usage_sessions (session_id, ${TOTALS}, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      sessionId,
      t.input,
      t.cacheRead,
      t.cacheWrite,
      t.output,
      t.reasoning,
      t.costUsd ?? null,
      t.at,
    );
    if (by) addDaily(t.at, by, delta);
  });
}

/** 把这次报上来的加进会话的总数（就地改 t），返回比原来多了多少 */
function accumulate(t: UsageTotals, usage: TokenUsage, cumulative: boolean): DailyTotals {
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
  return delta;
}

function addDaily(at: number, by: { owner?: string; agent: string; model?: string }, delta: DailyTotals): void {
  if (!FIELDS.some((f) => delta[f] > 0) && !delta.costUsd) return;
  sql(
    `INSERT INTO usage_daily (day, owner, agent, model, ${TOTALS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (day, owner, agent, model) DO UPDATE SET
       input = input + excluded.input, cache_read = cache_read + excluded.cache_read,
       cache_write = cache_write + excluded.cache_write, output = output + excluded.output,
       reasoning = reasoning + excluded.reasoning,
       cost_usd = CASE WHEN excluded.cost_usd IS NULL THEN cost_usd ELSE coalesce(cost_usd, 0) + excluded.cost_usd END`,
  ).run(dayOf(at), by.owner ?? "", by.agent, by.model ?? "", delta.input, delta.cacheRead, delta.cacheWrite, delta.output, delta.reasoning, delta.costUsd ?? null);
}

/** 按天的账里 from ~ to（含两头，YYYY-MM-DD）的行；visible 按主人过滤 */
export function dailyUsage(from: string, to: string, visible?: (owner: string | undefined) => boolean): DailyRow[] {
  const found = sql(`SELECT day, owner, agent, model, ${TOTALS} FROM usage_daily WHERE day >= ? AND day <= ? ORDER BY day`).all(from, to) as (TotalsRow & {
    day: string;
    owner: string;
    agent: string;
    model: string;
  })[];
  const rows: DailyRow[] = [];
  for (const r of found) {
    const owner = r.owner || undefined;
    if (visible && !visible(owner)) continue;
    const row: DailyRow = { day: r.day, ...(owner ? { owner } : {}), agent: r.agent, ...(r.model ? { model: r.model } : {}), ...fromRow(r) };
    if (!row.costUsd) {
      const est = estimateCost(r.model, row);
      if (est) Object.assign(row, { costUsd: est, estimated: true });
    }
    rows.push(row);
  }
  return rows;
}

export function usageOf(sessionId: string | undefined): UsageTotals | undefined {
  if (!sessionId) return undefined;
  const r = sql(`SELECT ${TOTALS}, at FROM usage_sessions WHERE session_id = ?`).get(sessionId) as (TotalsRow & { at: number }) | undefined;
  return r ? { ...fromRow(r), at: r.at } : undefined;
}
