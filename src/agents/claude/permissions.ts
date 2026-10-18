// Claude 的授权细节：「总是允许」名单、工具调用的人话描述、AskUserQuestion 的解析。
//
// Codex 把「总是允许」做进了协议（acceptForSession / execpolicy 补丁），Claude 没有，
// 只能自己记一份名单。特征刻意保守：Bash 只认命令的第一个词，文件类只认所在目录。
// 宁可多问几次，也不要因为特征太宽而放行了本不该放行的东西。
import path from "node:path";
import { dataDir, readJson, writeJsonAtomic } from "../../home.js";
import type { QuestionSpec } from "../../core/types.js";

const allowlistPath = path.join(dataDir, "claude-allowlist.json");
let allowlist: string[] | null = null;

/** 「总是允许一次提问」没有意义：只会让提问卡再也不出现。 */
const NEVER_REMEMBER = new Set(["AskUserQuestion", "ExitPlanMode"]);

export function isRememberable(toolName: string): boolean {
  return !NEVER_REMEMBER.has(toolName);
}

function load(): string[] {
  allowlist ??= readJson<string[]>(allowlistPath, []);
  return allowlist;
}

export function signatureOf(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return `Bash:${command.trim().split(/\s+/)[0] ?? ""}`;
  }
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
    const file = typeof input.file_path === "string" ? input.file_path : "";
    return `${toolName}:${path.dirname(file)}`;
  }
  return toolName;
}

export function isPreApproved(toolName: string, signature: string): boolean {
  return isRememberable(toolName) && load().includes(signature);
}

export function rememberAlways(signature: string): void {
  const list = load();
  if (list.includes(signature)) return;
  list.push(signature);
  writeJsonAtomic(allowlistPath, list);
}

export function listAllowlist(): string[] {
  return [...load()];
}

export function setAllowlist(next: string[]): void {
  allowlist = [...new Set(next.map((s) => s.trim()).filter(Boolean))];
  writeJsonAtomic(allowlistPath, allowlist);
}

/** 「总是允许」按钮上写清楚到底放行多宽。 */
export function alwaysLabelOf(toolName: string, signature: string): string {
  if (toolName === "Bash") return `总是允许 ${signature.slice(5) || "此命令"} 开头的命令`;
  if (signature.includes(":")) return `总是允许在该目录下${toolName === "Write" ? "新建" : "修改"}`;
  return `总是允许 ${toolName}`;
}

export function describeToolCall(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") {
    const desc = typeof input.description === "string" ? `${input.description}\n\n` : "";
    return `${desc}\`\`\`bash\n${String(input.command ?? "")}\n\`\`\``;
  }
  if (toolName === "Edit" || toolName === "Write") {
    return `**文件**：\`${String(input.file_path ?? "")}\``;
  }
  // 计划本身就是写给人看的 markdown，套一层 JSON 只会让它没法读
  if (toolName === "ExitPlanMode" && typeof input.plan === "string") return input.plan;
  return `\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``;
}

/**
 * 从 AskUserQuestion 的入参里解出问题清单。解不出来返回 null，调用方退回普通授权卡
 * —— 宁可显示得笨一点，也不要因为 SDK 改了 schema 就把一整轮卡死。
 *
 * 问题的 id 用问题原文：SDK 约定答案按「问题原文 → 答案」回填。
 */
export function parseQuestions(input: Record<string, unknown>): QuestionSpec[] | null {
  const raw = input.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const specs: QuestionSpec[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const rec = item as Record<string, unknown>;
    const question = typeof rec.question === "string" ? rec.question.trim() : "";
    const rawOptions = Array.isArray(rec.options) ? rec.options : [];
    if (!question || rawOptions.length === 0) return null;
    const options: QuestionSpec["options"] = [];
    for (const opt of rawOptions) {
      if (typeof opt !== "object" || opt === null) return null;
      const o = opt as Record<string, unknown>;
      const label = typeof o.label === "string" ? o.label.trim() : "";
      if (!label) return null;
      options.push({
        label,
        ...(typeof o.description === "string" && o.description.trim()
          ? { description: o.description.trim() }
          : {}),
      });
    }
    specs.push({
      id: typeof rec.question === "string" ? rec.question : question,
      header: typeof rec.header === "string" && rec.header.trim() ? rec.header.trim() : "选择",
      question,
      options,
      multiSelect: rec.multiSelect === true,
      allowOther: true,
    });
  }
  return specs;
}
