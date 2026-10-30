// 一条会话 ↔ 一条 Codex thread。
//
// 所有会话共用同一个 app-server 进程，靠 threadId 区分。所以本模块除了 CodexSession
// 之外还负责一件全局的事：把 app-server 收到的通知和反向请求按 threadId 分发到会话上。
import { appServer } from "./app-server.js";
import { refusalFor, UnsupportedRequest } from "./refusals.js";
import { config } from "../../core/config.js";
import { contextBlock } from "../../core/expert-prompt.js";
import { ACCESS_LEVELS, type ExpertAccess, type ExpertRuntime } from "../../core/experts.js";
import { MEMORY_MCP_NAME, memoryMcpSpawn } from "../../core/memory-mcp.js";
import { SKILLS_MCP_NAME, skillsMcpSpawn, TASK_TOOL_TIMEOUT_SEC, TASKS_MCP_NAME, tasksMcpSpawn } from "../../core/tasks-mcp.js";
import { codexSkillLines } from "../../core/skill-runtime.js";
import { describeAttachments, inlineTextBlocks, readTextAttachments } from "../../core/uploads.js";
import type {
  AgentEvents,
  AgentSession,
  InteractionHost,
  InteractionOutcome,
  InteractionSpec,
  InterruptOptions,
  QuestionSpec,
  RuntimeInfo,
  SavedAttachment,
  SessionOptions,
  Settlement,
  UserInput,
} from "../../core/types.js";
import type {
  AgentMessageDeltaNotification,
  CommandExecutionApprovalParams,
  FileChangeApprovalParams,
  ItemNotification,
  PermissionsApprovalParams,
  Thread,
  ThreadItem,
  ThreadResponse,
  ToolRequestUserInputParams,
  TurnCompletedNotification,
} from "./protocol.js";

// ---------- 全局分发 ----------

const byThread = new Map<string, CodexSession>();

function threadIdOf(params: unknown): string | undefined {
  const id = (params as { threadId?: unknown } | null)?.threadId;
  return typeof id === "string" ? id : undefined;
}

appServer.onNotification((method, params) => {
  const threadId = threadIdOf(params);
  if (threadId) byThread.get(threadId)?.handleNotification(method, params);
});

appServer.setServerRequestHandler(async (method, params) => {
  const threadId = threadIdOf(params);
  const session = threadId ? byThread.get(threadId) : undefined;
  if (!session) {
    console.warn(`[codex] 收到 ${method}，但没有对应的会话（thread=${threadId}），自动拒绝`);
    const refusal = refusalFor(method);
    if (refusal === null) throw new UnsupportedRequest(method);
    return refusal;
  }
  return session.handleServerRequest(method, params);
});

// app-server 退出：进程里的 thread 都没了，但盘上还在。在途的轮次立刻收尾，
// 之后说话时先 resume 回来，上下文不丢。
appServer.onExit((reason) => {
  for (const session of new Set([...byThread.values(), ...opening])) session.onServerExit(reason);
});

/** 还在 thread/start 途中、尚未登记到 byThread 的会话 */
const opening = new Set<CodexSession>();

/** 配置里的沙箱模式 → turn/start 的 sandboxPolicy */
function sandboxPolicyFor(mode: string, cwd: string): unknown {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") return { type: "readOnly", networkAccess: false };
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

// ---------- 自定义专家 ----------

/**
 * 只能联网的专家要关掉的东西（thread/start / resume 的 config 覆盖），也是别的权限的底子（expertConfig 再按权限打开）。
 * 实测一句话的输入从约 2 万 token 降到约 1.1 万，大头是技能清单（约 2.5 万字符）和权限说明（约 1.1 万字符）。
 * 剩下的是 Codex 自己的基础指令（改不得，见 modeParams）和关不掉的工具定义。
 * 不认识的 feature 名 Codex 会忽略；配置被拒绝时直接报错，不能丢掉专家限制后重试。
 */
export const CHAT_CONFIG: Record<string, unknown> = {
  web_search: "live",
  "skills.include_instructions": false,
  include_permissions_instructions: false,
  include_collaboration_mode_instructions: false,
  include_apps_instructions: false,
  include_apply_patch_tool: false,
  ...Object.fromEntries(
    [
      "shell_tool",
      "unified_exec",
      "plugins",
      "apps",
      "browser_use",
      "computer_use",
      "multi_agent",
      "image_generation",
      "view_image",
      "skill_search",
      "tool_suggest",
      "sleep_tool",
      "hooks",
      "goals",
      "code_mode_host",
      "worktrees",
      "workspace_dependencies",
      "in_app_browser",
      "in_app_local_automation",
      "realtime_conversation",
    ].map((f) => [`features.${f}`, false]),
  ),
};

/**
 * 按权限在 CHAT_CONFIG 上打开的东西。能读文件就要 shell（Codex 读文件也是跑命令，沙箱只读管着它改不了）；
 * 能改文件再给 apply_patch。
 */
export function expertConfig(e: ExpertRuntime): Record<string, unknown> {
  const rank = ACCESS_LEVELS.indexOf(e.access);
  return {
    ...CHAT_CONFIG,
    web_search: e.webSearch ? "live" : "disabled",
    ...(rank >= 1
      ? { include_permissions_instructions: true, "features.shell_tool": true, "features.unified_exec": true, "features.view_image": true }
      : {}),
    ...(rank >= 2 ? { include_apply_patch_tool: true } : {}),
  };
}

/** 专家选的 MCP 写成 Codex 的 mcp_servers 配置 */
export function codexMcp(mcp: ExpertRuntime["mcp"], ask: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(mcp)) {
    const policy = { enabled: true, default_tools_approval_mode: ask.includes(name) ? "prompt" : "approve" };
    if (spec.type === "stdio") out[`mcp_servers.${name}`] = { command: spec.command, args: spec.args, env: spec.env, ...policy };
    else if (spec.type === "http") out[`mcp_servers.${name}`] = { url: spec.url, ...(Object.keys(spec.headers).length ? { http_headers: spec.headers } : {}), ...policy };
  }
  return out;
}

