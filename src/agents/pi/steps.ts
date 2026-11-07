// 过程摘要里的一行（实时显示和读历史共用）
import { summarize } from "../claude/session.js";

/** agent-loft 补给 pi 的两个工具：提问卡、交方案 */
export const ASK_TOOL = "ask_user";
export const PLAN_TOOL = "exit_plan_mode";

/** 过程里的一行：工具名 + 最要紧的参数 */
export function describePiStep(toolName: string, input: unknown): string {
  const r = (input ?? {}) as Record<string, unknown>;
  if (toolName === "bash" && typeof r.command === "string") return `bash: ${summarize(r.command, 60)}`;
  if (typeof r.path === "string" && r.path) {
    const extra = typeof r.pattern === "string" ? ` ${summarize(r.pattern, 30)}` : "";
    return `${toolName}: ${r.path}${extra}`;
  }
  if (typeof r.pattern === "string") return `${toolName}: ${summarize(r.pattern, 40)}`;
  if (toolName === ASK_TOOL) return "向你提问";
  if (toolName === PLAN_TOOL) return "提交方案";
  return toolName;
}

