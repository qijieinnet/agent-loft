// MCP 工具 → Agent Loft Bridge 的命令。每个工具一条：参数怎么变成 Bridge 的 --flag=值。
// 参数一律写成 --key=value（值以 -- 开头、是空字符串也不会认错）；布尔值写 true / false。

const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const bool = (description) => ({ type: "boolean", description });
const int = (description) => ({ type: "integer", minimum: 1, maximum: 1000, description });

const DATE = "本地时间：YYYY-MM-DD、'YYYY-MM-DD HH:mm'、ISO8601，或 today / tomorrow / yesterday / now";
const ID = (what) => str(`${what}的 id（从列表 / 搜索结果里拿，不要猜）`);
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
const CONFIRM = "默认会在 Mac 上弹窗等用户点「允许」（2 分钟没人点就拒绝）；用户拒绝时什么都不会改，不要重试。";

const occurrence = {
  occurrence: str("重复事件：要改 / 删的那一次的开始时间（list 结果里的 start）"),
  span: str("重复事件的范围：this 只这一次（要配合 occurrence），future 这次及以后；只给 future 不给 occurrence 是整个系列", { enum: ["this", "future"] }),
};
const eventFields = {
  title: str("标题"),
  start: str(`开始时间，${DATE}。只给日期就是全天事件`),
  end: str("结束时间"),
  duration: int("时长（分钟），和 end 二选一；都不给默认 1 小时"),
  all_day: bool("是否全天"),
  calendar: str("日历名称或 id"),
  location: str("地点（修改时传空字符串清空）"),
  notes: str("备注（修改时传空字符串清空）"),
  url: str("链接（修改时传空字符串清空）"),
  alarm: str("提前几分钟提醒，多个用逗号分隔，例如 15 或 10,60；修改时 none 清除"),
};
const reminderFields = {
  title: str("标题"),
  list: str("提醒事项列表名称或 id"),
  due: str(`截止时间，${DATE}。带时刻的会到点通知；修改时 none 清除`),
  notes: str("备注（修改时传空字符串清空）"),
  priority: str("优先级", { enum: ["none", "low", "medium", "high"] }),
  url: str("链接（修改时传空字符串清空）"),
};

/**
 * @typedef {{ type: string, description?: string, flag?: string, enum?: string[] }} Prop
 * @typedef {{ name: string, title: string, description: string, cmd: string[] | ((a: any) => string[]),
 *   props?: Record<string, Prop>, required?: string[], annotations: object, timeout?: number }} Tool
 */

