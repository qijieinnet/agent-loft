// 记忆：agent 对「这个人」的长期了解，像 ChatGPT 的记忆那样。
//
// 每个用户一份，存在数据库的 memory 表里（见 db.ts），一人一行：
//   - about：用户自己写的「关于我」；
//   - items：一条条记住的事，用户在设置里加的，或者 agent 在对话里用 remember 工具记下的。
// 开会话时拼成一段文字放进系统提示（见 memoryPrompt），Claude / Codex、Web / 飞书共用同一份。
//
// 归属跟着对话的主人走（见 memoryOwnerOf）：别人的对话里绝不注入你的记忆，也不往你的记忆里写。
// 记忆隔离和多用户一样是「信任型」的：agent 都以同一个系统用户运行，工作模式下能读到数据库文件。
//
// 不做内存缓存，每次都查库：agent 的记忆工具跑在单独的进程里（见 mcp/memory-server.ts），
// 两边都会写。读—改—写放在一个事务里，两边同时改也不会互相冲掉。
import crypto from "node:crypto";
import { MEMORY_DEFAULT_OFF, sql, transaction } from "./db.js";

export type MemoryItem = {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  /** 谁记的：用户在设置里加的、agent 在对话里记的、聊完后自动整理出来的（见 memory-curator.ts） */
  source: "user" | "agent" | "auto";
};

export type UserMemory = {
  /** 关掉后不注入、不给记忆工具、不记聊天记录、不整理，已有的内容保留 */
  enabled: boolean;
  about: string;
  items: MemoryItem[];
  /** 什么时候、用谁整理记忆（见 memory-curator.ts） */
  curate: CurateSettings;
  /** 给 agent search_past_chats，能查以前的聊天 */
  chatHistory: boolean;
};

/**
 * 整理记忆的时机：
 *   idle：每段对话停了 idleMinutes 分钟就整理这一段，改了什么在那条对话里说一声；
 *   daily：每天 dailyHour 点（服务器所在时区）把当天聊过的合起来整理一次，省额度，也更容易合并重复；
 *   manual：只在用户点「现在整理」时；
 *   off：不整理，聊过的也不攒着。
 */
export type CurateWhen = "idle" | "daily" | "manual" | "off";

/** 整理哪些对话：全部 / 只整理选中专家的（experts 里的专家 id，内置的就是 claude、codex） */
export type CurateScope = "all" | "experts";

export type CurateSettings = {
  when: CurateWhen;
  scope: CurateScope;
  experts: string[];
  idleMinutes: number;
  dailyHour: number;
  /** auto：Claude 能用就用 Claude，否则 Codex */
  agent: "auto" | "claude" | "codex";
  /** 空 = 这个 agent 最省的默认（Claude 用 Haiku，Codex 用默认模型、思考程度 low） */
  model: string;
};

export const DEFAULT_CURATE: CurateSettings = { when: "daily", scope: "all", experts: [], idleMinutes: 30, dailyHour: 2, agent: "auto", model: "" };

function cleanCurate(raw: Partial<CurateSettings> | undefined, base: CurateSettings): CurateSettings {
  const r = raw ?? {};
  const when = (["idle", "daily", "manual", "off"] as const).find((w) => w === r.when) ?? base.when;
  // 以前的「只整理聊天 / 工作模式的」没有了（聊天模式换成了专家），一律回到全部
  const legacy = (r.scope as string) === "chat" || (r.scope as string) === "work";
  const scope = legacy ? "all" : ((["all", "experts"] as const).find((s) => s === r.scope) ?? base.scope);
  const experts = Array.isArray(r.experts)
    ? [...new Set(r.experts.filter((x): x is string => typeof x === "string" && /^[\w-]{1,64}$/.test(x)))].slice(0, 100)
    : base.experts;
  const idle = Math.round(Number(r.idleMinutes ?? base.idleMinutes));
  const hour = Math.round(Number(r.dailyHour ?? base.dailyHour));
  const agent = (["auto", "claude", "codex"] as const).find((a) => a === r.agent) ?? base.agent;
  const model = typeof r.model === "string" ? r.model.trim().slice(0, 100) : base.model;
  return {
    when,
    scope,
    experts,
    idleMinutes: Number.isFinite(idle) ? Math.max(5, Math.min(24 * 60, idle)) : base.idleMinutes,
    dailyHour: Number.isFinite(hour) ? Math.max(0, Math.min(23, hour)) : base.dailyHour,
    agent,
    // 自动选 agent 时模型跟着 agent 走，不能指定
    model: agent === "auto" ? "" : model,
  };
}

export const MEMORY_LIMITS = {
  about: 2000,
  item: 500,
  items: 200,
  /** 注入系统提示的记忆条目最多这么多字（新的优先），控制每轮的固定开销 */
  promptItems: 4000,
};

/** 用户 id 只会是 users.ts 生成的那种 */
function checkUser(userId: string): string {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(userId)) throw new Error("用户 id 不合法");
  return userId;
}

function empty(): UserMemory {
  return { enabled: false, about: "", items: [], curate: { ...DEFAULT_CURATE }, chatHistory: true };
}

