// 定时任务：到点让 agent 按一段提示词干活，结果回到一条对话里；agent 自己判断要不要提醒用户。
//
// 和「定时发送」（scheduled.ts）的区别：那个是替用户把一条消息晚点发出去，一次性；这个可以周期运行，
// 每次都带着「这是定时任务、没事就别打扰用户」的说明，结果按 agent 的判断决定推不推送。
//
// 按人隔离：每个任务记着主人（owner，用户 id），网页接口和 agent 的工具都只碰得到自己的。
// 到点时还要再核对一次主人和对话（见 task-runner.ts）。这里只管存取和算时间，不依赖 hub。
import crypto from "node:crypto";
import path from "node:path";
import { EventEmitter } from "node:events";
import { dataDir, readJson, writeJsonAtomic } from "../home.js";
import { describeSchedule, nextRun, normalizeSchedule, type TaskSchedule } from "./task-schedule.js";
import { canUseExpert, getExpert, isBuiltin } from "./experts.js";

/**
 * 结果回到哪：
 *   conv：一条已有的对话（agent 在对话里帮你建的，默认回到那条对话），专家 / 目录都跟着那条对话；
 *   dedicated：任务自己的对话，第一次运行时新建（key 记下来，之后续用），专家等按任务里的设置。
 */
export type TaskTarget = { kind: "conv"; key: string } | { kind: "dedicated"; key?: string };

export type TaskRunStatus = "running" | "notified" | "silent" | "error" | "skipped" | "interrupted";

export type TaskRun = {
  id: string;
  at: number;
  endedAt?: number;
  status: TaskRunStatus;
  /** 跳过 / 出错的原因，或者「手动运行」 */
  note?: string;
  convKey?: string;
  /** 回复开头一句，列表里显示 */
  preview?: string;
};

export type Task = {
  id: string;
  owner: string;
  title: string;
  prompt: string;
  schedule: TaskSchedule;
  /** smart：只在需要时提醒（agent 判断）；always：每次都提醒 */
  notify: "smart" | "always";
  target: TaskTarget;
  /** 专用对话的设置（target 是 conv 时不用，以那条对话为准）。agent 是引擎；expert 是自定义专家的 id，没有就是内置专家 agent */
  agent: string;
  expert?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** 谁建的：用户在页面上建的，还是 agent 在对话里建的 */
  createdBy: "user" | "agent";
  nextRunAt?: number;
  /** 最近的在前 */
  runs: TaskRun[];
};

/** 每人最多几个任务（暂停的也算） */
export const TASKS_PER_USER = 30;
const RUNS_KEPT = 20;
export const PROMPT_MAX = 4000;
export const TITLE_MAX = 60;

export const taskEvents = new EventEmitter<{ changed: [owner: string] }>();

const storePath = path.join(dataDir, "tasks.json");
let cache: Task[] | null = null;

function load(): Task[] {
  if (cache) return cache;
  cache = readJson<Task[]>(storePath, []).filter((t) => t && typeof t.id === "string" && typeof t.owner === "string" && t.schedule);
  // 聊天模式取消了（换成了专家）：以前聊天模式的专用对话已经丢掉，任务先暂停，等用户选个专家再启用 ——
  // 不能悄悄换成内置专家去跑（那是能执行命令的）
  let changed = false;
  for (const t of cache) {
    const legacy = t as Task & { mode?: string };
    if (legacy.mode === undefined) continue;
    if (legacy.mode === "chat" && t.target.kind === "dedicated") {
      t.enabled = false;
      delete t.nextRunAt;
      t.target = { kind: "dedicated" };
      t.runs.unshift({ id: `r_${crypto.randomBytes(4).toString("hex")}`, at: Date.now(), endedAt: Date.now(), status: "skipped", note: "聊天模式已取消：编辑任务选一个专家，再启用" });
    }
    delete legacy.mode;
    changed = true;
  }
  if (changed) writeJsonAtomic(storePath, cache);
  return cache;
}

/** 任务的专家 id：自定义专家的 id，或者内置专家（就是 agent 本身） */
export function taskExpertId(t: Pick<Task, "agent" | "expert">): string {
  return t.expert ?? t.agent;
}

