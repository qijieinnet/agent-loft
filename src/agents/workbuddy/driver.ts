// WorkBuddy 驱动：腾讯 CodeBuddy Code 的官方 Agent SDK（@tencent-ai/agent-sdk，自带 CLI）。
//
// 会话怎么跑见 session.ts；会话列表 / 历史是读 CLI 的记录文件（history.ts），SDK 没提供这些接口。
// 分叉、回退暂不支持：CLI 的记录格式没有公开，自己拼一条新记录风险太大。
import os from "node:os";
import type { AgentCommand } from "../../core/command-catalog.js";
import { config } from "../../core/config.js";
import type {
  AgentDriver,
  AgentEvents,
  AgentSession,
  CompleteRequest,
  HistoryMessage,
  InteractionHost,
  ModelInfo,
  RuntimeInfo,
  SessionOptions,
  SessionSummary,
} from "../../core/types.js";
import { cachedProbe } from "../claude/probe.js";
import { diagnose } from "./errors.js";
import { listSessionFiles, readHistoryFile, SESSION_ID, sessionFile, sessionTitleOf } from "./history.js";
import { baseOptions, loadSdk, modelOf, withProbe } from "./sdk.js";
import { WorkBuddySession } from "./session.js";

const readCatalog = cachedProbe(10 * 60_000, "WorkBuddy 模型列表", () =>
  withProbe(async (q) => (await q.supportedModels()).map(modelOf).filter((m): m is ModelInfo => !!m)),
);

/** CLI 报的命令带着前导斜杠；这些是终端界面里才有意义的，网页 / 飞书里用不了 */
const TUI_ONLY = new Set(["add-dir", "agents", "background", "bg", "bashes", "config", "doctor", "exit", "export", "help", "ide", "login", "logout", "memory", "mcp", "permissions", "plugin", "plugins", "quit", "resume", "status", "statusline", "terminal-setup", "theme", "upgrade", "vim"]);
const commandReaders = new Map<string, () => Promise<AgentCommand[]>>();
function readCommands(cwd: string): Promise<AgentCommand[]> {
  let reader = commandReaders.get(cwd);
  if (!reader) {
    if (commandReaders.size >= 50) commandReaders.delete(commandReaders.keys().next().value!);
    reader = cachedProbe(
      5 * 60_000,
      "WorkBuddy 命令列表",
      () =>
        withProbe(
          async (q) =>
            (await q.supportedCommands())
              .map((c) => ({ ...c, name: c.name.replace(/^\//, "") }))
              .filter((c) => c.name && !TUI_ONLY.has(c.name))
              .map((c) => ({ name: c.name, description: c.description || "", ...(c.argumentHint ? { args: c.argumentHint } : {}) })),
          cwd,
        ),
      [] as AgentCommand[],
    );
    commandReaders.set(cwd, reader);
  }
  return reader();
}

export class WorkBuddyDriver implements AgentDriver {
  readonly id = "workbuddy";
  readonly label = "WorkBuddy";
  readonly capabilities = { effort: false, fork: false, cost: false, streaming: true };

  async start(): Promise<void> {
    // 先把 SDK 加载好，第一条消息不用等 import
    await loadSdk();
  }
  async stop(): Promise<void> {}

  createSession(opts: SessionOptions, events: AgentEvents, host: InteractionHost): AgentSession {
    if (opts.expert) throw new Error("WorkBuddy 暂不支持自定义专家，请用内置的 WorkBuddy");
    return new WorkBuddySession(opts, events, host);
  }

  async listSessions(cwd: string | undefined, limit = 10): Promise<SessionSummary[]> {
    try {
      return listSessionFiles(cwd, limit);
    } catch (err) {
      console.error("[workbuddy] 读取会话列表失败:", err);
      return [];
    }
  }

  async sessionExists(id: string): Promise<boolean> {
    return SESSION_ID.test(id) && !!sessionFile(id);
  }

  async sessionTitle(id: string): Promise<string | undefined> {
    return sessionTitleOf(id);
  }

  async readHistory(id: string): Promise<HistoryMessage[]> {
    return readHistoryFile(id);
  }

  async listModels(session: AgentSession): Promise<ModelInfo[]> {
    const models = await (session as WorkBuddySession).listModels().catch(() => [] as ModelInfo[]);
    return models.length ? models : readCatalog();
  }

  catalog(): Promise<ModelInfo[]> {
    return readCatalog();
  }

  commands(cwd?: string): Promise<AgentCommand[]> {
    return readCommands(cwd ?? os.homedir());
  }

  async defaults(): Promise<RuntimeInfo> {
    const c = config().agents.workbuddy;
    return c.defaultModel ? { model: c.defaultModel } : {};
  }

  async statusLines(): Promise<string[]> {
    return [];
  }

  /** 后台整理记忆：不读本地配置、不给工具、不落记录，按 schema 出 JSON */
  async complete(req: CompleteRequest): Promise<unknown> {
    const { query } = await loadSdk();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), req.timeoutMs ?? 120_000);
    try {
      const q = query({
        prompt: req.prompt,
        options: {
          cwd: os.tmpdir(),
          ...baseOptions(),
          ...(req.model ? { model: req.model } : {}),
          systemPrompt: req.system,
          tools: [],
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: {},
          persistSession: false,
          maxTurns: 3,
          outputFormat: { type: "json_schema", schema: req.schema },
          abortController: abort,
          canUseTool: async () => ({ behavior: "deny", message: "后台整理不允许用工具" }),
        },
      });
      for await (const m of q) {
        if (m.type !== "result") continue;
        if (m.subtype !== "success" || m.is_error) throw new Error(`后台调用失败：${m.subtype}`);
        if (m.structured_output !== undefined) return m.structured_output;
        // 没走结构化输出的：从正文里抠 JSON
        const text = m.result.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
        return JSON.parse(text);
      }
      throw new Error("后台调用没有结果");
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  }

  diagnose(err: unknown) {
    return diagnose(err);
  }
}
