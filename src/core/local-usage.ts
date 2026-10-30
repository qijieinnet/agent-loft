// 服务端所在机器上直接用的 Claude Code、Codex（各自的桌面端、命令行）的用量，通过 /api/usage 给网页和桌面端的用量汇总用。
//
// 不经过 agent-loft，只能读它们自己落盘的会话记录：
// - Claude Code（命令行和 Claude 桌面端里的 Code 都写这里）：~/.claude/projects/**/*.jsonl，每条 assistant
//   消息带 usage。同一条消息按内容块拆成好几行、恢复 / 分叉的会话还会把旧消息抄进新文件，按 message.id + requestId 去重。
//   entrypoint 区分来源：claude-desktop 是桌面端，cli 是命令行，sdk-ts 是 Agent SDK（agent-loft 就是用它跑的）。
// - Codex：~/.codex/sessions/**/*.jsonl（和 archived_sessions），每次模型请求一条 token_count，带这次的
//   last_token_usage 和整条会话的累计 total。第一行 session_meta 的 originator 区分来源，agent-loft 跑的是 "agent-loft"。
// agent-loft 自己跑的会话已经记在服务器的账里，这里跳过，免得算两遍（别的用 Agent SDK 的程序也一起跳过了）。
//
// 新版 Claude Code 不再记费用，金额都按模型单价估（Claude 用内置快照，OpenAI 共用 pricing.ts 每天更新的价格表）。解析过的文件按 mtime + 大小缓存在内存里，没变的不再读。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { priceOf as openaiPriceOf } from "./pricing.js";
import { dayOf, type DailyRow } from "./usage.js";

type Source = "desktop" | "cli" | "other";
type Agent = "claude" | "codex";
type UsageEvent = [key: string, at: number, source: Source, model: string, input: number, cacheRead: number,
  write5m: number, write1h: number, output: number, reasoning: number, fast: number];
type Price = [number, number | null, number, ...number[]];
export type LocalUsageRow = DailyRow & { source: Source };
export type UsageRoots = { claude: string[]; codex: string[] };

const CLAUDE_PRICES: Record<string, Price> = JSON.parse(fs.readFileSync(new URL("./claude-model-prices.json", import.meta.url), "utf8"));
/** 缓存写入相对输入单价的倍数：5 分钟 1.25 倍，1 小时 2 倍 */
const WRITE_5M = 1.25;
const WRITE_1H = 2;
/** 快速模式按两倍价 */
const FAST = 2;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** Claude 的 entrypoint → 来源；null 是 agent-loft（Agent SDK）跑的，跳过 */
export function claudeSource(entrypoint: string | undefined): Source | null {
  if (entrypoint === "sdk-ts") return null;
  if (entrypoint === "claude-desktop") return "desktop";
  // 老版本没有 entrypoint，那时只有命令行
  if (!entrypoint || entrypoint === "cli") return "cli";
  return "other";
}

/** Codex 的 originator → 来源；null 是 agent-loft 跑的 */
export function codexSource(originator: string | undefined): Source | null {
  if (originator === "agent-loft") return null;
  if (/desktop/i.test(originator ?? "")) return "desktop";
  if (!originator || /^codex[_-](exec|cli|tui)/i.test(originator)) return "cli";
  return "other";
}

/**
 * 一个 Claude 会话文件里的用量。每条：
 * [去重键, 时间 ms, 来源, 模型, 输入, 缓存读取, 缓存写入（5 分钟）, 缓存写入（1 小时）, 输出, 推理, 快速模式]
 */