/**
 * 记忆从默认开改成默认关（0.2.46）：升级前就有、但还没存过记忆的用户，补一份开着的，
 * 让老实例里的人保持原样。只跑一次，跑过留个标记；新装的第一次启动时还没有用户，什么都不补。
 */
export function migrateMemoryDefault(userIds: string[]): void {
  const n = transaction(() => {
    if (sql("SELECT 1 FROM migrations WHERE name = ?").get(MEMORY_DEFAULT_OFF)) return 0;
    let added = 0;
    for (const id of userIds) {
      if (sql("SELECT 1 FROM memory WHERE user_id = ?").get(checkUser(id))) continue;
      write(id, { ...empty(), enabled: true });
      added++;
    }
    sql("INSERT INTO migrations (name, at) VALUES (?, ?)").run(MEMORY_DEFAULT_OFF, Date.now());
    return added;
  });
  if (n) console.log(`[记忆] 默认改成关闭：升级前的 ${n} 个用户保持开启`);
}

export function readMemory(userId: string): UserMemory {
  const row = sql("SELECT data FROM memory WHERE user_id = ?").get(checkUser(userId)) as { data: string } | undefined;
  let raw: Partial<UserMemory> & { autoExtract?: boolean } = {};
  try {
    raw = row ? JSON.parse(row.data) : {};
  } catch {
    // 坏了就当没有
  }
  const items = Array.isArray(raw.items)
    ? raw.items.filter((i): i is MemoryItem => !!i && typeof i.id === "string" && typeof i.text === "string")
    : [];
  return {
    // 默认关：后台整理会占订阅额度，夜里还会单独开一个 5 小时窗口。存过的都带着 enabled，老用户不受影响
    enabled: raw.enabled === true,
    // 早先的版本只有一个「自动整理」开关：关着的就是不整理
    curate: cleanCurate(raw.curate, raw.autoExtract === false ? { ...DEFAULT_CURATE, when: "off" } : DEFAULT_CURATE),
    chatHistory: raw.chatHistory !== false,
    about: typeof raw.about === "string" ? raw.about : "",
    items: items.map((i) => ({
      id: i.id,
      text: i.text,
      createdAt: Number(i.createdAt) || 0,
      updatedAt: Number(i.updatedAt) || Number(i.createdAt) || 0,
      source: i.source === "user" || i.source === "auto" ? i.source : "agent",
    })),
  };
}

function write(userId: string, memory: UserMemory): void {
  sql("INSERT OR REPLACE INTO memory (user_id, data) VALUES (?, ?)").run(checkUser(userId), JSON.stringify(memory));
}

/**
 * 读—改—写放进一个事务：主进程（设置页、自动整理）和每个会话的记忆工具子进程都会写同一个人的记忆，
 * 不这样的话两边同时改，后写的那个会把先写的冲掉（新记的一条、刚保存的「关于我」悄悄没了）。
 */
function locked<T>(userId: string, fn: (memory: UserMemory) => T): T {
  return transaction(() => fn(readMemory(userId)));
}

function cleanText(text: unknown, max: number, what: string): string {
  const t = typeof text === "string" ? text.trim() : "";
  if (t.length > max) throw new Error(`${what}最多 ${max} 个字`);
  return t;
}

const normalize = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();

function newItemId(): string {
  return `m_${crypto.randomBytes(3).toString("hex")}`;
}

export function setMemoryOptions(
  userId: string,
  patch: { enabled?: boolean; about?: string; curate?: Partial<CurateSettings>; chatHistory?: boolean },
): UserMemory {
  // 先校验再上锁：内容不合规直接报错，不白占锁
  const about = patch.about !== undefined ? cleanText(patch.about, MEMORY_LIMITS.about, "「关于我」") : undefined;
  return locked(userId, (memory) => {
    if (typeof patch.enabled === "boolean") memory.enabled = patch.enabled;
    if (patch.curate) memory.curate = cleanCurate(patch.curate, memory.curate);
    if (typeof patch.chatHistory === "boolean") memory.chatHistory = patch.chatHistory;
    if (about !== undefined) memory.about = about;
    write(userId, memory);
    return memory;
  });
}

export type AddResult = { item: MemoryItem; created: boolean; evicted?: MemoryItem };

/**
 * 记一条。内容一样的（忽略空白和大小写）不重复记，只更新时间（created: false）。
 * 满了就挤掉最久没更新的那条不是用户自己加的（agent 记的、自动整理的），挤掉的那条在 evicted 里；
 * 全是用户自己加的就报错。
 */
