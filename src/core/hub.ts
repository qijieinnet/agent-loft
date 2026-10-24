// 中枢：所有渠道共用的「会话 → agent」调度。
//
// 渠道只做三件事：把用户的话（和附件）交给 hub.send，把命令交给 hub.command，
// 订阅 hub 的事件流画到自己的界面上。会话的生命周期、闲置过期、切 agent / 模型 /
// 目录、取消挂着的审批，全在这里 —— 以前飞书桥接器 index.ts 里那 1000 行流程，
// 现在只写一遍。
//
// 同一条会话可以被多个渠道同时看着：飞书群里的会话也能在 Web 上打开，Web 上
// 说的话照样回到飞书。所以事件是广播出去的，每个订阅者自己挑感兴趣的会话。
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { config, onConfigChange, resolveWorkspacePath } from "./config.js";
import { attachFooters, copyFooters, formatDuration, recordFooter } from "./footers.js";
import { flushUsage, recordUsage, usageOf, type UsageTotals } from "./usage.js";
import { interactions, SETTLEMENT_LABEL } from "./interactions.js";
import {
  agentBinding,
  ensureConversation,
  getConversation,
  isExpired,
  listConversations,
  recordSessionOwner,
  touchConversation,
  updateAgentBinding,
  updateConversation,
  type Conversation,
} from "./store.js";
import { attachmentInfo, clearUploads, ensureUploadsDir, KIND_LABEL } from "./uploads.js";
import { memoryOwnerOf, sessionMemory } from "./personal.js";
import { readMemory } from "./memory.js";
import { getUser } from "./users.js";
import type {
  AgentDriver,
  AttachmentInfo,
  AgentSession,
  ContextUsage,
  ConversationMode,
  ApprovalDecision,
  HistoryMessage,
  InteractionSpec,
  ModelInfo,
  RuntimeInfo,
  SessionSummary,
  StepKind,
  UserInput,
} from "./types.js";
import { buildCatalog, expandCustomCommand, type AgentCommand, type CommandEntry, type CommandPrefs } from "./command-catalog.js";
import { helpText, type ParsedCommand } from "./commands.js";
import { listScheduled } from "./scheduled.js";
import { stripContext, wrapContext } from "./chat-mode.js";
import { isMachineCommand, mentionContext, sessionSkills, skillsText } from "./skill-runtime.js";
import { skillEvents } from "./skills.js";
import { isSilentReply } from "./task-prompt.js";

// ---------- 事件 ----------

export type Origin = {
  /** feishu / web / telegram… */
  channel: string;
  /** 渠道实例 id（飞书机器人 id；Web 为 web） */
  channelId: string;
  /** 显示用的人名 / 设备名 */
  name?: string;
  /** 飞书：从哪个聊天说的（一条会话可能同时挂在好几个飞书聊天上，回显时要分清） */
  chatId?: string;
};

export type ConvEvent =
  /** id：这条消息的编号，后面的 queue 事件按它对上；queued：收到时前面还有在跑 / 在等的，要排队 */
  | { type: "user"; text: string; attachments: string[]; files?: AttachmentInfo[]; origin: Origin; id?: string; queued?: boolean }
  /** 排队的消息：轮到它了（started，或者被当成提问的回答用掉了），或者没发出去（dropped：停止、会话切换…） */
  | { type: "queue"; id: string; state: "started" | "dropped" }
  /**
   * 这里弹出过一张授权 / 提问卡（内容和状态在 interactions 里按 id 查）。只是给卡片在对话里占个位置：
   * 刷新页面时进行中的这一轮靠重放事件画出来，没有它卡片就丢了
   */
  | { type: "ix"; id: string }
  | { type: "turn_start" }
  | { type: "step"; kind: StepKind; text: string }
  | { type: "delta"; text: string }
  | { type: "text"; text: string }
  /**
   * task：这一轮是定时任务发起的；silent：任务让 agent 自己判断要不要提醒，它判断这次不用 ——
   * 推送、飞书都不发，网页上折叠显示
   */
  | { type: "result"; text: string; footer: string; at: number; anchor?: string; task?: { id: string; title: string }; silent?: true }
  | { type: "error"; message: string }
  | { type: "notice"; text: string }
  | { type: "state"; busy: boolean }
  | { type: "meta" };

/** 定时任务发起的一轮（见 core/task-runner.ts） */
export type TaskTurn = { taskId: string; runId: string; title: string; smart: boolean };

/** 定时任务的一轮结束了 */
export type TaskTurnEnd = TaskTurn & { key: string; status: "notified" | "silent" | "error" | "interrupted"; text: string };

/** 一条输入是在哪个时刻收到的：停止代次 + 生命周期代次 */
/**
 * 一条输入收到时的状态快照。
 *   stop：停止代次。
 *   boundary：收到时已发起的最后一个切换操作的序号。序号比它大的切换是「收到之后才发起的」，
 *     它们中任何一个真正生效了，这条消息就是冲着旧会话说的，作废。序号不大于它的
 *     （收到之前就已发起、哪怕还在排队）不算 —— 这条本来就是冲着切换之后说的。
 *   at：收到的时刻。
 */
type SwitchOp = { at: number; seq: number };

export type InputGen = { stop: number; boundary: number; at: number };

export type EventEnvelope = { key: string; seq: number; ts: number; ev: ConvEvent };

/** 命令的结构化结果。各渠道自己决定怎么画（飞书画卡片，Web 画列表）。 */
export type CommandReply =
  | { type: "text"; text: string }
  | {
      type: "sessions";
      agent: string;
      sessions: SessionSummary[];
      current?: string;
      cwd: string;
      allDirs: boolean;
      fellBack: boolean;
    }
  | {
      type: "models";
      agent: string;
      models: ModelInfo[];
      current?: string;
      currentEffort?: string;
      effortSupported: boolean;
    }
  | { type: "agents"; agents: { id: string; label: string }[]; current: string }
  /** 只发了「/」：可用命令（已按用户配置排序、去掉隐藏的） */
  | { type: "commands"; agent: string; commands: CommandEntry[] }
  | { type: "none" };

export type ConversationInfo = {
  key: string;
  title?: string;
  channel: string;
  channelId: string;
  agent: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  effort?: string;
  /** 实际在用的模型 / 思考程度（尽力而为，可能不全）。model/effort 只是显式选过的 */
  runtimeModel?: string;
  runtimeEffort?: string;
  /** 当前 agent 会话的上下文占用（这次启动以来跑过至少一轮才有） */
  context?: ContextUsage;
  /** 当前 agent 会话累计消耗的 token（升级后跑过至少一轮才有） */
  usage?: UsageTotals;
  busy: boolean;
  activeAt: number;
  createdAt: number;
  hidden?: boolean;
  /** 从哪条对话分叉出来的 */
  forkOf?: string;
  /** 当前 agent 能不能从某条回复处分叉成新对话 */
  canFork?: boolean;
  /** 聊天模式还是工作模式 */
  mode: ConversationMode;
  /** 这条对话有主人、会用上主人的记忆（主人自己关了记忆的话实际不会注入，见 personal.ts） */
  personal?: boolean;
  /** 排着的定时消息（见 core/scheduled.ts），按发送时间先后 */
  scheduled?: { id: string; text: string; at: number }[];
  /** 定时任务的专用对话 */
  taskId?: string;
};

/** 普通成员点了会落盘的「总是允许」 */
export const GLOBAL_ALWAYS_DENIED = "「总是允许」会对所有人的会话生效，只有管理员能点。可以用「允许一次」或「本会话全部允许」。";

