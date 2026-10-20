// 核心类型：渠道（飞书 / Web / 以后的 Telegram）与 agent（Claude / Codex / 以后的 ACP）
// 之间只通过这里的类型说话。渠道不认识 Claude，agent 不认识飞书。
import type { AgentCommand } from "./command-catalog.js";

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

export type UserInput = { text: string; attachments: SavedAttachment[] };

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

export type TurnResult = {
  text: string;
  durationMs: number;
  costUsd?: number;
  tokens?: number;
  /** 这条回复在 agent 记录里的位置，从这里分叉用（见 AgentDriver.forkAt） */
  anchor?: string;
};

export type AgentEvents = {
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
};

/** 上下文窗口占用：used / window 都是 token 数，percent 是 0-100（可能略超 100） */
export type ContextUsage = { used: number; window: number; percent: number };

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
  role: "user" | "assistant";
  text: string;
  /** 助手这一条之前的过程摘要 */
  steps?: string[];
  /** 毫秒时间戳；助手消息是这一轮结束的时间 */
  ts?: number;
  /** 助手消息：从这条回复处分叉用的位置（见 AgentDriver.forkAt） */
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
};

export interface AgentSession {
  readonly sessionId: string | undefined;
  send(input: UserInput): void;
  interrupt(): Promise<void>;
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
  readHistory(id: string, cwd: string): Promise<HistoryMessage[]>;
  /**
   * 把会话复制出一条新的、返回新会话 id。anchor（HistoryMessage / TurnResult 里的）给了就只保留到
   * 那条回复为止（含），不给就整条复制。原会话不受影响。
   */
  forkAt?(id: string, cwd: string, anchor?: string): Promise<string>;
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
}
