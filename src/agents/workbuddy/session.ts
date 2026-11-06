// 一条会话 ↔ 一个常驻的 WorkBuddy（CodeBuddy Code）CLI 进程。
//
// 用的是 SDK 的 V2 会话（unstable_v2_createSession / resumeSession），不是 query()：
// 这个 SDK 的 query() 会先把 prompt 迭代器整个读完才开始收消息，而且收到第一个 result 就结束，
// 等于一次一轮，做不了常驻会话（实测，SDK 0.3.301）。V2 会话一个进程跑多轮：每轮 send() 再 stream()，
// stream() 收到这一轮的 result 就停；setModel / setPermissionMode / interrupt 都能在中途用。
//
// 消息先留在本地排队，上一轮出结果才交给 CLI —— 停止时排着的能一起丢掉（和 Claude 一样）。
// 出错时 SDK 不给 result，而是在 stream() 里抛 ExecutionError，当成这一轮出错处理。
//
// 只做内置专家：原装提示词和工具，后面追加 agent-loft 的回复格式、记忆、技能说明，挂上记忆 / 定时任务 / 技能 MCP。
import fs from "node:fs";
import type { McpServerConfig, Message, PermissionMode, PermissionResult, SessionOptions as SdkSessionOptions, UserMessage } from "@tencent-ai/agent-sdk";
import { RICH_REPLY_LINES } from "../../core/expert-prompt.js";
import { MEMORY_MCP_NAME, memoryMcpSpawn } from "../../core/memory-mcp.js";
import { SKILLS_MCP_NAME, skillsMcpSpawn, TASKS_MCP_NAME, tasksMcpSpawn } from "../../core/tasks-mcp.js";
import type { PermissionLevel } from "../../core/permission.js";
import { codexSkillLines } from "../../core/skill-runtime.js";
import { describeAttachments } from "../../core/uploads.js";
import type {
  AgentEvents,
  AgentSession,
  InteractionHost,
  InterruptOptions,
  ModelInfo,
  RuntimeInfo,
  SavedAttachment,
  SessionOptions,
  TokenUsage,
  UserInput,
} from "../../core/types.js";
import { describeToolUse, summarize } from "../claude/session.js";
import { describeToolCall, isRememberable, parseQuestions } from "../claude/permissions.js";
import { feedTodos, TodoTracker } from "../claude/todos.js";
import { baseOptions, loadSdk, modelOf } from "./sdk.js";

/** 级别 + 计划模式 → permissionMode。「完全允许」也用 default，在 canUseTool 里全放行（和 Claude 一样，见 permission.ts） */
export function modeOf(level: PermissionLevel | undefined, plan: boolean | undefined): PermissionMode {
  if (plan) return "plan";
  return level === "edit" || level === "auto" ? "acceptEdits" : "default";
}

type ImageMedia = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
type ContentBlock = { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: ImageMedia; data: string } };

/** 图片直接给模型看（和 Claude 一样限 3.75MB）；PDF 等其余附件只给路径，让它自己读 */
const INLINE_IMAGE_MAX = 3.75 * 1024 * 1024;
function canInline(a: SavedAttachment): boolean {
  return !!a.mediaType && /^image\/(png|jpeg|gif|webp)$/.test(a.mediaType) && a.size <= INLINE_IMAGE_MAX;
}

function buildContent(input: UserInput): string | ContentBlock[] {
  if (input.attachments.length === 0) return input.text;
  const note = describeAttachments(input.attachments, canInline, false);
  const blocks: ContentBlock[] = [{ type: "text", text: [input.text, note].filter(Boolean).join("\n\n") }];
  for (const a of input.attachments) {
    if (!canInline(a)) continue;
    blocks.push({ type: "image", source: { type: "base64", media_type: a.mediaType as ImageMedia, data: fs.readFileSync(a.path).toString("base64") } });
  }
  return blocks;
}

const MEMORY_TOOLS = new Set(["remember", "forget", "update_memory", "search_memory", "search_past_chats", "read_past_chat", "memory_timeline"].map((t) => `mcp__${MEMORY_MCP_NAME}__${t}`));
const TASK_TOOLS = new Set(["list_tasks", "create_task", "update_task", "delete_task"].map((t) => `mcp__${TASKS_MCP_NAME}__${t}`));
const SKILL_TOOLS = new Set(["list_skills", "get_skill", "create_skill", "update_skill", "skill_request"].map((t) => `mcp__${SKILLS_MCP_NAME}__${t}`));