/** @type {Tool[]} */
export const TOOLS = [
  {
    name: "apple_status",
    title: "权限状态",
    description: "查看 Agent Loft Bridge 对日历、提醒事项、备忘录的授权情况，以及删改前是否要在 Mac 上确认。calendars / reminders 应该是 fullAccess，notes 应该是 granted（备忘录没运行时是 unknown，不代表有问题）。不对的话请用户打开 Agent Loft 桌面端 → 设置 → 苹果日历 / 提醒事项 / 备忘录 处理。",
    cmd: ["status"],
    annotations: READ,
  },

  // ---------- 日历 ----------
  {
    name: "calendar_list_calendars",
    title: "列出日历",
    description: "列出所有日历（writable=false 的是只读的，比如节假日、生日）。",
    cmd: ["calendars"],
    annotations: READ,
  },
  {
    name: "calendar_list_events",
    title: "查日程",
    description: "按时间范围查日历事件，默认今天起 7 天。只写日期的 to 包含那一天。",
    cmd: ["events", "list"],
    props: { from: str(`开始，${DATE}`), to: str("结束（只写日期时包含当天）"), calendar: str("只看这些日历，名称或 id，多个用逗号分隔"), query: str("按标题、地点、备注搜索"), limit: int("最多返回几条") },
    annotations: READ,
  },
  {
    name: "calendar_add_event",
    title: "新建日程",
    description: "新建一个日历事件。不给 calendar 就放默认日历。",
    cmd: ["events", "add"],
    props: eventFields,
    required: ["title", "start"],
    annotations: WRITE,
  },
  {
    name: "calendar_update_event",
    title: "修改日程",
    description: `修改日历事件，只改传了的字段；只改 start 会保留原来的时长。重复事件必须给 occurrence 或 span。${CONFIRM}`,
    cmd: ["events", "update"],
    props: { id: ID("事件"), ...occurrence, ...eventFields },
    required: ["id"],
    annotations: DESTRUCTIVE,
    timeout: 180_000,
  },
  {
    name: "calendar_delete_event",
    title: "删除日程",
    description: `删除日历事件，删了不能恢复。重复事件必须给 occurrence 或 span。${CONFIRM}`,
    cmd: ["events", "delete"],
    props: { id: ID("事件"), ...occurrence },
    required: ["id"],
    annotations: DESTRUCTIVE,
    timeout: 180_000,
  },

  // ---------- 提醒事项 ----------
  {
    name: "reminders_list_lists",
    title: "列出提醒列表",
    description: "列出所有提醒事项列表。",
    cmd: ["reminders", "lists"],
    annotations: READ,
  },
  {
    name: "reminders_list",
    title: "查提醒事项",
    description: "查提醒事项，默认所有未完成的，按截止时间排序。",
    cmd: ["reminders", "list"],
    props: {
      list: str("只看这些列表，名称或 id，多个用逗号分隔"),
      status: str("看哪些", { enum: ["incomplete", "completed", "all"] }),
      query: str("按标题、备注搜索"),
      due_before: str("截止时间早于（只写日期时包含当天），例如 today 查今天及逾期的"),
      due_after: str("截止时间不早于"),
      limit: int("最多返回几条"),
    },
    annotations: READ,
  },
  {
    name: "reminders_add",
    title: "新建提醒",
    description: "新建一条提醒事项。不给 list 就放默认列表。",
    cmd: ["reminders", "add"],
    props: reminderFields,
    required: ["title"],
    annotations: WRITE,
  },
  {
    name: "reminders_update",
    title: "修改提醒",
    description: `修改提醒事项，只改传了的字段。只想勾完成用 reminders_set_completed。${CONFIRM}`,
    cmd: ["reminders", "update"],
    props: { id: ID("提醒事项"), ...reminderFields },
    required: ["id"],
    annotations: DESTRUCTIVE,
    timeout: 180_000,
  },
  {
    name: "reminders_set_completed",
    title: "勾完成 / 取消完成",
    description: "把提醒事项标成完成或未完成，不用确认。不想要的提醒一般标完成，而不是删除。",
    cmd: (a) => ["reminders", a.completed === false ? "reopen" : "complete"],
    props: { id: ID("提醒事项"), completed: { ...bool("true 标完成（默认），false 取消完成"), flag: null } },
    required: ["id"],
    annotations: { ...WRITE, idempotentHint: true },
  },
  {
    name: "reminders_delete",
    title: "删除提醒",
    description: `删除提醒事项，删了不能恢复；不需要的一般用 reminders_set_completed 标完成。${CONFIRM}`,
    cmd: ["reminders", "delete"],
    props: { id: ID("提醒事项") },
    required: ["id"],
    annotations: DESTRUCTIVE,
    timeout: 180_000,
  },

  // ---------- 备忘录 ----------
  {
    name: "notes_list_folders",
    title: "列出备忘录文件夹",
    description: "列出所有账户下的备忘录文件夹和各自的条数。",
    cmd: ["notes", "folders"],
    annotations: READ,
  },
  {
    name: "notes_list",
    title: "列出备忘录",
    description: "列出备忘录（不含正文），按修改时间从新到旧，默认 50 条。",
    cmd: ["notes", "list"],
    props: { folder: str("只看这些文件夹，名称或 id，多个用逗号分隔"), account: str("账户名，比如 iCloud"), limit: int("最多返回几条") },
    annotations: READ,
  },
  {
    name: "notes_search",
    title: "搜索备忘录",
    description: "按标题搜索备忘录；in_body 为 true 时也搜正文，并返回匹配片段。",
    cmd: ["notes", "search"],
    props: { query: str("关键词"), in_body: { ...bool("也搜正文（慢一些）"), flag: "--body" }, folder: str("只搜这些文件夹"), account: str("账户名"), limit: int("最多返回几条") },
    required: ["query"],
    annotations: READ,
  },
  {
    name: "notes_read",
    title: "读备忘录",
    description: "读一条备忘录的内容，默认纯文本。加密的备忘录读不了。",
    cmd: ["notes", "read"],
    props: { id: ID("备忘录"), format: str("text 纯文本（默认），html 原始 HTML，both 两个都要", { enum: ["text", "html", "both"] }) },
    required: ["id"],
    annotations: READ,
  },
  {
    name: "notes_create",
    title: "新建备忘录",
    description: "新建一条备忘录。正文默认按纯文本处理、保留换行；要格式就传 Notes HTML 并设 html=true。",
    cmd: ["notes", "create"],
    props: { title: str("标题"), body: str("正文"), html: bool("body 是 HTML"), folder: str("文件夹名称或 id，不给就放默认文件夹"), account: str("账户名") },
    required: ["title"],
    annotations: WRITE,
  },
  {
    name: "notes_append",
    title: "追加到备忘录",
    description: "在备忘录末尾追加内容。实际是重写整篇正文：有附件、图片、表格、清单的备忘录会被拒绝，告诉用户风险、用户同意后才能加 force=true。",
    cmd: ["notes", "append"],
    props: { id: ID("备忘录"), body: str("要追加的内容"), html: bool("body 是 HTML"), force: bool("用户已经同意可能丢失附件、表格、清单等格式") },
    required: ["id", "body"],
    annotations: WRITE,
  },
  {
    name: "notes_update",
    title: "改写备忘录",
    description: `改标题，或者用 body 替换标题以下的全部内容。有附件、图片、表格、清单的备忘录会被拒绝，用户同意后才能加 force=true。${CONFIRM}`,
    cmd: ["notes", "update"],
    props: { id: ID("备忘录"), title: str("新标题"), body: str("新正文（替换标题以下全部内容）"), html: bool("body 是 HTML"), force: bool("用户已经同意可能丢失附件、表格、清单等格式") },
    required: ["id"],
    annotations: DESTRUCTIVE,
    timeout: 180_000,
  },
  {
    name: "notes_move",
    title: "移动备忘录",
    description: "把备忘录移到另一个文件夹。",
    cmd: ["notes", "move"],
    props: { id: ID("备忘录"), folder: str("目标文件夹名称或 id"), account: str("账户名（文件夹重名时用）") },
    required: ["id", "folder"],
    annotations: WRITE,
  },
  {
    name: "notes_delete",
    title: "删除备忘录",
    description: `删除备忘录，会移到「最近删除」，约 30 天内能恢复。${CONFIRM}`,
    cmd: ["notes", "delete"],
    props: { id: ID("备忘录") },
    required: ["id"],
    annotations: DESTRUCTIVE,
    timeout: 180_000,
  },
  {
    name: "notes_create_folder",
    title: "新建备忘录文件夹",
    description: "新建一个备忘录文件夹。",
    cmd: ["notes", "create-folder"],
    props: { name: str("文件夹名称"), account: str("账户名") },
    required: ["name"],
    annotations: WRITE,
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

/** tools/list 里的样子 */
export function toolList() {
  return TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(Object.entries(t.props ?? {}).map(([k, { flag, ...schema }]) => [k, schema])),
      ...(t.required?.length ? { required: t.required } : {}),
      additionalProperties: false,
    },
    annotations: { title: t.title, ...t.annotations },
  }));
}

