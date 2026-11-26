import fs from "node:fs";
import { nativeOptions } from "../../core/web-bot-native-catalog.js";
// Codex 驱动：官方 `codex app-server`（Codex 桌面版和 IDE 插件走的那条路）。
//
// 不用 @openai/codex-sdk：它是 `codex exec --json` 的薄封装，没有任何审批回调。
import { appServer } from "./app-server.js";
import { describeRateLimits, readAccountKey, readRateLimits, toQuota } from "./account.js";
import { diagnose } from "./errors.js";
import { botChatConfig, CodexSession, summarize, codexTokenUsage } from "./session.js";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebBotError } from "../../core/web-bots.js";
import { config, onConfigChange } from "../../core/config.js";
import { splitAttachmentNote } from "../../core/uploads.js";
import { stripContext } from "../../core/expert-prompt.js";
import type {
  AgentDriver,
  AgentEvents,
  AgentSession,
  CompleteRequest,
  EngineReplyRequest,
  HistoryMessage,
  InteractionHost,
  ModelInfo,
  QuotaInfo,
  RuntimeInfo,
  SessionOptions,
  SessionSummary,
} from "../../core/types.js";
import type { ModelListResponse, Thread, ThreadListResponse } from "./protocol.js";

function titleOf(thread: Thread): string {
  const name = thread.name?.trim();
  if (name) return name;
  const preview = thread.preview && stripContext(thread.preview).replace(/\s+/g, " ").trim();
  if (!preview) return "(无标题)";
  return preview.length > 60 ? `${preview.slice(0, 60)}…` : preview;
}

type HistoryItem = {
  type: string;
  text?: string;
  phase?: string | null;
  command?: string;
  content?: { type: string; text?: string; path?: string }[];
  changes?: { path: string }[];
  server?: string;
  tool?: string;
  query?: string;
  summary?: string[];
};

type HistoryTurn = {
  id?: string;
  items?: HistoryItem[];
  startedAt?: number | null;
  completedAt?: number | null;
};

export class CodexDriver implements AgentDriver {
  readonly id = "codex";
  readonly label = "Codex";
  readonly capabilities = { effort: true, fork: true, cost: false, streaming: true };
  private unsubscribe: (() => void) | null = null;

  async start(): Promise<void> {
    const info = await appServer.start();
    console.log(`[codex] app-server 就绪，CODEX_HOME=${info.codexHome ?? "(默认)"}`);
    // 换了 codex 路径或 CODEX_HOME 就重拉 app-server
    this.unsubscribe = onConfigChange((next, prev) => {
      const a = next.agents.codex;
      const b = prev.agents.codex;
      if (a.path === b.path && a.home === b.home) return;
      if (!a.enabled) return;
      void appServer
        .restart("codex 配置已变更")
        .then(() => console.log("[codex] 配置变更，app-server 已重启"))
        .catch((err) => console.error("[codex] 重启 app-server 失败:", err));
    });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    await appServer.stop();
  }

  createSession(opts: SessionOptions, events: AgentEvents, host: InteractionHost): AgentSession {
    return new CodexSession(opts, events, host);
  }

  async listSessions(cwd: string | undefined, limit = 10): Promise<SessionSummary[]> {
    try {
      const res = await appServer.call<ThreadListResponse>("thread/list", {
        ...(cwd ? { cwd } : {}),
        limit,
        sortKey: "updated_at",
        sortDirection: "desc",
      });
      return (res.data ?? []).map((thread) => ({
        id: thread.id,
        title: titleOf(thread),
        ...(thread.cwd ? { cwd: thread.cwd } : {}),
        updatedAt: ((thread.updatedAt ?? thread.createdAt) || 0) * 1000,
      }));
    } catch (err) {
      console.error("[codex] 读取会话列表失败:", err);
      return [];
    }
  }

  async sessionExists(id: string): Promise<boolean> {
    try {
      await appServer.call("thread/read", { threadId: id, includeTurns: false });
      return true;
    } catch {
      return false;
    }
  }

