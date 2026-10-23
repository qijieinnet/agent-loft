// 聊天记录索引的录入，以及自动整理记忆。
//
// 三件事：
//   1. 录入（startHistoryCapture）：hub 的事件流里，有主人的对话的每句话（用户说的、agent 的最终回复）
//      记进主人的聊天记录索引（chat-history.ts）。主人关了记忆就不记。
//   2. 回填（backfill）：第一次用时，把已有对话从 agent 的记录里读一遍进索引，每人只做一次。
//      回填进来的只供搜索，不拿去整理 —— 一次整理几百段旧对话太费额度。
//   3. 整理：把上次整理之后新说的话交给模型（用户在记忆设置里选 agent 和模型，默认最省的），
//      让它对照现有记忆给出新增 / 更新 / 删除。用户自己加的条目它动不了。什么时候整理也由用户定
//      （CurateSettings.when）：每段聊完后 / 每天一次把当天的合起来 / 只在点「现在整理」时 / 不整理。
//      整理哪些也由用户定（CurateSettings.scope）：全部 / 只整理聊天模式的 / 只整理工作模式的。
import { hub } from "./hub.js";
import {
  appendRecords,
  markExtracted,
  patchMeta,
  pendingConversations,
  readMeta,
  readRecords,
  writeMeta,
  type CurationLog,
  type HistoryRecord,
} from "./chat-history.js";
import {
  addMemoryEntry,
  localDate,
  MEMORY_LIMITS,
  readMemory,
  removeMemoryItem,
  updateMemoryItem,
  type CurateScope,
  type CurateSettings,
  type UserMemory,
} from "./memory.js";
import { memoryOwnerOf } from "./personal.js";
import { listConversations } from "./store.js";
import { activeUsers } from "./users.js";
import type { AgentDriver } from "./types.js";
import { agentAvailability } from "../agents/health.js";

/** 「每天一次」和「现在整理」也不碰还在聊的：最后一句过去这么久才算聊完 */
const SETTLE_MS = 10 * 60_000;
const SWEEP_MS = 5 * 60_000;
/** 一次调用交给模型的对话最多这么多字；当天聊得多就分几次 */
const INPUT_MAX = 16_000;
/** 一段对话里用户的话加起来太短（「好」「谢谢」）就不值得整理 */
const MIN_USER_CHARS = 15;
/** 一次调用最多改这么多 */
const MAX_CHANGES = 5;

// ---------- 录入 ----------

let capturing = false;

/** 记不记这个用户的聊天：开着记忆，并且整理和「参考以前的聊天」至少开了一个 */
function wants(memory: UserMemory): boolean {
  return memory.enabled && (memory.curate.when !== "off" || memory.chatHistory);
}

export function startHistoryCapture(): void {
  if (capturing) return;
  capturing = true;
  hub.on("event", (env) => {
    const ev = env.ev;
    if (ev.type !== "user" && ev.type !== "result") return;
    try {
      const conv = hub.conversation(env.key);
      if (!conv || conv.hidden) return;
      const owner = memoryOwnerOf(conv);
      if (!owner || !wants(readMemory(owner))) return;
      const text =
        ev.type === "user"
          ? [ev.text, ev.attachments.length ? `（附件：${ev.attachments.join("、")}）` : ""].filter(Boolean).join("\n")
          : ev.text;
      if (!text.trim()) return;
      appendRecords(owner, [{ k: env.key, a: conv.agent, r: ev.type === "user" ? "u" : "a", t: text, ts: env.ts }]);
    } catch (err) {
      console.warn("[记忆] 记录聊天失败:", err instanceof Error ? err.message : err);
    }
  });
}

// ---------- 回填 ----------

const dedupKey = (r: Pick<HistoryRecord, "k" | "r" | "t">) => `${r.k}|${r.r}|${r.t.slice(0, 200)}`;

