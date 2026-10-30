// 核心类型：渠道（飞书 / Web / 以后的 Telegram）与 agent（Claude / Codex / 以后的 ACP）
// 之间只通过这里的类型说话。渠道不认识 Claude，agent 不认识飞书。
import type { AgentCommand } from "./command-catalog.js";
import type { ExpertRuntime } from "./experts.js";

// ---------- 用户输入 ----------

export type AttachmentKind = "image" | "file" | "audio" | "video";

/** 已经落盘的附件。各渠道负责下载 / 接收，agent 负责决定怎么喂给模型。 */
export type SavedAttachment = {
  kind: AttachmentKind;
  path: string;
  name: string;
  size: number;
  mediaType?: string;
  durationMs?: number;
};

export type UserInput = { text: string; attachments: SavedAttachment[]; id?: string };

/** 给前端展示用的附件：能预览 / 下载（path 只在上传目录里有效，见 uploads.resolveUploadFile） */
export type AttachmentInfo = { kind: AttachmentKind; name: string; path: string; size?: number };

// ---------- 交互（审批 / 提问） ----------

/**
 * allow-session：本会话内后续的审批全部自动放行（不落盘）。会话重建
 * （/new、切目录、切 agent、恢复历史、进程重启）后失效。
 */
export type ApprovalDecision = "allow-once" | "allow-always" | "allow-session" | "deny";

/** 一个卡点的收束方式。timeout / cancelled 和 deny 一样都是「没放行」，但显示不同。 */
export type Settlement = ApprovalDecision | "timeout" | "cancelled" | "answered" | "skipped";

export type QuestionSpec = {
  /** 回填答案时用的键：Claude 用问题原文，Codex 用问题 id */
  id: string;
  header: string;
  question: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
  /** 允许自由输入（直接发一条消息作答） */
  allowOther: boolean;
};

export type InteractionSpec =
  | {
      kind: "approval";
      title: string;
      /** markdown */
      detail: string;
      /** 「总是允许」按钮的文字；不给就没有这个按钮 */
      alwaysLabel?: string;
      /**
       * 「总是允许」会落盘、对所有会话生效（Claude 的总是允许名单、Codex 的 execpolicy）。
       * 多用户时只有管理员能点 —— 否则一个成员就能替所有人放行。
       */
      alwaysGlobal?: boolean;
      /** 给了就显示「本会话全部允许」按钮。只有 agent 能真正兑现时才给 */
      allowSession?: boolean;
    }
  | { kind: "question"; title: string; questions: QuestionSpec[] };

export type InteractionOutcome = {
  settlement: Settlement;
  /** 仅提问：问题 id → 选中的答案（多选为多个） */
  answers: Record<string, string[]>;
};

/** agent 向用户发起交互的入口，由核心实现。返回值是用户的决定。 */
export type InteractionHost = (spec: InteractionSpec) => Promise<InteractionOutcome>;

// ---------- agent 产生的事件 ----------

export type StepKind = "thinking" | "tool" | "note" | "warning";

/** agent 自己列的任务清单里的一项（Claude 的 TodoWrite / TaskCreate，Codex 的计划）。activeForm：进行中时显示的说法 */
export type TodoItem = { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string };

export type TurnResult = {
  text: string;
  durationMs: number;
  costUsd?: number;
  tokens?: number;
  /** 这条回复在 agent 记录里的位置，从这里分叉用（见 AgentDriver.forkAt） */
  anchor?: string;
};

export type AgentEvents = {
  /** 用户消息在 agent 记录里的位置，用于回退 */
  onUserAnchor?: (input: UserInput, anchor: string) => void;
  /** 一轮开始（agent 真正开始处理） */
  onTurnStart?: () => void;
  /** 过程信息：思考、工具调用等，一行摘要 */
  onStep: (kind: StepKind, text: string) => void;
  /** 回复正文的流式片段（可选能力，飞书不用，Web 用来逐字显示） */
  onTextDelta: (delta: string) => void;
  /** 一段完整的回复正文 */
  onText: (text: string) => void;
  onResult: (result: TurnResult) => void;
  onError: (err: unknown) => void;
  /** 拿到 / 更新了 agent 侧的会话 id，持久化后用于 resume */
  onSessionId: (id: string) => void;
  /** 有 n 条排队中的输入被丢弃了（不会再有结果）：调用方据此结清「进行中」的计数 */
  onDropped?: (n: number) => void;
  /** 上下文窗口占用更新了（一般在每轮结束后） */
  onContext?: (ctx: ContextUsage) => void;
  /** 任务清单变了，给的是改完之后的整份 */
  onTodos?: (todos: TodoItem[]) => void;
  /**
   * token 用量更新了。cumulative = 报的是这个会话到目前的累计值（Claude，每轮结束报一次）；
   * 否则是新增的量（Codex，每次模型请求报一次），由核心累加
   */
  onUsage?: (usage: TokenUsage, cumulative?: boolean) => void;
};