const SANDBOX_RANK = ["read-only", "workspace-write", "danger-full-access"];

/** 用户自己配的 MCP 服务（config.toml 里的 mcp_servers）。名字因人而异，只能读出来再逐个关 */
let userMcpCache: { names: string[]; at: number } | null = null;

export async function userMcpServers(): Promise<string[]> {
  if (userMcpCache && Date.now() - userMcpCache.at < 60_000) return userMcpCache.names;
  try {
    const res = await appServer.call<{ config?: { mcp_servers?: Record<string, unknown> | null } }>("config/read", {});
    const names = Object.keys(res.config?.mcp_servers ?? {}).filter((n) => n !== MEMORY_MCP_NAME && n !== TASKS_MCP_NAME && n !== SKILLS_MCP_NAME);
    userMcpCache = { names, at: Date.now() };
    return names;
  } catch (err) {
    throw new Error("读取 Codex MCP 配置失败，无法应用专家的 MCP 限制", { cause: err });
  }
}

// ---------- 审批正文 ----------

function describeCommand(params: CommandExecutionApprovalParams): string {
  const lines: string[] = [];
  if (params.reason) lines.push(params.reason);
  const actions = (params.commandActions ?? [])
    .filter((a) => a.type !== "unknown")
    .map((a) =>
      a.type === "read"
        ? `读取 ${a.path ?? a.name ?? ""}`
        : a.type === "listFiles"
          ? `列目录 ${a.path ?? ""}`
          : `搜索 ${(a as { query?: string | null }).query ?? ""}`,
    );
  if (actions.length > 0) lines.push(actions.join("、"));
  if (params.command) lines.push(`\`\`\`bash\n${params.command}\n\`\`\``);
  if (params.cwd) lines.push(`目录 \`${params.cwd}\``);
  return lines.join("\n\n") || "（没有更多信息）";
}

function describeFileChange(params: FileChangeApprovalParams): string {
  const lines: string[] = [];
  if (params.reason) lines.push(params.reason);
  if (params.grantRoot) lines.push(`想要写入 \`${params.grantRoot}\` 之下`);
  return lines.join("\n\n") || "Codex 想改动沙箱之外的文件。";
}

function describePermissions(params: PermissionsApprovalParams): string {
  const lines: string[] = [];
  if (params.reason) lines.push(params.reason);
  lines.push(`\`\`\`json\n${JSON.stringify(params.permissions ?? {}, null, 2)}\n\`\`\``);
  if (params.cwd) lines.push(`目录 \`${params.cwd}\``);
  return lines.join("\n\n");
}

function allowed(s: Settlement): boolean {
  return s === "allow-once" || s === "allow-always" || s === "allow-session";
}

type ParsedQuestion = QuestionSpec & { secret: boolean };

/** thread/tokenUsage/updated 里的一份用量（app-server 的 TokenUsageBreakdown） */
type TokenBreakdown = {
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
};

function parseQuestions(raw: unknown): ParsedQuestion[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const specs: ParsedQuestion[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : "";
    const question = typeof rec.question === "string" ? rec.question.trim() : "";
    if (!id || !question) return null;
    const options: QuestionSpec["options"] = [];
    for (const opt of Array.isArray(rec.options) ? rec.options : []) {
      if (typeof opt !== "object" || opt === null) continue;
      const o = opt as Record<string, unknown>;
      const label = typeof o.label === "string" ? o.label.trim() : "";
      if (!label) continue;
      options.push({
        label,
        ...(typeof o.description === "string" && o.description.trim() ? { description: o.description.trim() } : {}),
      });
    }
    specs.push({
      id,
      header: typeof rec.header === "string" && rec.header.trim() ? rec.header.trim() : "选择",
      question,
      options,
      // Codex 的问题都是单选
      multiSelect: false,
      allowOther: rec.isOther === true || options.length === 0,
      secret: rec.isSecret === true,
    });
  }
  return specs;
}

// ---------- 会话 ----------

/** 会话已被丢弃，迟到的异步结果直接作废 */
class DisposedError extends Error {}