export function parseClaude(text: string): UsageEvent[] {
  const out: UsageEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"')) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const m = d?.message;
    const u = m?.usage;
    if (d.type !== "assistant" || !u || !m.id) continue;
    // 本地报错、被打断时的占位消息
    if (m.model === "<synthetic>") continue;
    const source = claudeSource(d.entrypoint);
    const at = Date.parse(d.timestamp);
    if (!source || !Number.isFinite(at)) continue;
    const write = num(u.cache_creation_input_tokens);
    const w1h = Math.min(write, num(u.cache_creation?.ephemeral_1h_input_tokens));
    out.push([
      `${m.id}\t${d.requestId ?? ""}`,
      at,
      source,
      m.model ?? "",
      num(u.input_tokens),
      num(u.cache_read_input_tokens),
      write - w1h,
      w1h,
      num(u.output_tokens),
      num(u.output_tokens_details?.thinking_tokens),
      u.speed === "fast" ? 1 : 0,
    ]);
  }
  return out;
}

/** 一个 Codex 会话文件里的用量，格式同 parseClaude（Codex 不分缓存时长，都记在 5 分钟那格） */
export function parseCodex(text: string): UsageEvent[] {
  const out: UsageEvent[] = [];
  let source: Source | null | undefined;
  let sessionId = "";
  let model = "";
  let seenTotal: number | undefined;
  for (const line of text.split("\n")) {
    const meta = source === undefined && line.includes('"session_meta"');
    if (!meta && !line.includes('"turn_context"') && !line.includes('"token_count"')) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const p = d?.payload;
    if (d.type === "session_meta") {
      source = codexSource(p?.originator);
      if (source === null) return [];
      if (typeof p?.id === "string") sessionId = p.id;
      continue;
    }
    if (d.type === "turn_context") {
      if (typeof p?.model === "string") model = p.model;
      continue;
    }
    if (p?.type !== "token_count") continue;
    const total = p.info?.total_token_usage?.total_tokens;
    const l = p.info?.last_token_usage;
    // 同一次请求会报好几遍（累计值没变），只认第一遍
    if (!l || typeof total !== "number" || total === seenTotal) continue;
    seenTotal = total;
    const at = Date.parse(d.timestamp);
    if (!Number.isFinite(at)) continue;
    // OpenAI 的 input_tokens 含命中缓存的部分，拆出来（和 src/agents/codex/session.ts 一样）
    const cached = num(l.cached_input_tokens);
    const written = num(l.cache_write_input_tokens);
    out.push([
      `${sessionId}\t${d.timestamp}\t${total}`,
      at,
      source ?? "cli",
      model,
      Math.max(0, num(l.input_tokens) - cached - written),
      cached,
      written,
      0,
      num(l.output_tokens),
      num(l.reasoning_output_tokens),
      0,
    ]);
  }
  return out;
}

/** 模型的单价（美元 / 百万 token）：[输入, 缓存读取（null 按输入算）, 输出, 长提示词门槛?, 输入, 缓存读取, 输出]。认不出返回 undefined */
export function priceOf(agent: Agent, model: string): Price | undefined {
  if (!model) return undefined;
  if (agent === "claude") {
    // claude-opus-5-5[1m]、claude-haiku-4-5-20251001、us.anthropic.claude-…-v1:0 都认
    const base = model
      .toLowerCase()
      .replace(/\[.*\]$/, "")
      .replace(/^(\w+\.)?anthropic\./, "")
      .replace(/-v\d+:\d+$/, "")
      .replace(/[-@]\d{8}$/, "");
    return CLAUDE_PRICES[base];
  }
  return openaiPriceOf(model);
}

/** 一条用量的金额（美元），认不出模型是 0 */
export function costOf(agent: Agent, e: UsageEvent): number {
  const p = priceOf(agent, e[3]);
  if (!p) return 0;
  const [, , , , input, cacheRead, w5, w1h, output, , fast] = e;
  // Haiku 5.5 这类：一次请求的提示词超过门槛就整次按另一档算
  const long = p[3] !== undefined && input + cacheRead + w5 + w1h > p[3];
  const [pi, pr, po] = long ? [p[4]!, p[5]!, p[6]!] : p;
  const cost = input * pi + cacheRead * (pr ?? pi) + w5 * pi * (agent === "claude" ? WRITE_5M : 1) + w1h * pi * WRITE_1H + output * po;
  return (cost / 1e6) * (fast ? FAST : 1);
}

