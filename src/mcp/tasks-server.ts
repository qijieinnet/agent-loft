// 定时任务工具的 MCP 服务（stdio）：给 agent 用的 list / create / update / delete。
// 环境变量 AGENT_LOFT_TOOLSET=skills 时换成技能工具（list / get / create / update_skill），走同一条通道。
//
// 这里只是个传话的：每次调用原样转给主进程（core/tasks-bridge.ts，经 unix socket），带上拉起时
// 定死的用户、对话和签名（见 core/tasks-mcp.ts）。校验、授权卡、真正的增删改都在主进程里做。
//
// 和记忆工具一样只实现 MCP 里用得到的那一小块；stdout 只能写协议消息，日志一律走 stderr。
import net from "node:net";

const socketPath = process.env.AGENT_LOFT_TASKS_SOCKET ?? "";
const caller = {
  user: process.env.AGENT_LOFT_TASKS_USER ?? "",
  conv: process.env.AGENT_LOFT_TASKS_CONV ?? "",
  sig: process.env.AGENT_LOFT_TASKS_SIG ?? "",
};
const tz = process.env.AGENT_LOFT_TZ || "服务端本地时区";

type Request = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

const SCHEDULE = {
  type: "object",
  description:
    `什么时候运行，时间一律按 ${tz} 解释。kind 选一种：` +
    "once（一次：at 写「YYYY-MM-DD HH:MM」，或者 in_minutes 写多少分钟后）、" +
    "daily（每天 time）、weekdays（工作日 time）、weekly（每周 days 的 time，days 里 0=周日…6=周六）、" +
    "monthly（每月 day 日的 time）、hourly（每 every 小时一次，在第 minute 分）、cron（5 段 cron 表达式 expr）。" +
    "time 写「HH:MM」。两次运行至少隔 15 分钟。",
  properties: {
    kind: { type: "string", enum: ["once", "daily", "weekdays", "weekly", "monthly", "hourly", "cron"] },
    at: { type: "string", description: "once：运行时间，「YYYY-MM-DD HH:MM」" },
    in_minutes: { type: "number", description: "once：多少分钟之后（和 at 二选一）" },
    time: { type: "string", description: "daily / weekdays / weekly / monthly：几点，「HH:MM」" },
    days: { type: "array", items: { type: "integer" }, description: "weekly：星期几，0=周日 … 6=周六" },
    day: { type: "integer", description: "monthly：几号（1-31）" },
    every: { type: "integer", description: "hourly：每几小时（1-23）" },
    minute: { type: "integer", description: "hourly：第几分（0-59）" },
    expr: { type: "string", description: "cron：分 时 日 月 周" },
  },
  required: ["kind"],
  additionalProperties: false,
};

