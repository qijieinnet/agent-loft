// 一条会话 ↔ 一个常驻的 `dsh --profile acp` 进程（见 acp.ts 开头为什么不共用进程）。
//
// 消息先在本地排队，上一轮的 session/prompt 返回了才发下一条 —— 停止时排着的能一起丢掉（和 Claude 一样）。
// 权限级别、计划模式、追加的系统提示都是启动参数：运行中改了，闲下来就关掉进程，下一条消息带着会话 id 重拉（session/resume）。
//
// ACP 没有的东西：
//   - 提问卡（elicitation）：系统提示里告诉模型直接在回复里问
//   - 调用 MCP 前询问：dsh 的授权只管沙箱越界，拦不住 MCP 调用，所以设成「调用前询问」的 MCP 不挂
//   - 逐字流式：dsh 一条助手消息说完才推过来
//   - 每轮 token 用量：一轮结束后从会话记录里加出来（history.ts 的 lastTurnUsage）
import { RICH_REPLY_LINES } from "../../core/expert-prompt.js";
import { MEMORY_MCP_NAME, memoryMcpSpawn } from "../../core/memory-mcp.js";
import type { PermissionLevel } from "../../core/permission.js";
import { codexSkillLines } from "../../core/skill-runtime.js";
import { SKILLS_MCP_NAME, skillsMcpSpawn, TASKS_MCP_NAME, tasksMcpSpawn } from "../../core/tasks-mcp.js";
import type {
  AgentEvents,
  AgentSession,
  InteractionHost,
  InterruptOptions,
  ModelInfo,
  RuntimeInfo,
  SessionOptions,
  UserInput,
} from "../../core/types.js";
import { describeAttachments } from "../../core/uploads.js";
import { summarize } from "../claude/session.js";
import { TodoTracker } from "../claude/todos.js";
import { AcpConnection, initialize, type ConfigOption, type McpServer, type PermissionOutcome, type PermissionRequest, type SessionUpdate } from "./acp.js";
import { lastTurnUsage, readEvents, sessionFile } from "./history.js";
import { launchSpec, modelsOf, modelValueOf, modeOf, runtimeOf } from "./sdk.js";
import { describeDshStep, todoName } from "./steps.js";
import { resolveCommand } from "./which.js";

/** 计划模式：dsh 的计划模式 ACP 切不了，用只读沙箱 + 提示词代替 */
const PLAN_LINES = [
  "## 计划模式（agent-loft）",
  "",
  "现在是计划模式：只读、只出方案。可以读文件、搜索、跑只读命令来摸清情况，但不要改任何文件、不要提交，也不要申请越过沙箱。",
  "把完整方案（目标、要改哪些地方、步骤、风险、怎么验证）写在回复里，然后停下来等用户批准；用户关掉计划模式后才动手。",
];

