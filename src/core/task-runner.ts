// 定时任务的调度：每 30 秒看一眼哪些到点了，核对主人和对话，把提示词送进对话；一轮结束后记下结果。
//
// 到点时的核对（任何一条不满足都不跑）：
//   - 主人还在、没被停用；
//   - 回到的对话还在、没被删，而且还是他的（飞书私聊换绑了账号之类会让对话换主人）—— 不满足就暂停任务；
//   - 对话没在忙、也没挂着授权 / 提问：忙的话等它（最多 WAIT_MAX_MS），不能插进别人正在进行的那一轮，
//     更不能被当成对挂着的提问的回答。
import crypto from "node:crypto";
import { resolveWorkspacePath } from "./config.js";
import { canUseExpert, getExpert } from "./experts.js";
import { hub, type TaskTurnEnd } from "./hub.js";
import { interactions } from "./interactions.js";
import { memoryOwnerOf } from "./personal.js";
import { getConversation, updateAgentBinding, updateConversation, type Conversation } from "./store.js";
import { formatDateTime } from "./task-schedule.js";
import { stripSilentMark, taskMessage } from "./task-prompt.js";
import { advance, allTasks, finishRun, pauseTask, persistTask, pushRun, runId, type Task, type TaskRun } from "./tasks.js";
import { RUNNING_VERSION } from "./upgrade.js";
import { getUser } from "./users.js";

const TICK_MS = 30_000;
/** 服务停着的时候错过的：错过不到这么久的，启动后补跑一次；更早的记一笔「错过了」 */
const CATCHUP_MS = 2 * 3600_000;
/** 到点时对话在忙：最多等这么久，还忙就跳过这一次 */
const WAIT_MAX_MS = 30 * 60_000;
/** 送出去之后对话已经不忙了、却一直没等到结果（被别的操作吞掉了）：这么久之后按中断记 */
const LOST_MS = 2 * 60_000;

/** 到点了、在等对话空下来的 */
const waiting = new Map<string, { since: number }>();
/** 正在跑的：任务 id → 这次运行 */
const running = new Map<string, { runId: string; key: string; at: number }>();
let timer: NodeJS.Timeout | null = null;

/** 这条对话现在归谁（和记忆同一个规则：飞书群聊、没绑定的私聊没有主人） */
function ownerOf(conv: Conversation): string | undefined {
  return memoryOwnerOf(conv);
}

