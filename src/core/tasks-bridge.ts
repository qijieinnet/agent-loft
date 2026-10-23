// 主进程这头的定时任务工具：mcp/tasks-server.ts 经 unix socket 把 agent 的调用转过来，这里核对身份、
// 弹授权卡、真正增删改。
//
// 几条规矩：
//   - 身份只认拉起时签过名的（用户 + 对话），而且这条对话现在还得是这个人的；只碰得到他自己的任务；
//   - 新建、修改、删除（暂停除外）一律弹授权卡让用户确认：定时任务等于「以后在没人看着的时候执行一段指令」，
//     agent 读到的网页里要是藏着「帮我建个每小时跑的任务」，不能就这么建了；卡上没有「总是允许」；
//   - 定时任务自己跑的那一轮里不能建、改、删任务，免得一个任务生出一串任务。
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { config } from "./config.js";
import { hub } from "./hub.js";
import { interactions } from "./interactions.js";
import { memoryOwnerOf } from "./personal.js";
import { getConversation } from "./store.js";
import { forgetTask } from "./task-runner.js";
import { describeSchedule, formatDateTime, nextRun, normalizeSchedule, parseLocalDateTime, serverTimeZone, type TaskSchedule } from "./task-schedule.js";
import { TASK_TOOL_TIMEOUT_SEC, tasksSocketPath, verifyTaskCaller } from "./tasks-mcp.js";
import { createTask, deleteTask, getTask, listTasks, TASKS_PER_USER, updateTask, type Task, type TaskInput } from "./tasks.js";
import { getUser } from "./users.js";
import { SKILL_TOOL_NAMES, skillToolCall } from "./skills-bridge.js";

type Reply = { text: string; isError?: boolean };
const fail = (text: string): Reply => ({ text, isError: true });

const STATUS: Record<string, string> = {
  running: "运行中",
  notified: "已提醒",
  silent: "无需提醒",
  error: "出错",
  skipped: "跳过",
  interrupted: "中断",
};

/** agent 给的频率：「一次」的时间是字符串或者「多少分钟后」，换成时间戳再校验 */
function scheduleArg(raw: unknown, now: number): TaskSchedule {
  const r = { ...((raw ?? {}) as Record<string, unknown>) };
  if (r.kind === "once") {
    r.at = r.in_minutes !== undefined ? now + Number(r.in_minutes) * 60_000 : parseLocalDateTime(String(r.at ?? ""));
  }
  return normalizeSchedule(r, now);
}

function whereText(task: Task, convKey: string): string {
  if (task.target.kind === "dedicated") return "专用对话";
  if (task.target.key === convKey) return "这条对话";
  return `对话「${getConversation(task.target.key)?.title ?? "未命名"}」`;
}

function describeTask(task: Task, convKey: string): string {
  const last = task.runs[0];
  return [
    `- [${task.id}]「${task.title}」${describeSchedule(task.schedule)}`,
    task.enabled && task.nextRunAt ? `下次 ${formatDateTime(task.nextRunAt)}` : "已暂停",
    task.notify === "smart" ? "有需要才提醒" : "每次都提醒",
    `结果发到${whereText(task, convKey)}`,
    ...(last ? [`最近一次 ${formatDateTime(last.at)} ${STATUS[last.status] ?? last.status}${last.preview ? `：${last.preview}` : last.note ? `（${last.note}）` : ""}`] : []),
  ].join(" · ") + `\n  提示词：${task.prompt.replace(/\s+/g, " ").slice(0, 200)}`;
}

/** 弹授权卡，等用户点。返回 true 表示同意 */
async function confirm(convKey: string, title: string, detail: string): Promise<boolean> {
  const timeout = Math.min(config().approvalTimeoutMs, (TASK_TOOL_TIMEOUT_SEC - 60) * 1000);
  const outcome = await interactions.create(convKey, { kind: "approval", title, detail }, timeout, hub.liveSessionId(convKey));
  return outcome.settlement === "allow-once" || outcome.settlement === "allow-always" || outcome.settlement === "allow-session";
}

