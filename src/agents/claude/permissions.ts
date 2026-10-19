// Claude 的授权细节：「总是允许」名单、工具调用的人话描述、AskUserQuestion 的解析。
//
// Codex 把「总是允许」做进了协议（acceptForSession / execpolicy 补丁），Claude 没有，
// 只能自己记一份名单。特征刻意保守：Bash 只认命令的第一个词，文件类只认所在目录。
// 宁可多问几次，也不要因为特征太宽而放行了本不该放行的东西。
import os from "node:os";
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

/** 按目录记的签名，目录必须是绝对路径；老版本因读错参数名记下的「NotebookEdit:.」之类一律作废 */
function validSignature(sig: string): boolean {
  const m = /^(Edit|Write|NotebookEdit):(.*)$/.exec(sig);
  return !m || path.isAbsolute(m[2]!);
}

export function isRememberableSignature(toolName: string, signature: string): boolean {
  return isRememberable(toolName) && validSignature(signature);
}

function load(): string[] {
  allowlist ??= readJson<string[]>(allowlistPath, []).filter(validSignature);
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
/**
 * 出现这些字符就不按首词记：shell 组合语法、变量 / 命令替换，以及引号和通配符 ——
 * 引号能把危险参数藏起来（'--output=/x' 在 shell 去掉引号后才生效），
 * 通配符和 ~ 会在执行时展开成我们看不到的东西。
 */
const SHELL_SYNTAX = /[;&|`<>\n\r\\'"*?[\]{}~#!]|\$/;

/**
 * 可按首词放行的命令，以及它们「哪些参数不行」。
 *
 * 入选标准：无论带什么参数，都既不能执行别的程序，也不能写文件。为此去掉了
 * 看似只读、其实带「后门参数」的：rg（--pre 能把文件当脚本跑）、sort / uniq / tree
 * （-o 或位置参数能写文件）。剩下的少数命令里，个别参数仍有副作用（date -s 改系统时间），
 * 单独拦掉。
 */
const PREFIX_SAFE: Record<string, (args: string[]) => boolean> = {
  ls: () => true,
  cat: () => true,
  head: () => true,
  tail: () => true,
  wc: () => true,
  grep: () => true,
  pwd: (a) => a.length === 0,
  echo: () => true,
  stat: () => true,
  du: () => true,
  df: () => true,
  which: () => true,
  // GNU 长选项可以缩写（--se 就是 --set），所以只认明确列出的参数
  date: (a) => a.every((x) => /^\+/.test(x) || ["-u", "--utc", "-R", "-I", "--iso-8601"].includes(x)),
  basename: () => true,
  dirname: () => true,
  realpath: () => true,
  readlink: () => true,
  uname: () => true,
  whoami: (a) => a.length === 0,
  id: () => true,
  hostname: (a) => a.length === 0, // 带参数就是改主机名
  uptime: () => true,
  ps: () => true,
  mkdir: () => true,
  touch: () => true,
};

/**
 * git 只放行纯查看的子命令，参数也只认白名单 —— git 的长选项同样能缩写
 * （--outp 就是 --output），用黑名单拦不住。不是选项的参数（路径、提交号）照常放行。
 */
const GIT_READONLY = new Set(["status", "log", "show", "diff"]);
const GIT_SAFE_FLAGS = new Set([
  "-s", "--short", "-b", "--branch", "--porcelain", "-v", "--verbose", "-u", "--untracked-files",
  "--oneline", "--graph", "--decorate", "--all", "--stat", "--shortstat", "--name-only", "--name-status",
  "-p", "--patch", "--cached", "--staged", "--no-color", "--color", "-w", "--ignore-all-space",
  "--reverse", "--first-parent", "--no-merges", "--merges", "--", "-q", "--quiet",
]);

function gitArgOk(arg: string): boolean {
  if (!arg.startsWith("-")) return true;
  if (/^-\d+$/.test(arg)) return true; // -5：最近 5 条
  if (/^(-n|--max-count)=?\d*$/.test(arg)) return true;
  if (/^--(since|until|author|grep)=[^=]+$/.test(arg)) return true;
  return GIT_SAFE_FLAGS.has(arg);
}

function prefixSignature(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed || SHELL_SYNTAX.test(trimmed)) return null;
  const words = trimmed.split(/\s+/);
  const head = words[0] ?? "";
  const args = words.slice(1);
  const check = Object.hasOwn(PREFIX_SAFE, head) ? PREFIX_SAFE[head] : undefined;
  if (check) return check(args) ? `Bash:${head}` : null;
  if (head === "git") {
    const sub = args[0] ?? "";
    if (!GIT_READONLY.has(sub) || !args.slice(1).every(gitArgOk)) return null;
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
    // NotebookEdit 的路径参数叫 notebook_path，不是 file_path
    const raw = toolName === "NotebookEdit" ? input.notebook_path : input.file_path;
    const file = typeof raw === "string" ? raw : "";
    // 拿不到绝对路径就没法按目录记：给一个不可记忆的签名（见 isRememberableSignature）
    if (!file || !path.isAbsolute(file)) return `${toolName}:`;
    return `${toolName}:${path.dirname(file)}`;
  }
  return toolName;
}

export function isPreApproved(toolName: string, signature: string): boolean {
  // 防绕过靠的是 signatureOf：复合命令拿到的是 BashExact 签名，命中不了 Bash:<首词>
  if (!isRememberableSignature(toolName, signature)) return false;
  const list = load();
  if (list.includes(signature)) return true;
  return coveredBySubdirectoryRule(toolName, signature, list);
}

const DIR_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

/**
 * 按目录记的批准连带子目录：批准过 /home/me/project，改 project/src/core 下的文件不用再问。
 * 以前只认完全相同的目录，项目里每进一个子目录都要再点一次，点到后来就是闭眼点 —— 那才不安全。
 *
 * 两道收口：
 *   - 太宽的批准不往下延伸：/、家目录、家目录的上级。批准过「在家目录下新建文件」
 *     不等于能改 ~/.ssh、~/.bashrc；
 *   - 不延伸进隐藏目录（.git/hooks、.github/workflows、.husky…）：往那里写东西等于
 *     让它下次自动执行。真要改，单独批一次那个目录。
 */
function coveredBySubdirectoryRule(toolName: string, signature: string, list: string[]): boolean {
  if (!DIR_TOOLS.has(toolName)) return false;
  const target = signature.slice(toolName.length + 1);
  const home = os.homedir();
  for (const entry of list) {
    if (!entry.startsWith(`${toolName}:`)) continue;
    const approved = entry.slice(toolName.length + 1);
    if (!path.isAbsolute(approved)) continue;
    if (approved === path.parse(approved).root || approved === home || home.startsWith(`${approved}${path.sep}`)) continue;
    const rel = path.relative(approved, target);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (rel.split(path.sep).some((part) => part.startsWith("."))) continue;
    return true;
  }
  return false;
}

export function rememberAlways(signature: string): void {
  if (!validSignature(signature)) return;
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
  if (signature.includes(":")) return `总是允许在该目录及子目录下${toolName === "Write" ? "新建" : "修改"}`;
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
