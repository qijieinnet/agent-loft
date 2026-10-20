// Codex 驱动：官方 `codex app-server`（Codex 桌面版和 IDE 插件走的那条路）。
//
// 不用 @openai/codex-sdk：它是 `codex exec --json` 的薄封装，没有任何审批回调。
import { appServer } from "./app-server.js";
import { describeRateLimits, readRateLimits, toQuota } from "./account.js";
import { diagnose } from "./errors.js";
import { CodexSession, summarize } from "./session.js";
import { config, onConfigChange } from "../../core/config.js";
import type {
  AgentDriver,
  AgentEvents,
  AgentSession,
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
  const preview = thread.preview?.replace(/\s+/g, " ").trim();
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

  async readHistory(id: string): Promise<HistoryMessage[]> {
    const res = await appServer.call<{ thread: { turns?: { items?: HistoryItem[]; startedAt?: number | null }[] } }>(
      "thread/read",
      { threadId: id, includeTurns: true },
    );
    const out: HistoryMessage[] = [];
    for (const turn of res.thread.turns ?? []) {
      let assistant: HistoryMessage | null = null;
      const ts = turn.startedAt ? turn.startedAt * 1000 : undefined;
      for (const item of turn.items ?? []) {
        if (item.type === "userMessage") {
          const text = (item.content ?? [])
            .map((c) => (c.type === "text" ? (c.text ?? "") : c.type === "localImage" ? "📎 图片" : ""))
            .filter(Boolean)
            .join("\n");
          const cut = text.indexOf("[用户");
          out.push({ role: "user", text: cut > 0 ? text.slice(0, cut).trim() || text : text, ...(ts ? { ts } : {}) });
          continue;
        }
        assistant ??= { role: "assistant", text: "", steps: [] };
        if (item.type === "agentMessage" && item.text?.trim()) {
          if (item.phase === "commentary") assistant.steps!.push(`💬 ${summarize(item.text)}`);
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
      if (assistant && (assistant.text || assistant.steps?.length)) out.push(assistant);
    }
    return out;
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await appServer.call<ModelListResponse>("model/list", {});
    return (res.data ?? [])
      .filter((m) => !m.hidden)
      .map((m) => ({
        id: m.model,
        label: m.displayName || m.model,
        ...(m.description ? { description: m.description } : {}),
        ...(m.supportedReasoningEfforts?.length
          ? { efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort) }
          : {}),
        ...(m.isDefault ? { isDefault: true } : {}),
      }));
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
    const quota = describeRateLimits(await readRateLimits());
    return [`沙箱：${config().agents.codex.sandbox}`, ...(quota.length > 0 ? ["", ...quota] : [])];
  }

  async quota(): Promise<QuotaInfo | null> {
    return toQuota(await readRateLimits());
  }

  diagnose(err: unknown) {
    return diagnose(err);
  }
}
