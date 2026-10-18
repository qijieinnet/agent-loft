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

/**
 * 「总是允许」按多宽记。
 *
 * 默认只记**完整命令**。只有白名单里的命令才按「首词」记：它们不论带什么参数都
 * 只是读读看看，放宽了也出不了大事。黑名单的思路试过，不可靠 —— 包装程序数不完
 * （npm exec、python3.12 -c、各种解释器……），漏一个就是任意命令执行。
 *
 * git 单独处理：按「git + 子命令」记（批准过 git status 不等于批准 git push），
 * 并且带 -c / --config / --exec-path 之类能改行为的全局参数时只记完整命令。
 *
 * 无论哪种，命令里只要有 shell 组合语法（; && | $() 重定向……）就只记完整命令：
 * 否则 `ls; rm -rf ~` 的首词也是 ls。
 */
const SHELL_SYNTAX = /[;&|`<>\n\r\\]|\$[({]|\$[A-Za-z_]/;
const PREFIX_SAFE = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "pwd", "echo", "stat", "file", "du", "df",
  "which", "date", "tree", "diff", "sort", "uniq", "cut", "basename", "dirname", "realpath",
  "readlink", "uname", "whoami", "id", "hostname", "uptime", "ps", "mkdir", "touch",
]);
const GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "branch", "add", "commit", "fetch", "pull", "push",
  "checkout", "switch", "restore", "stash", "tag", "remote", "rev-parse", "blame", "merge", "rebase",
]);

function prefixSignature(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed || SHELL_SYNTAX.test(trimmed)) return null;
  const words = trimmed.split(/\s+/);
  const head = words[0] ?? "";
  if (PREFIX_SAFE.has(head)) return `Bash:${head}`;
  if (head === "git") {
    const sub = words[1] ?? "";
    if (!GIT_SUBCOMMANDS.has(sub)) return null;
    if (words.some((w) => /^(-c|--config(-env)?|--exec-path|--upload-pack|--receive-pack)(=|$)/.test(w))) return null;
    return `Bash:git ${sub}`;
  }
  return null;
}

export function signatureOf(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return prefixSignature(command) ?? `BashExact:${command.trim()}`;
  }
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
    const file = typeof input.file_path === "string" ? input.file_path : "";
    return `${toolName}:${path.dirname(file)}`;
  }
  return toolName;
}

export function isPreApproved(toolName: string, signature: string): boolean {
  // 防绕过靠的是 signatureOf：复合命令拿到的是 BashExact 签名，命中不了 Bash:<首词>
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
  if (toolName === "Bash") {
    return signature.startsWith("BashExact:") ? "总是允许这条完全相同的命令" : `总是允许 ${signature.slice(5)} 开头的单条命令`;
  }
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