export class CodexSession implements AgentSession {
  private threadId: string | undefined;
  private turnId: string | undefined;
  /**
   * 当前轮次的阶段。idle：没有轮次；starting：turn/start 已发出、还没拿到轮次 id；
   * running：拿到 id 了。一条会话同一时间只跑一轮，期间新来的消息排队。
   */
  private phase: "idle" | "starting" | "running" = "idle";
  /** 每开一轮加一：迟到的回调据此判断自己是不是已经过时 */
  private turnSeq = 0;
  private queue: UserInput[] = [];
  private currentInput: UserInput | undefined;
  /** 启动途中就被叫停（停止或丢弃）的轮次代次：turn/start 迟到返回时，拿它的 id 补一个中断 */
  private abandoned = new Set<number>();
  /** 已经收尾过的轮次：error 通知之后还可能再来一个 turn/completed，不能收两次尾 */
  private endedTurns = new Set<string>();
  /** thread/start 或 thread/resume 的在途请求，避免并发的两条消息各开一条 thread */
  private opening: Promise<string> | null = null;
  private detached = false;
  private runtime: RuntimeInfo = {};
  /** 用户点过「本会话全部允许」。只在内存里，会话对象一换就重新逐条询问。 */
  private allowAll = false;
  private replyText = "";
  /** 本轮所有模型请求的用量，和会话汇总使用相同的输入 / 缓存 / 输出口径。 */
  private turnTokens: number | undefined;
  /** 上次看到的 thread 累计 token 数：变了才说明有新的模型请求（同一次请求可能报好几遍） */
  private seenTotal: number | undefined;
  /** 当前轮次已开始：恢复 thread 时补报的旧用量不算新的消耗 */
  private turnSeen = false;
  /** 分叉已经真正完成（拿到并接管了新 thread）。失败了不算，重试还要接着分叉 */
  private forked = false;
  /** agentMessage 的 itemId → 是不是旁白（commentary 属于过程，不流式到正文里） */
  private commentaryItems = new Set<string>();
  private disposed = false;
  /** 轮次还在 starting 时点了停止：拿到轮次 id 立刻中断 */
  private stopRequested = false;

  constructor(
    private readonly opts: SessionOptions,
    private readonly events: AgentEvents,
    private readonly host: InteractionHost,
  ) {}

  get sessionId(): string | undefined {
    return this.threadId;
  }

  markDetached(): void {
    this.detached = true;
  }

  get busy(): boolean {
    return this.phase !== "idle";
  }

