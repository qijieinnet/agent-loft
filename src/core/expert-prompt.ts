// 专家要告诉 agent 的话（人设、能做什么、记忆），以及怎么告诉。
//
// 两个 agent 的「换系统提示」能力不一样（都实测过）：
//   - Claude：系统提示每次拉起进程时整个给。自定义专家默认用 expertSystemPrompt 换掉 Claude Code 原装的
//     那一大段（约 1.6 万 token）；专家选了「Claude Code 原装」就用 expertAppend 追加在原装提示后面。
//   - Codex：thread 的基础指令一旦设了就钉在 thread 上（resume 时不传就沿用，传 null 也一样），
//     开发者指令只在 thread 开头写一次、resume 时给新的会被忽略。所以 Codex 不动它的指令，
//     专家和记忆用 contextBlock 附在「这个会话进程的第一条消息」后面 —— 它按时间顺序进历史，
//     模型以最新的为准。读历史、列会话时用 stripContext 把它剥掉。
//
// 日期写进去是因为模型不知道今天几号；它在一条会话里不变，不影响提示缓存。
import type { ExpertAccess, ExpertRuntime } from "./experts.js";

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}（${tz}）`;
}

/** 拼提示词要知道的专家配置（主专家用 ExpertRuntime，子智能体只给一部分） */
export type PromptExpert = Pick<ExpertRuntime, "name" | "prompt" | "access" | "webSearch" | "webFetch"> & {
  subagents?: { key: string; name: string; description: string }[];
};

/**
 * 这个专家能做什么、不能做什么，由 agent-loft 按配置生成。
 * search：联网搜索 / 读网页的工具在这个 agent 里怎么称呼；不能联网就是 undefined。
 */
export function capabilityLines(expert: PromptExpert, search: string | undefined, cwd: string): string[] {
  const lines: string[] = [];
  lines.push(
    search
      ? `- 涉及最新信息、新闻、价格、版本、事实核查时，先用${search}查，回答里附上来源链接；不要凭记忆编造。`
      : "- 你不能联网。涉及最新信息时说明你知道的可能已经过时，不要编造。",
  );
  const access: Record<ExpertAccess, string> = {
    web: "- 你不能读写这台机器上的文件，也不能执行命令。用户发来的图片、PDF 和文本文件内容会直接附在消息里。",
    read: `- 你可以读这台机器上的文件（工作目录 ${cwd}），但不能修改文件，也不能执行命令。`,
    edit: `- 你可以读写工作目录 ${cwd} 里的文件，但不能执行命令。`,
    exec: `- 你可以在工作目录 ${cwd} 里读写文件、执行命令。`,
  };
  lines.push(access[expert.access]);
  if (expert.access !== "exec") {
    lines.push("- 用户要你做超出这些能力的事时，直接说明做不到；需要的话建议他新开一个对话，换一个有这项能力的专家。");
  }
  if (expert.subagents?.length) {
    lines.push(
      "- 遇到合适的子任务，可以用 Agent 工具交给下面的子智能体（subagent_type 写括号里的名字）。它们看不到这段对话，交代任务时把目标、约束和需要的背景写清楚：",
      ...expert.subagents.map((s) => `  - ${s.name}（${s.key}）：${s.description}`),
    );
  }
  return lines;
}

/** 这个专家能用的联网工具在提示词里怎么称呼；一个都没开就是 undefined（Codex 只有搜索） */
export function searchLabel(engine: "claude" | "codex", expert: Pick<PromptExpert, "webSearch" | "webFetch">): string | undefined {
  if (engine === "codex") return expert.webSearch ? "联网搜索" : undefined;
  const parts = [expert.webSearch ? "WebSearch（搜索）" : "", expert.webFetch ? "WebFetch（读网页）" : ""].filter(Boolean);
  return parts.length ? parts.join("和") : undefined;
}

function persona(expert: PromptExpert): string[] {
  return [`你是「${expert.name}」，用户通过 agent-loft 的网页或飞书和你对话。`, ...(expert.prompt ? ["", expert.prompt] : [])];
}

/** Claude 自定义专家的整段系统提示（lean：换掉 Claude Code 原装的） */
export function expertSystemPrompt(expert: PromptExpert, search: string | undefined, cwd: string, memory?: string): string {
  const base = [
    ...persona(expert),
    "",
    "## 你能做什么（agent-loft 按这个专家的配置生成）",
    "",
    ...capabilityLines(expert, search, cwd),
    "",
    `今天是 ${today()}。`,
  ].join("\n");
  return memory ? `${base}\n\n${memory}` : base;
}

/** Claude 自定义专家选了「Claude Code 原装」：追加在原装提示后面的部分 */
export function expertAppend(expert: PromptExpert, search: string | undefined, cwd: string): string {
  return [...persona(expert), "", "## 这个专家能做什么（agent-loft 按配置生成）", "", ...capabilityLines(expert, search, cwd)].join("\n");
}

const OPEN = "<agent-loft-context>";
const CLOSE = "</agent-loft-context>";

/**
 * Codex：附在会话进程第一条消息后面的背景。
 * expert 不给就是内置的 Codex 专家：只有记忆和技能清单，都没有就不附（返回空串）。
 */
export function contextBlock(
  expert: { prompt: PromptExpert; cwd: string } | undefined,
  memory: string | undefined,
  skills: string[] = [],
): string {
  const head = expert
    ? [...persona(expert.prompt), "", "## 你能做什么（agent-loft 按这个专家的配置生成）", "", ...capabilityLines(expert.prompt, searchLabel("codex", expert.prompt), expert.cwd)]
    : [];
  const sections = [head, memory ? [memory] : [], skills].filter((s) => s.length > 0);
  return sections.length ? wrapContext(sections.flatMap((s, i) => (i ? ["", ...s] : s))) : "";
}

/** 包成 agent-loft 附上的背景：用户看不到（读历史、实时显示时都剥掉），agent 照着做 */
export function wrapContext(lines: string[]): string {
  return [OPEN, "（这段是 agent-loft 自动附上的背景，不是用户写的。照着做，但不要在回复里提到它。）", "", ...lines, CLOSE].join("\n");
}

/** 剥掉 contextBlock（读历史、列会话标题时用）。一条消息里可能有好几段（定时任务的说明 + Codex 的专家说明） */
export function stripContext(text: string): string {
  let out = text;
  for (let start = out.indexOf(OPEN); start >= 0; start = out.indexOf(OPEN)) {
    const end = out.indexOf(CLOSE, start);
    const rest = end < 0 ? "" : out.slice(end + CLOSE.length);
    out = `${out.slice(0, start)}${rest}`;
  }
  return out === text ? text : out.trim();
}
