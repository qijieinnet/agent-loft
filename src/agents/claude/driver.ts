// Claude Code 驱动：官方 Claude Agent SDK。
//
// 会话列表 / 历史全部走 SDK 自带的 listSessions / getSessionInfo / getSessionMessages，
// 不再自己去扒 ~/.claude/projects 下的 jsonl —— 那是 CLI 的内部约定，SDK 才是公开接口。
import {
  forkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
} from "@anthropic-ai/claude-agent-sdk";
import os from "node:os";
import type { AgentCommand } from "../../core/command-catalog.js";
import { splitAttachmentNote } from "../../core/uploads.js";
import { config } from "../../core/config.js";
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
import { describeUsage, readUsage, toQuota } from "./account.js";
import { cachedProbe, withProbe } from "./probe.js";
import { diagnose } from "./errors.js";
import { ClaudeSession, describeToolUse, summarize, toModelInfo } from "./session.js";

/** 模型列表几乎不变，缓存 10 分钟；读失败抛给设置页，让它退回手填 */
const readCatalog = cachedProbe(10 * 60_000, "模型列表", () => withProbe(async (q) => toModelInfo(await q.supportedModels())));

/**
 * 斜杠命令（skills、/compact 这些）。项目目录里可能有自己的命令，所以按 cwd 分开缓存；
 * 装了新 skill 最多 5 分钟后出现。读不到就只显示 agent-loft 自己的命令。
 */
const commandReaders = new Map<string, () => Promise<AgentCommand[]>>();
function readCommands(cwd: string): Promise<AgentCommand[]> {
  let reader = commandReaders.get(cwd);
  if (!reader) {
    // 目录数量一般很少；万一很多，丢掉最早的，别无限涨
    if (commandReaders.size >= 50) commandReaders.delete(commandReaders.keys().next().value!);
    reader = cachedProbe(
      5 * 60_000,
      "Claude 命令列表",
      () =>
        withProbe(
          async (q) =>
            (await q.supportedCommands()).map((c) => ({
              name: c.name,
              description: c.description,
              ...(c.argumentHint ? { args: c.argumentHint } : {}),
            })),
          cwd,
        ),
      [] as AgentCommand[],
    );
    commandReaders.set(cwd, reader);
  }
  return reader();
}

/** sessionId 会被拼进路径，先验形，防 /resume ../../x 越界 */
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

function titleOf(info: { customTitle?: string; summary?: string; firstPrompt?: string }): string {
  const raw = (info.customTitle || info.summary || info.firstPrompt || "").replace(/\s+/g, " ").trim();
  if (!raw) return "(无标题)";
  return raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
}

type Block = { type?: string; text?: string; name?: string; input?: unknown; thinking?: string };

function blocksOf(message: unknown): Block[] {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}


export class ClaudeDriver implements AgentDriver {
  readonly id = "claude";
  readonly label = "Claude Code";
  readonly capabilities = { effort: true, fork: true, cost: true, streaming: true };

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  createSession(opts: SessionOptions, events: AgentEvents, host: InteractionHost): AgentSession {
    return new ClaudeSession(opts, events, host);
  }

  async listSessions(cwd: string | undefined, limit = 10): Promise<SessionSummary[]> {
    try {
      const sessions = await listSessions({ ...(cwd ? { dir: cwd } : {}), limit });
      return sessions.map((s) => ({
        id: s.sessionId,
        title: titleOf(s),
        ...(s.cwd ? { cwd: s.cwd } : {}),
        updatedAt: s.lastModified,
      }));
    } catch (err) {
      console.error("[claude] 读取会话列表失败:", err);
      return [];
    }
  }

  async sessionExists(id: string, cwd: string): Promise<boolean> {
    if (!SESSION_ID.test(id)) return false;
    try {
      return !!(await getSessionInfo(id, { dir: cwd }));
    } catch {
      return false;
    }
  }