  /**
   * thread 被另一条会话接管了（正常情况下只会在空闲时发生，见 openOnce 的检查）。
   * 万一时序上撞上了正在跑的一轮：先让服务端中断它，再在本地收尾 —— 不中断的话，
   * 它后续的输出和审批会按 threadId 串到新所有者那边。
   */
  evict(): void {
    this.detached = true;
    if (this.phase !== "idle" && this.threadId && this.turnId) {
      void appServer.call("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
    }
    if (this.phase !== "idle" && !this.disposed) {
      const dropped = this.queue.length;
      this.queue = [];
      this.endTurn();
      this.events.onError(new Error("这条 Codex 会话在别处被恢复了，这一轮已中断"));
      if (dropped > 0) this.events.onDropped?.(dropped);
    }
  }

  /** app-server 挂了 / 重启了：这一轮不会再有任何通知，必须自己收尾，否则界面一直显示忙。 */
  onServerExit(reason: string): void {
    this.markDetached();
    const inFlight = this.phase !== "idle";
    const dropped = this.queue.length;
    this.endTurn();
    this.queue = [];
    if (this.disposed) return;
    if (inFlight) this.events.onError(new Error(`${reason}，这一轮已中断，请重新发送`));
    if (dropped > 0) {
      this.events.onDropped?.(dropped);
      this.events.onStep("warning", `⚠️ 还有 ${dropped} 条排队的消息没来得及处理，请重新发送`);
    }
  }

  private endTurn(): void {
    // 还在 starting、没拿到 id 就收尾了：记下来，turn/start 迟到返回时补中断
    if (this.phase === "starting" && !this.turnId) {
      this.abandoned.add(this.turnSeq);
      if (this.abandoned.size > 20) this.abandoned.delete(this.abandoned.values().next().value!);
    }
    if (this.turnId) {
      this.endedTurns.add(this.turnId);
      if (this.endedTurns.size > 50) this.endedTurns.delete(this.endedTurns.values().next().value!);
    }
    this.phase = "idle";
    this.turnSeen = false;
    this.turnId = undefined;
    this.stopRequested = false;
    this.turnSeq += 1;
  }

  /** 一轮结束后，排着队的下一条消息接着开 */
  private drainQueue(): void {
    const next = this.queue.shift();
    if (next && !this.disposed) this.startTurn(next);
  }

  /**
   * 确保有一条可用的 thread。三条路都显式写死 approvalPolicy 和 sandbox ——
   * app-server 会继承 ~/.codex/config.toml，很多人那里是 never + danger-full-access，
   * 不覆盖的话审批请求根本不会发过来，卡片授权整条路就是死代码。
   */
  private async open(): Promise<string> {
    if (this.threadId && !this.detached) return this.threadId;
    this.opening ??= this.openOnce().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  /** 内置专家算能跑命令 */
  private get access(): ExpertAccess {
    return this.opts.expert?.access ?? "exec";
  }

  /**
   * 沙箱：只能联网、能读文件的专家一律只读（只能联网的本来就没有执行命令的工具，这是第二道保险）；
   * 能改文件的最多到 workspace-write；能跑命令的和内置专家一样按设置里的。设置里本来更严就按设置的
   */
  private get sandboxMode(): string {
    const configured = config().agents.codex.sandbox;
    const cap = this.access === "exec" ? configured : this.access === "edit" ? "workspace-write" : "read-only";
    return SANDBOX_RANK.indexOf(cap) < SANDBOX_RANK.indexOf(configured) ? cap : configured;
  }

  /**
   * 按专家给 thread 的配置覆盖。thread/start、resume、fork 三条路都带上：配置是每次 resume 现给的，
   * 专家改了以后旧会话先退订（dispose），再 resume 回来就换上了（实测）。
   *
   * 不动 baseInstructions / developerInstructions：Codex 把它们钉在 thread 上，改了专家也还原不了
   * （见 core/expert-prompt.ts）。专家和记忆走 contextBlock，附在第一条消息后面。
   * 自定义专家：机器上的 MCP 除了它选的都关掉，再挂上它选的 agent-loft 管的 MCP。
   */
  private async modeParams(): Promise<Record<string, unknown>> {
    const memory = this.opts.memory;
    const tasks = this.opts.tasks;
    const mcp = {
      ...(memory ? { [`mcp_servers.${MEMORY_MCP_NAME}`]: memoryMcpSpawn(memory.userId, "codex", { search: !!memory.search, ...(memory.convKey ? { convKey: memory.convKey } : {}) }) } : {}),
      // 新建 / 修改任务要等用户点授权卡，Codex 默认 60 秒就算工具超时
      ...(tasks
        ? {
            [`mcp_servers.${TASKS_MCP_NAME}`]: { ...tasksMcpSpawn(tasks.userId, tasks.convKey, "codex"), tool_timeout_sec: TASK_TOOL_TIMEOUT_SEC },
            [`mcp_servers.${SKILLS_MCP_NAME}`]: { ...skillsMcpSpawn(tasks.userId, tasks.convKey, "codex"), tool_timeout_sec: TASK_TOOL_TIMEOUT_SEC },
          }
        : {}),
    };
    const expert = this.opts.expert;
    if (expert) {
      const keep = new Set([...expert.machineMcp, ...Object.keys(expert.mcp)]);
      const off = Object.fromEntries((await userMcpServers()).filter((n) => !keep.has(n)).map((n) => [`mcp_servers.${n}.enabled`, false]));
      return { config: { ...expertConfig(expert), ...off, ...codexMcp(expert.mcp, expert.askMcp), ...mcp, ...this.skillConfig() } };
    }
    const builtin = this.opts.builtinMcp;
    const keep = new Set([...(builtin?.machineMcp ?? []), ...Object.keys(builtin?.mcp ?? {})]);
    const off = builtin && !builtin.inheritMachine
      ? Object.fromEntries((await userMcpServers()).filter((n) => !keep.has(n)).map((n) => [`mcp_servers.${n}.enabled`, false]))
      : {};
    const selected = Object.fromEntries((builtin?.machineMcp ?? []).map((n) => [`mcp_servers.${n}.enabled`, true]));
    const work = { ...off, ...selected, ...codexMcp(builtin?.mcp ?? {}, builtin?.askMcp), ...mcp, ...this.skillConfig() };
    return Object.keys(work).length ? { config: work } : {};
  }

  /**
   * 技能设置：变量逐个写进 shell_environment_policy.set（只作用于这个 thread 里跑的命令，
   * 一个个键写不会冲掉用户 config.toml 里本来设的），只给能跑命令的专家；成员和自定义专家关掉 Codex 自己的
   * 技能清单 —— 那里面是机器上装的技能，只给管理员。agent-loft 的技能走 contextBlock 里的清单。
   */
  private skillConfig(): Record<string, unknown> {
    const skills = this.opts.skills;
    if (!skills) return {};
    return {
      ...(this.access === "exec" ? Object.fromEntries(Object.entries(skills.env).map(([k, v]) => [`shell_environment_policy.set.${k}`, v])) : {}),
      ...(skills.admin && skills.machineSkills !== false && !this.opts.expert ? {} : { "skills.include_instructions": false, "features.skill_search": false }),
    };
  }

  /**
   * 这个会话进程还没告诉过 Codex 专家和记忆：第一条消息后面附上 contextBlock。
   * 进程一换（专家改了、记忆改了、服务重启）就是新的 CodexSession，会再附一次最新的。
   * 内置专家没有记忆和技能时也要附：回复里能画图（```chart / ```mermaid）得告诉它。
   */
  private contextSent = false;

  private get contextPending(): boolean {
    return !this.contextSent;
  }

  private async openOnce(): Promise<string> {
    const shared = {
      cwd: this.opts.cwd,
      approvalPolicy: "on-request",
      sandbox: this.sandboxMode,
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(await this.modeParams()),
    };
    if (this.disposed) throw new DisposedError();
    const resumeId = this.threadId ?? this.opts.resumeId;
    const fork = this.opts.fork && !this.forked;
    // 这个 thread 正在别的会话里跑：不接管。接管后它的后续输出和审批请求都按 threadId
    // 路由，会串到这边来；等它跑完再恢复。（fork 出来的是新 thread，不受影响）
    const owner = resumeId && !fork ? byThread.get(resumeId) : undefined;
    if (owner && owner !== this && owner.busy) {
      throw new Error("这条 Codex 会话正在另一个聊天里运行，等那边这一轮结束后再试。");
    }

    let res: ThreadResponse;
    opening.add(this);
    try {
      if (resumeId && fork) {
        res = await appServer.call<ThreadResponse>("thread/fork", { threadId: resumeId, excludeTurns: true, ...shared });
      } else if (resumeId) {
        res = await appServer.call<ThreadResponse>("thread/resume", { threadId: resumeId, excludeTurns: true, ...shared });
      } else {
        res = await appServer.call<ThreadResponse>("thread/start", shared);
      }
    } finally {
      opening.delete(this);
    }
    // 等待期间会话已被丢弃（切了目录 / 开了新会话）：迟到的 thread 只做清理，绝不再开轮次
    if (this.disposed) {
      // 只有没人在用时才退订：这个 thread 可能正被另一条会话持有，退订会断掉它的通知
      if (!byThread.has(res.thread.id)) {
        void appServer.call("thread/unsubscribe", { threadId: res.thread.id }).catch(() => {});
      }
      throw new DisposedError();
    }
    this.adopt(res.thread);
    // 到这里分叉才算完成；之前任何一步失败，下次重试都还会走 thread/fork，绝不会续写原会话
    if (fork) this.forked = true;
    return res.thread.id;
  }

  /**
   * 接管前最后再看一眼：等 resume 响应的这段时间里，原所有者可能刚好开了新一轮。
   * 这时放弃接管、路由完全不动 —— 否则它的输出和审批会串到这边来。
   * 这个检查和下面的 byThread.set 之间没有 await，不存在再插进来的空隙。
   */
  private adopt(thread: Thread): void {
    const busyOwner = byThread.get(thread.id);
    if (busyOwner && busyOwner !== this && busyOwner.busy) {
      throw new Error("这条 Codex 会话正在另一个聊天里运行，等那边这一轮结束后再试。");
    }
    const previous = this.threadId;
    if (previous && previous !== thread.id && byThread.get(previous) === this) byThread.delete(previous);
    this.threadId = thread.id;
    this.detached = false;
    // 同一个 thread 被两条会话恢复（比如 Web 上恢复了飞书群里那条）：通知按 threadId 路由，
    // 只能有一个接收方。所有权交给最后恢复它的这条，原来那条标记为待恢复，
    // 它下次说话时会重新 resume、再把所有权拿回去 —— 回复不会再串到别的聊天里。
    const owner = byThread.get(thread.id);
    if (owner && owner !== this) {
      // 原所有者空闲（忙的情况在函数开头已经拒绝，且那里到这里之间没有 await）
      owner.evict();
    }
    byThread.set(thread.id, this);
    this.runtime = {
      ...(thread.model ? { model: thread.model } : {}),
      ...(thread.reasoningEffort ? { effort: thread.reasoningEffort } : {}),
    };
    if (thread.id !== previous) this.events.onSessionId(thread.id);
  }

  /**
   * turn/start 的响应要等这一轮跑完才回来，所以不 await —— 过程和结果都从通知走。
   * 图片作为 localImage 一起送进去，模型能直接看到。
   */
  send(input: UserInput): void {
    if (this.disposed) return;
    // 上一轮还没完：排队。不能并发开两个 turn —— 它们会互相覆盖回复文本和中断状态
    if (this.phase !== "idle") {
      this.queue.push(input);
      return;
    }
    this.startTurn(input);
  }

  cancelQueued(input: UserInput): boolean {
    const index = this.queue.indexOf(input);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    return true;
  }

  private startTurn(input: UserInput): void {
    this.currentInput = input;
    this.replyText = "";
    this.turnTokens = undefined;
    this.turnSeen = false;
    this.phase = "starting";
    this.turnId = undefined;
    this.stopRequested = false;
    const token = ++this.turnSeq;
    // 只能联网的专家没有执行命令的工具，读不了文件：文本附件的内容直接放进消息
    const noRead = this.access === "web";
    const textMap = noRead ? readTextAttachments(input.attachments) : new Map<string, string>();
    const inlined = (a: SavedAttachment) => a.kind === "image" || textMap.has(a.path);
    const note = input.attachments.length ? describeAttachments(input.attachments, inlined, noRead) : "";
    const texts = noRead ? inlineTextBlocks(input.attachments, textMap) : "";
    // 放在最后：Codex 拿第一条消息的开头当会话预览，不能被这段背景占掉
    const expert = this.opts.expert;
    const context = this.contextPending
      ? contextBlock(expert ? { prompt: expert, cwd: this.opts.cwd } : undefined, this.opts.memory?.prompt, codexSkillLines(this.opts.skills))
      : "";
    const text = [input.text, note, texts, context].filter(Boolean).join("\n\n");
    const images = input.attachments.filter((a) => a.kind === "image").map((a) => a.path);
    let startedOn: string | undefined;
    void this.open()
      .then((threadId) => {
        if (this.disposed) throw new DisposedError();
        if (token !== this.turnSeq) throw new DisposedError(); // 等 thread 期间被停止了
        startedOn = threadId;
        return appServer.call<{ turn?: { id?: string } }>("turn/start", {
          threadId,
          input: [
            { type: "text", text, text_elements: [] },
            ...images.map((path) => ({ type: "localImage" as const, path })),
          ],
          cwd: this.opts.cwd,
          approvalPolicy: "on-request",
          // 每一轮都按当前配置显式给沙箱：thread 是开着复用的，只在 thread/start 时给的话，
          // 设置里收紧了沙箱（比如改成只读），已有会话还会按旧权限干活
          sandboxPolicy: sandboxPolicyFor(this.sandboxMode, this.opts.cwd),
          ...(this.opts.model ? { model: this.opts.model } : {}),
          ...(this.opts.effort ? { effort: this.opts.effort } : {}),
        });
      })
      .then((res) => {
        // 轮次开起来了，背景已经进了 thread 的历史；没开起来的话下一条消息再附一次
        if (context) this.contextSent = true;
        const id = res?.turn?.id;
        if (!id) return;
        if (token === this.turnSeq) {
          // turn/start 的响应带着轮次 id（它只是「轮次已开始」，不是结果）
          this.onTurnId(id);
          return;
        }
        // 这一轮在启动途中被叫停 / 会话被丢弃了，但服务端其实已经开跑：补一个中断，别让它在后台继续干活
        if (this.abandoned.delete(token) && startedOn) {
          this.endedTurns.add(id);
          void appServer.call("turn/interrupt", { threadId: startedOn, turnId: id }).catch(() => {});
        }
      })
      .catch((err) => {
        // 这一轮已经被别的路径收尾了（停止、进程退出、丢弃）：不再重复报错
        if (err instanceof DisposedError || this.disposed || token !== this.turnSeq) return;
        this.endTurn();
        this.events.onError(err);
        this.drainQueue();
      });
  }

  private onTurnId(id: string): void {
    if (id !== this.turnId && this.currentInput) this.events.onUserAnchor?.(this.currentInput, id);
    this.turnId = id;
    this.phase = "running";
    if (this.stopRequested) {
      this.stopRequested = false;
      void this.interrupt();
    }
  }

  /** 记下来，下一轮 turn/start 带上即可。 */
  async setModel(model?: string, effort?: string): Promise<void> {
    if (model !== undefined) this.opts.model = model;
    if (effort !== undefined) this.opts.effort = effort;
    const nextModel = model ?? this.runtime.model;
    const nextEffort = effort ?? this.runtime.effort;
    this.runtime = { ...(nextModel ? { model: nextModel } : {}), ...(nextEffort ? { effort: nextEffort } : {}) };
  }

  /** 已知的模型 / 思考程度，不拉起进程、不发请求（顶栏显示用） */
  peekRuntime(): RuntimeInfo {
    return this.runtime;
  }

  /** 不额外发请求，也绝不为此新开 thread（否则历史里会留一串空会话）。 */
  async describeRuntime(): Promise<RuntimeInfo> {
    return this.runtime;
  }

  async interrupt(opts: InterruptOptions = {}): Promise<void> {
    if (opts.keepQueue) {
      // 打断并发送：排着的留着，选中的挪到最前面，这一轮结束后 drainQueue 就开它
      const i = opts.first ? this.queue.indexOf(opts.first) : -1;
      if (i > 0) this.queue.unshift(...this.queue.splice(i, 1));
    } else {
      // 停止 = 这一轮和排着队的都不要了
      this.queue = [];
    }
    if (this.phase === "starting" && !this.turnId) {
      // 轮次还没真正开始：记下来，拿到轮次 id 立刻中断
      this.stopRequested = true;
      return;
    }
    if (this.phase !== "running" || !this.threadId || !this.turnId) return;
    try {
      await appServer.call("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
    } catch (err) {
      console.warn("[codex] 中断请求未生效:", err instanceof Error ? err.message : err);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.queue = [];
    await this.interrupt();
    // 只有当前所有者才清理映射和退订：thread 已经被别的会话接管时，退订会把它的订阅一起断掉
    if (this.threadId && byThread.get(this.threadId) === this) {
      byThread.delete(this.threadId);
      try {
        await appServer.call("thread/unsubscribe", { threadId: this.threadId });
      } catch {
        // 老版本没有这个方法，或者 thread 已经没了
      }
    }
    this.threadId = undefined;
    this.endTurn();
  }

  // ---------- 反向请求：审批与提问 ----------

  /** 审批都走这里：带上「本会话全部允许」按钮，点了就记住。 */
  private async ask(spec: Extract<InteractionSpec, { kind: "approval" }>): Promise<InteractionOutcome> {
    const outcome = await this.host({ ...spec, allowSession: true });
    if (outcome.settlement === "allow-session") {
      if (!this.allowAll) this.events.onStep("warning", "🔓 本会话内后续操作不再询问（/new 或切换会话后恢复逐条确认）");
      this.allowAll = true;
    }
    return outcome;
  }

  /**
   * 每一条都**必须**返回点什么 —— 漏回一次，Codex 那一轮就永远挂在等审批上。
   * 未知方法也要按它自己的协议结构明确拒绝。
   */
  async handleServerRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "mcpServer/elicitation/request": {
        const req = params as { serverName: string; mode?: string; message?: string; _meta?: Record<string, unknown> };
        // Codex 用 elicitation 传工具审批；普通 MCP 表单仍按未支持处理，不能把表单当授权。
        if (req.mode !== "form" || req._meta?.codex_approval_kind !== "mcp_tool_call" || !(this.opts.expert ?? this.opts.builtinMcp)?.mcp[req.serverName]) {
          return refusalFor(method);
        }
        const detail = [req.message, req._meta.tool_params === undefined ? "" : `\`\`\`json\n${JSON.stringify(req._meta.tool_params, null, 2)}\n\`\`\``].filter(Boolean).join("\n\n");
        // 每次都问，不沿用命令的「本会话全部允许」，也不把授权写回机器配置。
        const outcome = await this.host({ kind: "approval", title: `需要授权：调用 MCP「${req.serverName}」`, detail: detail || "Codex 想调用这个 MCP 的工具。" });
        return { action: allowed(outcome.settlement) ? "accept" : outcome.settlement === "cancelled" ? "cancel" : "decline", content: null, _meta: null };
      }

      case "item/commandExecution/requestApproval": {
        const req = params as CommandExecutionApprovalParams;
        if (this.allowAll) return { decision: "acceptForSession" };
        const amendment = req.proposedExecpolicyAmendment ?? null;
        const outcome = await this.ask({
          kind: "approval",
          title: req.kind === "writeStdin" ? "需要授权：向运行中的命令输入" : "需要授权：执行命令",
          detail: describeCommand(req),
          // 「总是允许」到底记多宽取决于 Codex 有没有给 execpolicy 补丁，差别很大，得写在按钮上
          alwaysLabel: amendment ? "以后同类不再问" : "本会话内不再问",
          ...(amendment ? { alwaysGlobal: true } : {}),
        });
        const s = outcome.settlement;
        if (s === "allow-once") return { decision: "accept" };
        if (s === "allow-session") return { decision: "acceptForSession" };
        if (s === "allow-always") {
          return {
            decision: amendment
              ? { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } }
              : "acceptForSession",
          };
        }
        if (s === "cancelled") return { decision: "cancel" };
        return { decision: "decline" };
      }

      case "item/fileChange/requestApproval": {
        const req = params as FileChangeApprovalParams;
        if (this.allowAll) return { decision: "acceptForSession" };
        const outcome = await this.ask({
          kind: "approval",
          title: "需要授权：改动文件",
          detail: describeFileChange(req),
          alwaysLabel: "本会话内不再问",
        });
        const s = outcome.settlement;
        if (s === "allow-once") return { decision: "accept" };
        if (s === "allow-always" || s === "allow-session") return { decision: "acceptForSession" };
        if (s === "cancelled") return { decision: "cancel" };
        return { decision: "decline" };
      }

      case "item/permissions/requestApproval": {
        const req = params as PermissionsApprovalParams;
        if (this.allowAll) return { permissions: req.permissions ?? {}, scope: "session" };
        const outcome = await this.ask({
          kind: "approval",
          title: "需要授权：额外权限",
          detail: describePermissions(req),
          alwaysLabel: "本会话内都给",
        });
        if (!allowed(outcome.settlement)) return { permissions: {}, scope: "turn" };
        return {
          permissions: req.permissions ?? {},
          scope: outcome.settlement === "allow-once" ? "turn" : "session",
        };
      }

      case "item/tool/requestUserInput": {
        const req = params as ToolRequestUserInputParams;
        const questions = parseQuestions(req.questions);
        if (!questions) {
          console.warn("[codex] 解不出问题清单，按未作答处理");
          return { answers: {} };
        }
        // 敏感问题（密码之类）不在聊天里问：内容会明明白白留在聊天记录里
        if (questions.some((q) => q.secret)) {
          this.events.onStep(
            "warning",
            "⚠️ Codex 想问一个敏感信息（密码 / 密钥之类），聊天里不收这种内容，已按未作答处理。请到终端里直接跑 Codex 完成这一步。",
          );
          return { answers: {} };
        }
        const outcome = await this.host({
          kind: "question",
          title: "Codex 想确认一下",
          questions: questions.map(({ secret: _secret, ...q }) => q),
        });
        const answers: Record<string, { answers: string[] }> = {};
        for (const [id, picked] of Object.entries(outcome.answers)) answers[id] = { answers: picked };
        return { answers };
      }

      default: {
        // MCP elicitation、动态工具调用等还没接。拒绝必须用这种请求自己的响应结构
        const refusal = refusalFor(method);
        if (refusal === null) throw new UnsupportedRequest(method);
        console.warn(`[codex] 暂不支持的请求 ${method}，已按其协议拒绝`);
        return refusal;
      }
    }
  }

  // ---------- 通知 ----------

  handleNotification(method: string, params: unknown): void {

    switch (method) {
      case "turn/started": {
        // 轮次 id 在 params.turn.id，不在顶层
        const id = (params as { turn?: { id?: string } }).turn?.id;
        // 只认「正在等它开始」的那一轮；收过尾的旧轮次晚到的通知忽略
        if (this.phase === "idle" || (id && this.endedTurns.has(id))) return;
        if (id) this.onTurnId(id);
        this.commentaryItems.clear();
        this.turnSeen = true;
        this.events.onTurnStart?.();
        return;
      }

      case "item/started":
        this.onItem((params as ItemNotification).item, "started");
        return;

      case "item/completed":
        this.onItem((params as ItemNotification).item, "completed");
        return;

      case "turn/plan/updated": {
        // Codex 的计划（update_plan）：每次给整份，状态叫法和 Claude 不一样
        const plan = (params as { plan?: { step?: unknown; status?: unknown }[] }).plan;
        if (!this.turnSeen || !Array.isArray(plan)) return;
        const todos = plan.flatMap((p) =>
          typeof p.step === "string"
            ? [{ content: p.step, status: p.status === "completed" ? ("completed" as const) : p.status === "inProgress" ? ("in_progress" as const) : ("pending" as const) }]
            : [],
        );
        this.events.onStep("note", `📋 更新计划（${todos.filter((t) => t.status === "completed").length}/${todos.length}）`);
        this.events.onTodos?.(todos);
        return;
      }

      case "item/agentMessage/delta": {
        const p = params as AgentMessageDeltaNotification;
        if (!this.commentaryItems.has(p.itemId) && p.delta) this.events.onTextDelta(p.delta);
        return;
      }

      case "thread/tokenUsage/updated": {
        // last 是最近一次模型请求的用量，total 是整条 thread 的累计；去重后累加到本轮页脚和会话汇总
        const usage = (params as { tokenUsage?: { total?: TokenBreakdown; last?: TokenBreakdown; modelContextWindow?: number | null } })
          .tokenUsage;
        const total = usage?.total?.totalTokens;
        if (this.turnSeen && usage?.last && typeof total === "number" && total !== this.seenTotal) {
          const l = usage.last;
          // OpenAI 的 inputTokens 含命中缓存的部分，拆出来
          const cached = l.cachedInputTokens ?? 0;
          const written = l.cacheWriteInputTokens ?? 0;
          const delta = {
            input: Math.max(0, (l.inputTokens ?? 0) - cached - written),
            cacheRead: cached,
            cacheWrite: written,
            output: l.outputTokens ?? 0,
            reasoning: l.reasoningOutputTokens ?? 0,
          };
          this.turnTokens = (this.turnTokens ?? 0) + delta.input + delta.cacheRead + delta.cacheWrite + delta.output;
          this.events.onUsage?.(delta);
        }
        if (typeof total === "number") this.seenTotal = total;
        const requestTokens = usage?.last?.totalTokens;
        // 最近一次请求的用量 ≈ 当前上下文大小（Codex 自己的「剩余上下文」也是这么算的）
        const window = usage?.modelContextWindow;
        if (typeof requestTokens === "number" && window) {
          this.events.onContext?.({ used: requestTokens, window, percent: Math.round((requestTokens / window) * 100) });
        }
        return;
      }

      case "turn/completed": {
        const { turn } = params as TurnCompletedNotification;
        // 已经收过尾的、或者不是当前这一轮的，不处理
        if (this.phase === "idle" || (turn.id && this.endedTurns.has(turn.id))) return;
        if (this.turnId && turn.id && turn.id !== this.turnId) return;
        const text = this.replyText;
        this.replyText = "";
        this.endTurn();
        if (turn.status === "failed") {
          this.events.onError(new Error(turn.error?.message ?? "这一轮失败了"));
        } else if (turn.status === "interrupted") {
          this.events.onResult({
            text: text || "（已中断）",
            durationMs: turn.durationMs ?? 0,
            ...(turn.id ? { anchor: turn.id } : {}),
          });
        } else {
          this.events.onResult({
            text,
            durationMs: turn.durationMs ?? 0,
            ...(this.turnTokens !== undefined ? { tokens: this.turnTokens } : {}),
            ...(turn.id ? { anchor: turn.id } : {}),
          });
        }
        this.drainQueue();
        return;
      }

      case "error": {
        const { error, willRetry } = params as { error?: { message?: string }; willRetry?: boolean };
        if (willRetry) {
          this.events.onStep("warning", `⚠️ ${summarize(error?.message ?? "出错，正在重试")}`);
          return;
        }
        if (this.phase === "idle") return;
        this.endTurn();
        this.events.onError(new Error(error?.message ?? "未知错误"));
        this.drainQueue();
        return;
      }

      case "thread/settings/updated": {
        const thread = (params as { thread?: Thread }).thread;
        if (thread) {
          this.runtime = {
            ...(thread.model ? { model: thread.model } : {}),
            ...(thread.reasoningEffort ? { effort: thread.reasoningEffort } : {}),
          };
        }
        return;
      }

      default:
        return;
    }
  }

  private onItem(item: ThreadItem, phase: "started" | "completed"): void {
    switch (item.type) {
      case "agentMessage": {
        const message = item as Extract<ThreadItem, { type: "agentMessage" }>;
        if (message.phase === "commentary") this.commentaryItems.add(message.id);
        if (phase !== "completed" || !message.text.trim()) return;
        // commentary 是 Codex 边干边说的旁白，属于过程；正文才是要给人看的回复
        if (message.phase === "commentary") {
          this.events.onStep("note", `💬 ${summarize(message.text)}`);
          return;
        }
        this.replyText += (this.replyText ? "\n\n" : "") + message.text;
        this.events.onText(message.text);
        return;
      }
      case "reasoning": {
        if (phase !== "completed") return;
        const reasoning = item as Extract<ThreadItem, { type: "reasoning" }>;
        const thought = (reasoning.summary ?? []).join(" ").trim();
        if (thought) this.events.onStep("thinking", `💭 ${summarize(thought)}`);
        return;
      }
      case "commandExecution": {
        const exec = item as Extract<ThreadItem, { type: "commandExecution" }>;
        if (phase === "started") {
          this.events.onStep("tool", `🔧 ${summarize(exec.command, 70)}`);
          return;
        }
        if (exec.status === "failed" || (exec.exitCode ?? 0) !== 0) {
          this.events.onStep("warning", `   ↳ 退出码 ${exec.exitCode ?? "?"}`);
        }
        return;
      }
      case "fileChange": {
        if (phase !== "completed") return;
        const change = item as Extract<ThreadItem, { type: "fileChange" }>;
        const files = change.changes.map((c) => `${kindMark(c.kind)}${c.path}`).join("、");
        this.events.onStep("tool", `📝 ${change.status === "failed" ? "改文件失败：" : ""}${summarize(files, 90)}`);
        return;
      }
      case "mcpToolCall": {
        if (phase !== "started") return;
        const call = item as Extract<ThreadItem, { type: "mcpToolCall" }>;
        this.events.onStep("tool", `🔌 ${call.server}.${call.tool}`);
        return;
      }
      case "webSearch": {
        if (phase !== "started") return;
        const search = item as Extract<ThreadItem, { type: "webSearch" }>;
        this.events.onStep("tool", `🔍 ${summarize(search.query ?? "", 60)}`);
        return;
      }
      case "plan": {
        if (phase !== "completed") return;
        const plan = item as Extract<ThreadItem, { type: "plan" }>;
        this.events.onStep("note", `📋 ${summarize(plan.text, 90)}`);
        return;
      }
      case "error": {
        if (phase !== "completed") return;
        const err = item as Extract<ThreadItem, { type: "error" }>;
        this.events.onStep("warning", `⚠️ ${summarize(err.message)}`);
        return;
      }
      default:
        return;
    }
  }
}

function kindMark(kind: unknown): string {
  const k = typeof kind === "string" ? kind : (kind as { type?: string } | null)?.type;
  return k === "add" ? "+" : k === "delete" ? "-" : "~";
}

export function summarize(text: string, max = 80): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
