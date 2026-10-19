// 中枢：所有渠道共用的「会话 → agent」调度。
//
// 渠道只做三件事：把用户的话（和附件）交给 hub.send，把命令交给 hub.command，
// 订阅 hub 的事件流画到自己的界面上。会话的生命周期、闲置过期、切 agent / 模型 /
// 目录、取消挂着的审批，全在这里 —— 以前飞书桥接器 index.ts 里那 1000 行流程，
// 现在只写一遍。
//
// 同一条会话可以被多个渠道同时看着：飞书群里的会话也能在 Web 上打开，Web 上
// 说的话照样回到飞书。所以事件是广播出去的，每个订阅者自己挑感兴趣的会话。
import { EventEmitter } from "node:events";
import { config, onConfigChange, resolveWorkspacePath } from "./config.js";
import { interactions, SETTLEMENT_LABEL } from "./interactions.js";
import {
  agentBinding,
  ensureConversation,
  getConversation,
  isExpired,
  listConversations,
  touchConversation,
  updateAgentBinding,
  updateConversation,
  type Conversation,
} from "./store.js";
import { clearUploads, ensureUploadsDir, KIND_LABEL } from "./uploads.js";
import type {
  AgentDriver,
  AgentSession,
  ApprovalDecision,
  HistoryMessage,
  InteractionSpec,
  ModelInfo,
  RuntimeInfo,
  SessionSummary,
  StepKind,
  UserInput,
} from "./types.js";
import { buildCatalog, type AgentCommand, type CommandEntry, type CommandPrefs } from "./command-catalog.js";
import { helpText, type ParsedCommand } from "./commands.js";

// ---------- 事件 ----------

export type Origin = {
  /** feishu / web / telegram… */
  channel: string;
  /** 渠道实例 id（飞书机器人 id；Web 为 web） */
  channelId: string;
  /** 显示用的人名 / 设备名 */
  name?: string;
};

export type ConvEvent =
  | { type: "user"; text: string; attachments: string[]; origin: Origin }
  | { type: "turn_start" }
  | { type: "step"; kind: StepKind; text: string }
  | { type: "delta"; text: string }
  | { type: "text"; text: string }
  | { type: "result"; text: string; footer: string }
  | { type: "error"; message: string }
  | { type: "notice"; text: string }
  | { type: "state"; busy: boolean }
  | { type: "meta" };

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
  busy: boolean;
  activeAt: number;
  createdAt: number;
  hidden?: boolean;
};

const BUFFER_MAX = 400;
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

class Hub extends EventEmitter<{ event: [EventEnvelope] }> {
  private drivers = new Map<string, AgentDriver>();
  private live = new Map<string, Live>();
  private buffers = new Map<string, EventEnvelope[]>();
  private seq = 0;
  /** 每条会话还没收到结果的轮数，> 0 即忙 */
  private inflight = new Map<string, number>();
  private announced = new Set<string>();
  /** 每条会话因缓冲区溢出被丢掉的最后一个 seq */
  private truncated = new Map<string, number>();
  /** 每条会话的生命周期操作串行执行，见 serial() */
  private locks = new Map<string, Promise<unknown>>();
  /** 最近一次点停止的时间：紧接着冒出来的「被打断」错误是预期内的，不当错误显示 */
  private stoppedAt = new Map<string, number>();
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

