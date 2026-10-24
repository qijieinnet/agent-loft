// 每个 agent 会话累计消耗的 token（页面右上角「更多」里显示分布）。
//
// Claude 每轮结束报一次这个会话的累计值（恢复 / 分叉来的会话也接着原来的总数算）；Codex 每次模型请求报一次增量。
// 都按会话 id 记在这里：页面重新加载、服务重启后还在。
// 按 agent 会话算，不按对话：/new、恢复旧会话、切 agent 之后显示的都是现在这个会话的。
// Codex 升级前跑过的轮次没有记录，从升级后开始算。
import path from "node:path";
import { dataDir, readJson, writeJsonAtomic } from "../home.js";
import type { TokenUsage } from "./types.js";

export type UsageTotals = Required<Omit<TokenUsage, "costUsd">> & { costUsd?: number; at: number };
type Store = Record<string, UsageTotals>;

const FILE = () => path.join(dataDir, "usage.json");
const MAX_SESSIONS = 1000;

let store: Store | null = null;
let timer: NodeJS.Timeout | null = null;

function load(): Store {
  return (store ??= readJson<Store>(FILE(), {}));
}

function write(): void {
  const s = load();
  // 只留最近用过的会话
  const keys = Object.keys(s).sort((a, b) => s[b]!.at - s[a]!.at);
  for (const k of keys.slice(MAX_SESSIONS)) delete s[k];
  writeJsonAtomic(FILE(), s);
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
 * 宁可先少算，也不把之前的再加一遍）。否则是增量，加上去
 */
export function recordUsage(sessionId: string | undefined, usage: TokenUsage, cumulative = false): void {
  if (!sessionId) return;
  const s = load();
  const t = (s[sessionId] ??= { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, at: 0 });
  for (const f of FIELDS) t[f] = cumulative ? Math.max(t[f], num(usage[f])) : t[f] + num(usage[f]);
  const cost = num(usage.costUsd);
  if (cost) t.costUsd = cumulative ? Math.max(t.costUsd ?? 0, cost) : (t.costUsd ?? 0) + cost;
  t.at = Date.now();
  persistSoon();
}

export function usageOf(sessionId: string | undefined): UsageTotals | undefined {
  return sessionId ? load()[sessionId] : undefined;
}
