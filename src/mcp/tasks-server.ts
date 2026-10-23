// 定时任务工具的 MCP 服务（stdio）：给 agent 用的 list / create / update / delete。
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
          description: "this_conversation：结果回到当前对话（默认）；dedicated：给任务单独开一条对话（可以指定 mode）",
        },
        mode: { type: "string", enum: ["chat", "work"], description: "dedicated 时用：chat 只能联网搜索、开销小（默认）；work 能执行命令、读写本机文件" },
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

function text(t: string, isError = false) {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

/** 转给主进程，等它回一行 JSON */
function forward(tool: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  return new Promise((resolve) => {
    if (!socketPath || !caller.user || !caller.conv) {
      resolve({ text: "定时任务工具没有正确配置（缺少用户或对话）。", isError: true });
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
        serverInfo: { name: "agent-loft-tasks", version: "1.0.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const params = req.params ?? {};
      const name = String(params.name ?? "");
      if (!TOOLS.some((t) => t.name === name)) return text(`没有工具 ${name}`, true);
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