/** 把这个用户已有的对话读进索引。只读每条对话当前绑着的 agent 会话 */
export async function backfill(userId: string): Promise<number> {
  const existing = readRecords(userId);
  const seen = new Set(existing.map(dedupKey));
  const meta = readMeta(userId);
  // 每条对话里还没整理的实时录入最早是什么时候：回填的「整理到」标记不能越过它，否则那些话就被跳过了
  const firstPending = new Map<string, number>();
  for (const r of existing) {
    if (r.ts <= (meta.extracted[r.k] ?? 0)) continue;
    firstPending.set(r.k, Math.min(firstPending.get(r.k) ?? Infinity, r.ts));
  }
  const enabled = new Set(hub.enabledAgents().map((d) => d.id));
  let added = 0;
  for (const conv of listConversations()) {
    if (conv.hidden || memoryOwnerOf(conv) !== userId) continue;
    for (const [agent, binding] of Object.entries(conv.perAgent)) {
      const driver = hub.driver(agent);
      if (!binding.sessionId || !driver || !enabled.has(agent)) continue;
      let messages;
      try {
        messages = await withTimeout(driver.readHistory(binding.sessionId, conv.cwd), 30_000);
      } catch (err) {
        console.warn(`[记忆] 回填 ${conv.key} 失败:`, err instanceof Error ? err.message : err);
        continue;
      }
      // 没带时间的（少数），沿用前一句的时间，开头的用对话创建时间
      let prev = conv.createdAt;
      const records: HistoryRecord[] = messages
        .filter((m) => m.text.trim())
        .map((m) => {
          prev = m.ts ?? prev;
          return { k: conv.key, a: agent, r: m.role === "user" ? ("u" as const) : ("a" as const), t: m.text, ts: prev };
        })
        .filter((r) => !seen.has(dedupKey(r)));
      appendRecords(userId, records);
      added += records.length;
      // 回填的旧对话只供搜索，不整理
      const last = Math.min(Math.max(0, ...records.map((r) => r.ts)), (firstPending.get(conv.key) ?? Infinity) - 1);
      if (last > 0) meta.extracted[conv.key] = Math.max(meta.extracted[conv.key] ?? 0, last);
    }
  }
  meta.backfilled = true;
  writeMeta(userId, meta);
  if (added) console.log(`[记忆] 已把 ${added} 句以前的聊天收进 ${userId} 的聊天记录索引`);
  return added;
}

// ---------- 整理 ----------

export const CURATE_SYSTEM = [
  "你在帮一个 AI 助手整理它对用户的长期记忆。会给你：用户自己写的「关于我」、已有的记忆条目（带 id），以及用户最近的一段或几段对话。",
  "找出这些对话里值得长期记住的、关于用户本人的信息：身份和背景、长期的偏好和习惯、长期在做的项目、用的设备和环境、做过的重要决定、明确要求以后注意的事。",
  "",
  "规则：",
  "- 只记关于用户的、以后的对话还用得上的事。不记一次性的任务细节、临时的问题、闲聊、助手自己说的话。",
  "- 不记密码、密钥、验证码、证件号、详细住址、银行卡这类敏感信息。",
  "- 已有条目里有的不要重复；信息变了就 update 那条（给 id），过时的、被用户否定的、和别的条目重复的就 remove。",
  "- 标着「用户自己加的」的条目不要 update，也不要 remove。",
  "- 每条一句话，以「用户」开头，写清时间背景（比如「2026-10 起」），用中文。",
  "- 宁缺毋滥：没有值得记的就全部返回空数组。新增最多 3 条。",
].join("\n");

export const CURATE_SCHEMA = {
  type: "object",
  properties: {
    add: { type: "array", items: { type: "string" } },
    update: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, text: { type: "string" } },
        required: ["id", "text"],
        additionalProperties: false,
      },
    },
    remove: { type: "array", items: { type: "string" } },
  },
  required: ["add", "update", "remove"],
  additionalProperties: false,
};

export type Pending = { key: string; records: HistoryRecord[]; last: number };

