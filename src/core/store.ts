// 会话（conversation）的持久化。
//
// 一个 conversation 是「一个聊天上下文」：飞书的一个私聊 / 群 / 话题，或者 Web 上
// 的一条对话。它记着当前用哪个 agent、在哪个目录，以及**每个 agent 各自**的会话 id
// 和模型 —— 在同一个群里从 Claude 切到 Codex 再切回来，Claude 那条会话还在。
import path from "node:path";
import { dataDir, readJson, writeJsonAtomic } from "../home.js";
import { config } from "./config.js";

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
  /**
   * 上次告诉这个 agent 会话的是哪种模式（没有 = 工作模式，agent 原装的样子）。和对话现在的模式不一样，
   * 就要在下一条消息里说一声（Codex 换不了系统提示，见 core/chat-mode.ts）。
   */
  announcedMode?: "chat" | "work";
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
  agent: string;
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
  /** chat：聊天模式（/chat）。没有就是工作模式。属于对话，跨 /new 和切 agent 保留 */
  mode?: "chat";
};

type StoreShape = Record<string, Conversation>;

const storePath = path.join(dataDir, "conversations.json");
let cache: StoreShape | null = null;
let persistTimer: NodeJS.Timeout | null = null;

function load(): StoreShape {
  cache ??= readJson<StoreShape>(storePath, {});
  return cache;
}

/** 合并写盘：一轮对话里会频繁 touch，没必要每次都落盘。 */
function persist(immediate = false): void {
  if (immediate) {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    writeJsonAtomic(storePath, cache ?? {});
    return;
  }
  persistTimer ??= setTimeout(() => {
    persistTimer = null;
    writeJsonAtomic(storePath, cache ?? {});
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
  title?: string;
  owner?: string;
}): Conversation {
  const existing = getConversation(params.key);
  if (existing) return existing;
  const now = Date.now();
  const conv: Conversation = {
    key: params.key,
    channel: params.channel,
    channelId: params.channelId,
    agent: params.agent,
    cwd: config().workspaceRoot,
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

const sessionOwnersPath = path.join(dataDir, "session-owners.json");
let sessionOwners: Record<string, string> | null = null;

function owners(): Record<string, string> {
  sessionOwners ??= readJson<Record<string, string>>(sessionOwnersPath, {});
  return sessionOwners;
}

/** 第一次见到这个会话 id 时记下主人；已经有主了不改 */
export function recordSessionOwner(sessionId: string | undefined, userId: string | undefined): void {
  if (!sessionId || !userId) return;
  const all = owners();
  if (all[sessionId]) return;
  all[sessionId] = userId;
  writeJsonAtomic(sessionOwnersPath, all);
}

export function sessionOwner(sessionId: string): string | undefined {
  return owners()[sessionId];
}
