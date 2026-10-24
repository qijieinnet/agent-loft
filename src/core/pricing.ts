// 按单价估算没报费用的 agent（Codex）的金额：Token × 单价。
//
// 单价来自 LiteLLM 公开维护的价格表（model_prices_and_context_window.json），只取 OpenAI 的对话模型。
// 内置一份快照（model-prices.json，[输入, 缓存读取, 输出]，美元 / 百万 token），连得上 GitHub 时
// 每天更新一次存到 data/model-prices.json，连不上就一直用快照。
// 只按基础单价算：长上下文加价、priority / flex 档位都不管，所以是估算。
import fs from "node:fs";
import path from "node:path";
import { dataDir, readJson, writeJsonAtomic } from "../home.js";
import type { TokenUsage } from "./types.js";

/** [输入, 缓存读取（null 表示按输入算）, 输出]，美元 / 百万 token */
type Price = [number, number | null, number];
type Table = Record<string, Price>;
type Cache = { at: number; prices: Table };

const SOURCE = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const CACHE_FILE = () => path.join(dataDir, "model-prices.json");
const MAX_AGE = 24 * 3600_000;
/** 拉失败了隔多久再试 */
const RETRY = 3600_000;

const snapshot: Table = JSON.parse(fs.readFileSync(new URL("./model-prices.json", import.meta.url), "utf8"));
let cache: Cache | null = null;
let fetching = false;
let lastTry = 0;

function loadCache(): Cache {
  return (cache ??= readJson<Cache>(CACHE_FILE(), { at: 0, prices: {} }));
}

/** 从 LiteLLM 的整张表里挑出 OpenAI 对话模型，换成每百万 token 的价格 */
export function pickOpenAiPrices(raw: Record<string, unknown>): Table {
  const perM = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v * 1e12) / 1e6 : null;
  const out: Table = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.litellm_provider !== "openai" || (e.mode !== "chat" && e.mode !== "responses")) continue;
    const input = perM(e.input_cost_per_token);
    const output = perM(e.output_cost_per_token);
    if (input === null || output === null) continue;
    out[name] = [input, perM(e.cache_read_input_token_cost), output];
  }
  return out;
}

async function refresh(): Promise<void> {
  fetching = true;
  lastTry = Date.now();
  try {
    const res = await fetch(SOURCE, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const prices = pickOpenAiPrices((await res.json()) as Record<string, unknown>);
    if (Object.keys(prices).length === 0) throw new Error("价格表里没有 OpenAI 模型");
    cache = { at: Date.now(), prices };
    writeJsonAtomic(CACHE_FILE(), cache);
  } catch (err) {
    console.warn("[pricing] 更新模型单价失败，先用内置的:", err instanceof Error ? err.message : err);
  } finally {
    fetching = false;
  }
}

/** 过期了就在后台更新一次（不等它，这次先用手上的） */
function refreshIfStale(): void {
  // 跑测试时不联网
  if (process.env.NODE_TEST_CONTEXT) return;
  if (fetching || Date.now() - loadCache().at < MAX_AGE || Date.now() - lastTry < RETRY) return;
  void refresh();
}

/** 模型的单价。认不出来返回 undefined。名字带 openai/ 前缀、日期后缀（-2026-03-05）的也认 */
export function priceOf(model: string | undefined): Price | undefined {
  if (!model) return undefined;
  refreshIfStale();
  const table = loadCache().prices;
  const base = model.replace(/^openai\//, "");
  for (const name of [base, base.replace(/-\d{4}-\d{2}-\d{2}$/, "")]) {
    const p = table[name] ?? snapshot[name];
    if (p) return p;
  }
  return undefined;
}

/** 按单价估算的金额（美元）。output 已经含推理，不再单算 reasoning；认不出模型返回 undefined */
export function estimateCost(model: string | undefined, usage: TokenUsage): number | undefined {
  const p = priceOf(model);
  if (!p) return undefined;
  const [input, cacheRead, output] = p;
  return (usage.input * input + usage.cacheRead * (cacheRead ?? input) + usage.cacheWrite * input + usage.output * output) / 1e6;
}
