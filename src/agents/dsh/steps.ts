// 过程摘要里的一行（实时显示和读历史共用）。dsh 的工具名是小写的：bash、read、write、edit、glob、grep……
import { summarize } from "../claude/session.js";

/** dsh 的 todo_write 和 Claude 的 TodoWrite 参数一样（{ todos: [{ content, status }] }），交给同一个 TodoTracker */
export function todoName(name: string): string {
  return name === "todo_write" ? "TodoWrite" : name;
}

export function describeDshStep(toolName: string, input: unknown): string {
  const r = (input ?? {}) as Record<string, unknown>;
  if (toolName === "bash" && typeof r.command === "string") return `bash: ${summarize(r.command, 60)}`;
  const file = typeof r.file_path === "string" ? r.file_path : typeof r.path === "string" ? r.path : undefined;
  if (file) {
    const extra = typeof r.pattern === "string" ? ` ${summarize(r.pattern, 30)}` : "";
    return `${toolName}: ${file}${extra}`;
  }
  if (typeof r.pattern === "string") return `${toolName}: ${summarize(r.pattern, 40)}`;
  if (typeof r.query === "string") return `${toolName}: ${summarize(r.query, 50)}`;
  if (typeof r.url === "string") return `${toolName}: ${summarize(r.url, 60)}`;
  if (typeof r.description === "string") return `${toolName}: ${summarize(r.description, 50)}`;
  return toolName;
}
