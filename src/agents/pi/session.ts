// 一条会话 ↔ 一个进程内的 pi AgentSession（SDK 的 createAgentSession）。
//
// pi 自己没有权限系统（官方说明：不逐次审批、没有沙箱），授权卡是这边做的：
// 挂一个内联扩展，在 tool_call 钩子里按权限级别放行 / 弹卡 / 拦下（{ block: true }）。
// 计划模式、提问卡 pi 也没有，用两个自定义工具补上：exit_plan_mode（交方案给用户批）、ask_user（问用户）。
//
// 消息先留在本地排队，上一轮跑完才交给 pi（prompt() 跑完一整轮才返回）—— 停止时排着的能一起丢掉。
// 记忆 / 定时任务 / 技能 MCP 和个人 MCP 交给 pi 自带的 MCP 扩展连（stdio / HTTP），工具直接给模型。
// 凭据、会话记录都在 data/pi/ 下（见 sdk.ts），不读机器上的 ~/.pi；项目里的 .pi/ 扩展一律不加载（会执行代码）。
import fs from "node:fs";
import path from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession as PiAgentSession, AgentSessionEvent, ExtensionAPI, ToolCallEventResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { config } from "../../core/config.js";
import { expertAppend, expertSystemPrompt, RICH_REPLY_LINES, wrapContext } from "../../core/expert-prompt.js";
import { ACCESS_LEVELS, type ExpertAccess } from "../../core/experts.js";
import { MEMORY_MCP_NAME, memoryMcpSpawn } from "../../core/memory-mcp.js";
import type { PermissionLevel } from "../../core/permission.js";
import { codexSkillLines } from "../../core/skill-runtime.js";
import { SKILLS_MCP_NAME, skillsMcpSpawn, TASKS_MCP_NAME, tasksMcpSpawn } from "../../core/tasks-mcp.js";
import { describeAttachments, inlineTextBlocks, readTextAttachments } from "../../core/uploads.js";
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
import { summarize } from "../claude/session.js";
import { parseQuestions } from "../claude/permissions.js";
import { NO_PROVIDER } from "./constants.js";
import { sessionFile } from "./history.js";
import { ASK_TOOL, describePiStep, PLAN_TOOL } from "./steps.js";
import { AGENT_DIR, availableModels, findModel, loadSdk, modelKey, modelRuntime, pickModel, SESSIONS_DIR } from "./sdk.js";


/** 只读、不会改东西的内置工具：任何级别都直接放行 */
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
/** 改文件的内置工具：「自动改文件」级别下，改的是工作目录（或附件目录）里的文件就不问 */
const EDIT_TOOLS = new Set(["edit", "write"]);
/**
 * 给 pi 的工具白名单：内置的 7 个（按专家的文件权限给）、两个补上的、所有 MCP 工具。
 * 不给 access（内置的 pi）就是全部：能跑命令
 */
export function toolsFor(access?: ExpertAccess): string[] {
  const rank = access ? ACCESS_LEVELS.indexOf(access) : ACCESS_LEVELS.length - 1;
  return [...(rank >= 1 ? ["read", "grep", "find", "ls"] : []), ...(rank >= 2 ? ["edit", "write"] : []), ...(rank >= 3 ? ["bash"] : []), ASK_TOOL, PLAN_TOOL, "mcp__*"];
}

/** 这个会话的个人 MCP：自定义专家用专家选的，内置的 pi 用设置 → Agent 里选的 */
export function userMcp(opts: Pick<SessionOptions, "expert" | "builtinMcp">): { mcp: Record<string, object>; askMcp: string[] } | undefined {
  if (opts.expert) return { mcp: opts.expert.mcp, askMcp: opts.expert.askMcp };
  return opts.builtinMcp ? { mcp: opts.builtinMcp.mcp, askMcp: opts.builtinMcp.askMcp } : undefined;
}

const AGENT_LOFT_MCP = new Set([MEMORY_MCP_NAME, TASKS_MCP_NAME, SKILLS_MCP_NAME]);

const PLAN_LINES = [
  "## 计划模式",
  "",
  "用户开着计划模式：这一轮只读、只出方案，不要改文件、不要跑会改东西的命令（bash / edit / write 会被拦下）。",
  "把代码看清楚后，调用 exit_plan_mode 工具，把完整方案（markdown）放进 plan 参数交给用户批准；批准了才按方案动手。",
];