/** 内置专家的会话选项：读不读本机 CodeBuddy 配置、挂哪些 MCP、系统提示后面追加什么 */
export function sessionOptions(opts: SessionOptions): Partial<SdkSessionOptions> {
  const memory = opts.memory;
  const skills = opts.skills;
  const mcpServers: Record<string, McpServerConfig> = {
    ...(opts.builtinMcp?.mcp as Record<string, McpServerConfig> | undefined),
    ...(memory
      ? { [MEMORY_MCP_NAME]: { type: "stdio", ...memoryMcpSpawn(memory.userId, "workbuddy", { search: !!memory.search, ...(memory.convKey ? { convKey: memory.convKey } : {}) }) } }
      : {}),
    ...(opts.tasks
      ? {
          [TASKS_MCP_NAME]: { type: "stdio", ...tasksMcpSpawn(opts.tasks.userId, opts.tasks.convKey, "workbuddy") },
          [SKILLS_MCP_NAME]: { type: "stdio", ...skillsMcpSpawn(opts.tasks.userId, opts.tasks.convKey, "workbuddy") },
        }
      : {}),
  };
  const append = [RICH_REPLY_LINES.join("\n"), memory?.prompt, codexSkillLines(skills).join("\n")].filter(Boolean).join("\n\n");
  // SDK 默认什么本地配置都不读。管理员（或没主人的对话）读全部，和直接用 CLI 一样；
  // 成员只读项目里的 —— 机器主人的 ~/.codebuddy 里的 MCP、技能、规则不给成员用（和 Claude 那边一致）
  const machine = !skills || (skills.admin && skills.machineSkills !== false);
  const strict = !!opts.builtinMcp && !opts.builtinMcp.inheritMachine;
  return {
    systemPrompt: { append },
    settingSources: machine ? ["user", "project", "local"] : ["project"],
    ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
    ...(strict || !machine ? { strictMcpConfig: true } : {}),
  };
}

type V2Session = ReturnType<Awaited<ReturnType<typeof loadSdk>>["unstable_v2_createSession"]>;

export class WorkBuddySession implements AgentSession {
  private session: V2Session | null = null;
  /** 正在拉起（SDK 按需 import） */
  private starting: Promise<V2Session | null> | null = null;
  private currentId: string | undefined;
  /** 分叉已经生效（CLI 报了一个和原会话不同的 id），之后重拉就是接着新的这条，不再分叉 */
  private forked = false;
  private lastAssistantUuid: string | undefined;
  private runtime: RuntimeInfo = {};
  private disposed = false;
  private turnBusy = false;
  private pending: UserInput[] = [];
  /** 「完全允许」或点过「本会话全部允许」 */
  private allowAll = false;
  private todos = new TodoTracker();
  /** 这一轮的 send + stream，dispose 时等它收尾 */
  private turn: Promise<void> | null = null;
  /** 这一轮报过「开始」了：CLI 每轮会发两次 init，只报一次 */
  private turnStarted = false;

  constructor(
    private readonly opts: SessionOptions,
    private readonly events: AgentEvents,
    private readonly host: InteractionHost,
  ) {
    this.allowAll = opts.permission === "full";
    if (opts.model) this.runtime = { model: opts.model };
  }

  get sessionId(): string | undefined {
    return this.currentId;
  }

