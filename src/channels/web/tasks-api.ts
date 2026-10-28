// 定时任务页面的接口：/api/tasks。每个人只看得到、改得了自己的任务（别人的一律当不存在）。
import type { IncomingMessage, ServerResponse } from "node:http";
import { config, resolveWorkspacePath } from "../../core/config.js";
import { canUseExpert, getExpert, isBuiltin } from "../../core/experts.js";
import { hub } from "../../core/hub.js";
import { memoryOwnerOf } from "../../core/personal.js";
import { getConversation } from "../../core/store.js";
import { forgetTask, isTaskRunning, runTaskNow } from "../../core/task-runner.js";
import { serverTimeZone } from "../../core/task-schedule.js";
import { createTask, deleteTask, getTask, listTasks, updateTask, viewOf, type Task, type TaskInput } from "../../core/tasks.js";
import type { User } from "../../core/users.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";

function view(task: Task) {
  const key = task.target.key;
  const conv = key ? getConversation(key) : undefined;
  return {
    ...viewOf(task),
    running: isTaskRunning(task.id),
    // 结果在哪条对话里看（专用对话第一次运行前还没有）
    ...(conv && !conv.hidden ? { convKey: conv.key, convTitle: conv.title ?? "" } : {}),
  };
}

/** 表单 / 请求里的字段先在这里核一遍：专家要是自己能用的、引擎要启用着，目录要在工作区里，对话要是自己的 */
function checkInput(user: User, body: TaskInput): TaskInput {
  const out: TaskInput = { ...body };
  const pick = body.expert ?? body.agent;
  if (pick !== undefined) {
    const id = String(pick);
    if (!canUseExpert(user.id, id)) throw new HttpError(400, "这个专家不存在");
    const agent = isBuiltin(id) ? id : getExpert(id)!.engine;
    if (!hub.enabledAgents().some((d) => d.id === agent)) throw new HttpError(400, `${hub.label(agent)} 没有启用`);
  }
  if (typeof body.cwd === "string" && body.cwd.trim()) {
    const cwd = resolveWorkspacePath(body.cwd.trim());
    if (!cwd) throw new HttpError(400, `目录必须存在，且在 ${config().workspaceRoot} 之内`);
    out.cwd = cwd === config().workspaceRoot ? "" : cwd;
  }
  const target = body.target as { kind?: string; key?: string } | undefined;
  if (target?.kind === "conv") {
    const conv = target.key ? getConversation(target.key) : undefined;
    if (!conv || conv.hidden || memoryOwnerOf(conv) !== user.id) throw new HttpError(400, "回复到的那条对话不存在了，改成专用对话吧");
  }
  return out;
}

const bad = (err: unknown) => (err instanceof HttpError ? err : new HttpError(400, err instanceof Error ? err.message : String(err)));

/** 处理了就返回 true */
export async function handleTasksApi(req: IncomingMessage, res: ServerResponse, p: string, user: User): Promise<boolean> {
  const method = req.method ?? "GET";
  if (p === "/api/tasks" && method === "GET") {
    sendJson(res, 200, { tasks: listTasks(user.id).map(view), tz: serverTimeZone(), now: Date.now() });
    return true;
  }
  if (p === "/api/tasks" && method === "POST") {
    const body = await readJsonBody<TaskInput>(req);
    // 没选专家：用第一个启用着的内置专家，不能默认成一个可能没启用的
    if (!body.expert && !body.agent) body.expert = hub.enabledAgents()[0]?.id;
    let task: Task;
    try {
      task = createTask(user.id, checkInput(user, body), "user");
    } catch (err) {
      throw bad(err);
    }
    sendJson(res, 200, view(task));
    return true;
  }
  const m = /^\/api\/tasks\/([^/]+)(?:\/(run))?$/.exec(p);
  if (!m) return false;
  const task = getTask(user.id, decodeURIComponent(m[1]!));
  if (!task) throw new HttpError(404, "这个任务不存在");
  if (m[2] === "run" && method === "POST") {
    const error = runTaskNow(task);
    if (error) throw new HttpError(409, error);
    sendJson(res, 200, view(task));
    return true;
  }
  if (!m[2] && method === "PATCH") {
    const body = await readJsonBody<TaskInput>(req);
    let updated: Task;
    try {
      updated = updateTask(user.id, task.id, checkInput(user, body));
    } catch (err) {
      throw bad(err);
    }
    sendJson(res, 200, view(updated));
    return true;
  }
  if (!m[2] && method === "DELETE") {
    deleteTask(user.id, task.id);
    forgetTask(task);
    sendJson(res, 200, { ok: true });
    return true;
  }
  return false;
}
