// dsh 驱动：DeepSeek Harness（@deepseek-ai/dsh）的 ACP profile。
//
// 会话怎么跑见 session.ts；会话列表 / 历史是读 dsh 的记录文件（history.ts），ACP 的 session/list 不带标题和时间。
// 分叉、回退不支持：ACP 没有，dsh 的记录格式也没公开，自己拼一条新记录风险太大。
// 只做内置专家：原装提示词和工具，后面追加 agent-loft 的回复格式、记忆、技能说明，挂上记忆 / 定时任务 / 技能 MCP。
import type { AgentDriver, AgentEvents, AgentSession, CompleteRequest, HistoryMessage, InteractionHost, ModelInfo, RuntimeInfo, SessionOptions, SessionSummary } from "../../core/types.js";
import { config } from "../../core/config.js";
import { cachedProbe } from "../claude/probe.js";
import type { ConfigOption } from "./acp.js";
import { diagnose } from "./errors.js";
import { listSessionFiles, readHistoryFile, SESSION_ID, sessionFile, sessionTitleOf } from "./history.js";
import { modelsOf, modelValueOf, sweepPatches, withProbe } from "./sdk.js";
import { DshSession } from "./session.js";

const readCatalog = cachedProbe(10 * 60_000, "dsh 模型列表", () => withProbe(async (_c, _s, opts) => modelsOf(opts)));

/** 能恢复的会话：最后用的服务商 ACP profile 认得（模型列表里有它） */
async function knownProviders(): Promise<Set<string> | undefined> {
  const models = await readCatalog().catch(() => [] as ModelInfo[]);
  if (!models.length) return undefined;
  return new Set(models.map((m) => m.id.slice(0, m.id.indexOf("/"))));
}

export class DshDriver implements AgentDriver {
  readonly id = "dsh";
  readonly label = "dsh";
  readonly capabilities = { effort: true, fork: false, cost: false, streaming: false };

  async start(): Promise<void> {
    sweepPatches();
  }
  async stop(): Promise<void> {}

  createSession(opts: SessionOptions, events: AgentEvents, host: InteractionHost): AgentSession {
    if (opts.expert) throw new Error("dsh 暂不支持自定义专家，请用内置的 dsh");
    return new DshSession(opts, events, host);
  }

  async listSessions(cwd: string | undefined, limit = 10): Promise<SessionSummary[]> {
    try {
      return listSessionFiles(cwd, limit, await knownProviders());
    } catch (err) {
      console.error("[dsh] 读取会话列表失败:", err);
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
    const models = await (session as DshSession).listModels().catch(() => [] as ModelInfo[]);
    return models.length ? models : readCatalog();
  }

  catalog(): Promise<ModelInfo[]> {
    return readCatalog();
  }

  async defaults(): Promise<RuntimeInfo> {
    const c = config().agents.dsh;
    if (c.defaultModel || c.defaultEffort) return { ...(c.defaultModel ? { model: c.defaultModel } : {}), ...(c.defaultEffort ? { effort: c.defaultEffort } : {}) };
    const def = (await readCatalog().catch(() => [] as ModelInfo[])).find((m) => m.isDefault);
    return def ? { model: def.id } : {};
  }

  async statusLines(): Promise<string[]> {
    return [];
  }

  /**
   * 后台整理记忆：临时进程、只读沙箱、拒绝一切授权，系统提示放在 dsh 原装提示后面，按 schema 出 JSON。
   * 用完会话记录一起删（见 withProbe）
   */
  async complete(req: CompleteRequest): Promise<unknown> {
    const append = [
      req.system,
      "这是一次后台调用：不要用任何工具，直接回答。",
      `只输出一个 JSON 对象（不要代码块、不要解释），符合这个 JSON Schema：\n${JSON.stringify(req.schema)}`,
    ].join("\n\n");
    const run = withProbe(
      async (conn, sessionId, opts) => {
        const set = (configId: string, value: string) => conn.request("session/set_config_option", { sessionId, configId, value }).catch(() => {});
        if (req.model) await set("model", modelValueOf(req.model));
        if (opts.some((o: ConfigOption) => o.id === "reasoning_effort")) await set("reasoning_effort", "off");
        const chunks: string[] = [];
        conn.onUpdate = (sid, u) => {
          const c = u.content as { type?: string; text?: string } | undefined;
          if (sid === sessionId && u.sessionUpdate === "agent_message_chunk" && c?.type === "text" && c.text) chunks.push(c.text);
        };
        conn.onPermission = async (r) => {
          const reject = r.options.find((o) => o.kind.startsWith("reject"));
          return reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" };
        };
        await conn.request("session/prompt", { sessionId, prompt: [{ type: "text", text: req.prompt }] });
        const text = chunks.join("\n").trim();
        const json = /\{[\s\S]*\}/.exec(text.replace(/^```(?:json)?\s*|\s*```$/g, ""))?.[0];
        if (!json) throw new Error("dsh 没有返回 JSON");
        return JSON.parse(json) as unknown;
      },
      { append },
    );
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("dsh 后台调用超时")), req.timeoutMs ?? 120_000);
    });
    try {
      return await Promise.race([run, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  diagnose(err: unknown) {
    return diagnose(err);
  }
}