  private start(): Promise<V2Session | null> {
    if (this.session) return Promise.resolve(this.session);
    if (this.disposed) return Promise.resolve(null);
    this.starting ??= this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(): Promise<V2Session | null> {
    const sdk = await loadSdk();
    if (this.disposed) return null;
    // 重拉时接着最新的会话；分叉只在第一次
    const fork = !!this.opts.fork && !this.forked;
    const resume = fork ? this.opts.resumeId : (this.currentId ?? this.opts.resumeId);
    const options: SdkSessionOptions = {
      cwd: this.opts.cwd,
      ...baseOptions(this.opts.skills?.env ?? {}),
      permissionMode: modeOf(this.opts.permission, this.opts.plan),
      includePartialMessages: true,
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...sessionOptions(this.opts),
      // V2 会话没有 additionalDirectories / forkSession 选项，直接给 CLI 参数
      extraArgs: { "add-dir": this.opts.uploadsDir, ...(fork ? { "fork-session": null } : {}) },
      canUseTool: async (toolName, toolInput) => this.canUseTool(toolName, toolInput as Record<string, unknown>),
    };
    const session = resume ? sdk.unstable_v2_resumeSession(resume, options) : sdk.unstable_v2_createSession(options);
    this.session = session;
    return session;
  }

  /** CLI 退了、连接断了：扔掉这个会话对象，下一轮带着最新的 id 重新拉起 */
  private drop(session: V2Session): void {
    if (this.session !== session) return;
    this.session = null;
    try {
      session.close();
    } catch {
      // 已经关了
    }
  }

  /** 跑一轮：发出去，收到这一轮的 result（或出错）为止 */
  private async runTurn(content: string | ContentBlock[], input: UserInput): Promise<void> {
    let sawResult = false;
    let session: V2Session | null = null;
    try {
      session = await this.start();
      if (!session) return;
      await session.send({
        type: "user",
        ...(input.id ? { uuid: input.id } : {}),
        session_id: this.currentId ?? "",
        message: { role: "user", content: content as never },
        parent_tool_use_id: null,
      } as UserMessage);
      if (input.id) this.events.onUserAnchor?.(input, input.id);
      for await (const message of session.stream()) {
        if (message.type === "result") sawResult = true;
        this.handle(message);
      }
      // 没等到 result 流就断了：CLI 多半退出了，下一轮重拉
      if (!sawResult && !this.disposed) {
        this.drop(session);
        this.events.onError(new Error("WorkBuddy 进程意外退出了，这一轮没有完成"));
      }
    } catch (err) {
      if (this.disposed) return;
      const name = (err as { name?: string })?.name;
      // ExecutionError：这一轮报错收场（未登录、额度用完…），进程还在；别的错误当进程坏了，重拉
      if (name !== "ExecutionError" && session) this.drop(session);
      this.events.onError(err);
    }
  }

  private handle(message: Message): void {
    const m = message as Message & { session_id?: string };
    if (typeof m.session_id === "string" && m.session_id && m.session_id !== this.currentId) {
      if (this.opts.fork && m.session_id !== this.opts.resumeId) this.forked = true;
      this.currentId = m.session_id;
      this.events.onSessionId(m.session_id);
    }
    if (message.type === "system" && message.subtype === "init") {
      if (message.model) this.runtime = { ...this.runtime, model: message.model };
      if (message.permissionMode) this.syncPlan(message.permissionMode === "plan");
      if (!this.turnStarted) {
        this.turnStarted = true;
        this.events.onTurnStart?.();
      }
      return;
    }

    if (message.type === "error") {
      this.events.onError(new Error(message.error));
      return;
    }

    if (message.type === "stream_event") {
      if (message.parent_tool_use_id) return;
      const event = message.event as { type?: string; delta?: { type?: string; text?: string } };
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) this.events.onTextDelta(event.delta.text);
      return;
    }

    if (message.type === "assistant") {
      const blocks = message.message?.content;
      if (!Array.isArray(blocks)) return;
      const sub = !!message.parent_tool_use_id;
      if (!sub && message.uuid) this.lastAssistantUuid = message.uuid;
      for (const block of blocks) {
        if (block.type === "thinking") {
          const thought = summarize(block.thinking);
          if (thought) this.events.onStep("thinking", `💭 ${thought}`);
        } else if (block.type === "tool_use") {
          const todo = sub ? null : this.todos.use(block.name, block.input, block.id);
          if (todo) {
            this.events.onStep("tool", todo.step);
            if (todo.changed) this.events.onTodos?.(this.todos.list);
            continue;
          }
          this.events.onStep("tool", `${sub ? "  ↳ " : ""}🔧 ${describeToolUse(block.name, block.input)}`);
        } else if (block.type === "text" && block.text.trim() && !sub) {
          this.events.onText(block.text);
        }
      }
      if (message.error && !sub) this.events.onStep("warning", `⚠️ ${message.error}`);
      return;
    }

    if (message.type === "user") {
      if (!message.parent_tool_use_id && feedTodos(this.todos, message)) this.events.onTodos?.(this.todos.list);
      return;
    }

    if (message.type === "result") {
      const tokens = this.reportUsage(message.usage);
      if (message.subtype === "success" && !message.is_error) {
        this.events.onResult({
          text: message.result,
          ...(tokens ? { tokens } : {}),
          durationMs: message.duration_ms,
          ...(this.lastAssistantUuid ? { anchor: this.lastAssistantUuid } : {}),
        });
      } else {
        const r = message as { result?: string; errors?: string[]; subtype: string };
        const why = r.errors?.filter(Boolean).join("；") || (message.subtype === "success" ? r.result : "") || message.subtype;
        this.events.onError(new Error(`运行结束但报错：${why}`));
      }
    }
  }