/** 内置专家追加在 dsh 原装提示后面的：回复格式、记忆、技能说明、这里用不了的工具 */
export function appendPrompt(opts: SessionOptions): string {
  return [
    RICH_REPLY_LINES.join("\n"),
    "ask_user_question 工具在这里用不了（没有提问界面）：需要用户拿主意时，直接在回复里问，然后结束这一轮。",
    opts.memory?.prompt,
    codexSkillLines(opts.skills).join("\n"),
    opts.plan ? PLAN_LINES.join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function pairs(rec: Record<string, string> | undefined): { name: string; value: string }[] {
  return Object.entries(rec ?? {}).map(([name, value]) => ({ name, value }));
}

/** 记忆 / 定时任务 / 技能 MCP，加上个人选的 MCP。返回挂上的和没挂的（「调用前询问」、SSE、找不到命令） */
export function mcpServersOf(opts: SessionOptions): { servers: McpServer[]; skipped: string[] } {
  const servers: McpServer[] = [];
  const skipped: string[] = [];
  const stdio = (name: string, spec: { command: string; args: string[]; env?: Record<string, string> }) =>
    servers.push({ name, command: spec.command, args: spec.args, env: pairs(spec.env) });
  if (opts.memory) stdio(MEMORY_MCP_NAME, memoryMcpSpawn(opts.memory.userId, "dsh", { search: !!opts.memory.search, ...(opts.memory.convKey ? { convKey: opts.memory.convKey } : {}) }));
  if (opts.tasks) {
    stdio(TASKS_MCP_NAME, tasksMcpSpawn(opts.tasks.userId, opts.tasks.convKey, "dsh"));
    stdio(SKILLS_MCP_NAME, skillsMcpSpawn(opts.tasks.userId, opts.tasks.convKey, "dsh"));
  }
  const builtin = opts.builtinMcp;
  for (const [name, spec] of Object.entries(builtin?.mcp ?? {})) {
    if (builtin!.askMcp.includes(name) || spec.type === "sse") {
      skipped.push(name);
      continue;
    }
    if (spec.type === "http") {
      servers.push({ type: "http", name, url: spec.url, headers: pairs(spec.headers) });
      continue;
    }
    // ACP 要求绝对路径
    const command = resolveCommand(spec.command, spec.env?.PATH);
    if (!command) {
      skipped.push(name);
      continue;
    }
    stdio(name, { command, args: spec.args, env: spec.env });
  }
  return { servers, skipped };
}

function settle(outcome: { settlement: string }): "allow" | "session" | "deny" {
  if (outcome.settlement === "allow-session") return "session";
  if (outcome.settlement === "allow-once" || outcome.settlement === "allow-always") return "allow";
  return "deny";
}

type Tracked = { name: string; input: Record<string, unknown> };

export class DshSession implements AgentSession {
  private conn: AcpConnection | null = null;
  private cleanup: (() => void) | null = null;
  private starting: Promise<AcpConnection | null> | null = null;
  /** 正在跑的进程是按哪种沙箱 / 提示词拉起的：和 opts 对不上了就该重拉 */
  private launchedKey = "";
  private currentId: string | undefined;
  private runtime: RuntimeInfo = {};
  private options: ConfigOption[] = [];
  private disposed = false;
  private turnBusy = false;
  private pending: UserInput[] = [];
  private allowAll = false;
  private todos = new TodoTracker();
  private tools = new Map<string, Tracked>();
  private turn: Promise<void> | null = null;
  /** 这一轮说过的话、最后一条助手消息的 id */
  private turnText: string[] = [];
  private lastMessageId: string | undefined;
  private warnedSkipped = false;

  constructor(
    private readonly opts: SessionOptions,
    private readonly events: AgentEvents,
    private readonly host: InteractionHost,
  ) {
    if (opts.fork) throw new Error("dsh 不支持分叉会话");
    this.currentId = opts.resumeId;
    this.allowAll = opts.permission === "full";
    this.runtime = { ...(opts.model ? { model: opts.model } : {}), ...(opts.effort ? { effort: opts.effort } : {}) };
  }

  get sessionId(): string | undefined {
    return this.currentId;
  }

  private wantedKey(): string {
    return JSON.stringify([modeOf(this.opts.permission, this.opts.plan), appendPrompt(this.opts)]);
  }

  private start(): Promise<AcpConnection | null> {
    if (this.conn?.alive && this.launchedKey === this.wantedKey()) return Promise.resolve(this.conn);
    if (this.disposed) return Promise.resolve(null);
    this.starting ??= (async () => {
      if (this.conn) await this.stopProcess();
      return this.launch();
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(): Promise<AcpConnection | null> {
    const key = this.wantedKey();
    const skills = this.opts.skills;
    const { spawn, cleanup } = launchSpec({
      cwd: this.opts.cwd,
      mode: modeOf(this.opts.permission, this.opts.plan),
      append: appendPrompt(this.opts),
      // 成员不加载机器上的技能（和别的 agent 一致）
      noMachineSkills: !!skills && !(skills.admin && skills.machineSkills !== false),
      env: skills?.env ?? {},
    });
    const conn = new AcpConnection(spawn);
    conn.onUpdate = (sid, u) => {
      if (sid === this.currentId) this.handle(u);
    };
    conn.onPermission = (req) => this.permission(req);
    conn.onExit = () => {
      cleanup();
      if (this.conn === conn) this.conn = null;
    };
    try {
      await initialize(conn);
      const { servers, skipped } = mcpServersOf(this.opts);
      if (skipped.length && !this.warnedSkipped) {
        this.warnedSkipped = true;
        this.events.onStep("warning", `⚠️ dsh 不支持调用前询问 / SSE 的 MCP，没挂上：${skipped.join("、")}`);
      }
      let res: { sessionId?: string; configOptions?: ConfigOption[] } | null;
      if (this.currentId) {
        res = await conn.request("session/resume", { sessionId: this.currentId, cwd: this.opts.cwd, mcpServers: servers });
      } else {
        res = await conn.request("session/new", { cwd: this.opts.cwd, mcpServers: servers });
        if (!res?.sessionId) throw new Error("dsh 没有返回会话 id");
        this.currentId = res.sessionId;
        this.events.onSessionId(res.sessionId);
      }
      if (this.disposed) {
        await conn.shutdown().catch(() => {});
        cleanup();
        return null;
      }
      this.conn = conn;
      this.cleanup = cleanup;
      this.launchedKey = key;
      if (res?.configOptions) this.applyOptions(res.configOptions);
      await this.applyRuntime(conn);
      return conn;
    } catch (err) {
      await conn.shutdown(1000).catch(() => {});
      cleanup();
      throw err;
    }
  }

  private async stopProcess(): Promise<void> {
    const conn = this.conn;
    this.conn = null;
    if (!conn) return;
    if (this.currentId) await conn.request("session/close", { sessionId: this.currentId }).catch(() => {});
    await conn.shutdown().catch(() => {});
    this.cleanup?.();
    this.cleanup = null;
  }

  private applyOptions(opts: ConfigOption[]): void {
    this.options = opts;
    this.runtime = { ...this.runtime, ...runtimeOf(opts) };
  }

  /** 把选好的模型 / 思考程度设进去（新建、恢复、重拉之后都要设一次） */
  private async applyRuntime(conn: AcpConnection): Promise<void> {
    if (!this.currentId) return;
    const cur = runtimeOf(this.options);
    const set = async (configId: string, value: string) => {
      const r = await conn.request<{ configOptions?: ConfigOption[] }>("session/set_config_option", { sessionId: this.currentId, configId, value });
      if (r?.configOptions) this.applyOptions(r.configOptions);
    };
    if (this.opts.model && this.opts.model !== cur.model) await set("model", modelValueOf(this.opts.model));
    if (this.opts.effort && this.opts.effort !== runtimeOf(this.options).effort) {
      await set("reasoning_effort", this.opts.effort).catch((err) => this.events.onStep("warning", `⚠️ 思考程度没设上：${err instanceof Error ? err.message : err}`));
    }
  }

  // ---------- 收消息 ----------

  private handle(u: SessionUpdate): void {
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const c = u.content as { type?: string; text?: string } | undefined;
        if (c?.type !== "text" || !c.text) return;
        if (typeof u.messageId === "string") this.lastMessageId = u.messageId;
        this.turnText.push(c.text);
        this.events.onText(c.text);
        return;
      }
      case "agent_thought_chunk": {
        const c = u.content as { type?: string; text?: string } | undefined;
        const t = c?.text ? summarize(c.text) : "";
        if (t) this.events.onStep("thinking", `💭 ${t}`);
        return;
      }
      case "tool_call": {
        const id = typeof u.toolCallId === "string" ? u.toolCallId : "";
        const name = typeof u.title === "string" ? u.title : "tool";
        const input = u.rawInput && typeof u.rawInput === "object" ? (u.rawInput as Record<string, unknown>) : {};
        if (id) this.tools.set(id, { name, input });
        const todo = this.todos.use(todoName(name), input, id);
        if (todo) {
          this.events.onStep("tool", todo.step);
          if (todo.changed) this.events.onTodos?.(this.todos.list);
          return;
        }
        this.events.onStep("tool", `🔧 ${describeDshStep(name, input)}`);
        return;
      }
      case "usage_update": {
        const used = Number(u.used);
        const size = Number(u.size);
        if (used > 0 && size > 0) this.events.onContext?.({ used, window: size, percent: Math.round((used / size) * 1000) / 10 });
        return;
      }
      case "config_option_update": {
        if (Array.isArray(u.configOptions)) this.applyOptions(u.configOptions as ConfigOption[]);
        return;
      }
    }
  }

  // ---------- 授权 ----------

  private async permission(req: PermissionRequest): Promise<PermissionOutcome> {
    const allow = req.options.find((o) => o.kind === "allow_once") ?? req.options.find((o) => o.kind.startsWith("allow"));
    const reject = req.options.find((o) => o.kind === "reject_once") ?? req.options.find((o) => o.kind.startsWith("reject"));
    if (req.sessionId !== this.currentId || this.disposed) return { outcome: "cancelled" };
    if (allow && this.allowAll && !this.opts.plan) return { outcome: "selected", optionId: allow.optionId };
    const tool = this.tools.get(req.toolCall.toolCallId);
    const name = tool?.name ?? req.toolCall.title ?? "操作";
    const input = tool?.input ?? (req.toolCall.rawInput as Record<string, unknown> | undefined) ?? {};
    const outcome = await this.host({
      kind: "approval",
      title: `需要授权：${name}`,
      detail: describePermission(name, input),
      ...(!this.opts.noSessionGrant ? { allowSession: true } : {}),
    });
    const s = settle(outcome);
    if (s === "session") {
      if (!this.allowAll) this.events.onStep("warning", "🔓 本会话内后续操作不再询问（/new 或切换会话后恢复逐条确认）");
      this.allowAll = true;
    }
    if (s !== "deny" && allow) return { outcome: "selected", optionId: allow.optionId };
    return reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" };
  }

  // ---------- 一轮 ----------

  private async runTurn(input: UserInput): Promise<void> {
    const t0 = Date.now();
    this.turnText = [];
    this.lastMessageId = undefined;
    try {
      const conn = await this.start();
      if (!conn || !this.currentId) return;
      const note = describeAttachments(input.attachments, () => false, false);
      const text = [input.text, note].filter(Boolean).join("\n\n");
      this.events.onTurnStart?.();
      const res = await conn.request<{ stopReason?: string }>("session/prompt", { sessionId: this.currentId, prompt: [{ type: "text", text }] });
      if (this.disposed) return;
      const stop = res?.stopReason ?? "end_turn";
      if (stop === "cancelled") {
        this.events.onError(new Error("interrupted"));
        return;
      }
      if (stop === "max_tokens") this.events.onStep("warning", "⚠️ 这一轮输出到达长度上限，被截断了");
      else if (stop === "max_turn_requests") this.events.onStep("warning", "⚠️ 这一轮的模型请求次数到上限了，没做完");
      else if (stop === "refusal") this.events.onStep("warning", "⚠️ 模型拒绝了这个请求");
      const tokens = await this.reportUsage();
      this.events.onResult({
        text: this.turnText.join("\n\n"),
        durationMs: Date.now() - t0,
        ...(tokens ? { tokens } : {}),
        ...(this.lastMessageId ? { anchor: this.lastMessageId } : {}),
      });
    } catch (err) {
      if (this.disposed) return;
      this.events.onError(err);
    }
  }

  /** 这一轮的用量从会话记录里加（记录可能稍晚才落盘，等一下） */
  private async reportUsage(): Promise<number | undefined> {
    if (!this.currentId) return undefined;
    await new Promise((r) => setTimeout(r, 300));
    try {
      const file = sessionFile(this.currentId);
      const u = file ? lastTurnUsage(readEvents(file)) : undefined;
      if (!u) return undefined;
      this.events.onUsage?.(u, false);
      return u.input + u.cacheRead + u.cacheWrite + u.output;
    } catch {
      return undefined;
    }
  }

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
      else if (!this.disposed && this.conn && this.launchedKey !== this.wantedKey()) void this.stopProcess();
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    const conn = await this.start();
    if (!conn) return [];
    return modelsOf(this.options);
  }

  /** 沙箱档位只能启动时定：闲着就马上关掉进程，忙着就等这一轮完（deliver 里），下一条消息按新档位重拉 */
  private async relaunchLater(): Promise<void> {
    if (this.conn && !this.turnBusy && this.launchedKey !== this.wantedKey()) await this.stopProcess();
  }

  async setPermission(level: PermissionLevel | undefined): Promise<void> {
    this.opts.permission = level;
    this.allowAll = level === "full";
    await this.relaunchLater();
  }

  async setPlan(on: boolean): Promise<void> {
    this.opts.plan = on;
    await this.relaunchLater();
  }

  async setModel(model?: string, effort?: string): Promise<void> {
    if (model !== undefined) this.opts.model = model || undefined;
    if (effort !== undefined) this.opts.effort = effort || undefined;
    this.runtime = { ...this.runtime, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
    // 改了从下一个模型请求起生效，不用重拉
    if (this.conn?.alive) await this.applyRuntime(this.conn);
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
    if (!this.conn || !this.turnBusy || !this.currentId) return;
    this.conn.notify("session/cancel", { sessionId: this.currentId });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.pending = [];
    await this.starting?.catch(() => null);
    if (this.conn && this.turnBusy && this.currentId) this.conn.notify("session/cancel", { sessionId: this.currentId });
    await this.stopProcess();
    await this.turn?.catch(() => {});
  }
}

/** 授权卡里显示什么：命令、文件、dsh 给的理由 */
export function describePermission(name: string, input: Record<string, unknown>): string {
  const why = typeof input.justification === "string" && input.justification.trim() ? `${input.justification.trim()}\n\n` : "";
  if (name === "bash" && typeof input.command === "string") {
    const desc = typeof input.description === "string" ? `${input.description}\n\n` : "";
    return `${why}${desc}\`\`\`bash\n${input.command}\n\`\`\``;
  }
  const file = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : undefined;
  if (file) return `${why}**文件**：\`${file}\``;
  const rest = Object.fromEntries(Object.entries(input).filter(([k]) => k !== "justification" && k !== "content"));
  return `${why}\`\`\`json\n${JSON.stringify(rest, null, 2)}\n\`\`\``;
}