/** 会话记录在哪：尊重 CLAUDE_CONFIG_DIR / CODEX_HOME，默认在家目录下 */
export function usageRoots(): UsageRoots {
  const home = os.homedir();
  const claude = [...new Set([process.env.CLAUDE_CONFIG_DIR, path.join(home, ".claude")].filter((d): d is string => !!d))];
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  return {
    claude: claude.map((d) => path.join(d, "projects")),
    codex: [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")],
  };
}

async function listJsonl(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => path.join(e.parentPath, e.name));
}

/** 路径 → { mtimeMs, size, events } */
const cache = new Map<string, { mtimeMs: number; size: number; events: UsageEvent[] }>();
/** 同时只扫一遍，后来的排队等 */
let queue: Promise<unknown> = Promise.resolve();

async function eventsOf(file: string, parse: (text: string) => UsageEvent[], sinceMs: number): Promise<UsageEvent[]> {
  let st;
  try {
    st = await fs.promises.stat(file);
  } catch {
    cache.delete(file);
    return [];
  }
  // 最后改动在这段时间之前的文件不会有这段时间的用量
  if (st.mtimeMs < sinceMs) return [];
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.events;
  let events: UsageEvent[] = [];
  try {
    events = parse(await fs.promises.readFile(file, "utf8"));
  } catch {
    // 读的时候正好被删了之类，跳过
  }
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, events });
  // 一个文件一个文件来，别把主进程卡住
  await new Promise((r) => setImmediate(r));
  return events;
}

/**
 * from ~ to（含两头，YYYY-MM-DD，本地时间）的用量，按「日期 + agent + 来源 + 模型」合计，
 * 格式和服务端 /api/usage 的 rows 一样，多一个 source（desktop / cli / other）。金额都是估算的
 */
export function localUsage(from: string, to: string, dirs = usageRoots()): Promise<LocalUsageRow[]> {
  const run = queue.then(() => scan(from, to, dirs));
  queue = run.catch(() => {});
  return run;
}

async function scan(from: string, to: string, dirs: UsageRoots): Promise<LocalUsageRow[]> {
  // 往前多留一天，时区、跨零点的会话不至于漏
  const sinceMs = new Date(`${from}T00:00:00`).getTime() - 86400_000;
  const groups = new Map<string, LocalUsageRow>();
  for (const [agent, parse, list] of [
    ["claude", parseClaude, dirs.claude],
    ["codex", parseCodex, dirs.codex],
  ] as const) {
    /** 去重键 → 这条用量（重复的取输出多的那条，流式中途写下的那行输出可能还没写全） */
    const seen = new Map<string, UsageEvent>();
    for (const dir of list) {
      for (const file of await listJsonl(dir)) {
        for (const e of await eventsOf(file, parse, sinceMs)) {
          const day = dayOf(e[1]);
          if (day < from || day > to) continue;
          const prev = seen.get(e[0]);
          if (!prev || e[8] > prev[8]) seen.set(e[0], e);
        }
      }
    }
    for (const e of seen.values()) {
      const day = dayOf(e[1]);
      const key = `${day}\t${e[2]}\t${e[3]}`;
      let g = groups.get(`${agent}\t${key}`);
      if (!g) {
        g = { day, agent, source: e[2], ...(e[3] ? { model: e[3] } : {}), input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0 };
        groups.set(`${agent}\t${key}`, g);
      }
      g.input += e[4];
      g.cacheRead += e[5];
      g.cacheWrite += e[6] + e[7];
      g.output += e[8];
      g.reasoning = (g.reasoning ?? 0) + e[9];
      g.costUsd = (g.costUsd ?? 0) + costOf(agent, e);
    }
  }
  return [...groups.values()]
    .map(({ costUsd, ...g }) => (costUsd ? { ...g, costUsd, estimated: true as const } : g))
    .sort((a, b) => a.day.localeCompare(b.day));
}