function card(fields: { schedule?: TaskSchedule; notify?: string; where?: string; mode?: string; prompt?: string; enabled?: boolean }, now: number): string {
  const lines: string[] = [];
  if (fields.schedule) {
    const next = nextRun(fields.schedule, now);
    lines.push(`**频率**：${describeSchedule(fields.schedule)}（${serverTimeZone()}）`);
    if (next) lines.push(`**下次运行**：${formatDateTime(next)}`);
  }
  if (fields.notify) lines.push(`**提醒**：${fields.notify === "always" ? "每次都提醒" : "有需要才提醒（由 agent 判断）"}`);
  if (fields.where) lines.push(`**结果发到**：${fields.where}`);
  if (fields.mode) lines.push(`**模式**：${fields.mode === "work" ? "工作模式（能执行命令、读写文件）" : "聊天模式（只能联网搜索）"}`);
  if (fields.enabled !== undefined) lines.push(`**状态**：${fields.enabled ? "恢复运行" : "暂停"}`);
  if (fields.prompt) lines.push("", "**到点要做的事**：", "", ...fields.prompt.split("\n").map((l) => `> ${l}`));
  return lines.join("\n");
}

async function call(userId: string, convKey: string, tool: string, args: Record<string, unknown>): Promise<Reply> {
  const user = getUser(userId);
  if (!user || user.disabled) return fail("账号已停用。");
  const conv = getConversation(convKey);
  if (!conv || memoryOwnerOf(conv) !== user.id) return fail("这条对话不属于当前用户，不能管理定时任务。");
  // 技能工具走的也是这条通道（见 tasks-mcp.ts 的 skillsMcpSpawn）
  if (SKILL_TOOL_NAMES.includes(tool)) return skillToolCall(user.id, convKey, tool, args);
  const now = Date.now();
  const inTaskTurn = !!hub.currentTaskTurn(convKey);

  if (tool === "list_tasks") {
    const tasks = listTasks(user.id);
    const head = `现在是 ${formatDateTime(now)}（${serverTimeZone()}）。`;
    if (tasks.length === 0) return { text: `${head}用户还没有定时任务。` };
    return { text: `${head}用户有 ${tasks.length} 个定时任务（最多 ${TASKS_PER_USER} 个）：\n\n${tasks.map((t) => describeTask(t, convKey)).join("\n")}` };
  }

  if (inTaskTurn) return fail("这一轮是定时任务自己在运行，不能在这里新建、修改或删除定时任务。需要的话告诉用户，让他来操作。");

  if (tool === "create_task") {
    if (listTasks(user.id).length >= TASKS_PER_USER) return fail(`用户已经有 ${TASKS_PER_USER} 个定时任务了，到上限了，请他先删掉几个。`);
    let schedule: TaskSchedule;
    try {
      schedule = scheduleArg(args.schedule, now);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    const prompt = String(args.prompt ?? "").trim();
    if (!prompt) return fail("prompt 不能为空。");
    const dedicated = args.reply_to === "dedicated";
    const mode = dedicated ? (args.mode === "work" ? "work" : "chat") : (conv.mode ?? "work");
    const input: TaskInput = {
      title: args.title,
      prompt,
      schedule,
      notify: args.notify === "always" ? "always" : "smart",
      target: dedicated ? { kind: "dedicated" } : { kind: "conv", key: convKey },
      agent: conv.agent,
      cwd: conv.cwd,
      mode,
    };
    const title = String(args.title ?? "").trim() || prompt.replace(/\s+/g, " ").slice(0, 60);
    const ok = await confirm(
      convKey,
      `新建定时任务「${title}」`,
      card({ schedule, notify: String(input.notify), where: dedicated ? "单独开一条对话" : "这条对话", ...(dedicated ? { mode } : {}), prompt }, now),
    );
    if (!ok) return fail("用户没有同意，任务没有建。");
    try {
      const task = createTask(user.id, input, "agent");
      return {
        text: `已建好 [${task.id}]「${task.title}」：${describeSchedule(task.schedule)}，${task.nextRunAt ? `下次 ${formatDateTime(task.nextRunAt)}` : "没有下次"}。用户可以在网页侧栏「定时任务」里查看和修改。`,
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  const id = String(args.id ?? "").trim();
  const task = getTask(user.id, id);
  if (!task) return fail(`没有 id 为 ${id} 的定时任务。先用 list_tasks 看看。`);

  if (tool === "delete_task") {
    // 删了就找不回来：也要用户点一下（只是暂停的话不用问，见下面）
    const ok = await confirm(
      convKey,
      `删除定时任务「${task.title}」`,
      `${card({ schedule: task.schedule, prompt: task.prompt }, now)}\n\n删除后不会再运行，之前运行的结果还留在对话里。`,
    );
    if (!ok) return fail("用户没有同意，任务没有删。");
    // 等用户点卡片的时候，任务可能已经在网页上删掉了
    if (!deleteTask(user.id, task.id)) return fail("这个任务已经不在了。");
    forgetTask(task);
    return { text: `已删掉「${task.title}」。` };
  }

  if (tool === "update_task") {
    const patch: TaskInput = {};
    try {
      if (args.schedule !== undefined) patch.schedule = scheduleArg(args.schedule, now);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    if (args.title !== undefined) patch.title = args.title;
    if (args.prompt !== undefined) patch.prompt = args.prompt;
    if (args.notify !== undefined) patch.notify = args.notify;
    if (args.enabled !== undefined) patch.enabled = args.enabled === true;
    if (Object.keys(patch).length === 0) return fail("没有要改的字段。");
    // 只是暂停：不会让它多跑什么，不用问
    const pauseOnly = Object.keys(patch).length === 1 && patch.enabled === false;
    if (!pauseOnly) {
      const ok = await confirm(
        convKey,
        `修改定时任务「${task.title}」`,
        card(
          {
            ...(patch.schedule ? { schedule: patch.schedule as TaskSchedule } : {}),
            ...(patch.notify !== undefined ? { notify: String(patch.notify) } : {}),
            ...(patch.enabled !== undefined ? { enabled: patch.enabled === true } : {}),
            ...(patch.prompt !== undefined ? { prompt: String(patch.prompt) } : {}),
          },
          now,
        ) + (patch.title !== undefined ? `\n\n**新名称**：${String(patch.title)}` : ""),
      );
      if (!ok) return fail("用户没有同意，任务没有改。");
    }
    try {
      const updated = updateTask(user.id, task.id, patch);
      return {
        text: `已改好「${updated.title}」：${describeSchedule(updated.schedule)}，${updated.enabled && updated.nextRunAt ? `下次 ${formatDateTime(updated.nextRunAt)}` : "已暂停"}。`,
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
  return fail(`没有工具 ${tool}`);
}

let server: net.Server | null = null;

export function startTasksBridge(): void {
  if (server) return;
  fs.mkdirSync(path.dirname(tasksSocketPath), { recursive: true, mode: 0o700 });
  // 上次没收拾干净留下的 socket 文件：不删的话 listen 会报 EADDRINUSE
  fs.rmSync(tasksSocketPath, { force: true });
  server = net.createServer((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const n = buf.indexOf("\n");
      if (n < 0) {
        // 技能工具会带着整份 SKILL.md 和附带文件过来，放宽到 8MB
        if (buf.length > 8 * 1024 * 1024) sock.destroy();
        return;
      }
      const line = buf.slice(0, n);
      buf = "";
      void (async () => {
        let reply: Reply;
        try {
          const req = JSON.parse(line) as { user?: string; conv?: string; sig?: string; tool?: string; args?: Record<string, unknown> };
          const userId = String(req.user ?? "");
          const convKey = String(req.conv ?? "");
          if (!verifyTaskCaller(userId, convKey, String(req.sig ?? ""))) {
            reply = fail("身份校验没通过（agent-loft 可能重启过），开个新会话再试。");
          } else {
            reply = await call(userId, convKey, String(req.tool ?? ""), req.args && typeof req.args === "object" ? req.args : {});
          }
        } catch (err) {
          console.error("[定时任务] 处理工具调用出错:", err);
          reply = fail(err instanceof Error ? err.message : String(err));
        }
        if (!sock.destroyed) sock.end(`${JSON.stringify(reply)}\n`);
      })();
    });
  });
  server.on("error", (err) => console.error(`[定时任务] 工具通道出错（agent 暂时用不了定时任务工具）：${err.message}`));
  server.listen(tasksSocketPath, () => {
    try {
      fs.chmodSync(tasksSocketPath, 0o600);
    } catch {
      // 改不了权限也不影响：调用都要带签名
    }
  });
}

export function stopTasksBridge(): void {
  server?.close();
  server = null;
  fs.rmSync(tasksSocketPath, { force: true });
}