/** 上下文窗口占用：used / window 都是 token 数，percent 是 0-100（可能略超 100） */
export type ContextUsage = { used: number; window: number; percent: number };

/**
 * token 用量。input 是没命中缓存的输入；cacheRead 是命中缓存读的；cacheWrite 是写进缓存的（Claude 单独计费）；
 * output 含推理，reasoning 是其中推理的部分（Codex 才有）。costUsd 是 agent 自己算的费用（Claude 才有）
 */
export type TokenUsage = { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning?: number; costUsd?: number };

/** 账号额度（订阅的用量窗口）。没有订阅额度（API key 之类）时 driver 返回 null */
export type QuotaInfo = {
  plan?: string;
  windows: {
    /** 完整名称，如「5 小时」「7 天（Opus）」 */
    label: string;
    /** 紧凑显示用，如「5h」「7d」 */
    short: string;
    percent: number;
    /** 重置时刻（毫秒时间戳） */
    resetsAt?: number;
  }[];
  /** 额度包等附加说明 */
  extra?: string;
  /** 已撞上限 */
  reached?: boolean;
  /**
   * 账号标识（邮箱等信息的哈希，见 core/account-key.ts）。多台服务器登的同一个账号时相同，
   * 桌面端据此只问其中一台。认不出账号时不给。
   */
  account?: string;
};

// ---------- agent ----------

export type RuntimeInfo = { model?: string; effort?: string };

export type ModelInfo = {
  id: string;
  label: string;
  description?: string;
  efforts?: string[];
  isDefault?: boolean;
};

export type SessionSummary = {
  id: string;
  title: string;
  cwd?: string;
  updatedAt: number;
};

export type HistoryMessage = {
  /** question：agent 问过的问题和你的回答（答过的提问卡，刷新后照样显示） */
  role: "user" | "assistant" | "question";
  text: string;
  /** 助手消息：被提问卡打断的前半段（只显示过程，不带复制 / 分叉 / 脚注） */
  segment?: boolean;
  /** 提问：问了什么、选了哪些（按问题下标）、自由作答的内容；skipped = 没作答（跳过 / 超时） */
  question?: { id: string; title: string; questions: QuestionSpec[]; selections: number[][]; freeText: Record<number, string>; skipped?: boolean };
  /** 助手这一条之前的过程摘要 */
  steps?: string[];
  /** 助手消息：这一条里改过任务清单的话，改完之后的整份 */
  todos?: TodoItem[];
  /** 毫秒时间戳；助手消息是这一轮结束的时间 */
  ts?: number;
  /** 消息在 agent 记录里的位置：用户消息用于回退，助手消息用于分叉 */
  anchor?: string;
  /** 助手消息：这一轮的用时 / 费用 / tokens（agent-loft 自己记的，agent 记录里没有） */
  footer?: string;
  /** 用户消息：带的附件（从消息里的附件清单解析出来） */
  attachments?: AttachmentInfo[];
};

export type SessionOptions = {
  cwd: string;
  model?: string;
  effort?: string;
  resumeId?: string;
  fork?: boolean;
  /** 附件所在目录，agent 需要能直接读 */
  uploadsDir: string;
  /** 工作目录内改文件不再询问（/autoedit）。Bash 等照常询问 */
  autoEdit?: boolean;
  /**
   * 自定义专家（core/experts.ts）：提示词、权限、技能、MCP、子智能体都按它来。
   * 不给就是内置专家：原装提示词和工具，技能与 MCP 按账号的内置默认配置加载。
   */
  expert?: ExpertRuntime;
  /** 这条对话主人的记忆：prompt 拼进系统提示，userId 交给记忆工具（记给谁由这里定死） */
  memory?: {
    userId: string;
    prompt: string;
    /** 给不给搜以前聊天的工具（用户在记忆设置里开着「参考以前的聊天」） */
    search?: boolean;
    /** 当前对话，搜索时跳过 */
    convKey?: string;
  };
  /**
   * 给 agent 定时任务工具（core/tasks-mcp.ts）：替谁、在哪条对话里管理。只有有主人的对话才给。
   * 技能工具（让 agent 帮用户建、改技能）也跟着它一起给。
   */
  tasks?: { userId: string; convKey: string };
  /** 这条对话主人的技能（core/skill-runtime.ts）。没主人的对话不给：机器上的技能照旧，没有 agent-loft 的技能 */
  skills?: SessionSkills;
  /** 内置 Agent 的个人 MCP 选择；不给时沿用 CLI 原配置。 */
  builtinMcp?: Pick<ExpertRuntime, "mcp" | "askMcp" | "machineMcp"> & { inheritMachine: boolean };
};

