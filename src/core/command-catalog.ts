// 命令目录：输入「/」时给用户看的那张表。
//
// 三种来源：
//   - agent-loft 自己的命令（/new /status …），由 hub 拦下来执行，所有 agent 通用；
//   - 用户自定义命令（设置 → 命令里添加）：一段预设的提示词，发送时展开成这段话交给 agent；
//   - agent 原生命令（Claude 的 skills、/compact 之类），agent-loft 不认识，原样转给 agent。
// 顺序和隐藏按 agent 分开存在配置里（设置 → 命令），用户自己排。

/** agent-loft 内置命令。name 不带斜杠；args 里尖括号是必填、方括号是可选 */
export type BuiltinSpec = { name: string; args?: string; description: string; multiAgentOnly?: boolean };

export const BUILTIN_COMMANDS: BuiltinSpec[] = [
  { name: "new", args: "[模型]", description: "开一条新会话" },
  { name: "status", description: "查看当前会话、模型、目录、剩余额度" },
  { name: "stop", description: "中断当前执行" },
  { name: "model", args: "[名称]", description: "切换模型（不带参数弹选择）" },
  { name: "effort", args: "[程度]", description: "切换思考程度" },
  { name: "sessions", args: "[all]", description: "列出历史会话，点按钮恢复；加 all 列所有目录" },
  { name: "resume", args: "<会话ID>", description: "恢复指定会话" },
  { name: "fork", description: "从当前会话分叉，原会话保留" },
  { name: "agent", args: "[名称]", description: "查看 / 切换 agent", multiAgentOnly: true },
  { name: "claude", description: "切换到 Claude Code", multiAgentOnly: true },
  { name: "codex", description: "切换到 Codex", multiAgentOnly: true },
  { name: "cd", args: "<相对目录>", description: "切换工作目录（限 workspace 内）" },
  { name: "pwd", description: "显示当前工作目录" },
  { name: "autoedit", args: "[on|off]", description: "本对话自动允许改工作目录内的文件（Bash 仍询问）" },
  { name: "approve", args: "<请求ID> allow-once|allow-always|allow-session|deny", description: "审批兜底（卡片失效时用）" },
  { name: "help", description: "显示帮助" },
];

/** agent 自己报上来的命令 */
export type AgentCommand = { name: string; description: string; args?: string };

/**
 * 用户自定义命令。prompt 里的 $ARGUMENTS 换成命令后面跟的参数；
 * 没写 $ARGUMENTS 又带了参数，参数接在提示词后面另起一段。
 */
export type CustomCommand = { name: string; description: string; prompt: string };

/** 自定义命令名：和飞书指令同样的规则（小写字母、数字、- _，最长 32），这样能原样同步到飞书 */
export const CUSTOM_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type CommandEntry = {
  name: string;
  args?: string;
  description: string;
  source: "agent-loft" | "custom" | "agent";
  /** 自定义命令的提示词（设置页编辑用） */
  prompt?: string;
  /** 不带参数就能直接执行（飞书卡片上给按钮、Web 里回车直接发） */
  runnable: boolean;
  hidden: boolean;
};

export type CommandPrefs = { order: string[]; hidden: string[]; custom?: CustomCommand[] };

/**
 * 整理自定义命令列表。strict（Web 保存时）遇到不合规的直接报错，提示具体哪条；
 * 否则（读配置文件时，可能是手改的）悄悄丢掉不合规的。
 */
export function cleanCustomCommands(list: unknown, strict = false): CustomCommand[] {
  const fail = (msg: string) => {
    if (strict) throw new Error(msg);
  };
  if (!Array.isArray(list)) {
    fail("自定义命令格式不对");
    return [];
  }
  const builtin = new Set(BUILTIN_COMMANDS.map((c) => c.name));
  const out: CustomCommand[] = [];
  for (const raw of list as Partial<CustomCommand>[]) {
    const name = typeof raw?.name === "string" ? raw.name.trim().replace(/^[/／]/, "").toLowerCase() : "";
    const prompt = typeof raw?.prompt === "string" ? raw.prompt.trim() : "";
    const description = typeof raw?.description === "string" ? raw.description.trim().slice(0, 200) : "";
    if (!CUSTOM_NAME.test(name)) {
      fail(`命令名「${name || "（空）"}」不合规：只能用小写字母、数字、- 和 _，以字母或数字开头，最长 32 个字符`);
      continue;
    }
    if (builtin.has(name)) {
      fail(`/${name} 是 agent-loft 内置命令，换个名字`);
      continue;
    }
    if (out.some((c) => c.name === name)) {
      fail(`/${name} 重复了`);
      continue;
    }
    if (!prompt) {
      fail(`/${name} 的提示词不能为空`);
      continue;
    }
    if (prompt.length > 20000) {
      fail(`/${name} 的提示词太长（最多 20000 字）`);
      continue;
    }
    out.push({ name, description, prompt });
  }
  return out;
}

