// Claude Code 驱动：官方 Claude Agent SDK。
//
// 会话列表 / 历史全部走 SDK 自带的 listSessions / getSessionInfo / getSessionMessages，
// 不再自己去扒 ~/.claude/projects 下的 jsonl —— 那是 CLI 的内部约定，SDK 才是公开接口。
import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
} from "@anthropic-ai/claude-agent-sdk";
import { config } from "../../core/config.js";
import type {
  AgentDriver,
  AgentEvents,
  AgentSession,
  HistoryMessage,
  InteractionHost,
  ModelInfo,
  RuntimeInfo,
  SessionOptions,
  SessionSummary,
} from "../../core/types.js";
import { diagnose } from "./errors.js";
import { ClaudeSession, describeToolUse, summarize } from "./session.js";

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

/** 用户消息里我们自己拼进去的附件说明，历史里只留一行简述 */
function cleanUserText(text: string): string {
  const cut = [text.indexOf("[用户通过飞书发来了以下附件"), text.indexOf("[用户发来了以下附件")]
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  if (cut === undefined) return text;
  const files = (text.slice(cut).match(/^- /gm) ?? []).length;
  return `${text.slice(0, cut).trim()}${files ? `\n\n📎 ${files} 个附件` : ""}`.trim();
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
      if (msg.type === "user") {
        const texts = blocks.filter((b) => b.type === "text" && b.text).map((b) => b.text!);
        if (texts.length === 0) continue; // 纯 tool_result
        const text = cleanUserText(texts.join("\n"));
        if (!text || text.startsWith("<command-") || text.startsWith("<local-command")) continue;
        flush();
        out.push({ role: "user", text });
      } else if (msg.type === "assistant") {
        assistant ??= { role: "assistant", text: "", steps: [] };
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

  async listModels(session: AgentSession): Promise<ModelInfo[]> {
    return (session as ClaudeSession).listModels();
  }

  async defaults(): Promise<RuntimeInfo> {
    const c = config().agents.claude;
    return {
      ...(c.defaultModel ? { model: c.defaultModel } : {}),
      ...(c.defaultEffort ? { effort: c.defaultEffort } : {}),
    };
  }

  async statusLines(): Promise<string[]> {
    return [];
  }

  diagnose(err: unknown) {
    return diagnose(err);
  }
}