export type SessionSkills = {
  userId: string;
  /** 管理员：机器上原有的技能照常能用；成员：只有 agent-loft 的技能和 agent 自带的 */
  admin: boolean;
  /** 内置 Agent 是否加载机器技能；未设置时沿用管理员默认行为 */
  machineSkills?: boolean;
  /** Claude 插件目录（里面是这个人启用的技能），一个都没有就不给 */
  pluginDir?: string;
  /** 启用的技能：名字、说明、SKILL.md 的路径 */
  list: { name: string; description: string; path: string }[];
  /** 要注入的环境变量（技能声明过、这个人填了值的） */
  env: Record<string, string>;
  /** 变量配没配好的说明，拼进系统提示 / 背景 */
  prompt?: string;
};

/**
 * 中断的方式。默认（停止）：这一轮和排着队的都不要了。
 * keepQueue（打断并发送）：只停这一轮，排着的留着；给了 first 就把它挪到最前面，这一轮一结束就轮到它
 */
export type InterruptOptions = { keepQueue?: boolean; first?: UserInput };

export interface AgentSession {
  readonly sessionId: string | undefined;
  send(input: UserInput): void;
  /** 仅移除尚未开始的指定输入，不中断当前回复 */
  cancelQueued?(input: UserInput): boolean;
  interrupt(opts?: InterruptOptions): Promise<void>;
  setModel(model?: string, effort?: string): Promise<void>;
  describeRuntime(): Promise<RuntimeInfo>;
  /** 手上已知的模型 / 思考程度，同步返回：不拉起进程、不发请求 */
  peekRuntime?(): RuntimeInfo;
  dispose(): Promise<void>;
  /** 运行中切换「自动允许改文件」；不支持的 agent 不实现 */
  setAutoEdit?(on: boolean): Promise<void>;
}

export type Diagnosis = {
  /** 发给用户看的一句人话 */
  chatMessage: string;
  /** 打在日志里的修复步骤 */
  consoleHint: string;
  kind: string;
};

export interface AgentDriver {
  readonly id: string;
  readonly label: string;
  /** 能力声明：前端据此决定显示哪些控件 */
  readonly capabilities: { effort: boolean; fork: boolean; cost: boolean; streaming: boolean };
  start(): Promise<void>;
  stop(): Promise<void>;
  createSession(opts: SessionOptions, events: AgentEvents, host: InteractionHost): AgentSession;
  /** cwd 为 undefined 时列全部目录 */
  listSessions(cwd: string | undefined, limit?: number): Promise<SessionSummary[]>;
  sessionExists(id: string, cwd: string): Promise<boolean>;
  /** agent 自己给会话起的标题（模型总结的或在别处改过的）；还没生成就返回 undefined，不拿首条消息凑数 */
  sessionTitle?(id: string, cwd: string): Promise<string | undefined>;
  readHistory(id: string, cwd: string): Promise<HistoryMessage[]>;
  /**
   * 把会话复制出一条新的、返回新会话 id。anchor（HistoryMessage / TurnResult 里的）给了就只保留到
   * 那条回复为止（含），不给就整条复制。原会话不受影响。
   */
  forkAt?(id: string, cwd: string, anchor?: string): Promise<string>;
  /** 保留指定用户消息之前的上下文；第一条返回 undefined，下一次发送新建会话 */
  rewindTo?(id: string, cwd: string, anchor: string): Promise<string | undefined>;
  /** 有的 agent（Claude）要借一个活着的会话才能问到模型列表 */
  listModels(session: AgentSession): Promise<ModelInfo[]>;
  /** 不依赖会话的模型列表，设置页的下拉框用 */
  catalog(): Promise<ModelInfo[]>;
  /** agent 自己的斜杠命令（skills 之类），没有就不实现。cwd 影响项目级命令 */
  commands?(cwd?: string): Promise<AgentCommand[]>;
  /** 不建会话也能知道的默认模型 / 思考程度 */
  defaults(): Promise<RuntimeInfo>;
  /** /status 里额外的几行（比如 Codex 的额度） */
  statusLines(): Promise<string[]>;
  /** 账号额度，侧栏显示用；读不到 / 没有订阅额度时返回 null */
  quota?(): Promise<QuotaInfo | null>;
  diagnose(err: unknown): Diagnosis;
  /**
   * 一次性的后台调用（聊完后整理记忆用）：不留会话记录、不用任何工具，按 schema 返回 JSON。
   * 用最便宜的模型。不支持的 agent 不实现。
   */
  complete?(req: CompleteRequest): Promise<unknown>;
}

export type CompleteRequest = {
  system: string;
  prompt: string;
  /** JSON Schema（顶层是 object，所有对象都 additionalProperties: false、字段全部 required —— 两家都能吃） */
  schema: Record<string, unknown>;
  /** 用哪个模型；不给就用这个 agent 最省的（Claude 用 Haiku，Codex 用默认模型、思考程度 low） */
  model?: string;
  /** 超时，毫秒 */
  timeoutMs?: number;
};
