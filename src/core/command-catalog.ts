// 命令目录：输入「/」时给用户看的那张表。
//
// 两种来源：
//   - im-agent 自己的命令（/new /status …），由 hub 拦下来执行，所有 agent 通用；
//   - agent 原生命令（Claude 的 skills、/compact 之类），im-agent 不认识，原样转给 agent。
// 顺序和隐藏按 agent 分开存在配置里（设置 → 命令），用户自己排。

/** im-agent 内置命令。name 不带斜杠；args 里尖括号是必填、方括号是可选 */
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
  { name: "approve", args: "<请求ID> allow-once|allow-always|deny", description: "审批兜底（卡片失效时用）" },
  { name: "help", description: "显示帮助" },
];

/** agent 自己报上来的命令 */
export type AgentCommand = { name: string; description: string; args?: string };

export type CommandEntry = {
  name: string;
  args?: string;
  description: string;
  source: "im-agent" | "agent";
  /** 不带参数就能直接执行（飞书卡片上给按钮、Web 里回车直接发） */
  runnable: boolean;
  hidden: boolean;
};

export type CommandPrefs = { order: string[]; hidden: string[] };

/** 参数里有必填项（尖括号）就不能一键执行 */
function needsArgs(args: string | undefined): boolean {
  return !!args && args.includes("<");
}

/**
 * 合并内置命令和 agent 原生命令，再按用户配置排序。
 * - 只对接得上的 agent 才列 /claude /codex 这类快捷切换；
 * - 和内置命令重名的原生命令丢掉：反正会被 im-agent 先拦下来，列出来只会误导；
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
    source: "im-agent" as const,
    runnable: !needsArgs(c.args),
    hidden: false,
  }));
  const taken = new Set(BUILTIN_COMMANDS.map((c) => c.name));
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

  const all = [...builtin, ...native];
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