const TOOLS = [
  {
    name: "list_tasks",
    description: "列出用户的定时任务（id、名称、频率、下次运行时间、最近一次结果），同时返回现在的时间。改、删任务之前先用它拿到 id。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "查看定时任务", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "create_task",
    description:
      "给用户建一个定时任务：到点 agent 会收到 prompt 并照着做，结果默认回到当前这条对话。用户说「每天 / 每周 / 明早 / 两小时后帮我……」时用。" +
      "notify 默认 smart：每次运行时由 agent 自己判断有没有需要告诉用户的事，没有就不提醒（适合「有更新才告诉我」）；always：每次都提醒。" +
      "prompt 要写成到点时独立可执行的完整指令（那时用户不在，不能再问他），需要对比时写清楚怎么判断（比如「和上次的结果比」「新版本号大于当前版本才算更新」）。" +
      "调用后会弹授权卡给用户确认，确认了才会建。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "简短的名称，比如「检查 agent-loft 更新」" },
        prompt: { type: "string", description: "到点时发给 agent 的完整指令" },
        schedule: SCHEDULE,
        notify: { type: "string", enum: ["smart", "always"], description: "smart：有需要才提醒（默认）；always：每次都提醒" },
        reply_to: {
          type: "string",
          enum: ["this_conversation", "dedicated"],
          description: "this_conversation：结果回到当前对话（默认）；dedicated：给任务单独开一条对话（和当前对话用同一个专家）",
        },
      },
      required: ["prompt", "schedule"],
      additionalProperties: false,
    },
    annotations: { title: "新建定时任务", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "update_task",
    description: "修改用户的一个定时任务：改名称、提示词、频率、提醒方式，或者暂停 / 恢复（enabled）。只给要改的字段。除了暂停以外的修改会弹授权卡让用户确认。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "任务 id（list_tasks 里的），形如 t_1a2b3c4d5e" },
        title: { type: "string" },
        prompt: { type: "string" },
        schedule: SCHEDULE,
        notify: { type: "string", enum: ["smart", "always"] },
        enabled: { type: "boolean", description: "false 暂停，true 恢复" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { title: "修改定时任务", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "delete_task",
    description: "删掉用户的一个定时任务（用户要求删除 / 取消时用；只是暂时不想运行的话用 update_task 暂停）。会弹授权卡让用户确认。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "任务 id" } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { title: "删除定时任务", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

// ---------- 技能工具（AGENT_LOFT_TOOLSET=skills 时只报这几个） ----------

const VARS = {
  type: "array",
  description:
    "技能要用的环境变量（API 地址、密钥之类）。值由用户自己在网页上填，运行时注入到他的会话环境里，SKILL.md 里用 $NAME 引用。" +
    "变量名用大写字母、数字和 _，最好带上技能相关的前缀（比如 WEATHER_API_KEY）。",
  items: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string", description: "给用户看的说明：这是什么、去哪里拿" },
      secret: { type: "boolean", description: "密钥、令牌之类：网页上不回显" },
      required: { type: "boolean" },
      hosts: {
        type: "array",
        items: { type: "string" },
        description:
          "secret 时建议给：这个密钥只允许发往的地址（域名或 IP，可带端口，比如 api.example.com）。给了就是受保护的密钥：不放进环境变量，agent 看不到值，" +
          "只能用 skill_request 工具在请求里写 {{NAME}} 由 agent-loft 代发。这时 body 里要写成用 skill_request 调用，而不是 curl $NAME。",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

const FILES = {
  type: "array",
  description: "技能附带的文件（脚本、模板、参考资料），路径相对技能目录，比如 scripts/fetch.sh。只支持文本。",
  items: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

const SKILL_TOOLS = [
  {
    name: "list_skills",
    description: "列出用户在 agent-loft 里启用着的技能（名字、说明、谁建的、变量配没配）。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "查看技能", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_skill",
    description: "读一个技能的 SKILL.md 和附带文件清单；给 file 时读那个附带文件。改技能之前先读。",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "技能名" }, file: { type: "string", description: "附带文件的相对路径（可选）" } },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { title: "读技能", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "create_skill",
    description:
      "把一套做事的方法存成用户的技能（agent-loft 管理，Claude Code 和 Codex 都能用；格式同 Claude Code 的 SKILL.md）。" +
      "用户说「把这个做成技能 / 以后都这么做 / 存成 skill」时用。写法：description 一句话说清什么时候该用它（agent 靠它判断）；" +
      "body 是给 agent 的操作说明（Markdown），步骤具体、可以直接照做；要调接口的，把地址、密钥做成 vars，body 里用 $NAME 引用，不要把真实的密钥写进去。" +
      "调用后会弹授权卡给用户确认。建好后只有用户自己看得到，下一轮起可用。不要写到 ~/.claude/skills 之类的目录里，那是机器上的，只有管理员能用。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "技能名：小写字母、数字和 -，最长 48 个字符，全站唯一" },
        description: { type: "string", description: "什么时候用这个技能（一两句话）" },
        body: { type: "string", description: "SKILL.md 的正文（不含 frontmatter）" },
        files: FILES,
        vars: VARS,
      },
      required: ["name", "description", "body"],
      additionalProperties: false,
    },
    annotations: { title: "新建技能", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "skill_request",
    description:
      "替你发一个 HTTP 请求，url、headers、body 里的 {{变量名}} 由 agent-loft 换成用户在技能里填的值 —— 你看不到密钥本身。" +
      "技能里的受保护密钥（list_skills 里标了「受保护」的）只能这样用，而且只能发往用户确认过的地址；普通变量也可以这样用。" +
      "不跟随跳转；响应里出现的变量值会被抹掉；最多返回 256KB 文本。",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"], description: "默认 GET" },
        url: { type: "string", description: "完整地址，比如 https://api.example.com/v1/weather?city=北京&key={{WEATHER_API_KEY}}" },
        headers: { type: "object", additionalProperties: { type: "string" }, description: "比如 { \"Authorization\": \"Bearer {{MY_TOKEN}}\" }" },
        body: { type: "string", description: "请求体（JSON 记得自己序列化，并带上 content-type）" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    // openWorldHint 不标：Codex 见到它会先弹 MCP 审批（agent-loft 不接，等于拒绝）。能发往哪里由 agent-loft 自己卡着
    annotations: { title: "代发请求", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "update_skill",
    description: "修改用户自己建的一个技能：说明、正文、附带文件、变量，只给要改的。会弹授权卡让用户确认。分享出去的技能改了之后，装了的人也会用上新的。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "技能名（不能改名）" },
        description: { type: "string" },
        body: { type: "string", description: "新的 SKILL.md 正文（整段替换）" },
        files: FILES,
        delete_files: { type: "array", items: { type: "string" }, description: "要删掉的附带文件" },
        vars: VARS,
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { title: "修改技能", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

const skillsOnly = process.env.AGENT_LOFT_TOOLSET === "skills";
const ACTIVE = skillsOnly ? SKILL_TOOLS : TOOLS;

function text(t: string, isError = false) {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

/** 转给主进程，等它回一行 JSON */
function forward(tool: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  return new Promise((resolve) => {
    if (!socketPath || !caller.user || !caller.conv) {
      resolve({ text: `${skillsOnly ? "技能" : "定时任务"}工具没有正确配置（缺少用户或对话）。`, isError: true });
      return;
    }
    const sock = net.createConnection(socketPath);
    let buf = "";
    let done = false;
    const finish = (r: { text: string; isError?: boolean }) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(r);
    };
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(`${JSON.stringify({ ...caller, tool, args })}\n`));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const n = buf.indexOf("\n");
      if (n < 0) return;
      try {
        const res = JSON.parse(buf.slice(0, n)) as { text?: string; isError?: boolean };
        finish({ text: String(res.text ?? ""), ...(res.isError ? { isError: true } : {}) });
      } catch {
        finish({ text: "agent-loft 返回的内容看不懂。", isError: true });
      }
    });
    sock.on("error", (err) => finish({ text: `连不上 agent-loft（${err.message}）。它可能刚重启过，开个新会话再试。`, isError: true }));
    sock.on("close", () => finish({ text: "agent-loft 断开了连接。", isError: true }));
  });
}

async function handle(req: Request): Promise<unknown> {
  switch (req.method) {
    case "initialize":
      return {
        protocolVersion: typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: skillsOnly ? "agent-loft-skills" : "agent-loft-tasks", version: "1.0.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: ACTIVE };
    case "tools/call": {
      const params = req.params ?? {};
      const name = String(params.name ?? "");
      if (!ACTIVE.some((t) => t.name === name)) return text(`没有工具 ${name}`, true);
      const res = await forward(name, (params.arguments as Record<string, unknown> | undefined) ?? {});
      return text(res.text, !!res.isError);
    }
    default:
      throw Object.assign(new Error(`不支持 ${req.method}`), { code: -32601 });
  }
}

function reply(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function onLine(line: string): void {
  if (!line.trim()) return;
  let req: Request;
  try {
    req = JSON.parse(line) as Request;
  } catch {
    reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败" } });
    return;
  }
  const isRequest = req.id !== undefined && req.id !== null;
  // 不按顺序等：一个调用在等授权卡的时候，ping 之类照样要回
  handle(req).then(
    (result) => {
      if (isRequest) reply({ jsonrpc: "2.0", id: req.id, result });
    },
    (err) => {
      if (!isRequest) return;
      const code = (err as { code?: number }).code ?? -32603;
      reply({ jsonrpc: "2.0", id: req.id, error: { code, message: err instanceof Error ? err.message : String(err) } });
    },
  );
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let n: number;
  while ((n = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, n);
    buf = buf.slice(n + 1);
    onLine(line);
  }
});
process.stdin.on("end", () => process.exit(0));