export type Gate = { allow: true } | { allow: false; reason: string } | { ask: true; sessionable: boolean };

/**
 * 不弹卡就能定下来的部分（纯函数，便于测试）：放行 / 拦下 / 要问用户。
 * 「完全允许」和「本会话全部允许」由调用方在 ask 之后处理（调用前询问的 MCP 不受它们影响）
 */
export function gateOf(
  toolName: string,
  input: Record<string, unknown>,
  ctx: { level: PermissionLevel | undefined; plan: boolean; cwd: string; uploadsDir: string; mcp?: { mcp: Record<string, object>; askMcp: string[] }; agentLoftMcp: boolean },
): Gate {
  if (READ_TOOLS.has(toolName) || toolName === ASK_TOOL || toolName === PLAN_TOOL) return { allow: true };
  const mcp = /^mcp__(.+?)__/.exec(toolName)?.[1];
  if (mcp) {
    if (AGENT_LOFT_MCP.has(mcp) && ctx.agentLoftMcp) return { allow: true };
    const picked = ctx.mcp;
    const configured = !!picked && mcp in picked.mcp;
    const asksFirst = configured && picked!.askMcp.includes(mcp);
    if (configured && !asksFirst) return { allow: true };
    return { ask: true, sessionable: !asksFirst };
  }
  if (ctx.plan && (toolName === "bash" || EDIT_TOOLS.has(toolName))) {
    return { allow: false, reason: "现在是计划模式：只读、出方案，不能改文件或跑命令。方案想好了就调用 exit_plan_mode 交给用户批准。" };
  }
  if (EDIT_TOOLS.has(toolName) && (ctx.level === "edit" || ctx.level === "auto") && typeof input.path === "string") {
    const file = path.resolve(ctx.cwd, input.path);
    if (inside(file, ctx.cwd) || inside(file, ctx.uploadsDir)) return { allow: true };
  }
  return { ask: true, sessionable: true };
}

