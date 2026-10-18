// 一条会话 ↔ 一个常驻的 Claude query。
//
// 必须用「流式输入」模式：setModel / interrupt / supportedModels / applyFlagSettings
// 这些控制方法在 SDK 里全都只在 streaming input mode 下可用，也就是 prompt 必须是
// async iterable。这是架构前提，别改。
import fs from "node:fs";
import {
  query,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { agentEnvironment } from "../../core/agent-env.js";
import { describeAttachments } from "../../core/uploads.js";
import type {
  AgentEvents,
  AgentSession,
  InteractionHost,
  ModelInfo,
  RuntimeInfo,
  SavedAttachment,
  SessionOptions,
  UserInput,
} from "../../core/types.js";
import {
  alwaysLabelOf,
  describeToolCall,
  isPreApproved,
  isRememberableSignature,
  parseQuestions,
  rememberAlways,
  signatureOf,
} from "./permissions.js";

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

/** 文字 + 附件清单，后面跟着能直接看的图片和 PDF。没有附件时就是原样的文字。 */
function buildContent(input: UserInput): string | ContentBlock[] {
  if (input.attachments.length === 0) return input.text;
  const note = describeAttachments(input.attachments, canInline);
  const blocks: ContentBlock[] = [{ type: "text", text: input.text ? `${input.text}\n\n${note}` : note }];
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

export class ClaudeSession implements AgentSession {
  private queue = new AsyncQueue<SDKUserMessage>();
  private q: Query | null = null;
  private pump: Promise<void> | null = null;
  private currentId: string | undefined;
  private everStarted = false;
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

  constructor(
    private readonly opts: SessionOptions,
    private readonly events: AgentEvents,
    private readonly host: InteractionHost,
  ) {}

  get sessionId(): string | undefined {
    return this.currentId;
  }

  private start(): void {
    if (this.q || this.disposed) return;
    // 重启时要接着最新的会话，而不是构造时那个 —— 否则中途崩一次，之后都被倒回去
    const resume = this.currentId ?? this.opts.resumeId;
    // fork 只在第一次生效：重启再 fork 一次就又分叉一条
    const fork = this.opts.fork && !this.everStarted;
    this.everStarted = true;

    // 每个 query 一条自己的输入队列：CLI 崩溃后重新拉起时，旧 query 的输入循环可能还挂在
    // 旧队列上等着；继续共用的话，下一条消息会被那个已经没人处理的旧循环吞掉。
    const input = new AsyncQueue<SDKUserMessage>();
    this.queue = input;
    this.q = query({
      prompt: input.stream(),
      options: {
        cwd: this.opts.cwd,
        env: agentEnvironment(),
        // 必须是 default：bypassPermissions 会让 canUseTool 变成死代码
        permissionMode: "default",
        // 逐字输出给 Web 用；飞书渠道直接忽略这些片段
        includePartialMessages: true,
        ...(this.opts.model ? { model: this.opts.model } : {}),
        ...(this.opts.effort ? { effort: this.opts.effort as never } : {}),
        additionalDirectories: [this.opts.uploadsDir],
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
      for (const block of blocks) {
        if (block.type === "thinking") {
          const thought = summarize(block.thinking);
          if (thought) this.events.onStep("thinking", `💭 ${thought}`);
        } else if (block.type === "tool_use") {
          this.events.onStep("tool", `${sub ? "  ↳ " : ""}🔧 ${describeToolUse(block.name, block.input)}`);
        } else if (block.type === "text" && block.text.trim() && !sub) {
          this.events.onText(block.text);
        }
      }
      return;
    }

    if (message.type === "result") {
      if (message.subtype === "success") {
        this.events.onResult({
          text: message.result,
          costUsd: message.total_cost_usd,
          durationMs: message.duration_ms,
        });
      } else {
        this.events.onError(new Error(`运行结束但报错：${message.subtype}`));
      }
      this.onTurnEnd();
    }
  }

  // ---------- 授权 ----------

  /**
   * canUseTool：预批过的直接放行，否则交给用户。
   * 对同一 request_id 必须幂等 —— reinitialize 之后 SDK 会重投同一个请求。
   */
  private async canUseTool(toolName: string, input: Record<string, unknown>): Promise<PermissionResult> {
    // 提问不是授权：它问的是「你选哪个」
    if (toolName === "AskUserQuestion") {
      const answered = await this.askQuestion(input);
      if (answered) return answered;
    }

    const signature = signatureOf(toolName, input);
    if (isPreApproved(toolName, signature)) return { behavior: "allow", updatedInput: input };

    const outcome = await this.host({
      kind: "approval",
      title: `需要授权：${toolName}`,
      detail: describeToolCall(toolName, input),
      ...(isRememberableSignature(toolName, signature) ? { alwaysLabel: alwaysLabelOf(toolName, signature) } : {}),
    });
    if (outcome.settlement === "allow-always" && isRememberableSignature(toolName, signature)) rememberAlways(signature);
    if (outcome.settlement === "allow-once" || outcome.settlement === "allow-always") {
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
      content = buildContent(input);
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
      message: { role: "user", content },
      parent_tool_use_id: null,
      // 人敲的字必须显式标记来源；缺省会在严格的信任门上 fail closed
      origin: { kind: "human" },
    } as SDKUserMessage);
  }

  async listModels(): Promise<ModelInfo[]> {
    this.start();
    const models = await this.q!.supportedModels();
    return models.map((m) => ({
      id: m.value,
      label: m.displayName || m.value,
      ...(m.description ? { description: m.description } : {}),
      ...(m.supportedEffortLevels?.length ? { efforts: [...m.supportedEffortLevels] } : {}),
    }));
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

  async interrupt(): Promise<void> {
    // 停止 = 这一轮和排着队的都不要了
    const dropped = this.pending.length + this.queue.clear();
    this.pending = [];
    if (dropped > 0) this.events.onDropped?.(dropped);
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
