// 斜杠命令解析（各渠道通用）。
//
// 只有「整条消息就是一个命令」时才当命令处理，参数对不上就退化成普通聊天 ——
// 避免把正常对话误当指令执行。
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
  | { kind: "help" }
  | { kind: "approve"; requestId: string; decision: ApprovalDecision }
  | { kind: "chat"; text: string };

const DECISIONS: ApprovalDecision[] = ["allow-once", "allow-always", "deny"];

export function parseCommand(raw: string): ParsedCommand {
  const text = raw.trim();
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
    "**命令**（需整条消息只有命令）",
    "",
    ...(multi
      ? [`\`/agent [名称]\` 查看 / 切换 agent（可选：${agents.join("、")}），也可以直接发 ${agents.map((a) => `\`/${a}\``).join(" ")}`]
      : []),
    "`/new [模型]` 开一条新会话",
    "`/fork` 从当前会话分叉，原会话保留",
    "`/sessions [all]` 列出历史会话，点按钮恢复；加 all 列所有目录",
    "`/resume <会话ID>` 恢复指定会话",
    "`/model [名称]` 切换模型（不带参数弹选择卡片）",
    "`/effort <程度>` 切换思考程度",
    "`/stop` 中断当前执行",
    "`/cd <相对目录>` 切换工作目录（限 workspace 内）",
    "`/pwd` 显示当前工作目录",
    "`/status` 查看当前会话、模型、目录",
    "`/approve <请求ID> allow-once|allow-always|deny` 审批兜底",
    "`/help` 显示本帮助",
  ].join("\n");
}