export function addMemoryEntry(userId: string, text: string, source: MemoryItem["source"]): AddResult {
  const t = cleanText(text, MEMORY_LIMITS.item, "一条记忆");
  if (!t) throw new Error("记忆内容不能为空");
  return locked(userId, (memory) => {
    const now = Date.now();
    const same = memory.items.find((i) => normalize(i.text) === normalize(t));
    if (same) {
      same.updatedAt = now;
      write(userId, memory);
      return { item: same, created: false };
    }
    let evicted: MemoryItem | undefined;
    if (memory.items.length >= MEMORY_LIMITS.items) {
      evicted = memory.items.filter((i) => i.source !== "user").sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (!evicted) throw new Error(`记忆已经有 ${MEMORY_LIMITS.items} 条了，先删掉一些`);
      memory.items = memory.items.filter((i) => i !== evicted);
    }
    const item: MemoryItem = { id: newItemId(), text: t, createdAt: now, updatedAt: now, source };
    memory.items.push(item);
    write(userId, memory);
    return { item, created: true, ...(evicted ? { evicted } : {}) };
  });
}

/** 记一条，只要结果 */
export function addMemoryItem(userId: string, text: string, source: MemoryItem["source"]): MemoryItem {
  return addMemoryEntry(userId, text, source).item;
}

export function updateMemoryItem(userId: string, id: string, text: string): MemoryItem {
  const t = cleanText(text, MEMORY_LIMITS.item, "一条记忆");
  if (!t) throw new Error("记忆内容不能为空");
  return locked(userId, (memory) => {
    const item = memory.items.find((i) => i.id === id);
    if (!item) throw new Error("这条记忆不存在");
    item.text = t;
    item.updatedAt = Date.now();
    write(userId, memory);
    return item;
  });
}

/** 删一条。返回删掉的那条，没有就返回 undefined */
export function removeMemoryItem(userId: string, id: string): MemoryItem | undefined {
  return locked(userId, (memory) => {
    const item = memory.items.find((i) => i.id === id);
    if (!item) return undefined;
    memory.items = memory.items.filter((i) => i !== item);
    write(userId, memory);
    return item;
  });
}

/**
 * 清空：「关于我」和所有条目都删掉，开关和整理设置保留 —— 关着记忆的人清空之后不能变成开着。
 * 管理员清空成员的记忆也走这里。
 */
export function clearMemory(userId: string): void {
  locked(userId, (memory) => write(userId, { ...memory, about: "", items: [] }));
}

/** 删用户时：整个删掉 */
export function deleteMemory(userId: string): void {
  sql("DELETE FROM memory WHERE user_id = ?").run(checkUser(userId));
}

// ---------- 注入系统提示 ----------

/** 本地日期 YYYY-MM-DD（记忆条目、整理、搜索结果都用它） */
export function localDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 系统提示里怎么称呼记忆工具：两个 agent 给 MCP 工具起的全名不一样，只说短名 */
export const MEMORY_TOOL_NAMES = { remember: "remember", forget: "forget", search: "search_past_chats" } as const;

/**
 * 拼进系统提示的一段文字。记忆关着就返回 undefined（也不该给记忆工具）。
 * 条目按最近更新排，超出字数预算的旧条目不放进来（它们还在，只是这次没带上）。
 */
export function memoryPrompt(userId: string): string | undefined {
  const memory = readMemory(userId);
  if (!memory.enabled) return undefined;
  const lines: string[] = [
    "# 关于这位用户",
    "",
    "下面是你对这位用户的长期了解：有的是他自己写的，有的是之前的对话里记下的。自然地用上，让回答更贴合他；不要逐条复述，也不要每次都提「我记得」。和当前对话冲突时以当前对话为准。",
  ];
  if (memory.about.trim()) lines.push("", "## 他的自我介绍", "", memory.about.trim());
  const sorted = [...memory.items].sort((a, b) => b.updatedAt - a.updatedAt);
  const kept: MemoryItem[] = [];
  let budget = MEMORY_LIMITS.promptItems;
  for (const item of sorted) {
    if (item.text.length > budget) break;
    budget -= item.text.length;
    kept.push(item);
  }
  if (kept.length > 0) {
    lines.push("", "## 记住的事", "");
    for (const item of kept) lines.push(`- [${item.id}] ${localDate(item.updatedAt)}：${item.text}`);
    if (kept.length < sorted.length) lines.push(`- （还有 ${sorted.length - kept.length} 条较早的记忆这次没有带上）`);
  }
  lines.push(
    "",
    "## 记忆工具",
    "",
    `- 用户让你记住什么，或者你发现了以后长期有用的信息（身份、偏好、习惯、长期在做的事、做过的重要决定），用 ${MEMORY_TOOL_NAMES.remember} 记一条：一句话、写清主语和时间背景。记完在回复里顺口说一句「已记住：…」。`,
    `- 记忆过时了、记错了，或者用户让你忘掉，用 ${MEMORY_TOOL_NAMES.forget}（给上面方括号里的 id）。更新一件事就先 forget 旧的再 remember 新的。`,
    "- 不要记密码、密钥、验证码、证件号这类敏感信息，也不要记一次性的琐事和当前任务的细节。",
    ...(memory.chatHistory
      ? [
          `- 用户提到以前聊过的事（「上次说的那个……」「我之前问过……」），或者你需要他以前说过的细节，用 ${MEMORY_TOOL_NAMES.search} 搜他以前的聊天（关键词搜索，换几个说法多搜几次）。`,
        ]
      : []),
  );
  return lines.join("\n");
}
