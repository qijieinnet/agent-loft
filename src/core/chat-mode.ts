// 聊天模式要告诉 agent 的话，以及怎么告诉。
//
// 两个 agent 的「换系统提示」能力不一样（都实测过）：
//   - Claude：系统提示每次拉起进程时整个给，换模式 = 带着新的系统提示 resume，干净利落。
//     聊天模式就用 chatSystemPrompt 换掉 Claude Code 原装的那一大段（约 1.6 万 token）。
//   - Codex：thread 的基础指令一旦设了就钉在 thread 上（resume 时不传就沿用，传 null 也一样），
//     开发者指令只在 thread 开头写一次、resume 时给新的会被忽略。所以 Codex 不动它的指令，
//     模式和记忆用 contextBlock 附在「这个会话进程的第一条消息」后面 —— 它按时间顺序进历史，
//     模型以最新的为准。读历史、列会话时用 stripContext 把它剥掉。
//
// 日期写进去是因为模型不知道今天几号；它在一条会话里不变，不影响提示缓存。

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}（${tz}）`;
}

/** search：这个 agent 里联网搜索 / 读网页的工具怎么称呼 */
function chatRules(search: string): string[] {
  return [
    "- 用用户使用的语言回答，自然、直接、简洁；需要时用 Markdown 排版（列表、表格、代码块）。",
    `- 涉及最新信息、新闻、价格、版本、事实核查时，先用${search}查，回答里附上来源链接；不要凭记忆编造。`,
    "- 用户发来的图片、PDF 和文本文件内容会直接附在消息里。",
    "- 现在是「聊天模式」：你不能执行命令，也不能读写这台机器上的文件。用户要你动手干活（写代码、改文件、跑命令、操作服务器）时，告诉他发 /work 切到工作模式，同一条对话会接着聊。",
  ];
}

/** Claude 聊天模式的整段系统提示 */
export function chatSystemPrompt(search: string, memory?: string): string {
  const base = ["你是用户的私人 AI 助手，他通过 agent-loft 的网页或飞书和你聊天。", "", ...chatRules(search), "", `今天是 ${today()}。`].join("\n");
  return memory ? `${base}\n\n${memory}` : base;
}

const OPEN = "<agent-loft-context>";
const CLOSE = "</agent-loft-context>";

/** Codex：附在会话进程第一条消息后面的背景（模式 + 记忆 + 工作模式下的技能清单） */
export function contextBlock(mode: "chat" | "work", memory: string | undefined, search: string, skills: string[] = []): string {
  const head =
    mode === "chat"
      ? ["当前是「聊天模式」，你作为用户的私人 AI 助手和他聊天：", ...chatRules(search)]
      : ["当前是「工作模式」：可以执行命令、读写文件，按平常的方式干活。之前如果说过「聊天模式下不能做」，那个限制已经解除。"];
  return wrapContext([...head, ...(memory ? ["", memory] : []), ...(mode === "work" && skills.length ? ["", ...skills] : [])]);
}

/** 包成 agent-loft 附上的背景：用户看不到（读历史、实时显示时都剥掉），agent 照着做 */
export function wrapContext(lines: string[]): string {
  return [OPEN, "（这段是 agent-loft 自动附上的背景，不是用户写的。照着做，但不要在回复里提到它。）", "", ...lines, CLOSE].join("\n");
}

/** 剥掉 contextBlock（读历史、列会话标题时用）。一条消息里可能有好几段（定时任务的说明 + Codex 的模式说明） */
export function stripContext(text: string): string {
  let out = text;
  for (let start = out.indexOf(OPEN); start >= 0; start = out.indexOf(OPEN)) {
    const end = out.indexOf(CLOSE, start);
    const rest = end < 0 ? "" : out.slice(end + CLOSE.length);
    out = `${out.slice(0, start)}${rest}`;
  }
  return out === text ? text : out.trim();
}