  /**
   * result 里的 usage 是这一轮的（新增量），由核心累加。
   * 实测 WorkBuddy 的 input_tokens 已经含了缓存读写的部分（input = 读 + 写 + 没命中的），减掉才是没命中缓存的
   */
  private reportUsage(usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | undefined): number | undefined {
    if (!usage) return undefined;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheWrite = usage.cache_creation_input_tokens || 0;
    const input = usage.input_tokens || 0;
    const u: TokenUsage = {
      input: input >= cacheRead + cacheWrite ? input - cacheRead - cacheWrite : input,
      cacheRead,
      cacheWrite,
      output: usage.output_tokens || 0,
    };
    const total = u.input + u.cacheRead + u.cacheWrite + u.output;
    if (!(total > 0)) return undefined;
    this.events.onUsage?.(u, false);
    return total;
  }

  // ---------- 授权 ----------

  private async canUseTool(toolName: string, input: Record<string, unknown>): Promise<PermissionResult> {
    if (MEMORY_TOOLS.has(toolName) && this.opts.memory) return { behavior: "allow", updatedInput: input };
    if ((TASK_TOOLS.has(toolName) || SKILL_TOOLS.has(toolName)) && this.opts.tasks) return { behavior: "allow", updatedInput: input };
    const mcp = /^mcp__(.+?)__/.exec(toolName)?.[1];
    const builtin = this.opts.builtinMcp;
    const configured = !!builtin && !!mcp && mcp in builtin.mcp;
    const asksFirst = configured && builtin!.askMcp.includes(mcp!);
    if (configured && !asksFirst) return { behavior: "allow", updatedInput: input };

    if (toolName === "AskUserQuestion") {
      const answered = await this.askQuestion(input);
      if (answered) return answered;
    }
    if (toolName === "ExitPlanMode") return this.approvePlan(input);

    const sessionable = isRememberable(toolName) && !asksFirst;
    if (sessionable && this.allowAll && !this.opts.plan) return { behavior: "allow", updatedInput: input };

    const outcome = await this.host({
      kind: "approval",
      title: `需要授权：${toolName}`,
      detail: describeToolCall(toolName, input),
      ...(sessionable && !this.opts.noSessionGrant ? { allowSession: true } : {}),
    });
    if (outcome.settlement === "allow-session") {
      if (!this.allowAll) this.events.onStep("warning", "🔓 本会话内后续操作不再询问（/new 或切换会话后恢复逐条确认）");
      this.allowAll = true;
    }
    if (outcome.settlement === "allow-once" || outcome.settlement === "allow-always" || outcome.settlement === "allow-session") {
      return { behavior: "allow", updatedInput: input };
    }
    const why =
      outcome.settlement === "timeout"
        ? "用户长时间没有响应授权请求（已超时），按拒绝处理"
        : outcome.settlement === "cancelled"
          ? "授权请求已被取消（用户中断了这一轮或切换了会话）"
          : "用户拒绝了此操作";
    return { behavior: "deny", message: why };
  }

  private async approvePlan(input: Record<string, unknown>): Promise<PermissionResult> {
    const plan = typeof input.plan === "string" && input.plan.trim() ? input.plan : "（WorkBuddy 没有附上方案正文）";
    const outcome = await this.host({ kind: "approval", title: "方案出好了，按这个开始做？", detail: plan, allowLabel: "开始执行", denyLabel: "继续改方案" });
    if (outcome.settlement === "allow-once" || outcome.settlement === "allow-always") {
      this.syncPlan(false);
      const mode = modeOf(this.opts.permission, false);
      // 有的 CLI 版本不认 updatedPermissions 里的 setMode：再显式切一次
      setTimeout(() => void this.session?.setPermissionMode(mode).catch(() => {}), 0);
      return { behavior: "allow", updatedInput: input, updatedPermissions: [{ type: "setMode", mode, destination: "session" }] };
    }
    const message =
      outcome.settlement === "timeout"
        ? "用户长时间没有回应这个方案（已超时）。留在计划模式，不要动手，等用户回来。"
        : outcome.settlement === "cancelled"
          ? "方案确认已被取消（用户中断了这一轮或切换了会话）。留在计划模式，不要动手。"
          : "用户还不想按这个方案做。留在计划模式，不要动手；简短问一句要改哪里，等用户说明。";
    return { behavior: "deny", message };
  }