function preview(text: string, max = 120): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " [代码] ")
    .replace(/[`*_~#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

type Resolved = { key: string } | { pause: string } | { error: string };

/** 这次该发到哪条对话；专用对话还没有（或者被删了）就新建一条 */
function resolveConv(task: Task): Resolved {
  const missingExpert = (id: string | undefined) => !!id && !canUseExpert(task.owner, id);
  const deletedExpert = { pause: "任务用的专家已经删除或取消共享了，任务已暂停。编辑任务换一个专家再启用。" };
  if (task.target.kind === "conv") {
    const conv = getConversation(task.target.key);
    if (!conv || conv.hidden) return { pause: "回复的那条对话已经被删除，任务已暂停。可以改成「专用对话」后再启用。" };
    if (ownerOf(conv) !== task.owner) return { pause: "回复的那条对话已经不属于你了，任务已暂停。" };
    if (missingExpert(conv.expert)) return deletedExpert;
    return { key: conv.key };
  }
  // 复用专用对话前也要检查，不能等到新建对话时才发现专家已删除。
  if (missingExpert(task.expert)) return deletedExpert;
  const existing = task.target.key ? getConversation(task.target.key) : undefined;
  if (existing && !existing.hidden && existing.taskId === task.id && ownerOf(existing) === task.owner) return missingExpert(existing.expert) ? deletedExpert : { key: existing.key };

  // 专家被删了：不能换成别的专家去跑（权限可能大得多），暂停等用户改
  const expert = task.expert ? getExpert(task.expert) : undefined;
  const enabled = hub.enabledAgents().map((d) => d.id);
  if (!enabled.includes(task.agent)) return { error: `${hub.label(task.agent)} 没有启用` };
  let cwd: string | null = null;
  const wantCwd = task.cwd || expert?.cwd;
  if (wantCwd) {
    cwd = resolveWorkspacePath(wantCwd);
    if (!cwd) return { error: `工作目录 ${wantCwd} 不存在了（或者不在工作区里），改一下任务的目录` };
  }
  const key = `web:${crypto.randomBytes(6).toString("hex")}`;
  // 侧栏里专用对话前面有时钟图标（taskId），标题不用再加
  hub.ensure({
    key,
    channel: "web",
    channelId: "web",
    defaultAgent: task.agent,
    ...(task.expert ? { expert: task.expert } : {}),
    ...(cwd ? { cwd } : {}),
    owner: task.owner,
    title: task.title.slice(0, 80),
  });
  updateConversation(key, { titleAuto: false, taskId: task.id });
  if (task.model || task.effort) {
    updateAgentBinding(key, task.agent, { ...(task.model ? { model: task.model } : {}), ...(task.effort ? { effort: task.effort } : {}) });
  }
  task.target = { kind: "dedicated", key };
  persistTask(task);
  hub.emitEvent(key, { type: "meta" });
  return { key };
}

function record(task: Task, status: TaskRun["status"], note: string, now = Date.now()): void {
  pushRun(task, { id: runId(), at: now, endedAt: now, status, note });
}

/**
 * 试着跑一次。manual：用户点了「立即运行」—— 对话忙就直接报错，不排队。
 * 返回给人看的错误；undefined 表示已经送出去了（或者在排队等）。
 */
function fire(task: Task, manual: boolean, now = Date.now()): string | undefined {
  const user = getUser(task.owner);
  if (!user || user.disabled) {
    waiting.delete(task.id);
    record(task, "skipped", "账号已停用", now);
    return "账号已停用";
  }
  const where = resolveConv(task);
  if ("pause" in where) {
    waiting.delete(task.id);
    pauseTask(task, where.pause, now);
    return where.pause;
  }
  if ("error" in where) {
    waiting.delete(task.id);
    record(task, "error", where.error, now);
    return where.error;
  }
  const key = where.key;
  const conv = getConversation(key)!;
  if (!hub.enabledAgents().some((d) => d.id === conv.agent)) {
    waiting.delete(task.id);
    record(task, "error", `${hub.label(conv.agent)} 没有启用`, now);
    return `${hub.label(conv.agent)} 没有启用`;
  }
  // 刚点过停止的也当忙：被打断的那一轮可能还会晚到一个出错，别让它算到这次运行头上
  if (hub.isBusy(key) || hub.recentlyStopped(key) || interactions.listPending(key).length > 0) {
    if (manual) return "这条对话正在回复或者在等你处理授权，等它结束再试";
    const since = waiting.get(task.id)?.since ?? now;
    if (now - since > WAIT_MAX_MS) {
      waiting.delete(task.id);
      record(task, "skipped", `对话一直在忙（等了 ${WAIT_MAX_MS / 60_000} 分钟），跳过了这一次`, now);
    } else {
      waiting.set(task.id, { since });
    }
    return undefined;
  }
  waiting.delete(task.id);
  const run = pushRun(task, { id: runId(), at: now, status: "running", convKey: key, ...(manual ? { note: "手动运行" } : {}) });
  running.set(task.id, { runId: run.id, key, at: now });
  console.log(`[定时任务] ${task.id}「${task.title}」${manual ? "手动运行" : "到点运行"}，发到 ${key}`);
  hub.send(
    key,
    { text: taskMessage(task, { now, manual, version: RUNNING_VERSION }), attachments: [] },
    { channel: "task", channelId: task.id, name: `定时任务「${task.title}」` },
    undefined,
    { task: { taskId: task.id, runId: run.id, title: task.title, smart: task.notify === "smart" } },
  );
  return undefined;
}

function onTurnEnd(e: TaskTurnEnd): void {
  const cur = running.get(e.taskId);
  if (cur?.runId === e.runId) running.delete(e.taskId);
  const text = e.status === "notified" || e.status === "silent" ? preview(stripSilentMark(e.text)) : "";
  finishRun(e.taskId, e.runId, {
    status: e.status,
    endedAt: Date.now(),
    ...(text ? { preview: text } : {}),
    ...(e.status === "error" || e.status === "interrupted" ? { note: preview(e.text) } : {}),
  });
}

function tick(): void {
  const now = Date.now();
  for (const [taskId, cur] of running) {
    // 送出去了，对话早就不忙了，却没等到结果：被吞掉了（比如期间切了会话），别让它永远「运行中」
    if (now - cur.at > LOST_MS && !hub.isBusy(cur.key) && hub.currentTaskTurn(cur.key)?.runId !== cur.runId) {
      running.delete(taskId);
      finishRun(taskId, cur.runId, { status: "interrupted", endedAt: now, note: "没有拿到结果" });
    }
  }
  for (const task of allTasks()) {
    if (running.has(task.id)) continue;
    if (waiting.has(task.id)) {
      // 等着的时候被暂停了：这次就不跑了（「一次」的任务到点时已经自动停用，照样要跑完这一次）
      if (!task.enabled && task.schedule.kind !== "once") waiting.delete(task.id);
      else fire(task, false, now);
      continue;
    }
    if (!task.enabled || task.nextRunAt === undefined || task.nextRunAt > now) continue;
    // 先把下一次算好再跑：跑的过程中出了什么岔子，也不会在下一个 tick 又跑一遍
    advance(task, now);
    fire(task, false, now);
  }
}

/** 网页上点「立即运行」 */
export function runTaskNow(task: Task): string | undefined {
  if (running.has(task.id)) return "这个任务正在运行";
  return fire(task, true);
}

export function isTaskRunning(id: string): boolean {
  return running.has(id) || waiting.has(id);
}

/** 任务删了：它的专用对话留着（里面有历史），只是不再是谁的专用对话 */
export function forgetTask(task: Task): void {
  waiting.delete(task.id);
  running.delete(task.id);
  if (task.target.kind === "dedicated" && task.target.key) {
    const conv = getConversation(task.target.key);
    if (conv?.taskId === task.id) {
      updateConversation(conv.key, { taskId: undefined });
      hub.emitEvent(conv.key, { type: "meta" });
    }
  }
}

export function startTaskRunner(): void {
  if (timer) return;
  const now = Date.now();
  for (const task of allTasks()) {
    // 上次进程退出时还在跑的：结果已经拿不到了
    let dirty = false;
    for (const run of task.runs) {
      if (run.status !== "running") continue;
      Object.assign(run, { status: "interrupted", endedAt: now, note: "服务重启，这次运行被打断了" });
      dirty = true;
    }
    if (dirty) persistTask(task);
    if (task.enabled && task.nextRunAt !== undefined && task.nextRunAt < now - CATCHUP_MS) {
      record(task, "skipped", `服务没在运行，错过了 ${formatDateTime(task.nextRunAt)} 这一次`, now);
      advance(task, now);
    }
  }
  hub.on("task", onTurnEnd);
  timer = setInterval(tick, TICK_MS);
  timer.unref();
  // 等 agent 起来了再补跑错过的
  setTimeout(tick, 5_000).unref();
}

export function stopTaskRunner(): void {
  if (timer) clearInterval(timer);
  timer = null;
  hub.off("task", onTurnEnd);
}