/**
 * 工具调用 → Bridge 的参数。参数不对时抛错（错误信息给智能体看）。
 * @returns {{ args: string[], timeout: number }}
 */
export function toolArgs(name, input) {
  const tool = byName.get(name);
  if (!tool) throw Object.assign(new Error(`没有这个工具：${name}`), { unknownTool: true });
  const a = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  for (const k of tool.required ?? []) {
    if (a[k] === undefined || a[k] === null || a[k] === "") throw new Error(`缺少参数 ${k}`);
  }
  const args = [...(typeof tool.cmd === "function" ? tool.cmd(a) : tool.cmd)];
  for (const [k, v] of Object.entries(a)) {
    const prop = tool.props?.[k];
    if (!prop) throw new Error(`${name} 没有参数 ${k}`);
    if (v === undefined || v === null) continue;
    if (prop.flag === null) continue; // 只用来挑子命令
    const flag = prop.flag ?? `--${k.replace(/_/g, "-")}`;
    let text;
    if (prop.type === "boolean") {
      if (typeof v !== "boolean") throw new Error(`参数 ${k} 要是 true 或 false`);
      text = String(v);
    } else if (prop.type === "integer") {
      if (!Number.isInteger(v) || v < 1) throw new Error(`参数 ${k} 要是正整数`);
      text = String(v);
    } else {
      if (typeof v !== "string") throw new Error(`参数 ${k} 要是字符串`);
      if (prop.enum && !prop.enum.includes(v)) throw new Error(`参数 ${k} 只能是 ${prop.enum.join(" / ")}`);
      if (v.length > 200_000) throw new Error(`参数 ${k} 太长了`);
      text = v;
    }
    args.push(`${flag}=${text}`);
  }
  return { args, timeout: tool.timeout ?? 60_000 };
}
