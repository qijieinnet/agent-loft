// 一条会话 ↔ 一条 Codex thread。
//
// 所有会话共用同一个 app-server 进程，靠 threadId 区分。所以本模块除了 CodexSession
// 之外还负责一件全局的事：把 app-server 收到的通知和反向请求按 threadId 分发到会话上。
import { appServer } from "./app-server.js";
import { refusalFor, UnsupportedRequest } from "./refusals.js";
import { config } from "../../core/config.js";
import { describeAttachments } from "../../core/uploads.js";
import type {
  AgentEvents,
  AgentSession,
  InteractionHost,
  QuestionSpec,
  RuntimeInfo,
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

// app-server 重启后进程里的 thread 都没了，但盘上还在：标记「下次说话先 resume 回来」
appServer.onRestart(() => {
  for (const session of byThread.values()) session.markDetached();
});

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
  return s === "allow-once" || s === "allow-always";
}

type ParsedQuestion = QuestionSpec & { secret: boolean };

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

export class CodexSession implements AgentSession {
  private threadId: string | undefined;
  private turnId: string | undefined;
  private turnActive = false;
  /** thread/start 或 thread/resume 的在途请求，避免并发的两条消息各开一条 thread */
  private opening: Promise<string> | null = null;
  private detached = false;
  private runtime: RuntimeInfo = {};
  private replyText = "";
  private lastTokens: number | undefined;
  private everOpened = false;
  /** agentMessage 的 itemId → 是不是旁白（commentary 属于过程，不流式到正文里） */
  private commentaryItems = new Set<string>();

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
    this.turnId = undefined;
    this.turnActive = false;
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

  private async openOnce(): Promise<string> {
    const shared = {
      cwd: this.opts.cwd,
      approvalPolicy: "on-request",
      sandbox: config().agents.codex.sandbox,
      ...(this.opts.model ? { model: this.opts.model } : {}),
    };
    const resumeId = this.threadId ?? this.opts.resumeId;
    const fork = this.opts.fork && !this.everOpened;
    this.everOpened = true;

    let res: ThreadResponse;
    if (resumeId && fork) {
      res = await appServer.call<ThreadResponse>("thread/fork", { threadId: resumeId, excludeTurns: true, ...shared });
    } else if (resumeId) {
      res = await appServer.call<ThreadResponse>("thread/resume", { threadId: resumeId, excludeTurns: true, ...shared });
    } else {
      res = await appServer.call<ThreadResponse>("thread/start", shared);
    }
    this.adopt(res.thread);
    return res.thread.id;
  }

  private adopt(thread: Thread): void {
    const previous = this.threadId;
    if (previous && previous !== thread.id) byThread.delete(previous);
    this.threadId = thread.id;
    this.detached = false;
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
    this.replyText = "";
    const note = input.attachments.length
      ? describeAttachments(input.attachments, (a) => a.kind === "image")
      : "";
    const text = note ? (input.text ? `${input.text}\n\n${note}` : note) : input.text;
    const images = input.attachments.filter((a) => a.kind === "image").map((a) => a.path);
    void this.open()
      .then((threadId) =>
        appServer.call("turn/start", {
          threadId,
          input: [
            { type: "text", text, text_elements: [] },
            ...images.map((path) => ({ type: "localImage" as const, path })),
          ],
          cwd: this.opts.cwd,
          approvalPolicy: "on-request",
          ...(this.opts.model ? { model: this.opts.model } : {}),
          ...(this.opts.effort ? { effort: this.opts.effort } : {}),
        }),
      )
      .catch((err) => this.events.onError(err));
  }

  /** 记下来，下一轮 turn/start 带上即可。 */
  async setModel(model?: string, effort?: string): Promise<void> {
    if (model !== undefined) this.opts.model = model;
    if (effort !== undefined) this.opts.effort = effort;
    const nextModel = model ?? this.runtime.model;
    const nextEffort = effort ?? this.runtime.effort;
    this.runtime = { ...(nextModel ? { model: nextModel } : {}), ...(nextEffort ? { effort: nextEffort } : {}) };
  }

  /** 不额外发请求，也绝不为此新开 thread（否则历史里会留一串空会话）。 */
  async describeRuntime(): Promise<RuntimeInfo> {
    return this.runtime;
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.turnId || !this.turnActive) return;
    try {
      await appServer.call("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
    } catch (err) {
      console.warn("[codex] 中断请求未生效:", err instanceof Error ? err.message : err);
    }
  }

