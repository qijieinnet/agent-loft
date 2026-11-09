// MCP 工具 → Agent Loft Bridge 的命令。每个工具一条：参数怎么变成 Bridge 的 --flag=值。
// 参数一律写成 --key=value（值以 -- 开头、是空字符串也不会认错）；布尔值写 true / false。

const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const bool = (description) => ({ type: "boolean", description });
const strList = (description) => ({ type: "array", items: { type: "string" }, maxItems: 200, description });
const labeled = (description) => ({
  type: "array",
  maxItems: 50,
  items: { type: "object", properties: { label: { type: "string", description: "mobile / home / work / other / iphone / main，或自定义" }, value: { type: "string" } }, required: ["value"], additionalProperties: false },
  description: `${description}。修改时传的列表会整个替换原来的`,
});
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
 *   props?: Record<string, Prop>, required?: string[], annotations: object, timeout?: number, images?: boolean }} Tool
 *   images：Bridge 返回 { thumbnails: [{ id, mimeType, data }] }，转成 MCP 的图片内容
 */

/** @type {Tool[]} */
export const TOOLS = [
  {
    name: "apple_status",
    title: "权限状态",
    description: "查看 Agent Loft Bridge 对日历、提醒事项、备忘录、通讯录、照片、邮件的授权情况，哪些应用开着（enabled），以及删改前是否要在 Mac 上确认。calendars / reminders / contacts / photos 应该是 fullAccess（limited 是只给了一部分），notes / mail 应该是 granted（App 没运行时是 unknown，不代表有问题）。不对的话请用户打开 Agent Loft 桌面端 → 设置 → 苹果应用 处理。",
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

  // ---------- 通讯录 ----------
  {
    name: "contacts_search",
    title: "搜索联系人",
    description: "按姓名、公司、邮箱或电话号码片段（至少 3 位数字）搜索联系人；不给 query 列出全部。返回姓名、电话、邮箱，详情用 contacts_get。",
    cmd: ["contacts", "search"],
    props: { query: str("关键词"), limit: int("最多返回几条，默认 50") },
    annotations: READ,
  },
  {
    name: "contacts_get",
    title: "联系人详情",
    description: "读一个联系人的全部信息：电话、邮箱、地址、生日、公司、职位、网址。",
    cmd: ["contacts", "get"],
    props: { id: ID("联系人") },
    required: ["id"],
    annotations: READ,
  },
  {
    name: "contacts_list_groups",
    title: "列出联系人分组",
    description: "列出通讯录里的分组。",
    cmd: ["contacts", "groups"],
    annotations: READ,
  },
  {
    name: "contacts_add",
    title: "新建联系人",
    description: "新建联系人，given_name、family_name、organization 至少给一个。",
    cmd: ["contacts", "add"],
    props: {
      given_name: str("名"),
      family_name: str("姓"),
      nickname: str("昵称"),
      organization: str("公司"),
      job_title: str("职位"),
      birthday: str("生日：YYYY-MM-DD，不知道年份写 MM-DD"),
      phones: labeled("电话"),
      emails: labeled("邮箱"),
      urls: labeled("网址"),
    },
    annotations: WRITE,
  },
  {
    name: "contacts_update",
    title: "修改联系人",
    description: `修改联系人，只改传了的字段。phones / emails / urls 传了就整个替换，要保留原来的先用 contacts_get 读出来再合并；birthday 传 none 清除。${CONFIRM}`,
    cmd: ["contacts", "update"],
    props: {
      id: ID("联系人"),
      given_name: str("名"),
      family_name: str("姓"),
      nickname: str("昵称"),
      organization: str("公司"),
      job_title: str("职位"),
      birthday: str("生日：YYYY-MM-DD 或 MM-DD，none 清除"),
      phones: labeled("电话"),
      emails: labeled("邮箱"),
      urls: labeled("网址"),
    },
    required: ["id"],
    annotations: DESTRUCTIVE,
    timeout: 180_000,
  },
  {
    name: "contacts_delete",
    title: "删除联系人",
    description: `删除联系人，删了不能恢复，iCloud 上也一起删。${CONFIRM}`,
    cmd: ["contacts", "delete"],
    props: { id: ID("联系人") },
    required: ["id"],
    annotations: DESTRUCTIVE,
    timeout: 180_000,
  },

  // ---------- 照片（只读） ----------
  {
    name: "photos_list_albums",
    title: "列出相册",
    description: "列出相簿和有内容的智能相册（个人收藏、视频、截屏……）及张数。",
    cmd: ["photos", "albums"],
    annotations: READ,
  },
  {
    name: "photos_search",
    title: "找照片",
    description: "按时间、相册、类型、收藏、地点找照片和视频，默认从新到旧 50 张（最多 200），用 offset 翻页。只返回信息（时间、尺寸、地点坐标、文件名），要看内容用 photos_get_thumbnails。没法按人物或画面内容搜。",
    cmd: ["photos", "search"],
    props: {
      from: str(`拍摄时间不早于，${DATE}`),
      to: str("拍摄时间不晚于（只写日期时包含当天）"),
      album: str("相册名称或 id"),
      type: str("类型", { enum: ["image", "video", "all"] }),
      favorite: bool("只要收藏的"),
      near: str("在这个坐标附近：'纬度,经度'，例如 '31.2304,121.4737'"),
      radius: str("配合 near：半径（公里），默认 1"),
      order: str("排序", { enum: ["newest", "oldest"] }),
      offset: { type: "integer", minimum: 0, description: "跳过前几张（翻页）" },
      limit: int("最多返回几张，默认 50，最多 200"),
    },
    annotations: READ,
  },
  {
    name: "photos_get_thumbnails",
    title: "看照片",
    description: "取照片的缩略图（JPEG），直接作为图片返回，一次最多 10 张。原图在 iCloud 上时会先下载，可能要等一会儿。",
    cmd: ["photos", "thumbnails"],
    props: { ids: strList("照片 id（photos_search 结果里的），最多 10 个"), size: { type: "integer", minimum: 64, maximum: 1024, description: "最长边像素，默认 512" } },
    required: ["ids"],
    annotations: READ,
    images: true,
    timeout: 180_000,
  },
  {
    name: "photos_export",
    title: "导出原图",
    description: "把原图 / 原视频导出到这台 Mac 上的一个目录（不存在会新建，同名文件不覆盖，自动加编号），一次最多 200 个。iCloud 上的会先下载。",
    cmd: ["photos", "export"],
    props: { ids: strList("照片 id"), out: str("导出到哪个目录，例如 ~/Desktop/导出的照片") },
    required: ["ids", "out"],
    annotations: { ...WRITE, idempotentHint: false },
    timeout: 10 * 60_000,
  },

  // ---------- 邮件（只读 + 起草） ----------
  {
    name: "mail_list_accounts",
    title: "列出邮件账户",
    description: "列出「邮件」App 里的账户、各邮箱（文件夹）路径和未读数。",
    cmd: ["mail", "accounts"],
    annotations: READ,
    timeout: 120_000,
  },
  {
    name: "mail_search",
    title: "搜邮件",
    description: "搜邮件，从新到旧，默认 20 封。不给 mailbox 就搜所有账户的收件箱。query 匹配主题，from 匹配发件人。大邮箱会慢一些。",
    cmd: ["mail", "search"],
    props: {
      query: str("主题里包含"),
      from: str("发件人里包含（名字或地址）"),
      mailbox: str("邮箱路径，例如 INBOX、已发送、归档/2026（见 mail_list_accounts）"),
      account: str("账户名"),
      since: str("收到时间不早于：YYYY-MM-DD / today / yesterday"),
      unread: bool("只要未读的"),
      limit: int("最多返回几封，默认 20，最多 100"),
    },
    annotations: READ,
    timeout: 180_000,
  },
  {
    name: "mail_read",
    title: "读邮件",
    description: "读一封邮件的纯文本正文、收件人、附件名。不会把邮件标成已读以外的状态。",
    cmd: ["mail", "read"],
    props: { id: ID("邮件"), max_chars: int("正文最多返回多少字，默认 20000") },
    required: ["id"],
    annotations: READ,
    timeout: 120_000,
  },
  {
    name: "mail_create_draft",
    title: "起草邮件",
    description: "起草一封邮件，存进草稿箱，**不会发送**：告诉用户去「邮件」App 的草稿箱里检查后自己发。",
    cmd: ["mail", "draft"],
    props: {
      to: str("收件人，多个用逗号分隔"),
      cc: str("抄送，多个用逗号分隔"),
      bcc: str("密送，多个用逗号分隔"),
      subject: str("主题"),
      body: str("正文（纯文本）"),
      account: str("用哪个账户发（账户名）"),
    },
    required: ["to", "subject"],
    annotations: WRITE,
    timeout: 120_000,
  },
];

/** 工具属于哪个应用（apple_status 不属于任何一个，一直在） */
const SERVICE_PREFIX = { calendar: "calendars", reminders: "reminders", notes: "notes", contacts: "contacts", photos: "photos", mail: "mail" };
export const serviceOf = (name) => SERVICE_PREFIX[name.split("_")[0]] ?? null;

const byName = new Map(TOOLS.map((t) => [t.name, t]));

/** tools/list 里的样子；enabled 是各应用开没开，关掉的不列 */
export function toolList(enabled = null) {
  return TOOLS.filter((t) => !enabled || !serviceOf(t.name) || enabled[serviceOf(t.name)]).map((t) => ({
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
 * @returns {{ args: string[], timeout: number, images: boolean }}
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
      const min = prop.minimum ?? 1;
      if (!Number.isInteger(v) || v < min || (prop.maximum !== undefined && v > prop.maximum)) throw new Error(`参数 ${k} 要是${min === 0 ? "非负" : "正"}整数${prop.maximum !== undefined ? `，最大 ${prop.maximum}` : ""}`);
      text = String(v);
    } else if (prop.type === "array") {
      if (!Array.isArray(v) || v.length > (prop.maxItems ?? 200)) throw new Error(`参数 ${k} 要是数组，最多 ${prop.maxItems ?? 200} 项`);
      const item = prop.items;
      for (const x of v) {
        if (item.type === "string" ? typeof x !== "string" : !x || typeof x !== "object" || typeof x.value !== "string" || (x.label !== undefined && typeof x.label !== "string")) {
          throw new Error(`参数 ${k} 的每一项格式不对`);
        }
      }
      // Bridge 那边按 JSON 数组解析
      text = JSON.stringify(item.type === "string" ? v : v.map((x) => ({ label: x.label ?? "", value: x.value })));
    } else {
      if (typeof v !== "string") throw new Error(`参数 ${k} 要是字符串`);
      if (prop.enum && !prop.enum.includes(v)) throw new Error(`参数 ${k} 只能是 ${prop.enum.join(" / ")}`);
      if (v.length > 200_000) throw new Error(`参数 ${k} 太长了`);
      text = v;
    }
    args.push(`${flag}=${text}`);
  }
  return { args, timeout: tool.timeout ?? 60_000, images: !!tool.images };
}