  async sessionTitle(id: string): Promise<string | undefined> {
    const res = await appServer.call<{ thread: Thread }>("thread/read", { threadId: id, includeTurns: false });
    const name = res.thread.name?.replace(/\s+/g, " ").trim();
    if (name) return name;
    // app-server 不会自动起名（Codex App / TUI 是在客户端自己生成的），开了设置就由这边生成一次
    const c = config().agents.codex;
    if (!c.autoTitle || this.titled.has(id)) return undefined;
    this.titled.add(id);
    return this.generateTitle(id, c.titleModel).catch((err) => {
      console.error("[codex] 生成会话名称失败:", err instanceof Error ? err.message : err);
      return undefined;
    });
  }

  /** 本进程里已经生成过（或试过）名称的线程：失败了也不反复重试，每轮结束都会来问 */
  private titled = new Set<string>();

  private async *readTurns(id: string, itemsView: "full" | "notLoaded" = "full"): AsyncGenerator<HistoryTurn, void> {
    const { thread } = await appServer.call<{
      thread: { historyMode?: string; turns?: HistoryTurn[] };
    }>("thread/read", { threadId: id, includeTurns: true });
    if (thread.historyMode !== "paginated") {
      yield* thread.turns ?? [];
      return;
    }

    // 分页历史的 thread/read 即使带 includeTurns 也只返回元数据。
    let cursor: string | null = null;
    do {
      const page: { data: HistoryTurn[]; nextCursor: string | null } = await appServer.call("thread/turns/list", {
        threadId: id,
        sortDirection: "asc",
        itemsView,
        ...(cursor ? { cursor } : {}),
      });
      yield* page.data;
      cursor = page.nextCursor;
    } while (cursor);
  }