function inside(file: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 授权卡上的说明：pi 的工具参数是 path / command / edits / content */
export function describePiTool(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash") return `\`\`\`bash\n${String(input.command ?? "")}\n\`\`\``;
  if (toolName === "write") {
    const content = String(input.content ?? "");
    const preview = content.length > 1500 ? `${content.slice(0, 1500)}\n…（共 ${content.length} 字）` : content;
    return `**写入文件**：\`${String(input.path ?? "")}\`\n\n\`\`\`\n${preview}\n\`\`\``;
  }
  if (toolName === "edit") {
    const edits = Array.isArray(input.edits) ? (input.edits as { oldText?: unknown; newText?: unknown }[]) : [];
    const body = edits
      .slice(0, 5)
      .map((e) => `\`\`\`diff\n${diffLines(String(e.oldText ?? ""), "-")}\n${diffLines(String(e.newText ?? ""), "+")}\n\`\`\``)
      .join("\n\n");
    return `**修改文件**：\`${String(input.path ?? "")}\`（${edits.length} 处）${body ? `\n\n${body}` : ""}${edits.length > 5 ? "\n\n…" : ""}`;
  }
  return `\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``;
}

function diffLines(text: string, mark: string): string {
  const lines = text.split("\n");
  const shown = lines.slice(0, 20).map((l) => `${mark} ${l}`);
  if (lines.length > 20) shown.push(`${mark} …（共 ${lines.length} 行）`);
  return shown.join("\n");
}

/** 图片直接给模型看（模型要支持图片输入）；其余附件只给路径，让它自己读 */
const INLINE_IMAGE_MAX = 3.75 * 1024 * 1024;
function canInline(a: SavedAttachment, images: boolean): boolean {
  return images && !!a.mediaType && /^image\/(png|jpeg|gif|webp)$/.test(a.mediaType) && a.size <= INLINE_IMAGE_MAX;
}

/** noRead：只能联网的专家没有读文件的工具，文本附件的内容直接放进消息 */
export function buildPrompt(input: UserInput, images: boolean, plan: boolean, noRead = false): { text: string; images: ImageContent[] } {
  const texts = noRead ? readTextAttachments(input.attachments) : new Map<string, string>();
  const inlined = (a: SavedAttachment) => canInline(a, images) || texts.has(a.path);
  const note = input.attachments.length ? describeAttachments(input.attachments, inlined, noRead) : "";
  const blocks = noRead ? inlineTextBlocks(input.attachments, texts) : "";
  const text = [input.text, note, blocks, plan ? wrapContext(PLAN_LINES) : ""].filter(Boolean).join("\n\n");
  const out: ImageContent[] = [];
  for (const a of input.attachments) {
    if (!canInline(a, images)) continue;
    out.push({ type: "image", data: fs.readFileSync(a.path).toString("base64"), mimeType: a.mediaType! });
  }
  return { text, images: out };
}

/**
 * 系统提示：内置的 pi 用原装的，后面追加回复格式、记忆、技能清单。
 * 自定义专家「只用专家的提示词」：换掉 pi 原装的开头（身份、工具说明、规则），追加、项目说明、工作目录照旧；
 * 「追加在原装后面」：原装的不动，专家的人设和能力说明追加在后面
 */
export function promptParts(opts: SessionOptions): { system?: string; append: string } {
  const e = opts.expert;
  const skills = codexSkillLines(opts.skills).join("\n");
  const join = (parts: (string | undefined)[]) => parts.filter(Boolean).join("\n\n");
  if (!e) return { append: join([RICH_REPLY_LINES.join("\n"), opts.memory?.prompt, skills]) };
  // pi 没有联网搜索 / 读网页的工具（要联网就给专家挂 MCP）
  if (e.basePrompt === "lean") return { system: expertSystemPrompt(e, undefined, opts.cwd, opts.memory?.prompt), append: skills };
  return { append: join([expertAppend(e, undefined, opts.cwd), opts.memory?.prompt, skills]) };
}

export function appendPrompt(opts: SessionOptions): string {
  return promptParts(opts).append;
}

type McpEntry = { name: string; config: Record<string, unknown>; source: string; scope: "extension" };

/** 要挂的 MCP：个人 MCP + 记忆 / 定时任务 / 技能。工具都直接声明给模型（exposure: direct） */
export function mcpServers(opts: SessionOptions): McpEntry[] {
  const out: McpEntry[] = [];
  const add = (name: string, spec: object) => out.push({ name, config: { ...spec, exposure: "direct" }, source: "agent-loft", scope: "extension" });
  for (const [name, spec] of Object.entries(userMcp(opts)?.mcp ?? {})) add(name, spec);
  const memory = opts.memory;
  if (memory) add(MEMORY_MCP_NAME, { type: "stdio", ...memoryMcpSpawn(memory.userId, "pi", { search: !!memory.search, ...(memory.convKey ? { convKey: memory.convKey } : {}) }) });
  if (opts.tasks) {
    add(TASKS_MCP_NAME, { type: "stdio", ...tasksMcpSpawn(opts.tasks.userId, opts.tasks.convKey, "pi") });
    add(SKILLS_MCP_NAME, { type: "stdio", ...skillsMcpSpawn(opts.tasks.userId, opts.tasks.convKey, "pi") });
  }
  return out;
}

/** pi 的 usage 每条助手消息一份，是这次请求的量 */
function usageOf(u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; cost?: { total?: number } } | undefined): TokenUsage | undefined {
  if (!u) return undefined;
  const usage: TokenUsage = { input: u.input || 0, cacheRead: u.cacheRead || 0, cacheWrite: u.cacheWrite || 0, output: u.output || 0 };
  if (u.reasoning) usage.reasoning = u.reasoning;
  if (u.cost?.total) usage.costUsd = u.cost.total;
  return usage.input + usage.cacheRead + usage.cacheWrite + usage.output > 0 ? usage : undefined;
}

type Assistant = { role: "assistant"; content: { type: string; text?: string; thinking?: string; redacted?: boolean }[]; stopReason?: string; errorMessage?: string; usage?: Parameters<typeof usageOf>[0] };

export class PiSession implements AgentSession {
  private session: PiAgentSession | null = null;
  private starting: Promise<PiAgentSession | null> | null = null;
  private currentId: string | undefined;
  /** 分叉已经生效：之后重建就接着新的这条 */
  private forked = false;
  private runtime: RuntimeInfo = {};
  private disposed = false;
  private turnBusy = false;
  private pending: UserInput[] = [];
  /** 「完全允许」或点过「本会话全部允许」 */
  private allowAll = false;
  private turn: Promise<void> | null = null;
  private aborting = false;
  /** 这一轮的 token 合计、最后一次报错 */
  private turnTokens = 0;
  private turnCost = 0;
  private turnError: string | undefined;

  constructor(
    private readonly opts: SessionOptions,
    private readonly events: AgentEvents,
    private readonly host: InteractionHost,
  ) {
    this.allowAll = opts.permission === "full";
    if (opts.model) this.runtime.model = opts.model;
    if (opts.effort) this.runtime.effort = opts.effort;
  }

  get sessionId(): string | undefined {
    return this.currentId;
  }

  private start(): Promise<PiAgentSession | null> {
    if (this.session) return Promise.resolve(this.session);
    if (this.disposed) return Promise.resolve(null);
    this.starting ??= this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(): Promise<PiAgentSession | null> {
    const { pi } = await loadSdk();
    const rt = await modelRuntime();
    if (this.disposed) return null;
    const cfg = config().agents.pi;
    const model = await pickModel(this.opts.model || cfg.defaultModel || undefined);
    if (!model) throw new Error(NO_PROVIDER);
    const cwd = this.opts.cwd;

    // 会话记录：新建 / 接着以前的 / 从以前的分叉一条新的
    const fork = !!this.opts.fork && !this.forked;
    const resume = fork ? this.opts.resumeId : (this.currentId ?? this.opts.resumeId);
    let sessionManager;
    if (resume) {
      const file = sessionFile(resume);
      if (!file) throw new Error(`找不到 pi 的会话记录 ${resume}`);
      sessionManager = fork ? pi.SessionManager.forkFrom(file, cwd, SESSIONS_DIR) : pi.SessionManager.open(file, SESSIONS_DIR, cwd);
    } else {
      sessionManager = pi.SessionManager.create(cwd, SESSIONS_DIR);
    }

    // 设置全在内存里：不读机器上的 ~/.pi/agent/settings.json；项目里的 .pi/ 一律不信任（扩展会执行代码）
    const settingsManager = pi.SettingsManager.inMemory({ defaultProjectTrust: "never" });
    const expert = this.opts.expert;
    // data/pi/skills 里的技能当「机器上的技能」：成员和自定义专家不给
    const machine = !expert && (!this.opts.skills || (this.opts.skills.admin && this.opts.skills.machineSkills !== false));
    const prompt = promptParts(this.opts);
    const servers = mcpServers(this.opts);
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd,
      agentDir: AGENT_DIR,
      settingsManager,
      extensionFactories: [
        { name: "agent-loft-gate", factory: (api: ExtensionAPI) => {
            api.on("tool_call", (e) => this.onToolCall(e.toolName, e.input as Record<string, unknown>));
          } },
        ...(servers.length ? [{ name: "mcp", factory: pi.createMcpExtension({ loadConfig: () => ({ servers: servers as never, errors: [] }), logPath: path.join(AGENT_DIR, "mcp.log") }) }] : []),
      ],
      noSkills: !machine,
      noThemes: true,
      // 只能联网的专家碰不了文件，项目里的 AGENTS.md / CLAUDE.md 也不读
      ...(expert?.access === "web" ? { noContextFiles: true } : {}),
      ...(prompt.system ? { systemPrompt: prompt.system } : {}),
      ...(prompt.append ? { appendSystemPrompt: [prompt.append] } : {}),
    });
    await resourceLoader.reload();

    const env = this.opts.skills?.env ?? {};
    const customTools: ToolDefinition[] = [this.askTool(), this.planTool()] as unknown as ToolDefinition[];
    // 技能声明的环境变量交给 bash（pi 进程内运行，不能改 process.env）
    if (Object.keys(env).length && (!expert || expert.access === "exec")) customTools.push(pi.createBashToolDefinition(cwd, { spawnHook: (c) => ({ ...c, env: { ...c.env, ...env } }) }) as unknown as ToolDefinition);

    const thinking = this.opts.effort || cfg.defaultEffort || undefined;
    const { session } = await pi.createAgentSession({
      cwd,
      agentDir: AGENT_DIR,
      modelRuntime: rt,
      model,
      ...(thinking ? { thinkingLevel: thinking as never } : {}),
      settingsManager,
      resourceLoader,
      sessionManager,
      tools: toolsFor(expert?.access),
      customTools,
    });
    if (this.disposed) {
      session.dispose();
      return null;
    }
    // 发出 session_start：MCP 扩展这时才开始连
    await session.bindExtensions({});
    session.subscribe((e) => this.handle(e));
    this.syncPlanTool(session);
    if (fork) this.forked = true;
    this.session = session;
    this.runtime = { model: modelKey(model), ...(session.supportsThinking() ? { effort: session.thinkingLevel } : {}) };
    return session;
  }

  // ---------- 自定义工具：提问、交方案 ----------

  private askTool(): object {
    return {
      name: ASK_TOOL,
      label: "Ask user",
      description:
        "Ask the user one or more multiple-choice questions when a decision is genuinely theirs to make. Each question has 2-4 options; the user can also answer in free text. Returns the user's answers.",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                question: { type: "string", description: "The full question" },
                header: { type: "string", description: "Very short label (max 12 chars)" },
                options: {
                  type: "array",
                  minItems: 2,
                  maxItems: 4,
                  items: { type: "object", properties: { label: { type: "string" }, description: { type: "string" } }, required: ["label"] },
                },
                multiSelect: { type: "boolean" },
              },
              required: ["question", "options"],
            },
          },
        },
        required: ["questions"],
      },
      execute: async (_id: string, params: Record<string, unknown>) => {
        const questions = parseQuestions(params);
        if (!questions) return text("问题格式不对：每个问题要有 question 和至少两个带 label 的 options。");
        const outcome = await this.host({ kind: "question", title: "pi 想确认一下", questions });
        const lines = Object.entries(outcome.answers).map(([q, picked]) => `- ${q}：${picked.join("、")}`);
        if (lines.length) return text(`用户的回答：\n${lines.join("\n")}`);
        return text("用户没有作答（超时或主动跳过）。不要重复提同样的问题：按你认为合理的默认继续，并在回复里说明你替他选了什么。");
      },
    };
  }

  private planTool(): object {
    return {
      name: PLAN_TOOL,
      label: "Exit plan mode",
      description: "Plan mode only: submit your complete plan (markdown) to the user for approval. Only after approval may you edit files or run commands.",
      parameters: { type: "object", properties: { plan: { type: "string", description: "The complete plan in markdown" } }, required: ["plan"] },
      execute: async (_id: string, params: Record<string, unknown>) => {
        if (!this.opts.plan) return text("现在不在计划模式，直接动手就行。");
        const plan = typeof params.plan === "string" && params.plan.trim() ? params.plan : "（pi 没有附上方案正文）";
        const outcome = await this.host({ kind: "approval", title: "方案出好了，按这个开始做？", detail: plan, allowLabel: "开始执行", denyLabel: "继续改方案" });
        if (outcome.settlement === "allow-once" || outcome.settlement === "allow-always") {
          this.syncPlan(false);
          return text("用户批准了这个方案。计划模式已关闭，现在按方案动手。");
        }
        return text(
          outcome.settlement === "timeout"
            ? "用户长时间没有回应这个方案（已超时）。留在计划模式，不要动手，等用户回来。"
            : outcome.settlement === "cancelled"
              ? "方案确认已被取消（用户中断了这一轮或切换了会话）。留在计划模式，不要动手。"
              : "用户还不想按这个方案做。留在计划模式，不要动手；简短问一句要改哪里，等用户说明。",
        );
      },
    };
  }

  /** 交方案的工具只在计划模式下给模型看 */
  private syncPlanTool(session: PiAgentSession): void {
    const active = session.getActiveToolNames().filter((n) => n !== PLAN_TOOL);
    session.setActiveToolsByName(this.opts.plan ? [...active, PLAN_TOOL] : active);
  }

  private syncPlan(on: boolean): void {
    if (!!this.opts.plan === on) return;
    this.opts.plan = on;
    if (this.session) this.syncPlanTool(this.session);
    this.events.onPlanMode?.(on);
  }

  // ---------- 授权 ----------

  private async onToolCall(toolName: string, input: Record<string, unknown>): Promise<ToolCallEventResult | undefined> {
    const gate = gateOf(toolName, input, {
      level: this.opts.permission,
      plan: !!this.opts.plan,
      cwd: this.opts.cwd,
      uploadsDir: this.opts.uploadsDir,
      mcp: userMcp(this.opts),
      agentLoftMcp: !!(this.opts.memory || this.opts.tasks),
    });
    if ("allow" in gate) return gate.allow ? undefined : { block: true, reason: gate.reason };
    if (gate.sessionable && this.allowAll) return undefined;
    const outcome = await this.host({
      kind: "approval",
      title: `需要授权：${toolName}`,
      detail: describePiTool(toolName, input),
      ...(gate.sessionable && !this.opts.noSessionGrant ? { allowSession: true } : {}),
    });
    if (outcome.settlement === "allow-session") {
      if (!this.allowAll) this.events.onStep("warning", "🔓 本会话内后续操作不再询问（/new 或切换会话后恢复逐条确认）");
      this.allowAll = true;
    }
    if (outcome.settlement === "allow-once" || outcome.settlement === "allow-always" || outcome.settlement === "allow-session") return undefined;
    const reason =
      outcome.settlement === "timeout"
        ? "用户长时间没有响应授权请求（已超时），按拒绝处理"
        : outcome.settlement === "cancelled"
          ? "授权请求已被取消（用户中断了这一轮或切换了会话）"
          : "用户拒绝了此操作";
    return { block: true, reason };
  }

  // ---------- 事件 ----------

  private handle(e: AgentSessionEvent): void {
    if (this.disposed) return;
    switch (e.type) {
      case "message_update": {
        const ev = e.assistantMessageEvent;
        if (ev.type === "text_delta" && ev.delta) this.events.onTextDelta(ev.delta);
        return;
      }
      case "message_end": {
        const m = e.message as unknown as Assistant;
        if (m.role !== "assistant") return;
        for (const block of m.content ?? []) {
          if (block.type === "thinking" && !block.redacted) {
            const thought = summarize(block.thinking ?? "");
            if (thought) this.events.onStep("thinking", `💭 ${thought}`);
          } else if (block.type === "text" && block.text?.trim()) {
            this.events.onText(block.text);
          }
        }
        const usage = usageOf(m.usage);
        if (usage) {
          this.turnTokens += usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
          this.turnCost += usage.costUsd ?? 0;
          this.events.onUsage?.(usage, false);
        }
        if (m.stopReason === "error") this.turnError = m.errorMessage || "模型请求失败";
        return;
      }
      case "tool_execution_start": {
        if (e.toolName === ASK_TOOL || e.toolName === PLAN_TOOL) return;
        this.events.onStep("tool", `${e.parentToolCallId ? "  ↳ " : ""}🔧 ${describePiStep(e.toolName, e.args)}`);
        return;
      }
      case "auto_retry_start":
        this.events.onStep("warning", `⚠️ 请求失败，${Math.round(e.delayMs / 1000)} 秒后重试（第 ${e.attempt}/${e.maxAttempts} 次）：${summarize(e.errorMessage, 80)}`);
        return;
      case "auto_retry_end":
        if (e.success) this.turnError = undefined;
        return;
      case "compaction_start":
        this.events.onStep("note", "🗜️ 上下文快满了，正在压缩");
        return;
      case "thinking_level_changed":
        this.runtime = { ...this.runtime, effort: e.level };
        return;
    }
  }

  /** 跑一轮：prompt() 返回时这一轮（含自动重试）就结束了 */
  private async runTurn(input: UserInput): Promise<void> {
    const started = Date.now();
    this.turnTokens = 0;
    this.turnCost = 0;
    this.turnError = undefined;
    this.aborting = false;
    let session: PiAgentSession | null = null;
    try {
      session = await this.start();
      if (!session) return;
      this.events.onTurnStart?.();
      const raw = input.text.trim();
      if (raw === "/compact" || raw.startsWith("/compact ")) {
        await this.compact(session, raw.slice("/compact".length).trim());
        return;
      }
      const images = (session.model?.input ?? []).includes("image");
      const prompt = buildPrompt(input, images, !!this.opts.plan, this.opts.expert?.access === "web");
      await session.prompt(prompt.text, { ...(prompt.images.length ? { images: prompt.images } : {}), expandPromptTemplates: false });
      if (this.disposed) return;
      this.reportIds(session, input);
      const usage = session.getContextUsage();
      if (usage && usage.tokens !== null) this.events.onContext?.({ used: usage.tokens, window: usage.contextWindow, percent: Math.round(usage.percent ?? (usage.tokens / usage.contextWindow) * 100) });
      const text = session.getLastAssistantText() ?? "";
      const anchor = lastEntryId(session, "assistant");
      if (this.aborting) {
        this.events.onResult({ text: text || "（已中断）", durationMs: Date.now() - started, ...(anchor ? { anchor } : {}) });
      } else if (this.turnError) {
        this.events.onError(new Error(this.turnError));
      } else {
        this.events.onResult({
          text,
          durationMs: Date.now() - started,
          ...(this.turnTokens ? { tokens: this.turnTokens } : {}),
          ...(this.turnCost ? { costUsd: this.turnCost } : {}),
          ...(anchor ? { anchor } : {}),
        });
      }
    } catch (err) {
      if (this.disposed) return;
      if (this.aborting) {
        // 用户消息已经落盘了：id 照样报，下次接着这条会话
        if (session) this.reportIds(session, input);
        this.events.onResult({ text: "（已中断）", durationMs: Date.now() - started });
        return;
      }
      // 会话对象坏了（模型没了、记录读不出来……）：扔掉，下一轮重建
      if (session) this.drop(session);
      this.events.onError(err);
    }
  }

  private async compact(session: PiAgentSession, instructions: string): Promise<void> {
    const started = Date.now();
    const before = session.getContextUsage();
    await session.compact(instructions || undefined);
    const after = session.getContextUsage();
    const fmt = (n: number | null | undefined) => (n == null ? "?" : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
    this.reportIds(session);
    this.events.onResult({ text: `上下文已压缩（${fmt(before?.tokens)} → ${fmt(after?.tokens)} tokens）`, durationMs: Date.now() - started });
  }

  private reportIds(session: PiAgentSession, input?: UserInput): void {
    if (session.sessionId !== this.currentId) {
      this.currentId = session.sessionId;
      this.events.onSessionId(session.sessionId);
    }
    if (input) {
      const user = lastEntryId(session, "user");
      if (user) this.events.onUserAnchor?.(input, user);
    }
  }

  private drop(session: PiAgentSession): void {
    if (this.session !== session) return;
    this.session = null;
    try {
      session.dispose();
    } catch {
      // 已经关了
    }
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

  private deliver(input: UserInput): void {
    this.turnBusy = true;
    this.turn = this.runTurn(input).finally(() => {
      this.turn = null;
      this.turnBusy = false;
      const next = this.pending.shift();
      if (next && !this.disposed) this.deliver(next);
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    return availableModels();
  }

  async setPermission(level: PermissionLevel | undefined): Promise<void> {
    this.opts.permission = level;
    this.allowAll = level === "full";
  }

  async setPlan(on: boolean): Promise<void> {
    this.opts.plan = on;
    if (this.session) this.syncPlanTool(this.session);
  }

  async setModel(model?: string, effort?: string): Promise<void> {
    if (model !== undefined && model) {
      const m = await findModel(model);
      if (!m) throw new Error(`pi 里没有这个模型：${model}`);
      this.opts.model = model;
      this.runtime = { ...this.runtime, model };
      if (this.session) await this.session.setModel(m);
    }
    if (effort !== undefined && effort) {
      this.opts.effort = effort;
      this.runtime = { ...this.runtime, effort };
      this.session?.setThinkingLevel(effort as never);
      if (this.session) this.runtime.effort = this.session.thinkingLevel;
    }
  }

  peekRuntime(): RuntimeInfo {
    return this.runtime;
  }

  async describeRuntime(): Promise<RuntimeInfo> {
    const s = this.session;
    if (!s?.model) return this.runtime;
    return { model: modelKey(s.model), ...(s.supportsThinking() ? { effort: s.thinkingLevel } : {}) };
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
    this.aborting = true;
    try {
      if (this.session.isCompacting) this.session.abortCompaction();
      await this.session.abort();
    } catch (err) {
      console.warn("[pi] 中断失败:", err instanceof Error ? err.message : err);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.pending = [];
    const session = this.session ?? (await this.starting?.catch(() => null)) ?? null;
    if (session) {
      if (this.turnBusy) await session.abort().catch(() => {});
      this.drop(session);
    }
    await this.turn?.catch(() => {});
  }
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: undefined };
}

/** 当前分支上最后一条 user / assistant 消息的记录 id：用户消息用来回退，助手消息用来分叉 */
function lastEntryId(session: PiAgentSession, role: "user" | "assistant"): string | undefined {
  const branch = session.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!;
    if (e.type === "message" && (e as { message?: { role?: string } }).message?.role === role) return e.id;
  }
  return undefined;
}