/** 一段对话写成给模型看的文字。太长就只留最近的；助手的回复截短（要的是用户的事，不是回复内容） */
function conversationText(records: HistoryRecord[], budget: number): string[] {
  const lines: string[] = [];
  for (const r of [...records].reverse()) {
    const text = r.r === "a" && r.t.length > 600 ? `${r.t.slice(0, 600)}…` : r.t;
    const line = `${r.r === "u" ? "用户" : "助手"}：${text}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.unshift(line);
  }
  return lines;
}

const lengthOf = (records: HistoryRecord[]) => records.reduce((n, r) => n + Math.min(r.t.length, r.r === "a" ? 600 : r.t.length) + 4, 0);

/** 交给模型的那段话：现有记忆 + 一段或几段对话 */
export function curatePrompt(memory: UserMemory, groups: { title?: string; records: HistoryRecord[] }[]): string {
  const items = memory.items.map((i) => `- [${i.id}]${i.source === "user" ? "（用户自己加的）" : ""} ${i.text}`);
  const perGroup = Math.floor(INPUT_MAX / Math.max(1, groups.length));
  return [
    `今天是 ${localDate(Date.now())}。`,
    "",
    "## 关于我",
    memory.about.trim() || "（没写）",
    "",
    "## 已有的记忆",
    ...(items.length ? items : ["（还没有）"]),
    ...groups.flatMap((g) => ["", `## 对话${g.title ? `：${g.title}` : ""}`, ...conversationText(g.records, perGroup)]),
  ].join("\n");
}