  private syncPlan(on: boolean): void {
    if (!!this.opts.plan === on) return;
    this.opts.plan = on;
    this.events.onPlanMode?.(on);
  }

  private async askQuestion(input: Record<string, unknown>): Promise<PermissionResult | null> {
    const questions = parseQuestions(input);
    if (!questions) return null;
    const outcome = await this.host({ kind: "question", title: "WorkBuddy 想确认一下", questions });
    const answers: Record<string, string> = {};
    for (const [id, picked] of Object.entries(outcome.answers)) answers[id] = picked.join(", ");
    if (Object.keys(answers).length > 0) return { behavior: "allow", updatedInput: { ...input, answers } };
    return { behavior: "deny", message: "用户没有作答（超时或主动跳过）。不要重复提同样的问题：按你认为合理的默认继续，并在回复里说明你替他选了什么。" };
  }

  // ---------- 对外 ----------

  send(input: UserInput): void {
    if (this.disposed) return;
    if (this.turnBusy) {
      this.pending.push(input);
      return;
    }
    this.deliver(input);
  }

  cancelQueued(input: UserInput): boolean {
    const index = this.pending.indexOf(input);
    if (index < 0) return false;
    this.pending.splice(index, 1);
    return true;
  }

  private onTurnEnd(): void {
    this.turnBusy = false;
    const next = this.pending.shift();
    if (next && !this.disposed) this.deliver(next);
  }

  private deliver(input: UserInput): void {
    let content: string | ContentBlock[];
    try {
      content = buildContent(input);
    } catch (err) {
      const why = (err as NodeJS.ErrnoException).code === "ENOENT" ? "附件文件已不存在，请重新上传" : String(err);
      this.events.onError(new Error(`这条消息没能发出：${why}`));
      const next = this.pending.shift();
      if (next && !this.disposed) this.deliver(next);
      return;
    }
    this.turnBusy = true;
    this.turnStarted = false;
    this.turn = this.runTurn(content, input).finally(() => {
      this.turn = null;
      if (this.turnBusy) this.onTurnEnd();
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    const session = await this.start();
    if (!session) return [];
    return (await session.getAvailableModels()).map(modelOf).filter((m): m is ModelInfo => !!m);
  }

  async setPermission(level: PermissionLevel | undefined): Promise<void> {
    this.opts.permission = level;
    this.allowAll = level === "full";
    // 还没拉起就不用管：拉起时按 opts 来
    if (this.session) await this.session.setPermissionMode(modeOf(level, this.opts.plan));
  }

  async setPlan(on: boolean): Promise<void> {
    this.opts.plan = on;
    if (this.session) await this.session.setPermissionMode(modeOf(this.opts.permission, on));
  }

  /** WorkBuddy 没有可在会话中途切换的思考程度，只认模型 */
  async setModel(model?: string): Promise<void> {
    if (model === undefined) return;
    this.opts.model = model;
    this.runtime = { ...this.runtime, model };
    if (this.session) await this.session.setModel(model);
  }

  peekRuntime(): RuntimeInfo {
    return this.runtime;
  }

  async describeRuntime(): Promise<RuntimeInfo> {
    return this.runtime;
  }

  async interrupt(opts: InterruptOptions = {}): Promise<void> {
    if (opts.keepQueue) {
      const i = opts.first ? this.pending.indexOf(opts.first) : -1;
      if (i > 0) this.pending.unshift(...this.pending.splice(i, 1));
    } else {
      const dropped = this.pending.length;
      this.pending = [];
      if (dropped > 0) this.events.onDropped?.(dropped);
    }
    if (!this.session || !this.turnBusy) return;
    try {
      await this.session.interrupt();
    } catch (err) {
      console.warn("[workbuddy] 中断失败:", err instanceof Error ? err.message : err);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.pending = [];
    const session = this.session ?? (await this.starting?.catch(() => null)) ?? null;
    if (session) {
      if (this.turnBusy) await session.interrupt().catch(() => {});
      this.drop(session);
    }
    await this.turn?.catch(() => {});
  }
}