  async dispose(): Promise<void> {
    await this.interrupt();
    if (this.threadId) {
      byThread.delete(this.threadId);
      try {
        await appServer.call("thread/unsubscribe", { threadId: this.threadId });
      } catch {
        // 老版本没有这个方法，或者 thread 已经没了
      }
    }
    this.threadId = undefined;
    this.turnId = undefined;
  }

  // ---------- 反向请求：审批与提问 ----------

  /**
   * 每一条都**必须**返回点什么 —— 漏回一次，Codex 那一轮就永远挂在等审批上。
   * 未知方法也要按它自己的协议结构明确拒绝。
   */
  async handleServerRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const req = params as CommandExecutionApprovalParams;
        const amendment = req.proposedExecpolicyAmendment ?? null;
        const outcome = await this.host({
          kind: "approval",
          title: req.kind === "writeStdin" ? "需要授权：向运行中的命令输入" : "需要授权：执行命令",
          detail: describeCommand(req),
          // 「总是允许」到底记多宽取决于 Codex 有没有给 execpolicy 补丁，差别很大，得写在按钮上
          alwaysLabel: amendment ? "以后同类不再问" : "本会话内不再问",
        });
        const s = outcome.settlement;
        if (s === "allow-once") return { decision: "accept" };
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
        const outcome = await this.host({
          kind: "approval",
          title: "需要授权：改动文件",
          detail: describeFileChange(req),
          alwaysLabel: "本会话内不再问",
        });
        const s = outcome.settlement;
        if (s === "allow-once") return { decision: "accept" };
        if (s === "allow-always") return { decision: "acceptForSession" };
        if (s === "cancelled") return { decision: "cancel" };
        return { decision: "decline" };
      }

      case "item/permissions/requestApproval": {
        const req = params as PermissionsApprovalParams;
        const outcome = await this.host({
          kind: "approval",
          title: "需要授权：额外权限",
          detail: describePermissions(req),
          alwaysLabel: "本会话内都给",
        });
        if (!allowed(outcome.settlement)) return { permissions: {}, scope: "turn" };
        return {
          permissions: req.permissions ?? {},
          scope: outcome.settlement === "allow-always" ? "session" : "turn",
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
    const turnId = (params as { turnId?: unknown } | null)?.turnId;
    if (typeof turnId === "string") this.turnId = turnId;

    switch (method) {
      case "turn/started":
        this.replyText = "";
        this.turnActive = true;
        this.commentaryItems.clear();
        this.events.onTurnStart?.();
        return;

      case "item/started":
        this.onItem((params as ItemNotification).item, "started");
        return;

      case "item/completed":
        this.onItem((params as ItemNotification).item, "completed");
        return;

      case "item/agentMessage/delta": {
        const p = params as AgentMessageDeltaNotification;
        if (!this.commentaryItems.has(p.itemId) && p.delta) this.events.onTextDelta(p.delta);
        return;
      }

      case "thread/tokenUsage/updated": {
        // last 是这一轮的用量，total 是整条 thread 的累计；页脚显示这一轮的
        const usage = (params as { tokenUsage?: { last?: { totalTokens?: number } } }).tokenUsage;
        const turnTokens = usage?.last?.totalTokens;
        if (typeof turnTokens === "number") this.lastTokens = turnTokens;
        return;
      }

      case "turn/completed": {
        const { turn } = params as TurnCompletedNotification;
        this.turnActive = false;
        if (turn.status === "failed") {
          this.events.onError(new Error(turn.error?.message ?? "这一轮失败了"));
          return;
        }
        if (turn.status === "interrupted") {
          this.events.onResult({ text: this.replyText || "（已中断）", durationMs: turn.durationMs ?? 0 });
          this.replyText = "";
          return;
        }
        this.events.onResult({
          text: this.replyText,
          durationMs: turn.durationMs ?? 0,
          ...(this.lastTokens !== undefined ? { tokens: this.lastTokens } : {}),
        });
        this.replyText = "";
        return;
      }

      case "error": {
        const { error, willRetry } = params as { error?: { message?: string }; willRetry?: boolean };
        if (willRetry) {
          this.events.onStep("warning", `⚠️ ${summarize(error?.message ?? "出错，正在重试")}`);
          return;
        }
        this.turnActive = false;
        this.events.onError(new Error(error?.message ?? "未知错误"));
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