const BUFFER_MAX = 400;
const CONTEXT_MAX = 500;
/** 会占住会话操作队列的 agent 查询，最多等这么久 */
const QUERY_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, what: string, ms = QUERY_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}超时（${ms / 1000} 秒没有响应）`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

type Live = { id: number; agent: string; cwd: string; session: AgentSession };

class Hub extends EventEmitter<{ event: [EventEnvelope]; task: [TaskTurnEnd] }> {
  private drivers = new Map<string, AgentDriver>();
  private live = new Map<string, Live>();
  /**
   * 每条会话已经送进 agent、还没出结果的轮次，按先后排：定时任务发起的带着 TaskTurn，普通消息是 null。
   * 和 inflight 一样一轮一项，出结果 / 出错 / 被丢弃时从头上取走。
   */
  private turnTags = new Map<string, (TaskTurn | null)[]>();
  private buffers = new Map<string, EventEnvelope[]>();
  private seq = 0;
  /** 每条会话还没收到结果的轮数，> 0 即忙 */
  private inflight = new Map<string, number>();
  /**
   * 已经交给 agent 会话、还没出结果的消息，和 inflight、turnTags 一一对应：第一条在跑，后面的在排队。
   * 用来告诉页面哪条消息轮到了 / 被丢了，以及「打断并发送」时把哪条挪到前面
   */
  private turnFifo = new Map<string, { id: string; input: UserInput; queued: boolean }[]>();
  /** 收到了、还在串行队列里没交给 agent 的消息数：这时再来的消息也算排队 */
  private waitingSends = new Map<string, number>();
  private msgSeq = 0;
  private announced = new Set<string>();
  /** 每条会话因缓冲区溢出被丢掉的最后一个 seq */
  private truncated = new Map<string, number>();
  /** 每条会话的生命周期操作串行执行，见 serial() */
  private locks = new Map<string, Promise<unknown>>();
  /** 最近一次点停止的时间：紧接着冒出来的「被打断」错误是预期内的，不当错误显示 */
  private stoppedAt = new Map<string, number>();
  /** 正在等 agent 标题的对话，避免一轮轮叠加重试 */
  private titleSyncing = new Set<string>();
  /**
   * 每条会话的「生命周期代次」：开新会话、分叉、恢复、切 agent、切目录时加一。
   * 渠道收到消息后还要先做异步的事（飞书下载附件），期间会话被换掉了的话，
   * 这条消息是冲着旧会话 / 旧目录说的，不能送进新的里去。
   */
  /** 每条会话已发起的切换操作序号（调用那一刻领号） */
  private opSeq = new Map<string, number>();
  /** 真正生效了的切换里，序号最大的那个，以及它生效的时刻 */
  private lastSwitch = new Map<string, { seq: number; at: number }>();
  /** 已发起、还在排队或执行中的切换操作数 */
  private pendingOps = new Map<string, number>();
  private sessionSeq = 0;
  /** 每条会话的「停止代次」：排队中的发送在真正送出前对一下，点过停止的就作废 */
  private stopGen = new Map<string, number>();
  /** 每条会话最近一次实际生效的模型 / 思考程度（会话进程退了也留着，顶栏显示用） */
  private lastRuntime = new Map<string, { agent: string; runtime: RuntimeInfo }>();
  /** 各 agent 的默认模型 / 思考程度（driver.defaults() 的结果，Codex 要问 app-server，所以缓存） */
  private defaultsCache = new Map<string, RuntimeInfo>();
  private defaultsLoading = new Set<string>();
  /** 已经补问过实际设置的会话进程（Live.id） */
  private runtimeAsked = new Set<number>();
  /**
   * 上下文占用，按 agent 的会话 id 记：开新会话 / 恢复 / 切 agent 后 id 变了，自然就不显示旧的。
   * 只在内存里，最多留 CONTEXT_MAX 条。
   */
  private contextBySession = new Map<string, ContextUsage>();

  constructor() {
    super();
    this.setMaxListeners(100);
    interactions.on("created", (i) => this.emitEvent(i.convKey, { type: "ix", id: i.id }));
    // 技能装了、改了、停用了、变量改了：受影响的人空闲的会话换上新的
    skillEvents.on("changed", (users) => this.personalChanged(new Set(users)));
    // workspaceRoot 改了：store 会把没显式 /cd 过的会话目录重置，正在跑的旧目录会话要作废
    onConfigChange((next, prev) => {
      // 默认模型可能改了，缓存作废，下次显示时重新读
      this.defaultsCache.clear();
      // agent 被禁用：它所有活着的会话立刻停掉
      const agents = next.agents as Record<string, { enabled: boolean }>;
      for (const [key, live] of [...this.live]) {
        if (agents[live.agent]?.enabled === false) {
          void this.serial(key, async () => {
            if (this.live.get(key)?.agent !== live.agent) return;
            await this.drop(key, `${this.label(live.agent)} 已在设置里关闭`);
            this.emitEvent(key, { type: "notice", text: `${this.label(live.agent)} 已在设置里关闭，这条会话暂时不能用它。` });
          });
        }
      }
      if (next.workspaceRoot === prev.workspaceRoot) return;
      // 工作区根目录变了：没显式 /cd 过的会话目录都会被重置，处理中的旧消息一律作废
      for (const conv of listConversations()) this.markSwitched(conv.key, this.nextOp(conv.key));
      for (const key of [...this.live.keys()]) {
        void this.serial(key, async () => {
          const conv = getConversation(key);
          if (conv && conv.cwd !== this.live.get(key)?.cwd) {
            await this.drop(key, "工作目录配置已变更");
            this.emitEvent(key, { type: "notice", text: `工作目录配置已变更，之后在 ${conv.cwd} 里开新会话。` });
            this.emitEvent(key, { type: "meta" });
          }
        });
      }
    });
  }

  // ---------- agent 注册 ----------

  registerDriver(driver: AgentDriver): void {
    this.drivers.set(driver.id, driver);
  }

  /** 后台读一次 agent 的默认配置（第一次要显示时才读），读到后通知用它的会话刷新顶栏 */
  private loadDefaults(agent: string): void {
    const driver = this.drivers.get(agent);
    if (!driver || this.defaultsLoading.has(agent)) return;
    this.defaultsLoading.add(agent);
    void withTimeout(driver.defaults(), "读取默认配置")
      .then((defaults) => {
        const prev = this.defaultsCache.get(agent);
        this.defaultsCache.set(agent, defaults);
        if (prev?.model === defaults.model && prev?.effort === defaults.effort) return;
        for (const conv of listConversations()) {
          if (conv.agent === agent && !conv.hidden) this.emitEvent(conv.key, { type: "meta" });
        }
      })
      .catch((err) => {
        // 记个空结果，别每次刷新顶栏都重试
        this.defaultsCache.set(agent, {});
        console.error(`[${agent}] 读取默认配置失败:`, err);
      })
      .finally(() => this.defaultsLoading.delete(agent));
  }

  /** 会话进程要退了：记下它最后实际用的模型，之后顶栏还能显示 */
  private rememberRuntime(key: string, live: Live): void {
    this.runtimeAsked.delete(live.id);
    const runtime = live.session.peekRuntime?.();
    if (runtime && (runtime.model || runtime.effort)) this.lastRuntime.set(key, { agent: live.agent, runtime: { ...runtime } });
  }

  /**
   * 一轮结束后补问一次实际设置（Claude 的 init 消息里不一定带思考程度）。
   * 进程已经在跑，不会额外拉起；每个会话进程只问一次。
   */
  private refreshRuntimeOnce(key: string, liveId: number): void {
    const live = this.live.get(key);
    if (!live || live.id !== liveId || this.runtimeAsked.has(liveId)) return;
    this.runtimeAsked.add(liveId);
    const before = live.session.peekRuntime?.() ?? {};
    void withTimeout(live.session.describeRuntime(), "读取模型信息")
      .then((rt) => {
        if (this.live.get(key)?.id !== liveId) return;
        if (rt.model !== before.model || rt.effort !== before.effort) this.emitEvent(key, { type: "meta" });
      })
      .catch(() => {});
  }

  /**
   * 顶栏显示用的模型 / 思考程度：不拉起进程、不发请求，只拼手上已有的信息。
   * 优先级和 runtimeNow 一致：活着的会话 > 显式选过的 > 上次实际跑的 > 设置里的默认 > agent 自己的默认。
   */
  private displayRuntime(conv: { key: string; agent: string }, binding: { model?: string; effort?: string }): RuntimeInfo {
    const live = this.live.get(conv.key);
    const peek = live && live.agent === conv.agent ? (live.session.peekRuntime?.() ?? {}) : {};
    const last = this.lastRuntime.get(conv.key);
    const lastRt = last && last.agent === conv.agent ? last.runtime : {};
    const defaults = (config().agents as Record<string, { defaultModel?: string; defaultEffort?: string }>)[conv.agent];
    const fallback = this.defaultsCache.get(conv.agent);
    if (!fallback) this.loadDefaults(conv.agent);
    const model = peek.model ?? binding.model ?? lastRt.model ?? (defaults?.defaultModel || undefined) ?? fallback?.model;
    const effort = peek.effort ?? binding.effort ?? lastRt.effort ?? (defaults?.defaultEffort || undefined) ?? fallback?.effort;
    return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  }

  driver(id: string): AgentDriver | undefined {
    return this.drivers.get(id);
  }

  /** 已注册且在配置里启用的 agent */
  enabledAgents(): AgentDriver[] {
    const agents = config().agents as Record<string, { enabled: boolean }>;
    return [...this.drivers.values()].filter((d) => agents[d.id]?.enabled !== false);
  }

  private requireDriver(agent: string): AgentDriver {
    const driver = this.drivers.get(agent);
    const enabled = (config().agents as Record<string, { enabled: boolean }>)[agent]?.enabled !== false;
    if (!driver || !enabled) throw new Error(`agent「${agent}」不可用（未启用或未安装）`);
    return driver;
  }

  // ---------- 事件 ----------

  emitEvent(key: string, ev: ConvEvent): void {
    const env: EventEnvelope = { key, seq: ++this.seq, ts: Date.now(), ev };
    let buf = this.buffers.get(key);
    if (!buf) this.buffers.set(key, (buf = []));
    buf.push(env);
    // 一轮结束后，这轮的流式片段已经被完整文本覆盖，没必要再留着占内存
    if (ev.type === "result" || ev.type === "error") {
      const kept = buf.filter((e) => e.ev.type !== "delta");
      buf.length = 0;
      buf.push(...kept);
    }
    if (buf.length > BUFFER_MAX) {
      const dropped = buf.splice(0, buf.length - BUFFER_MAX);
      // 记下截断水位：之后再压缩 delta 让数组变短，也不能假装还能补全
      this.truncated.set(key, dropped[dropped.length - 1]!.seq);
    }
    this.emit("event", env);
  }

  currentSeq(): number {
    return this.seq;
  }

  /**
   * seq 之后的事件。返回 null 表示缺口已经超出缓冲区（客户端该整页重新拉历史）。
   */
  eventsSince(key: string, since: number): EventEnvelope[] | null {
    const buf = this.buffers.get(key) ?? [];
    // 客户端没见过的事件里有被截掉的：补不全了
    if (since < (this.truncated.get(key) ?? 0)) return null;
    return buf.filter((e) => e.seq > since);
  }

  /** 正在进行的这一轮（从最后一条用户消息起），给刚打开页面的客户端补画用。 */
  liveTurn(key: string): EventEnvelope[] {
    if (!this.isBusy(key)) return [];
    const buf = this.buffers.get(key) ?? [];
    let start = buf.length;
    for (let i = buf.length - 1; i >= 0; i--) {
      const t = buf[i]!.ev.type;
      if (t === "user") {
        start = i;
        break;
      }
      if (t === "result" || t === "error") {
        start = i + 1;
        break;
      }
      if (i === 0) start = 0;
    }
    return buf.slice(start);
  }

  isBusy(key: string): boolean {
    return (this.inflight.get(key) ?? 0) > 0;
  }

  private setInflight(key: string, n: number): void {
    const before = this.isBusy(key);
    this.inflight.set(key, Math.max(0, n));
    const after = this.isBusy(key);
    if (before !== after) this.emitEvent(key, { type: "state", busy: after });
  }

  // ---------- 会话 ----------

  ensure(params: {
    key: string;
    channel: string;
    channelId: string;
    defaultAgent: string;
    title?: string;
    /** 谁的对话（用户 id）。只有 Web 上新建的有 */
    owner?: string;
  }): Conversation {
    return ensureConversation({
      key: params.key,
      channel: params.channel,
      channelId: params.channelId,
      agent: params.defaultAgent,
      ...(params.title ? { title: params.title } : {}),
      ...(params.owner ? { owner: params.owner } : {}),
    });
  }

  conversation(key: string): Conversation | undefined {
    return getConversation(key);
  }

  info(key: string): ConversationInfo | undefined {
    const conv = getConversation(key);
    if (!conv) return undefined;
    const binding = conv.perAgent[conv.agent] ?? {};
    return {
      key: conv.key,
      ...(conv.title ? { title: conv.title } : {}),
      channel: conv.channel,
      channelId: conv.channelId,
      agent: conv.agent,
      cwd: conv.cwd,
      ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
      ...(binding.model ? { model: binding.model } : {}),
      ...(binding.effort ? { effort: binding.effort } : {}),
      ...(() => {
        const rt = this.displayRuntime(conv, binding);
        return { ...(rt.model ? { runtimeModel: rt.model } : {}), ...(rt.effort ? { runtimeEffort: rt.effort } : {}) };
      })(),
      ...(() => {
        const ctx = binding.sessionId ? this.contextBySession.get(binding.sessionId) : undefined;
        return ctx ? { context: ctx } : {};
      })(),
      ...(() => {
        const usage = usageOf(binding.sessionId);
        return usage ? { usage } : {};
      })(),
      busy: this.isBusy(key),
      activeAt: conv.activeAt,
      createdAt: conv.createdAt,
      ...(conv.hidden ? { hidden: true } : {}),
      ...(conv.forkOf ? { forkOf: conv.forkOf } : {}),
      ...(this.drivers.get(conv.agent)?.forkAt ? { canFork: true } : {}),
      mode: conv.mode ?? "work",
      ...(memoryOwnerOf(conv) ? { personal: true } : {}),
      ...(conv.taskId ? { taskId: conv.taskId } : {}),
      ...(() => {
        const list = listScheduled(key);
        return list.length ? { scheduled: list.map(({ id, text, at }) => ({ id, text, at })) } : {};
      })(),
    };
  }

  /** visible：只列这些（按用户过滤，见 core/users.ts 的 ownedBy） */
  list(visible?: (conv: Conversation) => boolean): ConversationInfo[] {
    return listConversations()
      .filter((c) => !visible || visible(c))
      .map((c) => this.info(c.key)!)
      .sort((a, b) => b.activeAt - a.activeAt);
  }

  /** 取活着的 agent 会话，没有就按绑定拉起（默认续用上次的会话）。 */
  session(key: string, opts: { resumeId?: string; fork?: boolean } = {}): AgentSession {
    const conv = getConversation(key);
    if (!conv) throw new Error(`会话不存在：${key}`);
    // 先检查 agent 还启用着：设置里关掉了，已经打开的会话也不能再用
    const driver = this.requireDriver(conv.agent);
    const existing = this.live.get(key);
    if (existing && existing.agent === conv.agent && existing.cwd === conv.cwd && !opts.resumeId) {
      return existing.session;
    }
    if (existing) {
      interactions.cancelAll(key, "会话已切换");
      this.rememberRuntime(key, existing);
      this.live.delete(key);
      void existing.session.dispose();
    }

    const binding = agentBinding(conv);

    const agentDefaults = (config().agents as Record<string, { defaultModel?: string; defaultEffort?: string }>)[
      conv.agent
    ];
    const model = binding.model || agentDefaults?.defaultModel || undefined;
    const effort = binding.effort || agentDefaults?.defaultEffort || undefined;
    // 有待分叉的记录：从它分叉（见 AgentBinding.forkFrom）
    const pendingFork = !opts.resumeId && binding.forkFrom ? binding.forkFrom : undefined;
    const resumeId = opts.resumeId ?? pendingFork ?? (opts.fork ? undefined : binding.sessionId);
    const fork = opts.fork || !!pendingFork;
    const agent = conv.agent;
    const liveId = ++this.sessionSeq;
    // 被丢弃的旧会话晚到的事件（dispose 时的中断错误等）不该再出现在这条会话里
    const holder: { session?: AgentSession } = {};
    const alive = () => this.live.get(key)?.session === holder.session;

    // 记忆在拉起会话这一刻读一次：会话里 agent 自己记下的，上下文里本来就有；
    // 用户在设置里改了，memoryChanged() 会让空闲的会话下次说话时带着新的重新拉起
    const memory = sessionMemory(conv);
    // 定时任务工具：和记忆一样只给有主人的对话（飞书群聊里谁都能让机器人建任务，算不清是谁的）
    const taskOwner = memoryOwnerOf(conv);
    // 技能也跟着主人走：他启用的技能、填的变量；成员看不到机器上原有的技能（见 skill-runtime.ts）
    const skills = sessionSkills(taskOwner);
    const mode = conv.mode ?? "work";
    // 续着的会话上次被告知的模式和现在不一样（新会话没有历史，算原装的工作模式）
    const announceMode = (resumeId ? (binding.announcedMode ?? "work") : "work") !== mode;
    // 真开始一轮了才算告诉过它（/status 之类也会拉起会话，但什么都没发过去）
    let announced = false;
    const markAnnounced = () => {
      if (announced) return;
      announced = true;
      updateAgentBinding(key, agent, { announcedMode: mode === "work" ? undefined : mode });
    };
    const session = driver.createSession(
      {
        cwd: conv.cwd,
        uploadsDir: ensureUploadsDir(key),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(resumeId ? { resumeId } : {}),
        ...(fork ? { fork: true } : {}),
        ...(conv.autoEdit ? { autoEdit: true } : {}),
        ...(conv.mode === "chat" ? { mode: "chat" as const } : {}),
        ...(memory ? { memory } : {}),
        ...(announceMode ? { announceMode: true } : {}),
        ...(taskOwner ? { tasks: { userId: taskOwner, convKey: key } } : {}),
        ...(skills ? { skills } : {}),
      },
      {
        onTurnStart: () => {
          if (!alive()) return;
          markAnnounced();
          this.emitEvent(key, { type: "turn_start" });
        },
        onStep: (kind, text) => alive() && this.emitEvent(key, { type: "step", kind, text }),
        onTextDelta: (text) => alive() && this.emitEvent(key, { type: "delta", text }),
        onText: (text) => alive() && this.emitEvent(key, { type: "text", text }),
        onResult: (result) => {
          if (!alive()) return;
          const parts = [`用时 ${formatDuration(result.durationMs)}`];
          if (result.costUsd !== undefined) parts.push(`约 $${result.costUsd.toFixed(4)}`);
          if (result.tokens !== undefined) parts.push(`${result.tokens} tokens`);
          const footer = parts.join("　");
          const tag = this.takeTurnTag(key);
          const silent = !!tag?.smart && isSilentReply(result.text);
          this.emitEvent(key, {
            type: "result",
            text: result.text,
            footer,
            at: Date.now(),
            ...(result.anchor ? { anchor: result.anchor } : {}),
            ...(tag ? { task: { id: tag.taskId, title: tag.title } } : {}),
            ...(silent ? { silent: true as const } : {}),
          });
          if (tag) this.emit("task", { ...tag, key, status: silent ? "silent" : "notified", text: result.text });
          const conv = getConversation(key);
          recordFooter(holder.session?.sessionId ?? (conv ? agentBinding(conv, agent).sessionId : undefined), result.text, footer);
          this.setInflight(key, (this.inflight.get(key) ?? 1) - 1);
          this.finishTurn(key);
          this.refreshRuntimeOnce(key, liveId);
          this.syncTitle(key, agent);
          this.dropIfStale(key);
        },
        onError: (err) => {
          if (!alive()) return;
          const diagnosis = driver.diagnose(err);
          if (!this.announced.has(diagnosis.kind)) {
            this.announced.add(diagnosis.kind);
            console.error(`[${agent}] ${diagnosis.consoleHint}`);
          }
          console.error(`[${agent}] ${key} 出错:`, err instanceof Error ? err.message : err);
          // 这一轮已经结束了，挂着的审批没人会再等它
          interactions.cancelAll(key, "本轮出错结束");
          const stopped = Date.now() - (this.stoppedAt.get(key) ?? 0) < 15_000;
          const tag = this.takeTurnTag(key);
          if (tag) {
            this.emit("task", { ...tag, key, status: stopped ? "interrupted" : "error", text: stopped ? "被停止了" : diagnosis.chatMessage });
          }
          if (stopped) {
            // 用户自己点的停止：中断导致的「没能正常收尾」不是故障
            this.emitEvent(key, { type: "notice", text: "已中断。" });
          } else {
            this.emitEvent(key, { type: "error", message: diagnosis.chatMessage });
          }
          this.setInflight(key, (this.inflight.get(key) ?? 1) - 1);
          this.finishTurn(key);
          this.dropIfStale(key);
        },
        onContext: (ctx) => {
          if (!alive()) return;
          const sid = holder.session?.sessionId;
          if (!sid) return;
          const prev = this.contextBySession.get(sid);
          this.contextBySession.delete(sid);
          this.contextBySession.set(sid, ctx);
          if (this.contextBySession.size > CONTEXT_MAX) {
            this.contextBySession.delete(this.contextBySession.keys().next().value!);
          }
          // Codex 一轮里会报好几次，数字没变就不打扰前端
          if (prev?.used !== ctx.used || prev?.window !== ctx.window) this.emitEvent(key, { type: "meta" });
        },
        // 不用另发 meta：一轮结束的 result / error 会把会话信息（含用量）推给页面
        onUsage: (usage, cumulative) => alive() && recordUsage(holder.session?.sessionId, usage, cumulative),
        onDropped: (n) => {
          if (!alive() || n <= 0) return;
          // 丢的是排在最后、还没开始的那 n 条（Codex 先报正在跑的那轮出错、再报丢弃，那时队头已经取走了）
          const tags = this.turnTags.get(key) ?? [];
          for (const tag of tags.splice(Math.max(0, tags.length - n), n)) {
            if (tag) this.emit("task", { ...tag, key, status: "interrupted", text: "排队时被停止了" });
          }
          this.setInflight(key, (this.inflight.get(key) ?? n) - n);
          // 第一条是在跑的那一轮（它自己会报结果），丢的只会是后面排队的
          const fifo = this.turnFifo.get(key) ?? [];
          const k = Math.min(n, Math.max(0, fifo.length - 1));
          for (const e of fifo.splice(fifo.length - k, k)) this.emitEvent(key, { type: "queue", id: e.id, state: "dropped" });
        },
        onSessionId: (sessionId) => {
          // 切走之后旧会话晚到的回调不该覆盖新绑定
          if (!alive()) return;
          const current = getConversation(key);
          const forkFrom = current ? agentBinding(current, agent).forkFrom : undefined;
          // 分叉中还报的是原会话 id：分叉尚未生效，什么都不改
          if (forkFrom && sessionId === forkFrom) return;
          updateAgentBinding(key, agent, { sessionId, forkFrom: undefined });
          recordSessionOwner(sessionId, current?.owner);
          this.emitEvent(key, { type: "meta" });
        },
      },
      // 已经被丢弃的旧进程晚到的提问 / 审批：直接按取消处理，不能挂到新会话上
      (spec: InteractionSpec) =>
        alive()
          ? interactions.create(key, spec, config().approvalTimeoutMs, liveId)
          : Promise.resolve({ settlement: "cancelled" as const, answers: {} }),
    );
    holder.session = session;
    this.live.set(key, { id: liveId, agent, cwd: conv.cwd, session });
    return session;
  }

  /**
   * 自动标题换成 agent 自己起的。agent 的标题是异步生成的，一轮结束时未必已经有了，
   * 所以隔一会儿再问几次。每轮结束都会再同步一次：agent 后来改了标题（比如在终端里 /rename）也能跟上。
   */
  private syncTitle(key: string, agent: string, attempt = 0): void {
    const delays = [1_000, 5_000, 15_000, 45_000];
    const driver = this.drivers.get(agent);
    if (!driver?.sessionTitle) return;
    if (attempt === 0) {
      if (this.titleSyncing.has(key)) return; // 上一轮的重试还在跑
      this.titleSyncing.add(key);
    }
    if (attempt >= delays.length) {
      this.titleSyncing.delete(key);
      return;
    }
    setTimeout(() => {
      void (async () => {
        const conv = getConversation(key);
        const sessionId = conv && conv.agent === agent ? agentBinding(conv, agent).sessionId : undefined;
        if (!conv?.titleAuto || !sessionId) return this.titleSyncing.delete(key);
        const title = await driver.sessionTitle!(sessionId, conv.cwd).catch((err) => {
          console.error(`[${agent}] 读取会话标题失败:`, err instanceof Error ? err.message : err);
          return undefined;
        });
        // 等待期间用户可能改了名、切了会话
        const now = getConversation(key);
        if (!now?.titleAuto || now.agent !== agent || agentBinding(now, agent).sessionId !== sessionId) {
          return this.titleSyncing.delete(key);
        }
        if (!title) return this.syncTitle(key, agent, attempt + 1);
        this.titleSyncing.delete(key);
        const clipped = title.slice(0, 80);
        if (clipped !== now.title) {
          updateConversation(key, { title: clipped });
          this.emitEvent(key, { type: "meta" });
        }
      })();
    }, delays[attempt]);
  }

  /** 丢掉活着的会话（不动绑定）。挂着的审批一并取消，否则阻塞的那一轮永远走不完。 */
  async drop(key: string, note: string): Promise<void> {
    interactions.cancelAll(key, note);
    const existing = this.live.get(key);
    if (existing) this.rememberRuntime(key, existing);
    this.live.delete(key);
    for (const tag of this.turnTags.get(key) ?? []) if (tag) this.emit("task", { ...tag, key, status: "interrupted", text: note });
    this.turnTags.delete(key);
    this.clearFifo(key);
    this.setInflight(key, 0);
    if (!existing) return;
    // dispose 卡住（CLI 不响应）不能把这条会话的操作队列永远堵死
    await Promise.race([
      existing.session.dispose().catch(() => {}),
      new Promise((r) => setTimeout(r, 10_000).unref()),
    ]);
  }

  /**
   * 同一条会话的生命周期操作（开新会话、切目录、切 agent、恢复、发消息…）串行执行。
   *
   * 不串行的话：/cd 正在等旧会话 dispose，另一个渠道恰好发来一条消息，就会用旧目录
   * 拉起一个新会话；/cd 随后只改了记录，实际进程却还在旧目录里干活。
   */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tail = next.catch(() => {});
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return next;
  }

  // ---------- 说话 ----------

  /**
   * 送一句话进会话。
   *
   * 提问挂着的时候整轮是阻塞的，这条消息送进去也没人接 —— 所以先拿它当作答。
   * 带附件的不拿来作答：答案只能是文字。
   */
  /** 当前的停止代次 */
  stopGeneration(key: string): number {
    return this.stopGen.get(key) ?? 0;
  }

  /** 渠道在「收到消息」那一刻取，送进 send 的 gen 参数 */
  generation(key: string): InputGen {
    return { stop: this.stopGeneration(key), boundary: this.opSeq.get(key) ?? 0, at: Date.now() };
  }

  private nextOp(key: string): number {
    const seq = (this.opSeq.get(key) ?? 0) + 1;
    this.opSeq.set(key, seq);
    return seq;
  }

  /** 收到这条输入之后发起的切换里，有没有已经真正生效的 */
  private switchedSince(key: string, g: InputGen): boolean {
    return (this.lastSwitch.get(key)?.seq ?? 0) > g.boundary;
  }

  /** 当前活着的会话进程编号（交互请求绑定到它） */
  liveSessionId(key: string): number | undefined {
    return this.live.get(key)?.id;
  }

  /** 序号为 seq 的切换真的生效了（不是「操作被调用了」—— 没实际效果的操作不算） */
  private markSwitched(key: string, seq: number): void {
    const prev = this.lastSwitch.get(key);
    this.lastSwitch.set(key, { seq: Math.max(prev?.seq ?? 0, seq), at: Date.now() });
  }

  /**
   * 切换类操作的统一入口：调用那一刻记下「有一个切换在排队」和发起时刻（清上传目录用），
   * 进串行队列执行，结束后撤掉排队计数。真正换没换会话由操作自己 markSwitched。
   */
  private switchOp<T>(key: string, fn: (op: { at: number; seq: number }) => Promise<T>): Promise<T> {
    const op = { at: Date.now(), seq: this.nextOp(key) };
    this.pendingOps.set(key, (this.pendingOps.get(key) ?? 0) + 1);
    return this.serial(key, () => fn(op)).finally(() => {
      this.pendingOps.set(key, Math.max(0, (this.pendingOps.get(key) ?? 1) - 1));
    });
  }

  /**
   * 切换类操作清上传目录：只清这次操作发起之前就有的文件。切换途中刚收到的附件
   * 属于切换之后的新消息，不能一起删掉。截止时间由各操作在入口自己捕获后传进来，
   * 不读共享状态 —— 否则后面再来一条命令就会把它覆盖掉。
   */
  private clearOldUploads(key: string, before: number): void {
    clearUploads(key, [], before);
  }

  /**
   * gen：这条消息是在哪个停止代次下收到的。渠道自己还要先做点异步的事（飞书下载附件）
   * 才调到这里时必须传：下载期间点了停止，这条消息就不该再发出去。
   */
  send(key: string, input: UserInput, origin: Origin, gen?: InputGen, opts: { task?: TaskTurn } = {}): void {
    const conv = getConversation(key);
    if (!conv) throw new Error(`会话不存在：${key}`);
    const task = opts.task;
    // 用户自定义命令（设置 → 命令）：展开成预设的提示词再发，界面上和 agent 收到的都是展开后的内容
    const custom = (config().commands as Record<string, CommandPrefs | undefined>)[conv.agent]?.custom;
    const expanded = expandCustomCommand(input.text, custom);
    if (expanded !== null) input = { ...input, text: expanded };
    const g = gen ?? this.generation(key);
    const cancelled = () => {
      if (this.stopGeneration(key) !== g.stop) {
        this.emitEvent(key, { type: "notice", text: "已停止，这条消息没有发出。" });
        return true;
      }
      // 收到这条之后才发起的切换生效了（新会话 / 分叉 / 恢复 / 切 agent / 切目录 / 改了工作区根目录）：
      // 这条是冲着旧会话说的，不能送进新的里去
      if (this.switchedSince(key, g)) {
        this.emitEvent(key, {
          type: "notice",
          text: "这条消息处理期间会话被切换了（新会话 / 目录 / agent 变了），它没有发出，请重新发送。",
        });
        return true;
      }
      return false;
    };
    // 最先检查：停止之前收到的旧消息，不能去回答停止之后新冒出来的提问
    if (cancelled()) {
      if (task) this.emit("task", { ...task, key, status: "interrupted", text: "没有发出（停止了或者会话被切换了）" });
      return;
    }
    const shown = {
      type: "user" as const,
      // 附给 agent 的背景（定时任务的说明）不显示
      text: stripContext(input.text),
      attachments: input.attachments.map((a) => `${KIND_LABEL[a.kind]} ${a.name}`),
      files: input.attachments.map(attachmentInfo),
      origin,
      id: `m${++this.msgSeq}`,
      queued: false,
    };
    const by = `${origin.name ?? "用户"}以消息作答`;

    /**
     * 拿这条消息回答挂着的提问。条件：提问属于当前活着的会话进程、这条消息收到后
     * 没有切换生效过；expectId 给了的话，还必须正是收到时挂着的那一个（不能去回答后来才冒出的新提问）。
     */
    const tryAnswer = (expectId?: string): boolean => {
      // 定时任务的提示词不是给挂着的提问的回答
      if (task || input.attachments.length > 0) return false;
      const asking = interactions.findQuestion(key);
      if (!asking || asking.owner === undefined || asking.owner !== this.liveSessionId(key)) return false;
      if (expectId !== undefined && asking.id !== expectId) return false;
      if (this.switchedSince(key, g)) return false;
      return interactions.answerWithText(asking.id, input.text, by);
    };

    // 没有排队中的切换：能作答就立刻作答。有的话先排队，轮到它时再判断 ——
    // 那个切换可能是无效操作（会话没变，提问还在等），也可能真的换了会话（那就不该作答）
    const pending = (this.pendingOps.get(key) ?? 0) > 0;
    if (!pending && tryAnswer()) {
      this.emitEvent(key, shown);
      return;
    }
    const questionAtEntry = pending && input.attachments.length === 0 ? interactions.findQuestion(key)?.id : undefined;

    // 闲置过期要按这次说话之前的活跃时间判断，所以先记下、后 touch
    const lastActive = conv.activeAt;
    touchConversation(key);
    if (!conv.title && conv.channel === "web" && shown.text.trim()) {
      // 先用首条消息占位，第一轮结束后换成 agent 自己生成的短标题（syncTitle）
      updateConversation(key, { title: shown.text.trim().replace(/\s+/g, " ").slice(0, 40), titleAuto: true });
      this.emitEvent(key, { type: "meta" });
    }
    // 前面有在跑的、或者还在串行队列里等着的：这条要排队
    shown.queued = this.isBusy(key) || (this.waitingSends.get(key) ?? 0) > 0;
    this.emitEvent(key, shown);
    const dropped = () => this.emitEvent(key, { type: "queue", id: shown.id, state: "dropped" });
    const gone = (text: string) => {
      dropped();
      if (task) this.emit("task", { ...task, key, status: "interrupted", text });
    };
    this.waitingSends.set(key, (this.waitingSends.get(key) ?? 0) + 1);
    void this.serial(key, async () => {
      try {
        if (cancelled()) return gone("没有发出（停止了或者会话被切换了）");
        if (questionAtEntry && tryAnswer(questionAtEntry)) {
          // 被当成提问的回答用掉了：不再排队
          if (shown.queued) this.emitEvent(key, { type: "queue", id: shown.id, state: "started" });
          return;
        }
        // 收到之后发生过显式切换（恢复 / 分叉 / 新会话…）：用户已经明确指定了会话，不再按旧的闲置时间作废它。
        // 定时任务也不按闲置过期：每天跑一次的任务要接着上次的上下文
        const ttl = config().sessionTtlMs;
        const switchedAfterEntry = (this.lastSwitch.get(key)?.at ?? 0) >= g.at;
        const expired = !task && !switchedAfterEntry && ttl > 0 && Date.now() - lastActive > ttl;
        if (expired) {
          await this.expireNow(key);
          // 清理要等旧会话 dispose，期间可能又点了停止
          if (cancelled()) return dropped();
        }
        const blocked = await this.blockedSlash(key, input.text);
        if (blocked) {
          this.emitEvent(key, { type: "notice", text: blocked });
          return gone(blocked);
        }
        this.sendNow(key, this.withMentions(key, input), task ?? null, { id: shown.id, queued: shown.queued });
      } finally {
        this.waitingSends.set(key, Math.max(0, (this.waitingSends.get(key) ?? 1) - 1));
      }
    });
  }

  /**
   * 消息里 @ 了技能：附一段背景告诉 agent 用哪个、怎么用（用户看不到，见 skill-runtime.ts 的 mentionContext）。
   * 按发出去这一刻对话的 agent 和模式拼：排队期间可能刚切过。
   */
  private withMentions(key: string, input: UserInput): UserInput {
    const conv = getConversation(key);
    if (!conv) return input;
    const lines = mentionContext(stripContext(input.text), { owner: memoryOwnerOf(conv), agent: conv.agent, mode: conv.mode ?? "work" });
    return lines ? { ...input, text: `${input.text}\n\n${wrapContext(lines)}` } : input;
  }

  /** 成员直接发「/机器上的技能」：Claude 会绕过技能白名单把它展开，这里先拦下。返回拦下的原因 */
  private async blockedSlash(key: string, text: string): Promise<string | null> {
    const m = /^[/／](\S+)/.exec(text.trim());
    if (!m) return null;
    const conv = getConversation(key);
    if (!conv || conv.agent !== "claude" || conv.mode === "chat") return null;
    const owner = memoryOwnerOf(conv);
    if (!owner || getUser(owner)?.role === "admin") return null;
    const driver = this.enabledAgents().find((d) => d.id === conv.agent);
    if (!driver?.commands) return null;
    const native = await withTimeout(driver.commands(conv.cwd), "读取命令列表").catch(() => [] as AgentCommand[]);
    return isMachineCommand(m[1]!, native, conv.cwd) ? `/${m[1]} 是这台机器上装的技能，只有管理员能用。` : null;
  }

  /** 刚点过停止（被打断的那一轮还可能晚到一个出错，见 onError 里的 stopped） */
  recentlyStopped(key: string): boolean {
    return Date.now() - (this.stoppedAt.get(key) ?? 0) < 15_000;
  }

  /** 这条会话里正在跑的那一轮是不是定时任务发起的 */
  currentTaskTurn(key: string): TaskTurn | undefined {
    return this.turnTags.get(key)?.[0] ?? undefined;
  }

  private takeTurnTag(key: string): TaskTurn | null {
    const tags = this.turnTags.get(key);
    const tag = tags?.shift() ?? null;
    if (tags && tags.length === 0) this.turnTags.delete(key);
    return tag;
  }

  /** 闲置太久：不再续用上次的会话（活着的也丢掉），开新的 */
  private async expireNow(key: string): Promise<void> {
    const conv = getConversation(key);
    if (!conv || !(agentBinding(conv).sessionId || agentBinding(conv).forkFrom)) return;
    console.log(`[会话] ${key} 闲置超过 ${config().sessionTtlMs / 3600000} 小时，开新会话`);
    await this.drop(key, "会话已闲置过期");
    updateAgentBinding(key, conv.agent, { sessionId: undefined, forkFrom: undefined, model: undefined, effort: undefined });
    // 不清上传目录：本次和排在后面的消息可能都带着刚上传的附件。
    // 旧附件留到 /new 或下次启动的清扫时再删。
    this.emitEvent(key, { type: "notice", text: "上次的会话闲置太久，已自动开新会话。" });
    this.emitEvent(key, { type: "meta" });
  }

  /** msg：页面上那条消息的编号和收到时是否排队（见 send 里的 shown） */
  private sendNow(key: string, input: UserInput, tag: TaskTurn | null, msg: { id: string; queued: boolean }): void {
    const fail = (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.emitEvent(key, { type: "error", message });
      if (tag) this.emit("task", { ...tag, key, status: "error", text: message });
    };
    let session: AgentSession;
    try {
      session = this.session(key);
    } catch (err) {
      fail(err);
      return;
    }
    this.setInflight(key, (this.inflight.get(key) ?? 0) + 1);
    const tags = this.turnTags.get(key) ?? [];
    tags.push(tag);
    this.turnTags.set(key, tags);
    const fifo = this.turnFifo.get(key) ?? [];
    fifo.push({ id: msg.id, input, queued: msg.queued });
    this.turnFifo.set(key, fifo);
    try {
      session.send(input);
    } catch (err) {
      tags.pop();
      fifo.pop();
      this.setInflight(key, (this.inflight.get(key) ?? 1) - 1);
      fail(err);
      return;
    }
    // 收到时在排队（前面的在串行队列里等着），交出去时前面已经空了：这就开始了
    if (fifo.length === 1 && msg.queued) {
      fifo[0]!.queued = false;
      this.emitEvent(key, { type: "queue", id: msg.id, state: "started" });
    }
  }

  notice(key: string, text: string): void {
    this.emitEvent(key, { type: "notice", text });
  }

  // ---------- 操作（命令和 Web 按钮共用） ----------

  private async runtimeNow(key: string): Promise<RuntimeInfo> {
    const conv = getConversation(key)!;
    const driver = this.requireDriver(conv.agent);
    const binding = agentBinding(conv);
    let runtime: RuntimeInfo = {};
    try {
      runtime = await withTimeout(this.session(key).describeRuntime(), "读取模型信息");
    } catch (err) {
      console.error("[会话] 读取模型信息失败:", err);
    }
    const defaults = (config().agents as Record<string, { defaultModel?: string; defaultEffort?: string }>)[
      conv.agent
    ];
    const fallback =
      runtime.model && runtime.effort
        ? {}
        : await withTimeout(driver.defaults(), "读取默认配置").catch(() => ({}) as RuntimeInfo);
    const model = runtime.model ?? binding.model ?? (defaults?.defaultModel || undefined) ?? fallback.model;
    const effort = runtime.effort ?? binding.effort ?? (defaults?.defaultEffort || undefined) ?? fallback.effort;
    if (runtime.model || runtime.effort) this.lastRuntime.set(key, { agent: conv.agent, runtime });
    return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  }

  private async newSessionNow(key: string, model: string | undefined, op: SwitchOp): Promise<string> {
    const conv = getConversation(key)!;
    await this.drop(key, "已开新会话");
    this.markSwitched(key, op.seq);
    updateAgentBinding(key, conv.agent, { sessionId: undefined, forkFrom: undefined, model: model || undefined, effort: undefined });
    this.clearOldUploads(key, op.at);
    this.emitEvent(key, { type: "meta" });
    const runtime = await this.runtimeNow(key);
    return `已开新会话（${this.label(conv.agent)}，模型 ${runtime.model ?? "默认"}${
      runtime.effort ? `，思考 ${runtime.effort}` : ""
    }）。`;
  }

  private async forkNow(key: string, op: SwitchOp): Promise<string> {
    const conv = getConversation(key)!;
    const binding = agentBinding(conv);
    const current = binding.forkFrom ?? binding.sessionId;
    if (!current) return "当前还没有可分叉的会话。";
    await this.drop(key, "已分叉会话");
    this.markSwitched(key, op.seq);
    // 只记下意图，下一条消息时才真正分叉（见 session() 里的 pendingFork）
    updateAgentBinding(key, conv.agent, { forkFrom: current });
    touchConversation(key);
    this.emitEvent(key, { type: "meta" });
    return "已分叉，原会话保留。下一条消息起在分叉出来的新会话里继续。";
  }

  private async resumeNow(key: string, sessionId: string, originCwd: string | undefined, op: SwitchOp): Promise<string> {
    const conv = getConversation(key)!;
    const driver = this.requireDriver(conv.agent);
    if (!(await withTimeout(driver.sessionExists(sessionId, conv.cwd), "查询会话"))) {
      return `找不到会话 ${sessionId}。\n发 /sessions 看看有哪些可恢复的。`;
    }
    await this.drop(key, "会话已切换");
    this.markSwitched(key, op.seq);
    if (sessionId !== agentBinding(conv).sessionId) this.clearOldUploads(key, op.at);
    updateAgentBinding(key, conv.agent, { sessionId, forkFrom: undefined });
    // 显式恢复 = 用户要接着它聊：刷新活跃时间，否则下一条消息会按恢复前的闲置时间判成过期
    touchConversation(key);
    this.session(key, { resumeId: sessionId });
    this.emitEvent(key, { type: "meta" });
    const note =
      originCwd && originCwd !== conv.cwd
        ? `\n\n注意：这条会话原本在 \`${originCwd}\`，恢复后会在 \`${conv.cwd}\` 里继续 —— 上下文都在，但读写范围跟着当前工作目录走。`
        : "";
    return `已恢复会话 ${sessionId}，直接接着说就行。${note}`;
  }

  /** visible：这个用户能看到哪些 agent 会话（多用户时按人过滤）。不给就是全部 */
  async sessions(
    key: string,
    all: boolean,
    visible?: (sessionId: string) => boolean,
  ): Promise<Extract<CommandReply, { type: "sessions" }>> {
    const conv = getConversation(key)!;
    const driver = this.requireDriver(conv.agent);
    // 要过滤的话多拿一些，滤完再截到 10 条
    const list = async (cwd: string | undefined) =>
      visible ? (await driver.listSessions(cwd, 100)).filter((s) => visible(s.id)).slice(0, 10) : driver.listSessions(cwd, 10);
    // 先按当前目录列，一条都没有就自动退回全局 —— 回一句「没有历史」是误导
    let sessions = all ? [] : await list(conv.cwd);
    const fellBack = !all && sessions.length === 0;
    if (all || fellBack) sessions = await list(undefined);
    const current = agentBinding(conv).sessionId;
    return {
      type: "sessions",
      agent: conv.agent,
      sessions,
      ...(current ? { current } : {}),
      cwd: conv.cwd,
      allDirs: all || fellBack,
      fellBack,
    };
  }

  private async modelsNow(key: string): Promise<Extract<CommandReply, { type: "models" }>> {
    const conv = getConversation(key)!;
    const driver = this.requireDriver(conv.agent);
    const models = await withTimeout(driver.listModels(this.session(key)), "读取模型列表");
    const runtime = await this.runtimeNow(key);
    return {
      type: "models",
      agent: conv.agent,
      models,
      ...(runtime.model ? { current: runtime.model } : {}),
      ...(runtime.effort ? { currentEffort: runtime.effort } : {}),
      effortSupported: driver.capabilities.effort,
    };
  }

  private async setModelNow(key: string, model: string): Promise<string> {
    const conv = getConversation(key)!;
    await withTimeout(this.session(key).setModel(model), "切换模型");
    updateAgentBinding(key, conv.agent, { model });
    this.emitEvent(key, { type: "meta" });
    return `模型已切换为 ${model}。`;
  }

  private async setEffortNow(key: string, effort: string): Promise<string> {
    const conv = getConversation(key)!;
    const driver = this.requireDriver(conv.agent);
    if (!driver.capabilities.effort) return `${driver.label} 不支持切换思考程度。`;
    await withTimeout(this.session(key).setModel(undefined, effort), "切换思考程度");
    updateAgentBinding(key, conv.agent, { effort });
    this.emitEvent(key, { type: "meta" });
    return `思考程度已切换为 ${effort}。`;
  }

  /** /autoedit：on 不给就是切换。只影响正在跑的会话和以后新建的，不追溯已经弹出的授权。 */
  private async setAutoEditNow(key: string, on: boolean | undefined): Promise<string> {
    const conv = getConversation(key)!;
    const next = on ?? !conv.autoEdit;
    const live = this.live.get(key);
    if (live?.session.setAutoEdit) await withTimeout(live.session.setAutoEdit(next), "切换自动改文件");
    updateConversation(key, { autoEdit: next });
    this.emitEvent(key, { type: "meta" });
    const driver = this.requireDriver(conv.agent);
    const note =
      conv.agent === "codex"
        ? `\n\n注意：${driver.label} 改文件由沙箱控制（设置 → Agent → 沙箱），这个开关只对 Claude 生效。`
        : "";
    return next
      ? `已开启：这条对话里 Claude 修改工作目录（${conv.cwd}）内的文件不再询问；目录外的文件、Bash 命令照常询问。发 /autoedit off 关闭。${note}`
      : `已关闭：改文件恢复逐次询问。${note}`;
  }

  setAutoEdit(key: string, on?: boolean): Promise<string> {
    return this.serial(key, () => this.setAutoEditNow(key, on));
  }

  // ---------- 聊天 / 工作模式 ----------

  /**
   * /chat、/work。同一条对话、同一个 agent 会话接着聊：丢掉活着的进程，下一条消息带着新模式的
   * 系统提示和工具 resume 回来（Claude、Codex 都实测过能接上上下文）。正在回复时不切：
   * 丢进程会把这一轮打断。
   */
  private async setModeNow(key: string, mode: ConversationMode): Promise<string> {
    const conv = getConversation(key)!;
    if ((conv.mode ?? "work") === mode) {
      return mode === "chat" ? "已经是💬 聊天模式了。发 /work 切到工作模式。" : "已经是🛠 工作模式了。发 /chat 切到聊天模式。";
    }
    if (this.isBusy(key)) return "正在回复，等这一轮结束（或者先 /stop）再切换模式。";
    // 聊过的聊天对话切到工作模式：之后再回聊天模式就省不了了（Web 上点按钮时会先问，命令直接切，提醒一句）
    const hadChat = mode === "work" && !!agentBinding(conv).sessionId;
    await this.drop(key, "已切换模式");
    updateConversation(key, { mode: mode === "chat" ? "chat" : undefined });
    this.emitEvent(key, { type: "meta" });
    return mode === "chat"
      ? "已切到💬 聊天模式：精简的系统提示，只能联网搜索，不执行命令、不读写文件，每轮的开销小很多。上下文接着之前的。要动手干活时发 /work。"
      : `已切到🛠 工作模式：${this.label(conv.agent)} 原装的全部能力（执行命令、改文件、技能、MCP）。上下文接着之前的。发 /chat 切回聊天模式。${
          hadChat ? "\n\n提示：工作模式会在这条会话里留下一大段背景，之后再切回聊天模式就省不了多少了。干完活想回到省 token 的聊天，发 /new 开个新会话再发 /chat。" : ""
        }`;
  }

  setMode(key: string, mode: ConversationMode): Promise<string> {
    return this.serial(key, () => this.setModeNow(key, mode));
  }

  // ---------- 记忆变了 / 主人变了 ----------

  /** 记忆过期了的会话进程（Live.id）：空闲下来就丢掉，下次说话带着新记忆重新拉起 */
  private staleLive = new Set<number>();

  private dropIfStale(key: string): void {
    const live = this.live.get(key);
    if (!live || !this.staleLive.has(live.id) || this.isBusy(key)) return;
    this.staleLive.delete(live.id);
    void this.serial(key, async () => {
      // 排队期间可能已经换了进程、或者又开始说话了：那就留到下一轮结束
      const now = this.live.get(key);
      if (now?.id !== live.id) return;
      if (this.isBusy(key)) {
        this.staleLive.add(live.id);
        return;
      }
      await this.drop(key, "记忆或技能已更新");
    });
  }

  /**
   * 用户在设置里改了记忆（关于我、增删条目、开关）：他名下活着的会话都要换上新的。
   * agent 自己用 remember / forget 改的不走这里 —— 那些本来就在上下文里，没必要重启进程、白白丢掉提示缓存。
   */
  memoryChanged(userId: string): void {
    this.personalChanged(new Set([userId]));
  }

  /** 这些人的记忆或技能变了：他们名下活着的会话空闲下来就重新拉起 */
  private personalChanged(users: Set<string>): void {
    for (const [key, live] of this.live) {
      const conv = getConversation(key);
      const owner = conv ? memoryOwnerOf(conv) : undefined;
      if (!owner || !users.has(owner)) continue;
      this.staleLive.add(live.id);
      this.dropIfStale(key);
    }
  }

  /**
   * 对话换主人（飞书私聊绑定 / 解绑 / 换绑账号时）。返回有没有变。
   * 旧主人的 agent 会话不能交给新主人接着用（上下文里是旧主人的话和记忆），绑定清掉、下条消息开新的；
   * 唯一的例外是从「没主（归管理员）」变成某个管理员自己：那些会话本来就是他能看的。
   * 同步改记录（紧接着的消息要按新主人处理），丢进程排进串行队列。
   */
  reassignOwner(key: string, owner: string | undefined): boolean {
    const conv = getConversation(key);
    if (!conv || conv.owner === owner) return false;
    const keep = !conv.owner && !!owner && getUser(owner)?.role === "admin";
    const perAgent = keep
      ? conv.perAgent
      : Object.fromEntries(Object.entries(conv.perAgent).map(([a, b]) => [a, { ...b, sessionId: undefined, forkFrom: undefined }]));
    updateConversation(key, { owner, perAgent });
    void this.switchOp(key, async (op) => {
      await this.drop(key, "对话换了主人");
      this.markSwitched(key, op.seq);
      this.emitEvent(key, { type: "meta" });
    });
    return true;
  }

  /** 切 agent：各 agent 的会话各自保留，切回来接着聊。 */
  private async setAgentNow(key: string, agent: string, allowed: string[], op: SwitchOp): Promise<string> {
    const conv = getConversation(key)!;
    if (!allowed.includes(agent)) {
      return `这里不能用「${agent}」。可选：${allowed.join("、")}`;
    }
    this.requireDriver(agent);
    if (conv.agent === agent) return `当前已经是 ${this.label(agent)}。`;
    await this.drop(key, `已切换到 ${this.label(agent)}`);
    this.markSwitched(key, op.seq);
    updateConversation(key, { agent });
    this.emitEvent(key, { type: "meta" });
    const resumed = agentBinding(getConversation(key)!, agent).sessionId;
    return `已切换到 ${this.label(agent)}${resumed ? "，接着它上次的会话" : ""}。`;
  }

  async stop(key: string): Promise<string> {
    // 不进串行队列：停止要立刻生效。排队中还没送出的消息靠代次作废
    this.stopGen.set(key, (this.stopGen.get(key) ?? 0) + 1);
    this.stoppedAt.set(key, Date.now());
    interactions.cancelAll(key, "本轮已中断");
    await this.live.get(key)?.session.interrupt();
    // 和 inflight 一起清零：被打断的那一轮不一定还会报结果，留着的话下一轮的结果会被当成定时任务的
    for (const tag of this.turnTags.get(key) ?? []) if (tag) this.emit("task", { ...tag, key, status: "interrupted", text: "被停止了" });
    this.turnTags.delete(key);
    this.clearFifo(key);
    this.setInflight(key, 0);
    return "已请求中断。";
  }

  /**
   * 打断并发送：停掉正在跑的这一轮，排着队的 id 这条挪到最前面，马上处理它；其余排着的照常接在后面。
   * 和停止不同，不丢排队的消息、也不清计数 —— 被打断的这一轮会正常报结果（已中断），之后就轮到它
   */
  async jump(key: string, id: string): Promise<string> {
    const fifo = this.turnFifo.get(key) ?? [];
    const idx = fifo.findIndex((e) => e.id === id);
    if (idx === 0) return "这条已经在处理了。";
    const live = this.live.get(key);
    if (idx < 0 || !live) return "这条消息已经不在排队了。";
    const [entry] = fifo.splice(idx, 1);
    fifo.splice(1, 0, entry!);
    // turnTags 和 fifo 一一对应，一起挪
    const tags = this.turnTags.get(key);
    if (tags && tags.length === fifo.length) tags.splice(1, 0, ...tags.splice(idx, 1));
    this.stoppedAt.set(key, Date.now());
    interactions.cancelAll(key, "本轮已中断");
    await live.session.interrupt({ keepQueue: true, first: entry!.input });
    return "已打断，马上处理这条。";
  }

  /** 一轮出结果了：队首出队，下一条要是排过队的，告诉页面轮到它了 */
  private finishTurn(key: string): void {
    const fifo = this.turnFifo.get(key);
    if (!fifo) return;
    fifo.shift();
    const next = fifo[0];
    if (next?.queued) {
      next.queued = false;
      this.emitEvent(key, { type: "queue", id: next.id, state: "started" });
    }
    if (fifo.length === 0) this.turnFifo.delete(key);
  }

  /** 停止 / 会话丢了：在跑的那条不管（它的结果或中断自己会报），排着队的都没发出 */
  private clearFifo(key: string): void {
    for (const e of (this.turnFifo.get(key) ?? []).slice(1)) this.emitEvent(key, { type: "queue", id: e.id, state: "dropped" });
    this.turnFifo.delete(key);
  }

  private async cdNow(key: string, dir: string, op: SwitchOp): Promise<string> {
    const resolved = resolveWorkspacePath(dir);
    if (!resolved) return `不允许：目录必须存在，且在 ${config().workspaceRoot} 之内（不能经符号链接跳出去）。`;
    const conv = getConversation(key)!;
    await this.drop(key, "工作目录已切换");
    this.markSwitched(key, op.seq);
    // 会话记录是按目录存的，换目录后旧会话 resume 不回来，干脆都清掉
    const perAgent = Object.fromEntries(
      Object.entries(conv.perAgent).map(([a, b]) => [a, { ...b, sessionId: undefined, forkFrom: undefined }]),
    );
    updateConversation(key, { cwd: resolved, cwdExplicit: true, perAgent });
    this.clearOldUploads(key, op.at);
    this.emitEvent(key, { type: "meta" });
    return `工作目录已切换到 ${resolved}，下条消息将开新会话。`;
  }

  private async statusNow(key: string): Promise<string> {
    const conv = getConversation(key)!;
    const driver = this.requireDriver(conv.agent);
    const runtime = await this.runtimeNow(key);
    const extra = await withTimeout(driver.statusLines(), "读取状态").catch(() => [] as string[]);
    const memoryOwner = memoryOwnerOf(conv);
    const memoryLine = !memoryOwner
      ? conv.channel === "feishu"
        ? "记忆：不用（群聊，或者没绑定账号的私聊）"
        : "记忆：不用（这条对话没有主人）"
      : readMemory(memoryOwner).enabled
        ? `记忆：开（${getUser(memoryOwner)?.name ?? memoryOwner} 的）`
        : "记忆：主人关掉了";
    return [
      `模式：${conv.mode === "chat" ? "💬 聊天（/work 切到工作模式）" : "🛠 工作（/chat 切到聊天模式）"}`,
      memoryLine,
      `Agent：${driver.label}`,
      `会话：${agentBinding(conv).sessionId ?? "(尚未建立)"}`,
      `目录：${conv.cwd}`,
      `模型：${runtime.model ?? "默认"}`,
      ...(runtime.effort ? [`思考程度：${runtime.effort}`] : []),
      ...(conv.autoEdit ? ["自动允许改文件：开（/autoedit off 关闭）"] : []),
      ...(extra.length > 0 ? ["", ...extra] : []),
    ].join("\n");
  }

  async history(key: string): Promise<HistoryMessage[]> {
    const conv = getConversation(key);
    if (!conv) return [];
    const sessionId = agentBinding(conv).sessionId;
    if (!sessionId) return [];
    const driver = this.requireDriver(conv.agent);
    try {
      return attachFooters(sessionId, await driver.readHistory(sessionId, conv.cwd));
    } catch (err) {
      console.error(`[历史] 读取 ${key} 失败:`, err);
      return [];
    }
  }

  // ---------- 对外的操作：都经过 serial() ----------

  runtime(key: string): Promise<RuntimeInfo> {
    return this.serial(key, () => this.runtimeNow(key));
  }

  newSession(key: string, model?: string): Promise<string> {
    return this.switchOp(key, (op) => this.newSessionNow(key, model, op));
  }

  fork(key: string): Promise<string> {
    return this.switchOp(key, (op) => this.forkNow(key, op));
  }

  /**
   * 分叉成一条新的 Web 对话：agent 会话复制一份（给了 anchor 就只到那条回复为止），
   * 原对话完全不动。返回新对话的 key。和 /fork 不同 —— /fork 是在同一条对话里换成分叉出来的会话。
   */
  /** owner：新对话归谁（分叉的人）。不给就沿用原对话的 */
  async forkConversation(key: string, anchor?: string, owner?: string): Promise<string> {
    const conv = getConversation(key);
    if (!conv) throw new Error(`会话不存在：${key}`);
    const driver = this.requireDriver(conv.agent);
    if (!driver.forkAt) throw new Error(`${driver.label} 不支持从这里分叉`);
    const binding = agentBinding(conv);
    // /fork 之后还没发消息：真正的内容还在原会话里
    const source = binding.sessionId ?? binding.forkFrom;
    if (!source) throw new Error("这条对话还没有可分叉的会话");
    const sessionId = await withTimeout(driver.forkAt(source, conv.cwd, anchor), "分叉会话");
    copyFooters(source, sessionId);
    owner ??= conv.owner;
    const newKey = `web:${crypto.randomBytes(6).toString("hex")}`;
    ensureConversation({ key: newKey, channel: "web", channelId: "web", agent: conv.agent, ...(owner ? { owner } : {}) });
    recordSessionOwner(sessionId, owner);
    updateConversation(newKey, {
      title: `${conv.title ?? "会话"} · 分叉`.slice(0, 80),
      cwd: conv.cwd,
      ...(conv.cwdExplicit ? { cwdExplicit: true } : {}),
      ...(conv.autoEdit ? { autoEdit: true } : {}),
      ...(conv.mode ? { mode: conv.mode } : {}),
      forkOf: key,
      perAgent: {
        [conv.agent]: {
          sessionId,
          ...(binding.model ? { model: binding.model } : {}),
          ...(binding.effort ? { effort: binding.effort } : {}),
        },
      },
    });
    this.emitEvent(newKey, { type: "meta" });
    return newKey;
  }

  resume(key: string, sessionId: string, originCwd?: string): Promise<string> {
    return this.switchOp(key, (op) => this.resumeNow(key, sessionId, originCwd, op));
  }

  models(key: string): Promise<Extract<CommandReply, { type: "models" }>> {
    return this.serial(key, () => this.modelsNow(key));
  }

  setModel(key: string, model: string): Promise<string> {
    return this.serial(key, () => this.setModelNow(key, model));
  }

  setEffort(key: string, effort: string): Promise<string> {
    return this.serial(key, () => this.setEffortNow(key, effort));
  }

  setAgent(key: string, agent: string, allowed: string[]): Promise<string> {
    return this.switchOp(key, (op) => this.setAgentNow(key, agent, allowed, op));
  }

  cd(key: string, dir: string): Promise<string> {
    return this.switchOp(key, (op) => this.cdNow(key, dir, op));
  }

  status(key: string): Promise<string> {
    return this.serial(key, () => this.statusNow(key));
  }

  label(agent: string): string {
    return this.drivers.get(agent)?.label ?? agent;
  }

  /** 执行一条已解析的命令。chat 不在这里处理。 */
  /** ctx.channel：命令是从哪个渠道发的（飞书聊天挂在 Web 会话上时，和会话自己的渠道不一样） */
  async command(
    key: string,
    cmd: ParsedCommand,
    ctx: {
      allowedAgents: string[];
      by: string;
      channel?: string;
      /** 多用户：发命令的人能看到哪些 agent 会话（/sessions 列哪些、/resume 能恢复哪些） */
      sessionVisible?: (sessionId: string) => boolean;
      /** 多用户：/approve 只能处理这些会话里的请求 */
      convVisible?: (convKey: string) => boolean;
      /** 多用户：false = 不能点会落盘的「总是允许」（见 InteractionSpec.alwaysGlobal） */
      allowGlobalAlways?: boolean;
    },
  ): Promise<CommandReply> {
    const text = (t: string): CommandReply => ({ type: "text", text: t });
    const channel = ctx.channel ?? getConversation(key)?.channel;
    switch (cmd.kind) {
      case "help":
        return text(helpText(ctx.allowedAgents, channel));
      case "skills":
        return text(skillsText(memoryOwnerOf(getConversation(key)!)));
      case "commands": {
        const conv = getConversation(key)!;
        const owner = memoryOwnerOf(conv);
        const all = await this.commandCatalog(conv.agent, {
          cwd: conv.cwd,
          allowedAgents: ctx.allowedAgents,
          ...(channel ? { channel } : {}),
          ...(owner && getUser(owner)?.role !== "admin" ? { member: true } : {}),
        });
        return { type: "commands", agent: conv.agent, commands: all.filter((c) => !c.hidden) };
      }
      case "pwd":
        return text(getConversation(key)!.cwd);
      case "autoedit":
        return text(await this.setAutoEdit(key, cmd.on));
      case "mode":
        return text(await this.setMode(key, cmd.mode));
      case "status":
        return text(await this.status(key));
      case "cd":
        return text(await this.cd(key, cmd.dir));
      case "new":
        return text(await this.newSession(key, cmd.model));
      case "fork":
        return text(await this.fork(key));
      case "sessions": {
        const reply = await this.sessions(key, cmd.all, ctx.sessionVisible);
        return reply.sessions.length === 0 ? text("还没有任何历史会话。") : reply;
      }
      case "resume":
        if (ctx.sessionVisible && !ctx.sessionVisible(cmd.sessionId)) {
          return text(`找不到会话 ${cmd.sessionId}。\n发 /sessions 看看有哪些可恢复的。`);
        }
        return text(await this.resume(key, cmd.sessionId));
      case "model":
        return cmd.model ? text(await this.setModel(key, cmd.model)) : await this.models(key);
      case "effort":
        if (!cmd.effort) return await this.models(key);
        return text(await this.setEffort(key, cmd.effort));
      case "agent": {
        if (!cmd.agent) {
          return {
            type: "agents",
            agents: ctx.allowedAgents
              .filter((a) => this.drivers.has(a))
              .map((id) => ({ id, label: this.label(id) })),
            current: getConversation(key)!.agent,
          };
        }
        return text(await this.setAgent(key, cmd.agent, ctx.allowedAgents));
      }
      case "stop":
        return text(await this.stop(key));
      case "approve": {
        const target = interactions.get(cmd.requestId);
        if (target && ctx.convVisible && !ctx.convVisible(target.convKey)) {
          return text(`请求 ${cmd.requestId} 不存在或已处理。`);
        }
        if (target?.spec.kind === "approval" && target.spec.alwaysGlobal && cmd.decision === "allow-always" && ctx.allowGlobalAlways === false) {
          return text(GLOBAL_ALWAYS_DENIED);
        }
        const settled = interactions.decide(cmd.requestId, cmd.decision as ApprovalDecision, ctx.by);
        if (!settled && interactions.isPending(cmd.requestId)) {
          return text(`请求 ${cmd.requestId} 不支持 ${cmd.decision}。`);
        }
        if (!settled) return text(`请求 ${cmd.requestId} 不存在或已处理。`);
        return text(`${SETTLEMENT_LABEL[cmd.decision]}：${cmd.requestId}`);
      }
      case "chat":
        return { type: "none" };
    }
  }

  /**
   * 某个 agent 的完整命令表（含隐藏项，带 hidden 标记），已按配置排序。
   * 原生命令读不到、或者超时，就只给 agent-loft 自己的 —— 列表少几项，总比「/」没反应强。
   * 未启用的 agent 不去问：问一次就可能拉起它的进程。
   */
  async commandCatalog(
    agent: string,
    opts: { cwd?: string; allowedAgents: string[]; channel?: string; member?: boolean },
  ): Promise<CommandEntry[]> {
    const driver = this.enabledAgents().find((d) => d.id === agent);
    let native: AgentCommand[] = [];
    if (driver?.commands) {
      native = await withTimeout(driver.commands(opts.cwd), "读取命令列表").catch((err) => {
        console.error(`[${agent}] 读取命令列表失败:`, err instanceof Error ? err.message : err);
        return [];
      });
    }
    // 成员：机器上装的技能不列（用了也会被 blockedSlash 拦下）
    if (opts.member) native = native.filter((c) => !isMachineCommand(c.name, native, opts.cwd ?? config().workspaceRoot));
    const prefs = (config().commands as Record<string, CommandPrefs | undefined>)[agent];
    return buildCatalog({ allowedAgents: opts.allowedAgents, native, prefs, ...(opts.channel ? { channel: opts.channel } : {}) });
  }

  async shutdown(): Promise<void> {
    for (const key of [...this.live.keys()]) await this.drop(key, "服务正在重启");
    for (const driver of this.drivers.values()) await driver.stop().catch(() => {});
    flushUsage();
  }
}

export const hub = new Hub();