  /** 按第一轮的问答起个短标题，写回线程（thread/name/set），Codex App 里也能看到 */
  private async generateTitle(id: string, model: string): Promise<string | undefined> {
    const { value: turn } = await this.readTurns(id).next();
    const items = turn?.items ?? [];
    const user = items
      .filter((i) => i.type === "userMessage")
      .flatMap((i) => (i.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")))
      .join("\n");
    const question = splitAttachmentNote(stripContext(user)).text.trim();
    if (!question) return undefined;
    const answer = items
      .filter((i) => i.text && (i.type === "plan" || (i.type === "agentMessage" && i.phase !== "commentary")))
      .map((i) => i.text)
      .join("\n\n");
    const out = (await this.complete({
      system: "你给对话起标题。根据用户的第一条消息（和助手的回复）概括这次对话在做什么，输出一个简短的标题：和用户用同一种语言，中文不超过 15 个字，不加引号、句号和表情。",
      prompt: `用户：\n${question.slice(0, 2000)}${answer ? `\n\n助手：\n${answer.slice(0, 1500)}` : ""}`,
      schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
      ...(model ? { model } : {}),
      timeoutMs: 60_000,
    })) as { title?: unknown };
    const title = String(out?.title ?? "")
      .replace(/\s+/g, " ")
      .replace(/^["'“”‘’「」《》]+|["'“”‘’「」《》。.]+$/g, "")
      .trim()
      .slice(0, 80);
    if (!title) return undefined;
    await appServer.call("thread/name/set", { threadId: id, name: title });
    return title;
  }

  async readHistory(id: string): Promise<HistoryMessage[]> {
    const out: HistoryMessage[] = [];
    for await (const turn of this.readTurns(id)) {
      let assistant: HistoryMessage | null = null;
      const ts = turn.startedAt ? turn.startedAt * 1000 : undefined;
      for (const item of turn.items ?? []) {
        if (item.type === "userMessage") {
          const raw = (item.content ?? [])
            .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
            .filter(Boolean)
            .join("\n");
          // 附件清单拆出来单独展示；没有清单的图片（别处发的）只能留个占位
          const { text, attachments } = splitAttachmentNote(stripContext(raw));
          const bareImages = attachments.length ? 0 : (item.content ?? []).filter((c) => c.type === "localImage").length;
          out.push({
            role: "user",
            ...(turn.id ? { anchor: turn.id } : {}),
            text: bareImages ? [text, ...Array(bareImages).fill("📎 图片")].filter(Boolean).join("\n") : text,
            ...(attachments.length ? { attachments } : {}),
            ...(ts ? { ts } : {}),
          });
          continue;
        }
        assistant ??= { role: "assistant", text: "", steps: [] };
        if ((item.type === "agentMessage" || item.type === "plan") && item.text?.trim()) {
          if (item.type === "agentMessage" && item.phase === "commentary") assistant.steps!.push(`💬 ${summarize(item.text)}`);
          else assistant.text += (assistant.text ? "\n\n" : "") + item.text;
        } else if (item.type === "commandExecution" && item.command) {
          assistant.steps!.push(`🔧 ${summarize(item.command, 70)}`);
        } else if (item.type === "fileChange" && item.changes?.length) {
          assistant.steps!.push(`📝 ${summarize(item.changes.map((c) => c.path).join("、"), 90)}`);
        } else if (item.type === "mcpToolCall") {
          assistant.steps!.push(`🔌 ${item.server}.${item.tool}`);
        } else if (item.type === "webSearch") {
          assistant.steps!.push(`🔍 ${summarize(item.query ?? "", 60)}`);
        } else if (item.type === "reasoning" && item.summary?.length) {
          assistant.steps!.push(`💭 ${summarize(item.summary.join(" "))}`);
        }
      }
      if (assistant && (assistant.text || assistant.steps?.length)) {
        const done = turn.completedAt ? turn.completedAt * 1000 : ts;
        out.push({ ...assistant, ...(done ? { ts: done } : {}), ...(turn.id ? { anchor: turn.id } : {}) });
      }
    }
    return out;
  }

  /** anchor 是轮次 id：分叉到这一轮为止（含） */
  async forkAt(id: string, cwd: string, anchor?: string): Promise<string> {
    const res = await appServer.call<{ thread: Thread }>("thread/fork", {
      threadId: id,
      ...(anchor ? { lastTurnId: anchor } : {}),
      cwd,
      excludeTurns: true,
    });
    // 只是复制，这边不接管：等这条会话真正发消息时再由 CodexSession 去 resume
    void appServer.call("thread/unsubscribe", { threadId: res.thread.id }).catch(() => {});
    return res.thread.id;
  }

  async rewindTo(id: string, cwd: string, anchor: string): Promise<string | undefined> {
    let previous: string | undefined;
    for await (const turn of this.readTurns(id, "notLoaded")) {
      if (turn.id === anchor) return previous ? this.forkAt(id, cwd, previous) : undefined;
      previous = turn.id;
    }
    throw new Error("在会话记录里找不到这条消息，请刷新后重试");
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await appServer.call<ModelListResponse>("model/list", {});
    return (res.data ?? [])
      .filter((m) => !m.hidden)
      .map((m) => {
        const fast = m.serviceTiers?.find((tier) => tier.id === "priority");
        return {
          id: m.model,
          label: m.displayName || m.model,
          ...(m.description ? { description: m.description } : {}),
          ...(m.supportedReasoningEfforts?.length
            ? { efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort) }
            : {}),
          ...(m.defaultReasoningEffort ? { defaultEffort: m.defaultReasoningEffort } : {}),
          ...(fast ? { fastMode: { description: fast.description } } : {}),
          ...(m.isDefault ? { isDefault: true } : {}),
        };
      });
  }

  catalog(): Promise<ModelInfo[]> {
    return this.listModels();
  }

  /** config.toml 里的默认值（config/read），不需要为此建 thread。 */
  async defaults(): Promise<RuntimeInfo> {
    const c = config().agents.codex;
    try {
      const res = await appServer.call<{
        config?: { model?: string | null; model_reasoning_effort?: string | null };
      }>("config/read", {});
      const fromToml = res.config ?? {};
      const model = c.defaultModel || fromToml.model || undefined;
      const effort = c.defaultEffort || fromToml.model_reasoning_effort || undefined;
      return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
    } catch (err) {
      console.error("[codex] 读取默认配置失败:", err);
      return {};
    }
  }

  async statusLines(): Promise<string[]> {
    const quota = config().web.quotaEnabled ? describeRateLimits(await readRateLimits()) : [];
    return [`默认沙箱：${config().agents.codex.sandbox}`, ...(quota.length > 0 ? ["", ...quota] : [])];
  }

  async quota(): Promise<QuotaInfo | null> {
    const [limits, account] = await Promise.all([readRateLimits(), readAccountKey()]);
    return toQuota(limits, account);
  }

  /**
   * 后台整理记忆：临时 thread（ephemeral，不落记录、不进会话列表），工具、技能、MCP、联网全关，
   * 只读沙箱，思考程度 low，用 outputSchema 拿 JSON。
   */
  async complete(req: CompleteRequest): Promise<unknown> {
    const text = await this.reply({
      ...req, signal: AbortSignal.timeout(req.timeoutMs ?? 120_000),
    }, req.schema);
    return JSON.parse(text);
  }

  async reply(req: EngineReplyRequest, schema?: Record<string, unknown>): Promise<string> {
    req.signal.throwIfAborted();
    const tools = req.codexTools;
    const cwd = os.tmpdir();
    const overrides: Record<string, unknown> = await botChatConfig(cwd);
    if (tools?.webSearch) overrides.web_search = "live";
    const extra = tools?.extra ?? [];
    for (const id of extra) Object.assign(overrides, nativeOptions[id].flags);
    overrides["features.multi_agent_v2"] = false;
    overrides["agents.max_depth"] = 0;
    let permissions: string | undefined;
    if (tools && (tools.terminal || tools.edit || extra.length)) {
      if ((tools.terminal || tools.edit || extra.includes("view_image")) && !tools.directory) throw new WebBotError(400, "请先设置 Codex 工作目录。");
      permissions = "loft-bot-" + randomUUID();
      const helper = appServer.linuxSandboxHelper();
      const filesystem: Record<string,string> = { ":minimal": "read" };
      if (helper) filesystem[helper] = "read";
      if (tools.directory) filesystem[tools.directory] = tools.edit ? "write" : "read";
      if (tools.skillRoot) filesystem[tools.skillRoot] = "read";
      overrides["permissions." + permissions] = { filesystem, network: { enabled: false } };
      const windowsRoot = process.env.SystemRoot || "C:\\Windows";
      const env = process.platform === "win32" ? { SystemRoot: windowsRoot, PATH: path.join(windowsRoot, "System32") } : { PATH: "/usr/bin:/bin" };
      Object.assign(overrides, {
        "features.shell_tool": tools.terminal, "features.unified_exec": tools.terminal,
        include_apply_patch_tool: tools.edit, "features.shell_snapshot": false, "features.shell_snapshot_v2": false,
        allow_login_shell: false,
        shell_environment_policy: { inherit: "none", set: env },
      });
    }
    req.signal.throwIfAborted();
    tools?.checkAccess();
    // Start from neutral config roots. Only the tool turn enters the authorized directory.
    const res = await appServer.call<{ thread: Thread; model: string; activePermissionProfile?: { id: string } }>("thread/start", {
      cwd, ephemeral: true, ...(req.model ? { model: req.model } : {}),
      approvalPolicy: "never", ...(permissions ? { permissions, runtimeWorkspaceRoots: tools?.directory ? [tools.directory] : [] } : { sandbox: "read-only" }),
      baseInstructions: req.system, config: overrides,
    });
    const threadId = res.thread.id;
    if (permissions && res.activePermissionProfile?.id !== permissions) {
      void appServer.call("thread/unsubscribe", { threadId }).catch(() => {});
      throw new WebBotError(503, "当前 Codex 没有应用指定目录的权限配置，请升级 Codex 后再使用本机工具。");
    }
    let text = "";
    let turnId: string | undefined;
    let total: Parameters<typeof codexTokenUsage>[0] | undefined;
    let unsubscribe = () => {};
    let onExit = () => {};
    let cancelRequested = false;
    const cancel = () => {
      cancelRequested = true;
      if (turnId) void appServer.call("turn/interrupt", { threadId, turnId }).catch(() => {});
    };
    let onAbort = () => {};
    let checkGrants = () => {};
    const done = new Promise<void>((resolve, reject) => {
      onAbort = () => {
        cancel();
        reject(req.signal.reason);
      };
      checkGrants = () => {
        if (!tools || cancelRequested) return;
        try { tools.checkAccess(); } catch (err) { cancel(); reject(err); }
      };
      onExit = appServer.onExit(reason => reject(new Error(reason)));
      unsubscribe = appServer.onNotification((method, params) => {
        const p = params as { threadId?: string; item?: { type?: string; id?: string; text?: string; phase?: string | null; tool?: string; server?: string;
          status?: string; exitCode?: number; query?: string; savedPath?: string; changes?: unknown[]; failure?: unknown };
          tokenUsage?: { total?: typeof total }; turn?: { status?: string; error?: { message?: string } } };
        if (p.threadId !== threadId) return;
        if (method === "item/started") checkGrants();
        const item = p.item;
        if (tools?.onTool && !cancelRequested && item?.id && item.type && ["item/started","item/completed"].includes(method)) {
          const names: Record<string,string> = { webSearch: "web_search", commandExecution: "exec_command", fileChange: "apply_patch",
            imageView: "view_image", imageGeneration: "image_generation", collabAgentToolCall: item.tool || "multi_agent",
            mcpToolCall: [item.server, item.tool].filter(Boolean).join(" / "), dynamicToolCall: item.tool || "dynamic_tool" };
          if (Object.hasOwn(names, item.type)) try {
            tools.checkAccess();
            const completed = method === "item/completed";
            let image: Buffer | undefined;
            let detail = item.query || (item.exitCode != null ? "退出码 " + item.exitCode : item.changes ? item.changes.length + " 处文件变更" : "");
            if (completed && item.type === "imageGeneration" && extra.includes("image_generation") && item.savedPath) {
              try {
                const home = config().agents.codex.home || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
                const root = fs.realpathSync(path.join(home, "generated_images"));
                const file = fs.realpathSync(item.savedPath);
                if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile() || fs.statSync(file).size > 16 * 1024 * 1024)
                  throw new Error();
                image = fs.readFileSync(file);
              } catch { detail = "无法读取本次生成的图片。"; }
            }
            tools.onTool({ id: threadId + "/" + item.id, name: names[item.type]!, completed,
              failed: !!item.failure || ["failed","declined","cancelled"].includes(item.status || "") || !!item.exitCode,
              detail, image });
          } catch (err) { cancel(); reject(err); }
        }
        if (method === "thread/tokenUsage/updated" && p.tokenUsage?.total) total = p.tokenUsage.total;
        if (method === "item/completed" && p.item?.type === "agentMessage" && p.item.phase !== "commentary") text = p.item.text ?? text;
        if (method === "turn/completed") {
          if (p.turn?.status === "completed") resolve();
          else reject(new Error(p.turn?.error?.message ?? "后台调用已中断"));
        }
      });
    });
    done.catch(() => {});
    // A long-running command may emit no further events after a grant is revoked by another process.
    const grantTimer = tools ? setInterval(checkGrants, 2000).unref() : undefined;
    req.signal.addEventListener("abort", onAbort, { once: true });
    try {
      req.signal.throwIfAborted();
      tools?.beforeTurn();
      const started = await appServer.call<{ turn: { id: string } }>("turn/start", {
        threadId,
        ...(permissions ? { permissions, cwd: tools!.directory } : {}),
        input: [{ type: "text", text: req.prompt, text_elements: [] },
          ...(req.images ?? (req.image ? [req.image] : [])).map(img => ({ type: "image", url: `data:${img.mimeType};base64,${img.data}` }))],
        effort: "low",
        ...(schema ? { outputSchema: schema } : {}),
      });
      turnId = started.turn.id;
      if (cancelRequested || req.signal.aborted) cancel();
      await done;
      return text;
    } finally {
      clearInterval(grantTimer);
      unsubscribe();
      onExit();
      req.signal.removeEventListener("abort", onAbort);
      void appServer.call("thread/unsubscribe", { threadId }).catch(() => {});
      if (total) req.onUsage?.(codexTokenUsage(total), res.model);
    }
  }

  diagnose(err: unknown) {
    return diagnose(err);
  }
}