/** 把要整理的对话分成几批，每批加起来不超过 INPUT_MAX（单段太长的自己一批，里面会截短） */
export function chunk(pendings: Pending[]): Pending[][] {
  const out: Pending[][] = [];
  let cur: Pending[] = [];
  let size = 0;
  for (const p of pendings) {
    const n = Math.min(lengthOf(p.records), INPUT_MAX);
    if (cur.length && size + n > INPUT_MAX) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(p);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

type Proposal = { add: string[]; update: { id: string; text: string }[]; remove: string[] };

function parseProposal(raw: unknown): Proposal {
  const o = (raw ?? {}) as Partial<Record<keyof Proposal, unknown>>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);
  const updates = Array.isArray(o.update)
    ? o.update.filter((u): u is { id: string; text: string } => !!u && typeof u.id === "string" && typeof u.text === "string" && !!u.text.trim())
    : [];
  return { add: strings(o.add), update: updates, remove: strings(o.remove) };
}

export type CurateResult = { added: string[]; updated: string[]; removed: string[] };

/** 按规则落实模型的提议：用户自己加的不动，总数有上限，单条出错不影响别的 */
export function applyProposal(userId: string, raw: unknown): CurateResult {
  const proposal = parseProposal(raw);
  const result: CurateResult = { added: [], updated: [], removed: [] };
  let budget = MAX_CHANGES;
  const mine = (id: string) => readMemory(userId).items.find((i) => i.id === id && i.source !== "user");
  for (const id of proposal.remove) {
    if (budget <= 0) break;
    const item = mine(id);
    if (!item) continue;
    removeMemoryItem(userId, id);
    result.removed.push(item.text);
    budget--;
  }
  for (const u of proposal.update) {
    if (budget <= 0) break;
    if (!mine(u.id)) continue;
    try {
      updateMemoryItem(userId, u.id, u.text.slice(0, MEMORY_LIMITS.item));
      result.updated.push(u.text);
      budget--;
    } catch {
      // 内容不合规（空、太长）：跳过这条
    }
  }
  for (const text of proposal.add.slice(0, 3)) {
    if (budget <= 0) break;
    try {
      const r = addMemoryEntry(userId, text.slice(0, MEMORY_LIMITS.item), "auto");
      // 和已有的重复了：只更新时间，不算新增
      if (!r.created) continue;
      result.added.push(text);
      // 满了挤掉了最旧的一条：也要告诉用户
      if (r.evicted) result.removed.push(r.evicted.text);
      budget--;
    } catch {
      // 全是用户自己加的满了、或者内容不合规：跳过
    }
  }
  return result;
}

function clip(t: string, n = 40): string {
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export function describeResult(r: CurateResult): string | undefined {
  const parts = [
    ...r.added.map((t) => `记住了「${clip(t)}」`),
    ...r.updated.map((t) => `更新为「${clip(t)}」`),
    ...(r.removed.length ? [`删掉了 ${r.removed.length} 条过时的`] : []),
  ];
  return parts.length ? `🧠 记忆已更新：${parts.join("；")}。（设置 → 记忆 里可以查看和修改）` : undefined;
}

/** 按用户的设置挑 agent。指定的那个用不了就是 undefined（不悄悄换成另一个，免得用到他没想用的额度） */
export function pickDriver(settings: Pick<CurateSettings, "agent">): AgentDriver | undefined {
  const usable = hub.enabledAgents().filter((d) => d.complete && agentAvailability(d.id as "claude" | "codex")?.available !== false);
  if (settings.agent !== "auto") return usable.find((d) => d.id === settings.agent);
  return usable.find((d) => d.id === "claude") ?? usable[0];
}

function modelLabel(driver: AgentDriver, model: string): string {
  return `${driver.label} · ${model || (driver.id === "claude" ? "Haiku" : "默认模型")}`;
}

/** 每个用户连续失败的次数：一直失败（额度用完之类）三次后放过这批，别每 5 分钟烧一次 */
const failures = new Map<string, number>();

export type BatchOutcome = CurationLog;

/**
 * 整理一批对话：太短的直接放过，其余分批交给模型，按批落实、按批记成整理过。
 * notify：改了什么在每段对话里说一声（「聊完后」模式；每天 / 手动整理只记在设置页）。
 */
export async function curateBatch(
  userId: string,
  pendings: Pending[],
  opts: { notify?: boolean; driver?: AgentDriver } = {},
): Promise<BatchOutcome> {
  const memory = readMemory(userId);
  const log: CurationLog = { at: Date.now(), conversations: 0, added: [], updated: [], removed: 0 };
  const worth: Pending[] = [];
  for (const p of pendings) {
    const userChars = p.records.filter((r) => r.r === "u").reduce((n, r) => n + r.t.length, 0);
    if (userChars < MIN_USER_CHARS) markExtracted(userId, p.key, p.last);
    else worth.push(p);
  }
  if (worth.length === 0) return log;
  const driver = opts.driver ?? pickDriver(memory.curate);
  if (!driver) {
    // 没有能用的 agent：留着，等它能用了再整理
    log.error = memory.curate.agent === "auto" ? "没有能用的 agent" : `${memory.curate.agent === "claude" ? "Claude" : "Codex"} 现在用不了（没启用、没装或没登录）`;
    patchMeta(userId, { lastCuration: log });
    return log;
  }
  log.by = modelLabel(driver, memory.curate.model);
  for (const batch of chunk(worth)) {
    let raw: unknown;
    try {
      raw = await driver.complete!({
        system: CURATE_SYSTEM,
        prompt: curatePrompt(readMemory(userId), batch.map((p) => ({ title: hub.conversation(p.key)?.title, records: p.records }))),
        schema: CURATE_SCHEMA,
        ...(memory.curate.model ? { model: memory.curate.model } : {}),
        timeoutMs: 120_000,
      });
    } catch (err) {
      const n = (failures.get(userId) ?? 0) + 1;
      failures.set(userId, n);
      log.error = err instanceof Error ? err.message : String(err);
      console.warn(`[记忆] 整理 ${userId} 的 ${batch.length} 段对话失败（第 ${n} 次）:`, log.error);
      if (n >= 3) {
        failures.delete(userId);
        for (const p of batch) markExtracted(userId, p.key, p.last);
      }
      continue;
    }
    failures.delete(userId);
    const result = applyProposal(userId, raw);
    for (const p of batch) markExtracted(userId, p.key, p.last);
    log.conversations += batch.length;
    log.added.push(...result.added);
    log.updated.push(...result.updated);
    log.removed += result.removed.length;
    const note = describeResult(result);
    if (note && opts.notify) for (const p of batch) hub.notice(p.key, note);
  }
  console.log(`[记忆] ${userId}：整理了 ${log.conversations} 段对话（${log.by}），+${log.added.length} ~${log.updated.length} -${log.removed}`);
  patchMeta(userId, { lastCuration: log });
  return log;
}

/** 这段对话在不在用户选的整理范围里（按现在的模式算，中途切过模式的整段归现在的） */
function inScope(conv: { mode?: "chat" }, scope: CurateScope): boolean {
  return scope === "all" || (scope === "chat") === (conv.mode === "chat");
}

/** 某个用户等着整理的对话。删掉的、不在整理范围里的直接记成整理过（之后改范围也不补整理）；正在回复的这次先不碰 */
function collect(userId: string, settleMs: number, now?: number): Pending[] {
  const scope = readMemory(userId).curate.scope;
  const out: Pending[] = [];
  for (const p of pendingConversations(userId, settleMs, now)) {
    const conv = hub.conversation(p.key);
    if (!conv || conv.hidden || !inScope(conv, scope)) {
      markExtracted(userId, p.key, p.last);
      continue;
    }
    if (!hub.isBusy(p.key)) out.push(p);
  }
  return out;
}

/** 同一时间只整理一件事：定时的和用户点的「现在整理」不能撞在一起，同一段对话整理两次 */
let lock: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = lock.catch(() => {}).then(fn);
  lock = next.catch(() => {});
  return next;
}

/** 看一遍所有人：该回填的回填，按各自的设置该整理的整理 */
export function sweepOnce(opts: { now?: number } = {}): Promise<void> {
  return exclusive(async () => {
    const now = opts.now ?? Date.now();
    for (const user of activeUsers()) {
      try {
        const memory = readMemory(user.id);
        if (!memory.enabled) continue;
        if (memory.chatHistory && !readMeta(user.id).backfilled) await backfill(user.id);
        const c = memory.curate;
        if (c.when === "off") {
          // 不整理：聊过的不攒着，之后再打开也不会一下子整理一大堆旧的
          for (const p of pendingConversations(user.id, 0, now)) markExtracted(user.id, p.key, p.last);
        } else if (c.when === "idle") {
          for (const p of collect(user.id, c.idleMinutes * 60_000, now)) await curateBatch(user.id, [p], { notify: true });
        } else if (c.when === "daily") {
          const today = localDate(now);
          if (new Date(now).getHours() < c.dailyHour || readMeta(user.id).lastDaily === today) continue;
          patchMeta(user.id, { lastDaily: today });
          await curateBatch(user.id, collect(user.id, SETTLE_MS, now));
        }
        // manual：等用户点
      } catch (err) {
        console.error(`[记忆] 整理 ${user.id} 出错:`, err);
      }
    }
  });
}

/** 用户点了「现在整理」：他所有没整理过的对话合起来整理一次（正在回复的那段除外） */
export function curateNow(userId: string, opts: { now?: number } = {}): Promise<BatchOutcome> {
  return exclusive(async () => {
    const memory = readMemory(userId);
    if (!memory.enabled || memory.curate.when === "off") {
      return { at: Date.now(), conversations: 0, added: [], updated: [], removed: 0, error: memory.enabled ? "整理已关闭" : "记忆已关闭" };
    }
    const pendings = collect(userId, 0, opts.now);
    return curateBatch(userId, pendings);
  });
}

/** 还没整理的对话有几段（设置页显示「有 N 段对话等着整理」） */
export function pendingCount(userId: string): number {
  const scope = readMemory(userId).curate.scope;
  return pendingConversations(userId, 0).filter((p) => {
    const conv = hub.conversation(p.key);
    return conv && !conv.hidden && inScope(conv, scope);
  }).length;
}

export function startMemoryCurator(): void {
  startHistoryCapture();
  // 等 agent 起来、健康检查跑完再开始
  setTimeout(() => void sweepOnce(), 60_000).unref();
  setInterval(() => void sweepOnce(), SWEEP_MS).unref();
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("超时")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
