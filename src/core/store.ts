// 会话（conversation）的持久化。
//
// 一个 conversation 是「一个聊天上下文」：飞书的一个私聊 / 群 / 话题，或者 Web 上
// 的一条对话。它记着用哪个专家（core/experts.ts）和它的引擎（agent）、在哪个目录，以及 agent 的会话 id
// 和模型。专家定了就不换：飞书里换专家等于开新会话（见 hub.setExpert）。
import path from "node:path";
import { config } from "./config.js";
import { sql, transaction } from "./db.js";

export type AgentBinding = {
  /** agent 侧的会话 id（Claude 的 sessionId / Codex 的 threadId） */
  sessionId?: string;
  /** 用户显式选的模型，开新会话清掉 */
  model?: string;
  effort?: string;
  /**
   * 待分叉：/fork 之后、新会话真正建立之前，记着要从哪个会话分叉。
   * 必须落盘：期间切了 agent、或者 agent-loft 重启了，下一条消息仍要分叉，而不是续写原会话。
   * 拿到不同于它的新会话 id 后清掉。
   */
  forkFrom?: string;
};

export type Conversation = {
  key: string;
  /** 渠道类型：feishu / web / telegram… */
  channel: string;
  /** 渠道实例：飞书是机器人 id，Web 固定 web */
  channelId: string;
  title?: string;
  /**
   * 标题是自动起的（先用首条消息占位，之后换成 agent 生成的标题），可以继续被 agent 的标题覆盖。
   * 用户手动改过名就清掉，之后不再动它。
   */
  titleAuto?: boolean;
  /** 引擎：claude / codex。按它找 driver、存会话 id */
  agent: string;
  /** 自定义专家的 id。没有就是内置专家，也就是 agent 本身 */
  expert?: string;
  cwd: string;
  /** cwd 是否用户显式指定。没指定过的跟随 workspaceRoot 变化 */
  cwdExplicit?: boolean;
  perAgent: Record<string, AgentBinding>;
  /** 最后一次有人说话的时间，用于闲置过期 */
  activeAt: number;
  createdAt: number;
  /** Web 列表里隐藏（Web 上删除的会话只是隐藏，agent 侧的历史还在） */
  hidden?: boolean;
  /** /autoedit：这条对话里 agent 在工作目录内改文件不再询问（跨 /new 保留，属于对话不属于某个会话） */
  autoEdit?: boolean;
  /** 从哪条对话分叉出来的（对话 key），列表里据此显示关联 */
  forkOf?: string;
  /**
   * 谁的对话（用户 id，见 core/users.ts）。Web 上新建 / 分叉时记下；飞书私聊在发消息的人绑定了
   * 账号时记下（见 core/feishu-links.ts）。飞书群聊、没绑定的私聊和升级前就有的 Web 会话没有，归管理员。
   */
  owner?: string;
  /** 定时任务的专用对话：是哪个任务的（见 core/tasks.ts）。任务删了就清掉 */
  taskId?: string;
};

type StoreShape = Record<string, Conversation>;

// 存在数据库的 conversations 表里（见 db.ts），一条对话一行。读进内存后都改内存里的对象，
// 落盘时和上次写下去的比，只写变了的、删掉没了的。
let cache: StoreShape | null = null;
/** 每条对话上次写进数据库的内容 */
const written = new Map<string, string>();
let persistTimer: NodeJS.Timeout | null = null;

function load(): StoreShape {
  if (cache) return cache;
  cache = {};
  for (const row of sql("SELECT key, data FROM conversations").all() as { key: string; data: string }[]) {
    try {
      cache[row.key] = JSON.parse(row.data) as Conversation;
      written.set(row.key, row.data);
    } catch {
      console.warn(`[store] 会话 ${row.key} 的数据坏了，跳过`);
    }
  }
  // 聊天模式取消了（换成了专家）：以前聊天模式的对话直接丢掉，不迁移
  let dropped = 0;
  for (const [key, conv] of Object.entries(cache)) {
    if ((conv as { mode?: string }).mode === "chat") {
      delete cache[key];
      dropped++;
    }
    for (const b of Object.values(conv.perAgent ?? {})) delete (b as { announcedMode?: string }).announcedMode;
  }
  if (dropped) {
    console.log(`[store] 聊天模式已取消，丢掉了 ${dropped} 条聊天模式的对话`);
    writeChanges();
  }
  return cache;
}

function writeChanges(): void {
  const all = cache ?? {};
  const changed: [string, string][] = [];
  for (const [key, conv] of Object.entries(all)) {
    const data = JSON.stringify(conv);
    if (written.get(key) !== data) changed.push([key, data]);
  }
  const removed = [...written.keys()].filter((key) => !(key in all));
  if (changed.length === 0 && removed.length === 0) return;
  transaction(() => {
    for (const [key, data] of changed) sql("INSERT OR REPLACE INTO conversations (key, data) VALUES (?, ?)").run(key, data);
    for (const key of removed) sql("DELETE FROM conversations WHERE key = ?").run(key);
  });
  for (const [key, data] of changed) written.set(key, data);
  for (const key of removed) written.delete(key);
}

/** 这条对话的专家 id：自定义专家的 id，或者内置专家（就是 agent 本身） */
export function expertIdOf(conv: Pick<Conversation, "agent" | "expert">): string {
  return conv.expert ?? conv.agent;
}