  /**
   * 把会话记录整理成「一问一答」：用户一条，助手把这一轮所有文本拼成一条，
   * 中间的工具调用作为过程摘要挂在助手那条上。工具结果（type=user 的 tool_result）
   * 和子 agent 的消息不算对话。
   */
  async readHistory(id: string, cwd: string): Promise<HistoryMessage[]> {
    if (!SESSION_ID.test(id)) return [];
    const raw = await getSessionMessages(id, { dir: cwd });
    const out: HistoryMessage[] = [];
    let assistant: HistoryMessage | null = null;
    const flush = () => {
      if (assistant && (assistant.text.trim() || assistant.steps?.length)) out.push(assistant);
      assistant = null;
    };
    for (const msg of raw) {
      if (msg.parent_tool_use_id) continue;
      const blocks = blocksOf(msg.message);
      // 运行时带着 timestamp（ISO 字符串），类型声明里没有
      const ts = Date.parse((msg as { timestamp?: string }).timestamp ?? "");
      if (msg.type === "user") {
        // Claude Code 自己塞进记录的「用户消息」不是人发的：后台命令跑完的 <task-notification> 等，
        // 记录里 origin.kind 不是 human。老记录可能没有 origin，再按正文开头兜底
        const origin = (msg as { origin?: { kind?: string } }).origin;
        // 它触发的那轮回复仍单独成一条（和实时看到的一样），不并进上一条回复
        if (origin?.kind && origin.kind !== "human") {
          flush();
          continue;
        }
        const texts = blocks.filter((b) => b.type === "text" && b.text).map((b) => b.text!);
        if (texts.length === 0) continue; // 纯 tool_result
        // 我们自己拼进去的附件清单：从正文里拆出来，单独作为附件给前端展示
        const { text, attachments } = splitAttachmentNote(texts.join("\n"));
        if (!text && attachments.length === 0) continue;
        if (text.startsWith("<command-") || text.startsWith("<local-command")) continue;
        if (text.startsWith("<task-notification>")) {
          flush();
          continue;
        }
        flush();
        out.push({
          role: "user",
          text,
          ...(attachments.length ? { attachments } : {}),
          ...(Number.isFinite(ts) ? { ts } : {}),
        });
      } else if (msg.type === "assistant") {
        assistant ??= { role: "assistant", text: "", steps: [] };
        // 这一轮最后一条助手消息：分叉到这里为止，时间也取它的
        assistant.anchor = msg.uuid;
        if (Number.isFinite(ts)) assistant.ts = ts;
        for (const b of blocks) {
          if (b.type === "text" && b.text?.trim()) {
            assistant.text += (assistant.text ? "\n\n" : "") + b.text;
          } else if (b.type === "tool_use" && b.name) {
            assistant.steps!.push(`🔧 ${describeToolUse(b.name, b.input)}`);
          } else if (b.type === "thinking" && b.thinking) {
            const t = summarize(b.thinking);
            if (t) assistant.steps!.push(`💭 ${t}`);
          }
        }
      }
    }
    flush();
    return out;
  }

  async forkAt(id: string, cwd: string, anchor?: string): Promise<string> {
    if (!SESSION_ID.test(id)) throw new Error("会话 id 不对");
    if (anchor) {
      // 先确认这条回复在记录里：SDK 遇到不认识的 id 不一定报错，可能整条复制
      const raw = await getSessionMessages(id, { dir: cwd });
      if (!raw.some((m) => m.uuid === anchor)) throw new Error("在会话记录里找不到这条回复");
    }
    const res = await forkSession(id, { dir: cwd, ...(anchor ? { upToMessageId: anchor } : {}) });
    return res.sessionId;
  }

  async listModels(session: AgentSession): Promise<ModelInfo[]> {
    return (session as ClaudeSession).listModels();
  }

  catalog(): Promise<ModelInfo[]> {
    return readCatalog();
  }

  commands(cwd?: string): Promise<AgentCommand[]> {
    return readCommands(cwd ?? os.homedir());
  }

  async defaults(): Promise<RuntimeInfo> {
    const c = config().agents.claude;
    return {
      ...(c.defaultModel ? { model: c.defaultModel } : {}),
      ...(c.defaultEffort ? { effort: c.defaultEffort } : {}),
    };
  }

  async statusLines(): Promise<string[]> {
    return describeUsage(await readUsage());
  }

  async quota(): Promise<QuotaInfo | null> {
    return toQuota(await readUsage());
  }

  diagnose(err: unknown) {
    return diagnose(err);
  }
}
