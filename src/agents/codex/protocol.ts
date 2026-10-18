// `codex app-server` 的 JSON-RPC 协议，只抄我们真正用到的那一小块。
//
// 为什么手写而不是用 `codex app-server generate-ts`：那条命令会吐出七百多个
// ts-rs 生成的文件，其中绝大部分我们碰都不碰，而且它们互相 import，扔进仓库
// 就是七百个必须跟着 codex 版本一起漂移的死代码。这里只声明用得上的字段，
// 其余一律留给 `unknown` —— 协议加字段不会弄坏我们，删字段才会，而删字段
// 本来就该炸出来。
//
// ⚠️ app-server 在 codex 里标着 [experimental]，`initialize` 的响应里**没有**
// 协议版本号，也就没有版本协商这回事：协议跟着 codex 二进制走。所以下面记一个
// 「开发时对着的版本」，doctor 会拿它和本机实际的 codex 比对，不一致时明确
// 提醒，而不是让它在运行时以一个莫名其妙的形态崩掉。
export const DEVELOPED_AGAINST_CODEX = "0.153.0";

// ---------- 通用 JSON-RPC ----------

export type RequestId = number | string;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: RequestId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc?: "2.0";
  id: RequestId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/** 服务端发来的一帧，可能是响应、通知，或它反过来向我们发起的请求。 */
export type Incoming = JsonRpcResponse & Partial<JsonRpcRequest>;

// ---------- 客户端 → 服务端 ----------

export type InitializeResult = {
  userAgent?: string;
  codexHome?: string;
  platformOs?: string;
};

export type ReasoningEffortOption = { reasoningEffort: string; description?: string };

export type Model = {
  id: string;
  model: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  supportedReasoningEfforts?: ReasoningEffortOption[];
  defaultReasoningEffort?: string;
};

export type ModelListResponse = { data: Model[]; nextCursor?: string | null };

/** 只列出我们会传的那些；协议里还有一堆可选项。 */
export type ThreadStartParams = {
  cwd?: string;
  model?: string | null;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  config?: Record<string, unknown>;
};

export type Thread = {
  id: string;
  sessionId?: string;
  preview?: string;
  name?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  cwd?: string | null;
  createdAt?: number;
  updatedAt?: number;
};

export type ThreadResponse = { thread: Thread };
export type ThreadListResponse = { data: Thread[]; nextCursor?: string | null };

/** 只列出我们会发的：文字，以及落在本机的图片。 */
export type UserInput = { type: "text"; text: string } | { type: "localImage"; path: string };

export type TurnStartParams = {
  threadId: string;
  input: UserInput[];
  cwd?: string;
  model?: string;
  effort?: string;
  approvalPolicy?: ApprovalPolicy;
  sandboxPolicy?: unknown;
};

/**
 * 审批策略。
 *
 * ⚠️ 必须是 `on-request`。设成 `never` 会让审批请求根本不再发过来 ——
 * 卡片授权那一整条路就成了死代码，Codex 在沙箱允许的范围内直接动手。
 * 注意 codex 0.153 起 `untrusted` 已被移除，写进 config.toml 会让进程起不来。
 */
export type ApprovalPolicy = "never" | "on-request" | "on-failure";

/**
 * 沙箱模式 —— Codex 侧真正的第一道闸。
 *
 * 值得先建立的心智模型：命令**默认在沙箱里跑**，只有需要越界（写工作区外、
 * 联网）才会请求审批。所以授权卡不会条条都弹 —— 而这并不意味着放松：挡住
 * 越界的是操作系统级的沙箱，比一张需要人点的卡片更靠得住。
 */
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

// ---------- 服务端 → 客户端：审批请求 ----------

export type CommandAction =
  | { type: "read"; command: string; name?: string; path?: string }
  | { type: "listFiles"; command: string; path?: string | null }
  | { type: "search"; command: string; query?: string | null; path?: string | null }
  | { type: "unknown"; command: string };

export type CommandExecutionApprovalParams = {
  kind?: "command" | "writeStdin";
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string | null;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  commandActions?: CommandAction[] | null;
  /**
   * Codex 主动提出的「以后同类命令别再问」的 execpolicy 补丁。
   * 这就是「总是允许」的原生实现 —— 粒度由 Codex 自己判断，
   * 比我们在外面按命令首词瞎猜要准。
   */
  proposedExecpolicyAmendment?: string[] | null;
};

export type FileChangeApprovalParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  grantRoot?: string | null;
};

export type PermissionsApprovalParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  cwd?: string;
  reason?: string | null;
  /** Codex 想额外拿到的网络 / 文件系统权限，批准时原样回给它即可。 */
  permissions: { network?: unknown | null; fileSystem?: unknown | null };
};

/** 权限授予的范围：只这一轮，还是整条会话。 */
export type PermissionGrantScope = "turn" | "session";

/** 命令审批的决策。`acceptForSession` 对应卡片上的「本次会话内总是允许」。 */
export type CommandApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel"
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } };

export type FileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

// ---------- 服务端 → 客户端：提问 ----------

export type UserInputOption = { label: string; description?: string };

/**
 * 一问。
 *
 * `id` 是回答时的键 —— 回填 answers 表时用它，不是用问题原文。`isOther` 表示
 * 这一问允许自由输入，`isSecret` 表示答案敏感（密码之类），后者我们一律不接：
 * 飞书上的按钮和消息都不是填密码的地方。
 */
export type UserInputQuestion = {
  id: string;
  header?: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: UserInputOption[] | null;
};

export type ToolRequestUserInputParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: UserInputQuestion[];
  isBlocking?: boolean;
};

/** 回答：问题 id → 选中的一个或多个答案文本。没答的问题不出现在表里。 */
export type ToolRequestUserInputResponse = {
  answers: Record<string, { answers: string[] }>;
};

// ---------- 服务端 → 客户端：通知 ----------

export type ThreadItem =
  | { type: "userMessage"; id: string }
  | { type: "agentMessage"; id: string; text: string; phase?: string | null }
  | { type: "reasoning"; id: string; summary?: string[]; content?: string[] }
  | { type: "plan"; id: string; text: string }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd?: string;
      status: "inProgress" | "completed" | "failed";
      exitCode?: number | null;
      aggregatedOutput?: string | null;
      commandActions?: CommandAction[];
    }
  | {
      type: "fileChange";
      id: string;
      changes: { path: string; kind: "add" | "delete" | "update" }[];
      status: "completed" | "failed";
    }
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      status: "inProgress" | "completed" | "failed";
    }
  | { type: "webSearch"; id: string; query?: string }
  | { type: "error"; id: string; message: string }
  | { type: string; id: string };

export type ItemNotification = {
  item: ThreadItem;
  threadId: string;
  turnId: string;
};

export type AgentMessageDeltaNotification = {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
};

export type TurnError = { message: string; additionalDetails?: string | null };

export type Turn = {
  id: string;
  status: "inProgress" | "completed" | "failed" | "aborted" | string;
  error?: TurnError | null;
  durationMs?: number | null;
};

export type TurnCompletedNotification = { threadId: string; turn: Turn };
export type TurnStartedNotification = { threadId: string; turnId?: string };
export type ErrorNotification = {
  error: TurnError;
  willRetry: boolean;
  threadId: string;
  turnId: string;
};

export type TokenUsageNotification = {
  threadId: string;
  turnId: string;
  tokenUsage?: {
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  };
};
