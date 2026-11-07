// pi 驱动：官方 TypeScript SDK（@earendil-works/pi-coding-agent），进程内运行。
//
// 会话怎么跑见 session.ts；会话列表 / 历史自己读 data/pi/sessions 下的 JSONL（history.ts）。
// 记录是树结构（id / parentId），分叉、回退都用 SDK 的 SessionManager 另存一条新会话，原会话不动。
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
import { NO_PROVIDER } from "./constants.js";
import { diagnose } from "./errors.js";
import { listSessionFiles, readHistoryFile, rewindParent, SESSION_ID, sessionFile, sessionTitleOf } from "./history.js";
import { availableModels, loadSdk, modelKey, modelRuntime, pickModel, SESSIONS_DIR } from "./sdk.js";
import { PiSession } from "./session.js";

const readCatalog = cachedProbe(60_000, "pi 模型列表", () => availableModels(), [] as ModelInfo[]);

const COMMANDS: AgentCommand[] = [{ name: "compact", args: "[说明]", description: "压缩上下文（可以附一句要保留什么）", builtin: true }];

export class PiDriver implements AgentDriver {
  readonly id = "pi";
  readonly label = "pi";
  readonly capabilities = { effort: true, fork: true, cost: true, streaming: true };

  async start(): Promise<void> {
    // 先把 SDK 和模型目录加载好，第一条消息不用等
    await modelRuntime();
  }
  async stop(): Promise<void> {}

  createSession(opts: SessionOptions, events: AgentEvents, host: InteractionHost): AgentSession {
    return new PiSession(opts, events, host);
  }

  async listSessions(cwd: string | undefined, limit = 10): Promise<SessionSummary[]> {
    try {
      return listSessionFiles(cwd, limit);
    } catch (err) {
      console.error("[pi] 读取会话列表失败:", err);
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

  async forkAt(id: string, cwd: string, anchor?: string): Promise<string> {
    const file = sessionFile(id);
    if (!file) throw new Error("找不到这条 pi 会话的记录");
    const { pi } = await loadSdk();
    if (!anchor) return pi.SessionManager.forkFrom(file, cwd, SESSIONS_DIR).getSessionId();
    const sm = pi.SessionManager.open(file, SESSIONS_DIR, cwd);
    if (!sm.getEntry(anchor)) throw new Error("找不到要分叉的那条回复");
    sm.createBranchedSession(anchor);
    return sm.getSessionId();
  }

  async rewindTo(id: string, cwd: string, anchor: string): Promise<string | undefined> {
    const parent = rewindParent(id, anchor);
    if (parent === undefined) throw new Error("找不到要回退到的那条消息");
    if (parent === null) return undefined;
    const { pi } = await loadSdk();
    const sm = pi.SessionManager.open(sessionFile(id)!, SESSIONS_DIR, cwd);
    sm.createBranchedSession(parent);
    return sm.getSessionId();
  }

  async listModels(): Promise<ModelInfo[]> {
    return availableModels().catch(() => readCatalog());
  }

  catalog(): Promise<ModelInfo[]> {
    return readCatalog();
  }

  async commands(): Promise<AgentCommand[]> {
    return COMMANDS;
  }

  async defaults(): Promise<RuntimeInfo> {
    const c = config().agents.pi;
    return { ...(c.defaultModel ? { model: c.defaultModel } : {}), ...(c.defaultEffort ? { effort: c.defaultEffort } : {}) };
  }

  async statusLines(): Promise<string[]> {
    return [];
  }

  /** 后台整理记忆：直接调模型，不建会话、不给工具、不落记录 */
  async complete(req: CompleteRequest): Promise<unknown> {
    const rt = await modelRuntime();
    const model = await pickModel(req.model || config().agents.pi.defaultModel || undefined);
    if (!model) throw new Error(NO_PROVIDER);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), req.timeoutMs ?? 120_000);
    try {
      const prompt = `${req.prompt}\n\n只输出一个 JSON 对象（不要代码块、不要解释），符合这个 JSON Schema：\n${JSON.stringify(req.schema)}`;
      const msg = await rt.completeSimple(
        model,
        { systemPrompt: req.system, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
        { signal: abort.signal, ...(model.reasoning ? { reasoning: "minimal" as const } : {}) },
      );
      if (msg.stopReason === "error" || msg.stopReason === "aborted") throw new Error(`后台调用失败（${modelKey(model)}）：${msg.errorMessage ?? msg.stopReason}`);
      const text = msg.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      return parseJson(text);
    } finally {
      clearTimeout(timer);
    }
  }

  diagnose(err: unknown) {
    return diagnose(err);
  }
}

/** 模型偶尔会套一层代码块、前后加几句话：抠出第一个完整的 JSON 对象 */
export function parseJson(text: string): unknown {
  const bare = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try {
    return JSON.parse(bare);
  } catch {
    const start = bare.indexOf("{");
    const end = bare.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(bare.slice(start, end + 1));
    throw new Error(`后台调用没有返回 JSON：${bare.slice(0, 120)}`);
  }
}