/** 合并写盘：一轮对话里会频繁 touch，没必要每次都落盘。 */
function persist(immediate = false): void {
  if (immediate) {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    writeChanges();
    return;
  }
  persistTimer ??= setTimeout(() => {
    persistTimer = null;
    writeChanges();
  }, 500);
}

export function flushStore(): void {
  if (persistTimer) persist(true);
}

function insideRoot(dir: string): boolean {
  const root = config().workspaceRoot;
  const rel = path.relative(root, dir);
  return dir === root || (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 目录跟随配置：没显式指定过的跟着 workspaceRoot 走，显式指定的只在越界时回退。 */
function reconcileCwd(conv: Conversation): Conversation {
  const root = config().workspaceRoot;
  const needsReset = conv.cwdExplicit ? !insideRoot(conv.cwd) : conv.cwd !== root;
  if (!needsReset) return conv;
  console.warn(`[store] 会话 ${conv.key} 的工作目录由 ${conv.cwd} 重置为 ${root}`);
  conv.cwd = root;
  conv.cwdExplicit = false;
  // 目录变了，旧会话的上下文已经没意义
  for (const binding of Object.values(conv.perAgent)) {
    delete binding.sessionId;
    delete binding.forkFrom;
  }
  persist();
  return conv;
}

export function getConversation(key: string): Conversation | undefined {
  const conv = load()[key];
  return conv ? reconcileCwd(conv) : undefined;
}

export function ensureConversation(params: {
  key: string;
  channel: string;
  channelId: string;
  agent: string;
  expert?: string;
  title?: string;
  owner?: string;
  cwd?: string;
}): Conversation {
  const existing = getConversation(params.key);
  if (existing) return existing;
  const now = Date.now();
  const conv: Conversation = {
    key: params.key,
    channel: params.channel,
    channelId: params.channelId,
    agent: params.agent,
    ...(params.expert ? { expert: params.expert } : {}),
    cwd: params.cwd ?? config().workspaceRoot,
    ...(params.cwd && params.cwd !== config().workspaceRoot ? { cwdExplicit: true } : {}),
    perAgent: {},
    activeAt: now,
    createdAt: now,
    ...(params.title ? { title: params.title } : {}),
    ...(params.owner ? { owner: params.owner } : {}),
  };
  load()[params.key] = conv;
  persist(true);
  return conv;
}

export function updateConversation(key: string, patch: Partial<Conversation>): Conversation {
  const conv = getConversation(key);
  if (!conv) throw new Error(`会话不存在：${key}`);
  Object.assign(conv, patch);
  persist();
  return conv;
}

export function agentBinding(conv: Conversation, agent = conv.agent): AgentBinding {
  return (conv.perAgent[agent] ??= {});
}

export function updateAgentBinding(key: string, agent: string, patch: Partial<AgentBinding>): void {
  const conv = getConversation(key);
  if (!conv) return;
  const binding = agentBinding(conv, agent);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (binding as Record<string, unknown>)[k];
    else (binding as Record<string, unknown>)[k] = v;
  }
  persist();
}

export function touchConversation(key: string): void {
  const conv = getConversation(key);
  if (!conv) return;
  conv.activeAt = Date.now();
  persist();
}

export function isExpired(conv: Conversation, now = Date.now()): boolean {
  const ttl = config().sessionTtlMs;
  return ttl > 0 && now - conv.activeAt > ttl;
}

export function listConversations(): Conversation[] {
  return Object.values(load()).map(reconcileCwd);
}

export function deleteConversation(key: string): void {
  delete load()[key];
  persist(true);
}

/** 迁移旧数据用：整条写入。 */
export function putConversation(conv: Conversation): void {
  load()[conv.key] = conv;
  persist(true);
}

// ---------- agent 会话的归属 ----------
//
// /sessions、/resume 列的是 agent 自己存的全部历史（磁盘上谁开的都有），多用户时要按人过滤：
// 记下每个 agent 会话 id 是哪个用户的对话里开出来的。没记过的（飞书、终端里开的、升级前的）归管理员。

/** 第一次见到这个会话 id 时记下主人；已经有主了不改 */
export function recordSessionOwner(sessionId: string | undefined, userId: string | undefined): void {
  if (!sessionId || !userId) return;
  sql("INSERT OR IGNORE INTO session_owners (session_id, user_id) VALUES (?, ?)").run(sessionId, userId);
}

export function sessionOwner(sessionId: string): string | undefined {
  const row = sql("SELECT user_id FROM session_owners WHERE session_id = ?").get(sessionId) as { user_id: string } | undefined;
  return row?.user_id;
}

/** 别的进程（记忆工具）要对话的标题和是否隐藏：直接查库，不走缓存，Web 上刚删的立刻生效 */
export function conversationLabels(): Map<string, { title?: string; hidden?: boolean }> {
  const rows = sql("SELECT key, json_extract(data, '$.title') AS title, json_extract(data, '$.hidden') AS hidden FROM conversations").all() as {
    key: string;
    title: string | null;
    hidden: number | null;
  }[];
  return new Map(rows.map((r) => [r.key, { ...(r.title ? { title: r.title } : {}), ...(r.hidden ? { hidden: true } : {}) }]));
}
