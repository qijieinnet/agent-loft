// 一条会话 ↔ 一个常驻的 Claude query。
//
// 必须用「流式输入」模式：setModel / interrupt / supportedModels / applyFlagSettings
// 这些控制方法在 SDK 里全都只在 streaming input mode 下可用，也就是 prompt 必须是
// async iterable。这是架构前提，别改。
import fs from "node:fs";
import {
  query,
  type AgentDefinition,
  type McpServerConfig,
  type McpServerConfigForProcessTransport,
  type ModelUsage,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { agentEnvironment } from "../../core/agent-env.js";
import { expertAppend, expertSystemPrompt, searchLabel } from "../../core/expert-prompt.js";
import { ACCESS_LEVELS, type ExpertAccess } from "../../core/experts.js";
import { MEMORY_MCP_NAME, memoryMcpSpawn } from "../../core/memory-mcp.js";
import { SKILLS_MCP_NAME, skillsMcpSpawn, TASKS_MCP_NAME, tasksMcpSpawn } from "../../core/tasks-mcp.js";
import { PLUGIN_NAME, projectCommandNames } from "../../core/skill-runtime.js";
import { describeAttachments, inlineTextBlocks, readTextAttachments } from "../../core/uploads.js";
import type {
  AgentEvents,
  AgentSession,
  InteractionHost,
  ModelInfo,
  RuntimeInfo,
  SavedAttachment,
  InterruptOptions,
  SessionOptions,
  TokenUsage,
  UserInput,
} from "../../core/types.js";
import {
  alwaysLabelOf,
  describeToolCall,
  isPreApproved,
  isRememberable,
  isRememberableSignature,
  parseQuestions,
  rememberAlways,
  signatureOf,
} from "./permissions.js";
import { feedTodos, readTodos, TodoTracker } from "./todos.js";

export function toModelInfo(models: Awaited<ReturnType<Query["supportedModels"]>>): ModelInfo[] {
  return models.map((m) => ({
    id: m.value,
    label: m.displayName || m.value,
    ...(m.description ? { description: m.description } : {}),
    ...(m.supportedEffortLevels?.length ? { efforts: [...m.supportedEffortLevels] } : {}),
  }));
}

class AsyncQueue<T> {
  private items: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  /** 丢掉还没被消费的项（停止时：排着队的消息不该在中断后接着跑） */
  clear(): number {
    const n = this.items.length;
    this.items = [];
    return n;
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) waiter({ value: undefined as never, done: true });
  }

  async *stream(): AsyncGenerator<T> {
    while (true) {
      const item = this.items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

/** Claude 原生能看的内容块 —— 和 Anthropic API 的 content block 同形。 */
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };

/** API 对单张图片的限制是 5MB（按 base64 后计），PDF 是整个请求 32MB。超了只给路径。 */
const INLINE_IMAGE_MAX = 3.75 * 1024 * 1024;
const INLINE_PDF_MAX = 20 * 1024 * 1024;

function canInline(a: SavedAttachment): boolean {
  if (a.mediaType === "application/pdf") return a.size <= INLINE_PDF_MAX;
  if (a.mediaType && /^image\/(png|jpeg|gif|webp)$/.test(a.mediaType)) return a.size <= INLINE_IMAGE_MAX;
  return false;
}

/**
 * 文字 + 附件清单，后面跟着能直接看的图片和 PDF。没有附件时就是原样的文字。
 * inlineText：专家没有读文件的工具（只能联网），文本附件的内容也直接放进来。
 */
function buildContent(input: UserInput, inlineText: boolean): string | ContentBlock[] {
  if (input.attachments.length === 0) return input.text;
  const texts = inlineText ? readTextAttachments(input.attachments) : new Map<string, string>();
  const inlined = (a: SavedAttachment) => canInline(a) || texts.has(a.path);
  const note = describeAttachments(input.attachments, inlined, inlineText);
  const head = [input.text, note, inlineText ? inlineTextBlocks(input.attachments, texts) : ""].filter(Boolean).join("\n\n");
  const blocks: ContentBlock[] = [{ type: "text", text: head }];
  for (const a of input.attachments) {
    if (!canInline(a)) continue;
    const data = fs.readFileSync(a.path).toString("base64");
    blocks.push(
      a.mediaType === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
        : { type: "image", source: { type: "base64", media_type: a.mediaType!, data } },
    );
  }
  return blocks;
}

/** 记忆工具在 Claude 里的全名 */
const MEMORY_TOOLS = new Set(["remember", "forget", "search_past_chats"].map((t) => `mcp__${MEMORY_MCP_NAME}__${t}`));
/** 定时任务工具：要用户确认的那几个由 agent-loft 自己弹卡（tasks-bridge.ts），这里不再问一遍 */
const TASK_TOOLS = new Set(["list_tasks", "create_task", "update_task", "delete_task"].map((t) => `mcp__${TASKS_MCP_NAME}__${t}`));
/** 技能工具：建、改技能前由 agent-loft 自己弹卡（skills-bridge.ts） */
const SKILL_TOOLS = new Set(["list_skills", "get_skill", "create_skill", "update_skill", "skill_request"].map((t) => `mcp__${SKILLS_MCP_NAME}__${t}`));
/**
 * Claude Code 自带的命令和技能名（supportedCommands 里标了 builtin 的），driver 读命令表时顺手记下。
 * 成员会话的技能白名单要带上它们；还没读到过就先不带（只少了 /simplify 这类自带技能）。
 */
export const claudeBuiltins = new Set<string>();
/** 各级权限能用的 Claude Code 工具（自定义专家）。能跑命令的不限工具，见 expertTools */
const READ_TOOLS = ["Read", "Glob", "Grep"];
const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];
/** 任务清单和提问：能读文件的专家才给（只能联网的专家省下这些工具说明的 token） */
const WORK_TOOLS = ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TodoWrite", "AskUserQuestion"];

type ToolPlan = { tools?: string[]; disallowedTools?: string[] };

/**
 * 自定义专家（或它的子智能体）能用哪些工具。
 * 能跑命令：Claude Code 的全部工具（跑命令就等于能改任何文件，再细分没有意义），只按开关去掉联网工具。
 * 其余：白名单。技能、子智能体、MCP 多的时候用的 Skill / Agent / ToolSearch 按需加。
 */
function expertTools(
  e: { access: ExpertAccess; webSearch: boolean; webFetch: boolean },
  extra: { skill: boolean; agent: boolean; mcp: boolean },
): ToolPlan {
  const web = [...(e.webSearch ? ["WebSearch"] : []), ...(e.webFetch ? ["WebFetch"] : [])];
  if (e.access === "exec") {
    const off = [...(e.webSearch ? [] : ["WebSearch"]), ...(e.webFetch ? [] : ["WebFetch"]), ...(extra.agent ? [] : ["Agent"])];
    return off.length ? { disallowedTools: off } : {};
  }
  const rank = ACCESS_LEVELS.indexOf(e.access);
  return {
    tools: [
      ...web,
      ...(rank >= 1 ? [...READ_TOOLS, ...WORK_TOOLS] : []),
      ...(rank >= 2 ? EDIT_TOOLS : []),
      ...(extra.skill ? ["Skill"] : []),
      ...(extra.agent ? ["Agent"] : []),
      ...(extra.mcp ? ["ToolSearch"] : []),
    ],
  };
}

/** agent-loft 自己的 MCP（记忆、定时任务、技能管理）：内置和自定义专家都挂 */
function loftMcp(opts: SessionOptions): Record<string, McpServerConfig> {
  const memory = opts.memory;
  return {
    ...(memory
      ? { [MEMORY_MCP_NAME]: { type: "stdio", ...memoryMcpSpawn(memory.userId, "claude", { search: !!memory.search, ...(memory.convKey ? { convKey: memory.convKey } : {}) }) } }
      : {}),
    ...(opts.tasks
      ? {
          [TASKS_MCP_NAME]: { type: "stdio", ...tasksMcpSpawn(opts.tasks.userId, opts.tasks.convKey, "claude") },
          [SKILLS_MCP_NAME]: { type: "stdio", ...skillsMcpSpawn(opts.tasks.userId, opts.tasks.convKey, "claude") },
        }
      : {}),
  };
}

/**
 * 按专家拼 query 的选项。
 *
 * 内置的 Claude Code 专家：原装的样子，有记忆就追加在它的系统提示后面。
 * 自定义专家：
 *   - 提示词：默认只用专家自己的（expertSystemPrompt，一句话约 2 千 token，和以前的聊天模式一样）；
 *     选了「Claude Code 原装」就追加在原装提示后面；
 *   - 工具按权限给（expertTools），不读本地设置（技能、插件、CLAUDE.md、机器上的 MCP 都不加载），
 *     原装提示的专家读项目设置（为了 CLAUDE.md）；
 *   - 技能只给它选中的（白名单），MCP 只认这里给的（strictMcpConfig），子智能体转成 agents。
 * 实测（SDK 0.3.302）：自定义提示词下技能白名单照样生效，没选的技能调用会报错；子智能体能用，
 * 而且拿不到主专家没有的工具。
 *
 * 系统提示一律 snapshot: false。SDK 默认会把会话第一次请求时的系统提示记进记录，之后 resume 时传的
 * 新提示一概忽略 —— 那样改了专家、改了记忆都不生效。snapshot: false 每次现渲染（实测）。
 * 代价只是 Claude Code 升级后提示变了会让缓存失效一次。
 */
export function expertOptions(opts: SessionOptions): Partial<Options> {
  const memory = opts.memory;
  const skills = opts.skills;
  const expert = opts.expert;
  if (!expert) {
    const mcpServers = loftMcp(opts);
    const append = [memory?.prompt, skills?.prompt].filter(Boolean).join("\n\n");
    return {
      systemPrompt: { type: "preset", preset: "claude_code", ...(append ? { append } : {}), snapshot: false },
      ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
      ...(skills?.pluginDir ? { plugins: [{ type: "local" as const, path: skills.pluginDir, skipMcpDiscovery: true }] } : {}),
      ...(skills && !skills.admin ? { skills: memberSkillAllowlist(skills, opts.cwd) } : {}),
    };
  }

  const search = searchLabel("claude", expert);
  const skillNames = (skills?.list ?? []).map((s) => `${PLUGIN_NAME}:${s.name}`);
  const mcpServers: Record<string, McpServerConfig> = { ...(expert.mcp as Record<string, McpServerConfig>), ...loftMcp(opts) };
  const subagents = expert.subagents;
  const needsSkills = skillNames.length > 0 || subagents.some((sub) => sub.skills.length > 0);
  const plan = expertTools(expert, { skill: needsSkills, agent: subagents.length > 0, mcp: Object.keys(expert.mcp).length > 0 });
  const prompt = { ...expert, subagents };
  const systemPrompt: Options["systemPrompt"] =
    expert.basePrompt === "claude_code"
      ? {
          type: "preset",
          preset: "claude_code",
          append: [expertAppend(prompt, search, opts.cwd), memory?.prompt, skills?.prompt].filter(Boolean).join("\n\n"),
          snapshot: false,
        }
      : { type: "custom", prompt: expertSystemPrompt(prompt, search, opts.cwd, [memory?.prompt, skills?.prompt].filter(Boolean).join("\n\n") || undefined), snapshot: false };
  return {
    systemPrompt,
    ...plan,
    settingSources: expert.basePrompt === "claude_code" ? ["project"] : [],
    strictMcpConfig: true,
    mcpServers,
    skills: skillNames,
    ...(needsSkills && skills?.pluginDir ? { plugins: [{ type: "local" as const, path: skills.pluginDir, skipMcpDiscovery: true }] } : {}),
    ...(subagents.length
      ? {
          agents: Object.fromEntries(
            subagents.map((sub) => {
              const subPlan = expertTools(sub, { skill: sub.skills.length > 0, agent: false, mcp: Object.keys(sub.mcp).length > 0 });
              const def: AgentDefinition = {
                description: sub.description,
                prompt: sub.prompt,
                ...subPlan,
                ...(sub.model ? { model: sub.model } : {}),
                ...(sub.skills.length ? { skills: sub.skills.map((n) => `${PLUGIN_NAME}:${n}`) } : {}),
                ...(Object.keys(sub.mcp).length ? { mcpServers: [sub.mcp as Record<string, McpServerConfigForProcessTransport>] } : {}),
              };
              return [sub.key, def];
            }),
          ),
        }
      : {}),
  };
}

/**
 * 成员会话能用的技能：agent-loft 里启用的、Claude Code 自带的、项目目录里的。机器上另外装的
 * （~/.claude/skills、插件市场、claude.ai 同步的）不在里面：模型看不到，Skill 工具也调不了。
 */
function memberSkillAllowlist(skills: NonNullable<SessionOptions["skills"]>, cwd: string): string[] {
  return [...new Set([...skills.list.map((s) => `${PLUGIN_NAME}:${s.name}`), ...claudeBuiltins, ...projectCommandNames(cwd)])];
}

export class ClaudeSession implements AgentSession {
  private queue = new AsyncQueue<SDKUserMessage>();
  private q: Query | null = null;
  private pump: Promise<void> | null = null;
  private currentId: string | undefined;
  /**
   * 分叉已经真正生效（CLI 报出了一个不同于原会话的新 session id）。
   * 在那之前 CLI 起不来、半路退出，重试都还要带 forkSession，绝不能续写原会话。
   */
  private forked = false;
  /** 主线上最新一条助手消息的 uuid，见 handle() */
  private lastAssistantUuid: string | undefined;
  private runtime: RuntimeInfo = {};
  private disposed = false;
  /**
   * 消息先留在本地，上一轮出结果了才交给 CLI。
   *
   * 一股脑塞给 CLI 的话，它会自己排队；而 interrupt() 只停当前这一轮，排在 CLI 里的
   * 下一条照样会跑 —— 用户点了停止，agent 却还在干活。留在本地就能在停止时一并丢掉。
   */
  private turnBusy = false;
  private pending: UserInput[] = [];
  /**
   * 用户点过「本会话全部允许」。只在内存里：这个对象一换（/new、切目录、切 agent、
   * 恢复历史、进程重启），就重新逐条询问。
   */
  private allowAll = false;
  /**
   * 上一轮结束时的累计费用。result 里的 total_cost_usd 是这个会话到目前的累计值，这一轮的 = 差值。
   * 恢复 / 分叉来的会话第一轮不知道之前累计了多少，这一轮先不报费用
   */
  private costSoFar: number | undefined;
  /** 任务清单（见 todos.ts）。只记主线的，子 agent 自己列的不算 */
  private todos = new TodoTracker();

  constructor(
    private readonly opts: SessionOptions,
    private readonly events: AgentEvents,
    private readonly host: InteractionHost,
  ) {
    this.costSoFar = opts.resumeId ? undefined : 0;
    // 接着老会话说：之前列的任务后面可能接着改（TaskUpdate 只给编号），先读回来。
    // 读一个本地文件，比模型第一次调工具快得多
    if (opts.resumeId) void readTodos(opts.resumeId, opts.cwd).then((items) => this.todos.seed(items));
  }

  get sessionId(): string | undefined {
    return this.currentId;
  }

  private start(): void {
    if (this.q || this.disposed) return;
    // 重启时要接着最新的会话，而不是构造时那个 —— 否则中途崩一次，之后都被倒回去
    const resume = this.opts.fork && !this.forked ? this.opts.resumeId : (this.currentId ?? this.opts.resumeId);
    // fork 只在第一次生效：重启再 fork 一次就又分叉一条
    const fork = this.opts.fork && !this.forked;

    // 每个 query 一条自己的输入队列：CLI 崩溃后重新拉起时，旧 query 的输入循环可能还挂在
    // 旧队列上等着；继续共用的话，下一条消息会被那个已经没人处理的旧循环吞掉。
    const input = new AsyncQueue<SDKUserMessage>();
    this.queue = input;
    this.q = query({
      prompt: input.stream(),
      options: {
        cwd: this.opts.cwd,
        // 技能变量只给能跑命令的专家：别的用不上。
        // 任务清单工具（TaskCreate / TaskUpdate）在 SDK 里对新模型默认是关的（Claude 桌面端是打开的），
        // 不开的话 Claude 不会列任务，页面上也就没有进度可看。只能联网的专家不要
        env: {
          ...agentEnvironment(),
          ...(this.access === "web" ? {} : { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" }),
          ...(this.access === "exec" ? (this.opts.skills?.env ?? {}) : {}),
        },
        // 只能是 default 或 acceptEdits：bypassPermissions 会让 canUseTool 变成死代码。
        // acceptEdits 只放行工作目录（含附件目录）内的改文件，其它照样走 canUseTool
        permissionMode: this.opts.autoEdit ? "acceptEdits" : "default",
        // 逐字输出给 Web 用；飞书渠道直接忽略这些片段
        includePartialMessages: true,
        ...(this.opts.model ? { model: this.opts.model } : {}),
        ...(this.opts.effort ? { effort: this.opts.effort as never } : {}),
        // 只能联网的专家不读本地文件，附件内容由 buildContent 直接放进消息
        additionalDirectories: this.access === "web" ? [] : [this.opts.uploadsDir],
        ...expertOptions(this.opts),
        ...(resume ? { resume } : {}),
        ...(fork ? { forkSession: true } : {}),
        canUseTool: async (toolName, input) => this.canUseTool(toolName, input as Record<string, unknown>),
      },
    });

    this.pump = this.consume()
      .catch((err) => {
        if (!this.disposed) this.events.onError(err);
      })
      .finally(() => {
        // query 真的结束了（CLI 退出或输入被关）。清掉之后下一条消息会带着最新的
        // sessionId 重新拉起来，上下文不丢；不清的话消息会进一个没人消费的队列。
        input.close();
        this.q = null;
        this.pump = null;
        // CLI 半路退出：这一轮不会再有结果了，排队的下一条会重新拉起 CLI 接着跑
        if (this.turnBusy) this.onTurnEnd();
      });
  }

  private async consume(): Promise<void> {
    if (!this.q) return;
    for await (const message of this.q as AsyncIterable<SDKMessage>) this.handle(message);
  }

  private handle(message: SDKMessage): void {
    if ("session_id" in message && typeof message.session_id === "string" && message.session_id) {
      if (message.session_id !== this.currentId) {
        // 分叉时 CLI 报出的新 id 和原会话不同，这才算分叉成功
        if (this.opts.fork && message.session_id !== this.opts.resumeId) this.forked = true;
        this.currentId = message.session_id;
        this.events.onSessionId(message.session_id);
      }
    }

    if (message.type === "system" && message.subtype === "init") {
      this.runtime = { model: message.model, ...(message.effort ? { effort: message.effort } : {}) };
      this.events.onTurnStart?.();
      return;
    }

    // 逐字片段。子 agent 的输出（parent_tool_use_id 非空）不算回复正文
    if (message.type === "stream_event") {
      if (message.parent_tool_use_id) return;
      const event = message.event as { type?: string; delta?: { type?: string; text?: string } };
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
        this.events.onTextDelta(event.delta.text);
      }
      return;
    }

    if (message.type === "assistant") {
      const blocks = message.message.content;
      if (!Array.isArray(blocks)) return;
      const sub = !!message.parent_tool_use_id;
      // 主线上最新的一条助手消息：这一轮结束时作为分叉位置报出去（和记录里的 uuid 一致）
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
      return;
    }

    // 工具结果：新建任务的编号在这里
    if (message.type === "user") {
      if (!message.parent_tool_use_id && feedTodos(this.todos, message)) this.events.onTodos?.(this.todos.list);
      return;
    }

    if (message.type === "result") {
      const costUsd = this.turnCost(message.total_cost_usd);
      this.reportUsage(message.modelUsage);
      if (message.subtype === "success") {
        this.events.onResult({
          text: message.result,
          ...(costUsd !== undefined ? { costUsd } : {}),
          durationMs: message.duration_ms,
          ...(this.lastAssistantUuid ? { anchor: this.lastAssistantUuid } : {}),
        });
      } else {
        this.events.onError(new Error(`运行结束但报错：${message.subtype}`));
      }
      this.onTurnEnd();
      void this.readContext();
    }
  }

  /** 这一轮的费用 = 累计费用的差值。崩溃时的 result 费用是 0，不当成新的起点 */
  private turnCost(total: number | undefined): number | undefined {
    if (typeof total !== "number" || !(total > 0)) return undefined;
    const prev = this.costSoFar;
    this.costSoFar = total;
    return prev !== undefined && total >= prev ? total - prev : undefined;
  }

  /**
   * 报这个会话到目前的累计用量。用 modelUsage 而不是 usage：usage 只有主循环这一轮的，
   * modelUsage 含子 agent、压缩等所有调用，而且是累计值（恢复的会话接着原来的总数算）
   */
  private reportUsage(modelUsage: Record<string, ModelUsage> | undefined): void {
    const sum: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0 };
    for (const m of Object.values(modelUsage ?? {})) {
      sum.input += m.inputTokens || 0;
      sum.cacheRead += m.cacheReadInputTokens || 0;
      sum.cacheWrite += m.cacheCreationInputTokens || 0;
      sum.output += m.outputTokens || 0;
      sum.reasoning! += m.thinkingTokens || 0;
      sum.costUsd! += m.costUSD || 0;
    }
    // 崩溃时的 result 全是 0
    if (sum.input + sum.cacheRead + sum.cacheWrite + sum.output > 0) this.events.onUsage?.(sum, true);
  }

  /**
   * 一轮结束后问一次上下文占用（和 /context 同一份数据）。summary 模式只用上一次响应的
   * usage 加本地估算，不额外调 token 计数接口，很便宜。读不到就算了，只是少个指示器。
   */
  private async readContext(): Promise<void> {
    const q = this.q;
    if (!q || typeof q.getContextUsage !== "function") return;
    try {
      const r = await q.getContextUsage({ detail: "summary" });
      const window = r.rawMaxTokens || r.maxTokens;
      if (!window || typeof r.totalTokens !== "number") return;
      this.events.onContext?.({
        used: r.totalTokens,
        window,
        percent: typeof r.percentage === "number" ? r.percentage : Math.round((r.totalTokens / window) * 100),
      });
    } catch (err) {
      console.warn("[claude] 读取上下文占用失败:", err instanceof Error ? err.message : err);
    }
  }

  // ---------- 授权 ----------

  /**
   * canUseTool：预批过的直接放行，否则交给用户。
   * 对同一 request_id 必须幂等 —— reinitialize 之后 SDK 会重投同一个请求。
   */
  private async canUseTool(toolName: string, input: Record<string, unknown>): Promise<PermissionResult> {
    // 自家的记忆工具，以及自定义专家配好的联网工具、MCP（没标「调用前询问」的）：不问。
    // 不用 allowedTools 放行 —— SDK 会对每个会话打一条「canUseTool 被绕过」的警告
    if (MEMORY_TOOLS.has(toolName) && this.opts.memory) return { behavior: "allow", updatedInput: input };
    if ((TASK_TOOLS.has(toolName) || SKILL_TOOLS.has(toolName)) && this.opts.tasks) return { behavior: "allow", updatedInput: input };
    if (this.expertPreApproved(toolName)) return { behavior: "allow", updatedInput: input };

    // 提问不是授权：它问的是「你选哪个」
    if (toolName === "AskUserQuestion") {
      const answered = await this.askQuestion(input);
      if (answered) return answered;
    }

    // 提问、批准计划这类不是「安全确认」，而是要用户真的做决定，全部允许也照样问
    const sessionable = isRememberable(toolName);
    if (sessionable && this.allowAll) return { behavior: "allow", updatedInput: input };

    const signature = signatureOf(toolName, input);
    if (isPreApproved(toolName, signature)) return { behavior: "allow", updatedInput: input };

    const outcome = await this.host({
      kind: "approval",
      title: `需要授权：${toolName}`,
      detail: describeToolCall(toolName, input),
      ...(isRememberableSignature(toolName, signature) ? { alwaysLabel: alwaysLabelOf(toolName, signature), alwaysGlobal: true } : {}),
      ...(sessionable ? { allowSession: true } : {}),
    });
    if (outcome.settlement === "allow-always" && isRememberableSignature(toolName, signature)) rememberAlways(signature);
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

  /** 自定义专家：它配了的联网工具、MCP 工具（没标「调用前询问」的）是用户自己给的，不再逐次问 */
  private expertPreApproved(toolName: string): boolean {
    const e = this.opts.expert;
    if (!e) return false;
    if ((toolName === "WebSearch" && e.webSearch) || (toolName === "WebFetch" && e.webFetch)) return true;
    const m = /^mcp__(.+?)__/.exec(toolName);
    return !!m && m[1]! in e.mcp && !e.askMcp.includes(m[1]!);
  }

  /** 内置专家算能跑命令 */
  private get access(): ExpertAccess {
    return this.opts.expert?.access ?? "exec";
  }

  /**
   * AskUserQuestion：选了什么要顺着 updatedInput.answers 回填（问题原文 → 答案），
   * 少了这一步工具会以「The user did not answer the questions.」收场。
   */
  private async askQuestion(input: Record<string, unknown>): Promise<PermissionResult | null> {
    const questions = parseQuestions(input);
    if (!questions) return null;
    const outcome = await this.host({ kind: "question", title: "Claude 想确认一下", questions });
    const answers: Record<string, string> = {};
    for (const [id, picked] of Object.entries(outcome.answers)) answers[id] = picked.join(", ");
    if (Object.keys(answers).length > 0) {
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }
    // 说清楚是「没作答」而不是「拒绝这件事」，并且明说别再问一遍
    return {
      behavior: "deny",
      message:
        "用户没有作答（超时或主动跳过）。不要重复提同样的问题：按你认为合理的默认继续，并在回复里说明你替他选了什么。",
    };
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

  /** 一轮结束（出结果、出错或 CLI 退出）：交出下一条排队的消息 */
  private onTurnEnd(): void {
    this.turnBusy = false;
    const next = this.pending.shift();
    if (next && !this.disposed) this.deliver(next);
  }

  private deliver(input: UserInput): void {
    // 先把内容组装出来再标记「忙」：附件读不出来（比如已被别处的 /new 清掉）时，
    // 这条要明确报错并让会话恢复可用，而不是挂在一个永远等不到结果的「忙」上
    let content: string | ContentBlock[];
    try {
      content = buildContent(input, this.access === "web");
    } catch (err) {
      const why = (err as NodeJS.ErrnoException).code === "ENOENT" ? "附件文件已不存在，请重新上传" : String(err);
      this.events.onError(new Error(`这条消息没能发出：${why}`));
      const next = this.pending.shift();
      if (next && !this.disposed) this.deliver(next);
      return;
    }
    this.turnBusy = true;
    this.start();
    this.queue.push({
      type: "user",
      ...(input.id ? { uuid: input.id } : {}),
      message: { role: "user", content },
      parent_tool_use_id: null,
      // 人敲的字必须显式标记来源；缺省会在严格的信任门上 fail closed
      origin: { kind: "human" },
    } as SDKUserMessage);
    if (input.id) this.events.onUserAnchor?.(input, input.id);
  }

  async listModels(): Promise<ModelInfo[]> {
    this.start();
    return toModelInfo(await this.q!.supportedModels());
  }

  async setAutoEdit(on: boolean): Promise<void> {
    this.opts.autoEdit = on;
    // 还没起 CLI 就不用管：下次拉起时按 opts 来
    if (this.q) await this.q.setPermissionMode(on ? "acceptEdits" : "default");
  }

  async setModel(model?: string, effort?: string): Promise<void> {
    this.start();
    if (model !== undefined) {
      await this.q!.setModel(model);
      this.opts.model = model;
      this.runtime = { ...this.runtime, model };
    }
    if (effort !== undefined) {
      await this.q!.applyFlagSettings({ effortLevel: effort as never });
      this.opts.effort = effort;
      this.runtime = { ...this.runtime, effort };
    }
  }

  /** 已知的模型 / 思考程度，不拉起进程、不发请求（顶栏显示用） */
  peekRuntime(): RuntimeInfo {
    return this.runtime;
  }

  /**
   * 当前实际生效的模型与思考程度。会拉起 CLI 进程，但不消耗对话轮次。
   * getSettings 没写进 SDK 的 Query 类型，先探测再调用。
   */
  async describeRuntime(): Promise<RuntimeInfo> {
    this.start();
    const q = this.q as unknown as {
      getSettings?: () => Promise<{ applied?: { model?: string; effort?: string | null } }>;
    };
    if (typeof q?.getSettings === "function") {
      try {
        const applied = (await q.getSettings()).applied;
        if (applied?.model) {
          this.runtime = { model: applied.model, ...(applied.effort ? { effort: applied.effort } : {}) };
        }
      } catch (err) {
        console.error("[claude] 读取模型设置失败:", err);
      }
    }
    return this.runtime;
  }

  async interrupt(opts: InterruptOptions = {}): Promise<void> {
    if (opts.keepQueue) {
      // 打断并发送：排着的留着，选中的挪到最前面，这一轮出结果后 onTurnEnd 就交出它
      const i = opts.first ? this.pending.indexOf(opts.first) : -1;
      if (i > 0) this.pending.unshift(...this.pending.splice(i, 1));
    } else {
      // 停止 = 这一轮和排着队的都不要了
      const dropped = this.pending.length + this.queue.clear();
      this.pending = [];
      if (dropped > 0) this.events.onDropped?.(dropped);
    }
    if (!this.q) return;
    try {
      await this.q.interrupt();
    } catch (err) {
      console.warn("[claude] 中断失败:", err instanceof Error ? err.message : err);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.pending = [];
    this.queue.close();
    try {
      await this.q?.interrupt();
    } catch {
      // 已经停了就无所谓
    }
    await this.pump?.catch(() => {});
    this.q = null;
    this.pump = null;
  }
}

export function summarize(text: string, max = 80): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function describeToolUse(name: string, input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>;
  if (name === "Bash" && typeof record.command === "string") return `Bash: ${summarize(record.command, 60)}`;
  if (typeof record.file_path === "string") return `${name}: ${record.file_path}`;
  if (typeof record.pattern === "string") return `${name}: ${summarize(record.pattern, 40)}`;
  if (typeof record.description === "string") return `${name}: ${summarize(record.description, 50)}`;
  return name;
}