/**
 * 整条消息是一条自定义命令时，展开成它的提示词；不是就返回 null（照原样处理）。
 * 和内置命令一样，只认「整条消息就是命令」：多行的、不认识的名字都不展开。
 */
export function expandCustomCommand(raw: string, custom: CustomCommand[] | undefined): string | null {
  if (!custom?.length) return null;
  const text = raw.trim().replace(/^／/, "/");
  if (!text.startsWith("/") || text.includes("\n")) return null;
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!m) return null;
  const cmd = custom.find((c) => c.name === m[1]!.toLowerCase());
  if (!cmd) return null;
  const args = (m[2] ?? "").trim();
  if (cmd.prompt.includes("$ARGUMENTS")) return cmd.prompt.split("$ARGUMENTS").join(args).trim();
  return args ? `${cmd.prompt.trim()}\n\n${args}` : cmd.prompt.trim();
}

/** 参数里有必填项（尖括号）就不能一键执行 */
function needsArgs(args: string | undefined): boolean {
  return !!args && args.includes("<");
}

/**
 * 合并内置命令和 agent 原生命令，再按用户配置排序。
 * - 只对接得上的 agent 才列 /claude /codex 这类快捷切换；
 * - 和内置命令重名的原生命令丢掉：反正会被 agent-loft 先拦下来，列出来只会误导；
 * - 配置里排过序的在前，按配置的顺序；没排过的（比如新装的 skill）按默认顺序接在后面。
 */
export function buildCatalog(params: {
  allowedAgents: string[];
  native: AgentCommand[];
  prefs: CommandPrefs | undefined;
}): CommandEntry[] {
  const multi = params.allowedAgents.length > 1;
  const builtin: CommandEntry[] = BUILTIN_COMMANDS.filter(
    (c) =>
      (!c.multiAgentOnly || multi) &&
      // /claude /codex 只在这个渠道能用对应 agent 时才有意义
      (!["claude", "codex"].includes(c.name) || params.allowedAgents.includes(c.name)),
  ).map((c) => ({
    name: c.name,
    ...(c.args ? { args: c.args } : {}),
    description: c.description,
    source: "agent-loft" as const,
    runnable: !needsArgs(c.args),
    hidden: false,
  }));
  const taken = new Set(BUILTIN_COMMANDS.map((c) => c.name));
  // 自定义命令：和内置重名的不收（保存时已经拦过，这里兜底手改配置的情况）；原生命令和它重名时让给它
  const custom: CommandEntry[] = [];
  for (const c of params.prefs?.custom ?? []) {
    if (!CUSTOM_NAME.test(c.name) || taken.has(c.name)) continue;
    taken.add(c.name);
    custom.push({
      name: c.name,
      ...(c.prompt.includes("$ARGUMENTS") ? { args: "[参数]" } : {}),
      description: c.description,
      source: "custom",
      prompt: c.prompt,
      runnable: true,
      hidden: false,
    });
  }
  const seen = new Set<string>();
  const native: CommandEntry[] = [];
  for (const c of params.native) {
    const name = c.name.replace(/^\//, "");
    if (!name || taken.has(name) || seen.has(name)) continue;
    seen.add(name);
    native.push({
      name,
      ...(c.args ? { args: c.args } : {}),
      description: c.description,
      source: "agent",
      runnable: !needsArgs(c.args),
      hidden: false,
    });
  }

  const all = [...builtin, ...custom, ...native];
  const order = params.prefs?.order ?? [];
  const hidden = new Set(params.prefs?.hidden ?? []);
  const rank = new Map(order.map((name, i) => [name, i]));
  return all
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const ra = rank.get(a.c.name);
      const rb = rank.get(b.c.name);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return a.i - b.i;
    })
    .map(({ c }) => ({ ...c, hidden: hidden.has(c.name) }));
}

/** 「/name args」，给人看的写法 */
export function usageOf(c: { name: string; args?: string }): string {
  return `/${c.name}${c.args ? ` ${c.args}` : ""}`;
}
