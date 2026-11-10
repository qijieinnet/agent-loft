// 斜杠命令解析（各渠道通用）。
//
// 只有「整条消息就是一个命令」时才当命令处理，参数对不上就退化成普通聊天 ——
// 避免把正常对话误当指令执行。
import { BUILTIN_COMMANDS, usageOf } from "./command-catalog.js";
import type { PermissionLevel } from "./permission.js";
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
  /** 计划模式；on 不给就是切换 */
  | { kind: "plan"; on?: boolean }
  /** default：恢复默认；不给就是看当前级别 */
  | { kind: "permission"; level?: PermissionLevel | "default" }
  | { kind: "help" }
  /** 只发了一个「/」：列出可用命令 */
  | { kind: "commands" }
  | { kind: "approve"; requestId: string; decision: ApprovalDecision }
  | { kind: "chat"; text: string };

const PERMISSION_ARGS: Record<string, PermissionLevel | "default"> = {
  ask: "ask", 询问: "ask", 逐次询问: "ask",
  edit: "edit", 自动改文件: "edit",
  auto: "auto", 自动判断: "auto",
  full: "full", 完全允许: "full",
  default: "default", 默认: "default",
};

const DECISIONS: ApprovalDecision[] = ["allow-once", "allow-always", "allow-session", "deny"];

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
    // 换专家（会开新会话）。/agent 是以前的叫法，照样认
    case "expert":
    case "agent":
      return { kind: "agent", ...(arg ? { agent: arg } : {}) };
    // 快捷切换到内置专家
    case "claude":
    case "codex":
    case "workbuddy":
    case "pi":
    case "dsh":
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
    // 不叫 /plan：那是很常见的自定义命令名，内置了会把用户已有的挤掉
    case "planmode": {
      const v = arg.toLowerCase();
      if (!v) return { kind: "plan" };
      if (["on", "开", "1", "true"].includes(v)) return { kind: "plan", on: true };
      if (["off", "关", "0", "false"].includes(v)) return { kind: "plan", on: false };
      return { kind: "chat", text };
    }
    case "permission": {
      if (!arg) return { kind: "permission" };
      const level = Object.hasOwn(PERMISSION_ARGS, arg.toLowerCase()) ? PERMISSION_ARGS[arg.toLowerCase()] : undefined;
      return level ? { kind: "permission", level } : { kind: "chat", text };
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

export function helpText(agents: string[], channel?: string): string {
  const multi = agents.length > 1;
  return [
    "直接说话即可，会自动接着上次的会话。闲置太久会自动开新会话。",
    "",
    channel === "weixin"
      ? "Agent 要授权或提问时会发一条消息，回复里面的数字作答；提问的选项都不合适就直接发文字。"
      : "Agent 给选项时会发一张提问卡，点按钮作答；都不合适就直接发消息，那条消息会被当成你的回答。",
    "",
    "**命令**（需整条消息只有命令；只发一个 `/` 可以列出命令；agent 自己的命令默认不在列表里，可以在设置 → 命令里勾选，没勾的照样可以直接发）",
    "",
    ...BUILTIN_COMMANDS.filter((c) => !c.multiAgentOnly || multi)
      .filter((c) => !c.feishuOnly || channel === "feishu")
      .filter((c) => !c.chatOnly || channel === "feishu" || channel === "weixin")
      .filter((c) => !["claude", "codex", "workbuddy", "pi", "dsh"].includes(c.name))
      .map((c) =>
        c.name === "expert"
          ? `\`${usageOf(c)}\` ${c.description}${multi ? `，也可以直接发 ${agents.map((a) => `\`/${a}\``).join(" ")}` : ""}`
          : `\`${usageOf(c)}\` ${c.description}`,
      ),
  ].join("\n");
}
