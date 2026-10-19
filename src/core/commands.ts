// 斜杠命令解析（各渠道通用）。
//
// 只有「整条消息就是一个命令」时才当命令处理，参数对不上就退化成普通聊天 ——
// 避免把正常对话误当指令执行。
import { BUILTIN_COMMANDS, usageOf } from "./command-catalog.js";
import type { ApprovalDecision } from "./types.js";

export type ParsedCommand =
  | { kind: "new"; model?: string }
  | { kind: "fork" }
  | { kind: "resume"; sessionId: string }
  | { kind: "sessions"; all: boolean }
  | { kind: "model"; model?: string }
  | { kind: "effort"; effort?: string }
  | { kind: "agent"; agent?: string }
  | { kind: "stop" }
  | { kind: "cd"; dir: string }
  | { kind: "status" }
  | { kind: "pwd" }
  | { kind: "autoedit"; on?: boolean }
  | { kind: "help" }
  /** 只发了一个「/」：列出可用命令 */
  | { kind: "commands" }
  | { kind: "approve"; requestId: string; decision: ApprovalDecision }
  | { kind: "chat"; text: string };

const DECISIONS: ApprovalDecision[] = ["allow-once", "allow-always", "deny"];

export function parseCommand(raw: string): ParsedCommand {
  const text = raw.trim();
  // 全角斜杠也认：中文输入法下很容易打成「／」
  if (text === "/" || text === "／") return { kind: "commands" };
  if (!text.startsWith("/") || text.includes("\n")) return { kind: "chat", text };

  const [head = "", ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (head.toLowerCase()) {
    case "new":
      return { kind: "new", ...(arg ? { model: arg } : {}) };
    case "fork":
      return { kind: "fork" };
    case "resume":
      return arg ? { kind: "resume", sessionId: arg } : { kind: "chat", text };
    case "sessions":
      return { kind: "sessions", all: arg === "all" || arg === "-a" };
    case "model":
      return { kind: "model", ...(arg ? { model: arg } : {}) };
    case "effort":
      return { kind: "effort", ...(arg ? { effort: arg } : {}) };
    case "agent":
      return { kind: "agent", ...(arg ? { agent: arg.toLowerCase() } : {}) };
    // 快捷切换
    case "claude":
    case "codex":
      return arg ? { kind: "chat", text } : { kind: "agent", agent: head.toLowerCase() };
    case "stop":
      return { kind: "stop" };
    case "cd":
      return arg ? { kind: "cd", dir: arg } : { kind: "chat", text };
    case "status":
      return { kind: "status" };
    case "pwd":
      return { kind: "pwd" };
    case "autoedit": {
      const v = arg.toLowerCase();
      if (!v) return { kind: "autoedit" };
      if (["on", "开", "1", "true"].includes(v)) return { kind: "autoedit", on: true };
      if (["off", "关", "0", "false"].includes(v)) return { kind: "autoedit", on: false };
      return { kind: "chat", text };
    }
    case "help":
      return { kind: "help" };
    case "approve": {
      const [requestId, decision] = rest;
      if (!requestId || !decision) return { kind: "chat", text };
      const normalized = decision.toLowerCase() as ApprovalDecision;
      if (!DECISIONS.includes(normalized)) return { kind: "chat", text };
      return { kind: "approve", requestId, decision: normalized };
    }
    default:
      // 不认识的命令原样交给 agent：Claude / Codex 自己也有斜杠命令
      return { kind: "chat", text };
  }
}

export function helpText(agents: string[]): string {
  const multi = agents.length > 1;
  return [
    "直接说话即可，会自动接着上次的会话。闲置太久会自动开新会话。",
    "",
    "Agent 给选项时会发一张提问卡，点按钮作答；都不合适就直接发消息，那条消息会被当成你的回答。",
    "",
    "**命令**（需整条消息只有命令；只发一个 `/` 可以列出全部命令，包括 agent 自己的）",
    "",
    ...BUILTIN_COMMANDS.filter((c) => !c.multiAgentOnly || multi)
      .filter((c) => !["claude", "codex"].includes(c.name))
      .map((c) =>
        c.name === "agent"
          ? `\`${usageOf(c)}\` ${c.description}（可选：${agents.join("、")}），也可以直接发 ${agents.map((a) => `\`/${a}\``).join(" ")}`
          : `\`${usageOf(c)}\` ${c.description}`,
      ),
  ].join("\n");
}