function save(owner?: string): void {
  writeJsonAtomic(storePath, load());
  if (owner) taskEvents.emit("changed", owner);
}

export function resetTasksForTest(): void {
  cache = null;
}

// ---------- 查询 ----------

export function allTasks(): Task[] {
  return load();
}

export function listTasks(owner: string): Task[] {
  return load()
    .filter((t) => t.owner === owner)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** 只认主人：别人的任务一律当不存在 */
export function getTask(owner: string, id: string): Task | undefined {
  return load().find((t) => t.id === id && t.owner === owner);
}

export function findTask(id: string): Task | undefined {
  return load().find((t) => t.id === id);
}

// ---------- 增删改 ----------

export type TaskInput = {
  title?: unknown;
  prompt?: unknown;
  schedule?: unknown;
  notify?: unknown;
  target?: unknown;
  /** 专家 id（内置的 claude / codex，或者自定义专家）。agent 是以前的叫法，照样认 */
  expert?: unknown;
  agent?: unknown;
  cwd?: unknown;
  model?: unknown;
  effort?: unknown;
  enabled?: unknown;
};

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function cleanTitle(v: unknown, prompt: string): string {
  const t = str(v).replace(/\s+/g, " ");
  return (t || prompt.replace(/\s+/g, " ")).slice(0, TITLE_MAX);
}

function cleanPrompt(v: unknown): string {
  const p = str(v);
  if (!p) throw new Error("要写清楚让 agent 做什么");
  if (p.length > PROMPT_MAX) throw new Error(`提示词最多 ${PROMPT_MAX} 字`);
  return p;
}

/** 选的专家 → 引擎 + 自定义专家 id。可选内置、自己的或共享的专家 */
function cleanExpert(owner: string, v: unknown): { agent: string; expert?: string } {
  const id = str(v) || "claude";
  if (!canUseExpert(owner, id)) throw new Error("这个专家不存在");
  if (isBuiltin(id)) return { agent: id };
  return { agent: getExpert(id)!.engine, expert: id };
}

function cleanTarget(v: unknown, prev?: TaskTarget): TaskTarget {
  const r = (v ?? {}) as Record<string, unknown>;
  if (r.kind === "conv" && typeof r.key === "string" && r.key) return { kind: "conv", key: r.key };
  // 改成专用对话时沿用之前那条专用对话
  return prev?.kind === "dedicated" ? prev : { kind: "dedicated" };
}

export function createTask(owner: string, input: TaskInput, by: "user" | "agent", now = Date.now()): Task {
  if (listTasks(owner).length >= TASKS_PER_USER) throw new Error(`每人最多 ${TASKS_PER_USER} 个定时任务，先删掉几个不用的`);
  const prompt = cleanPrompt(input.prompt);
  const schedule = normalizeSchedule(input.schedule, now);
  const picked = cleanExpert(owner, input.expert ?? input.agent);
  const task: Task = {
    id: `t_${crypto.randomBytes(5).toString("hex")}`,
    owner,
    title: cleanTitle(input.title, prompt),
    prompt,
    schedule,
    notify: input.notify === "always" ? "always" : "smart",
    target: cleanTarget(input.target),
    ...picked,
    ...(str(input.cwd) ? { cwd: str(input.cwd) } : {}),
    ...(str(input.model) ? { model: str(input.model) } : {}),
    ...(str(input.effort) ? { effort: str(input.effort) } : {}),
    enabled: input.enabled !== false,
    createdAt: now,
    updatedAt: now,
    createdBy: by,
    runs: [],
  };
  task.nextRunAt = task.enabled ? nextRun(schedule, now) : undefined;
  load().push(task);
  save(owner);
  return task;
}

/** 只改给了的字段。改了频率或重新启用都重算下次时间 */
export function updateTask(owner: string, id: string, patch: TaskInput, now = Date.now()): Task {
  const task = getTask(owner, id);
  if (!task) throw new Error("这个任务不存在");
  const next: Task = { ...task };
  if (patch.prompt !== undefined) next.prompt = cleanPrompt(patch.prompt);
  if (patch.title !== undefined) next.title = cleanTitle(patch.title, next.prompt);
  if (patch.schedule !== undefined) next.schedule = normalizeSchedule(patch.schedule, now);
  if (patch.notify !== undefined) next.notify = patch.notify === "always" ? "always" : "smart";
  if (patch.target !== undefined) next.target = cleanTarget(patch.target, task.target);
  const pick = patch.expert ?? patch.agent;
  if (pick !== undefined && str(pick)) {
    const picked = cleanExpert(owner, pick);
    next.agent = picked.agent;
    if (picked.expert) next.expert = picked.expert;
    else delete next.expert;
  }
  if (patch.cwd !== undefined) {
    if (str(patch.cwd)) next.cwd = str(patch.cwd);
    else delete next.cwd;
  }
  for (const k of ["model", "effort"] as const) {
    if (patch[k] === undefined) continue;
    if (str(patch[k])) next[k] = str(patch[k]);
    else delete next[k];
  }
  if (patch.enabled !== undefined) next.enabled = patch.enabled !== false;
  // 专用对话的专家 / 目录变了：旧的那条对话对不上了（对话中途不能换专家），下次新开一条
  if (
    next.target.kind === "dedicated" &&
    next.target.key &&
    (next.agent !== task.agent || next.expert !== task.expert || next.cwd !== task.cwd)
  ) {
    next.target = { kind: "dedicated" };
  }
  next.updatedAt = now;
  next.nextRunAt = next.enabled ? nextRun(next.schedule, now) : undefined;
  // 「一次」的时间已经过了还要启用：没有下一次
  if (next.enabled && next.nextRunAt === undefined) throw new Error("这个任务已经没有下一次运行时间了，改一下时间");
  // 整个换成 next：Object.assign 不会删掉 next 里去掉了的字段（清空目录 / 模型时）
  for (const k of Object.keys(task) as (keyof Task)[]) if (!(k in next) || next[k] === undefined) delete task[k];
  Object.assign(task, next);
  save(owner);
  return task;
}

export function deleteTask(owner: string, id: string): Task | undefined {
  const list = load();
  const i = list.findIndex((t) => t.id === id && t.owner === owner);
  if (i < 0) return undefined;
  const [removed] = list.splice(i, 1);
  save(owner);
  return removed;
}

/** 删用户时：他的任务一起删掉，不转给管理员 */
export function deleteUserTasks(owner: string): number {
  const list = load();
  const kept = list.filter((t) => t.owner !== owner);
  const n = list.length - kept.length;
  if (n === 0) return 0;
  cache = kept;
  save(owner);
  return n;
}

// ---------- 运行记录（task-runner 用） ----------

/** 暂停并说明原因（对话被删了、换了主人……） */
export function pauseTask(task: Task, note: string, now = Date.now()): void {
  task.enabled = false;
  delete task.nextRunAt;
  pushRun(task, { id: runId(), at: now, endedAt: now, status: "skipped", note });
}

export function runId(): string {
  return `r_${crypto.randomBytes(4).toString("hex")}`;
}

/** 记一条运行（最新的在前，留最近 RUNS_KEPT 条）并落盘 */
export function pushRun(task: Task, run: TaskRun): TaskRun {
  task.runs = [run, ...task.runs.filter((r) => r.id !== run.id)].slice(0, RUNS_KEPT);
  save(task.owner);
  return run;
}

export function finishRun(taskId: string, id: string, patch: Partial<TaskRun>): Task | undefined {
  const task = findTask(taskId);
  const run = task?.runs.find((r) => r.id === id);
  if (!task || !run) return undefined;
  Object.assign(run, patch);
  save(task.owner);
  return task;
}

/** 到点了：算出再下一次（「一次」跑完就停用） */
export function advance(task: Task, now = Date.now()): void {
  task.nextRunAt = nextRun(task.schedule, now);
  if (task.nextRunAt === undefined) task.enabled = false;
  save(task.owner);
}

export function persistTask(task: Task): void {
  save(task.owner);
}

// ---------- 给页面 / agent 看的 ----------

export type TaskView = Task & { summary: string };

export function viewOf(task: Task): TaskView {
  return { ...task, summary: describeSchedule(task.schedule) };
}