  constructor() {
    super();
    this.setMaxListeners(100);
    // workspaceRoot 改了：store 会把没显式 /cd 过的会话目录重置，正在跑的旧目录会话要作废
    onConfigChange((next, prev) => {
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
  }): Conversation {
    return ensureConversation({
      key: params.key,
      channel: params.channel,
      channelId: params.channelId,
      agent: params.defaultAgent,
      ...(params.title ? { title: params.title } : {}),
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
      busy: this.isBusy(key),
      activeAt: conv.activeAt,
      createdAt: conv.createdAt,
      ...(conv.hidden ? { hidden: true } : {}),
    };
  }

  list(): ConversationInfo[] {
    return listConversations()
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

    const session = driver.createSession(
      {
        cwd: conv.cwd,
        uploadsDir: ensureUploadsDir(key),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(resumeId ? { resumeId } : {}),
        ...(fork ? { fork: true } : {}),
        ...(conv.autoEdit ? { autoEdit: true } : {}),
      },
      {
        onTurnStart: () => alive() && this.emitEvent(key, { type: "turn_start" }),
        onStep: (kind, text) => alive() && this.emitEvent(key, { type: "step", kind, text }),
        onTextDelta: (text) => alive() && this.emitEvent(key, { type: "delta", text }),
        onText: (text) => alive() && this.emitEvent(key, { type: "text", text }),
        onResult: (result) => {
          if (!alive()) return;
          const parts = [`用时 ${(result.durationMs / 1000).toFixed(1)}s`];
          if (result.costUsd !== undefined) parts.push(`约 $${result.costUsd.toFixed(4)}`);
          if (result.tokens !== undefined) parts.push(`${result.tokens} tokens`);
          this.emitEvent(key, { type: "result", text: result.text, footer: parts.join("　") });
          this.setInflight(key, (this.inflight.get(key) ?? 1) - 1);
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
          if (Date.now() - (this.stoppedAt.get(key) ?? 0) < 15_000) {
            // 用户自己点的停止：中断导致的「没能正常收尾」不是故障
            this.emitEvent(key, { type: "notice", text: "已中断。" });
          } else {
            this.emitEvent(key, { type: "error", message: diagnosis.chatMessage });
          }
          this.setInflight(key, (this.inflight.get(key) ?? 1) - 1);
        },
        onDropped: (n) => {
          if (!alive() || n <= 0) return;
          this.setInflight(key, (this.inflight.get(key) ?? n) - n);
        },
        onSessionId: (sessionId) => {
          // 切走之后旧会话晚到的回调不该覆盖新绑定
          if (!alive()) return;
          const current = getConversation(key);
          const forkFrom = current ? agentBinding(current, agent).forkFrom : undefined;
          // 分叉中还报的是原会话 id：分叉尚未生效，什么都不改
          if (forkFrom && sessionId === forkFrom) return;
          updateAgentBinding(key, agent, { sessionId, forkFrom: undefined });
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

  /** 丢掉活着的会话（不动绑定）。挂着的审批一并取消，否则阻塞的那一轮永远走不完。 */
  async drop(key: string, note: string): Promise<void> {
    interactions.cancelAll(key, note);
    const existing = this.live.get(key);
    this.live.delete(key);
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
  send(key: string, input: UserInput, origin: Origin, gen?: InputGen): void {
    const conv = getConversation(key);
    if (!conv) throw new Error(`会话不存在：${key}`);
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
    if (cancelled()) return;
    const shown = {
      type: "user" as const,
      text: input.text,
      attachments: input.attachments.map((a) => `${KIND_LABEL[a.kind]} ${a.name}`),
      origin,
    };
    const by = `${origin.name ?? "用户"}以消息作答`;

    /**
     * 拿这条消息回答挂着的提问。条件：提问属于当前活着的会话进程、这条消息收到后
     * 没有切换生效过；expectId 给了的话，还必须正是收到时挂着的那一个（不能去回答后来才冒出的新提问）。
     */
    const tryAnswer = (expectId?: string): boolean => {
      if (input.attachments.length > 0) return false;
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
    if (!conv.title && conv.channel === "web" && input.text.trim()) {
      updateConversation(key, { title: input.text.trim().replace(/\s+/g, " ").slice(0, 40) });
      this.emitEvent(key, { type: "meta" });
    }
    this.emitEvent(key, shown);
    void this.serial(key, async () => {
      if (cancelled()) return;
      if (questionAtEntry && tryAnswer(questionAtEntry)) return;
      // 收到之后发生过显式切换（恢复 / 分叉 / 新会话…）：用户已经明确指定了会话，不再按旧的闲置时间作废它
      const ttl = config().sessionTtlMs;
      const switchedAfterEntry = (this.lastSwitch.get(key)?.at ?? 0) >= g.at;
      const expired = !switchedAfterEntry && ttl > 0 && Date.now() - lastActive > ttl;
      if (expired) {
        await this.expireNow(key);
        // 清理要等旧会话 dispose，期间可能又点了停止
        if (cancelled()) return;
      }
      this.sendNow(key, input);
    });
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

  private sendNow(key: string, input: UserInput): void {
    let session: AgentSession;
    try {
      session = this.session(key);
    } catch (err) {
      this.emitEvent(key, { type: "error", message: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.setInflight(key, (this.inflight.get(key) ?? 0) + 1);
    try {
      session.send(input);
    } catch (err) {
      this.setInflight(key, (this.inflight.get(key) ?? 1) - 1);
      this.emitEvent(key, { type: "error", message: err instanceof Error ? err.message : String(err) });
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

  async sessions(key: string, all: boolean): Promise<Extract<CommandReply, { type: "sessions" }>> {
    const conv = getConversation(key)!;
    const driver = this.requireDriver(conv.agent);
    // 先按当前目录列，一条都没有就自动退回全局 —— 回一句「没有历史」是误导
    let sessions = all ? [] : await driver.listSessions(conv.cwd, 10);
    const fellBack = !all && sessions.length === 0;
    if (all || fellBack) sessions = await driver.listSessions(undefined, 10);
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
    this.setInflight(key, 0);
    return "已请求中断。";
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
    return [
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
      return await driver.readHistory(sessionId, conv.cwd);
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
  async command(key: string, cmd: ParsedCommand, ctx: { allowedAgents: string[]; by: string }): Promise<CommandReply> {
    const text = (t: string): CommandReply => ({ type: "text", text: t });
    switch (cmd.kind) {
      case "help":
        return text(helpText(ctx.allowedAgents));
      case "commands": {
        const conv = getConversation(key)!;
        const all = await this.commandCatalog(conv.agent, { cwd: conv.cwd, allowedAgents: ctx.allowedAgents });
        return { type: "commands", agent: conv.agent, commands: all.filter((c) => !c.hidden) };
      }
      case "pwd":
        return text(getConversation(key)!.cwd);
      case "autoedit":
        return text(await this.setAutoEdit(key, cmd.on));
      case "status":
        return text(await this.status(key));
      case "cd":
        return text(await this.cd(key, cmd.dir));
      case "new":
        return text(await this.newSession(key, cmd.model));
      case "fork":
        return text(await this.fork(key));
      case "sessions": {
        const reply = await this.sessions(key, cmd.all);
        return reply.sessions.length === 0 ? text("还没有任何历史会话。") : reply;
      }
      case "resume":
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
        const settled = interactions.decide(cmd.requestId, cmd.decision as ApprovalDecision, ctx.by);
        if (!settled) return text(`请求 ${cmd.requestId} 不存在或已处理。`);
        return text(`${SETTLEMENT_LABEL[cmd.decision]}：${cmd.requestId}`);
      }
      case "chat":
        return { type: "none" };
    }
  }

  /**
   * 某个 agent 的完整命令表（含隐藏项，带 hidden 标记），已按配置排序。
   * 原生命令读不到、或者超时，就只给 im-agent 自己的 —— 列表少几项，总比「/」没反应强。
   * 未启用的 agent 不去问：问一次就可能拉起它的进程。
   */
  async commandCatalog(
    agent: string,
    opts: { cwd?: string; allowedAgents: string[] },
  ): Promise<CommandEntry[]> {
    const driver = this.enabledAgents().find((d) => d.id === agent);
    let native: AgentCommand[] = [];
    if (driver?.commands) {
      native = await withTimeout(driver.commands(opts.cwd), "读取命令列表").catch((err) => {
        console.error(`[${agent}] 读取命令列表失败:`, err instanceof Error ? err.message : err);
        return [];
      });
    }
    const prefs = (config().commands as Record<string, CommandPrefs | undefined>)[agent];
    return buildCatalog({ allowedAgents: opts.allowedAgents, native, prefs });
  }

  async shutdown(): Promise<void> {
    for (const key of [...this.live.keys()]) await this.drop(key, "服务正在重启");
    for (const driver of this.drivers.values()) await driver.stop().catch(() => {});
  }
}

export const hub = new Hub();
