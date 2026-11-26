import { sql, transaction } from "./db.js";
import { appendBotNotice, startTurn, finishTurn, WebBotError, type BotMessage } from "./web-bots.js";
import { getRoutine, nextRoutineAt, type BotRoutine } from "./web-bot-routines.js";
import { answerScheduled } from "./web-bot-reply.js";
import { enqueueBotNotice, hasBotAccess } from "./web-bot-reminders.js";
import { botReminderEnabled, requireBotCapability } from "./web-bot-profile.js";

type Due = BotRoutine & { nextAt: number };
type RunJob = { task: Due; message: BotMessage; key: string };

function canRun(task: Due) {
  return hasBotAccess(task) && botReminderEnabled(task.userId, task.threadId, task.nextAt);
}

function record(task: Due, status: string, result: string, messageId?: number) {
  sql(`INSERT INTO web_bot_routine_runs(routine,dueAt,status,result,messageId) VALUES(?,?,?,?,?)
    ON CONFLICT(routine,dueAt) DO UPDATE SET status=excluded.status,result=excluded.result,messageId=excluded.messageId`)
    .run(task.id, task.nextAt, status, result, messageId ?? null);
  sql(`DELETE FROM web_bot_routine_runs WHERE routine=? AND dueAt NOT IN
    (SELECT dueAt FROM web_bot_routine_runs WHERE routine=? ORDER BY dueAt DESC LIMIT 30)`).run(task.id, task.id);
}

function ownsRun(task: Due, messageId: number) {
  return !!sql("SELECT 1 FROM web_bot_routine_runs WHERE routine=? AND dueAt=? AND status='running' AND messageId=?")
    .get(task.id, task.nextAt, messageId);
}

function current(task: Due, messageId: number) {
  return ownsRun(task, messageId) && !!sql("SELECT 1 FROM web_bot_routines WHERE id=? AND revision=?")
    .get(task.id, task.revision) && canRun(task);
}

// 先在写事务里认领并推进下次时间；断电后即便外部工具已经执行，也不会重放这一轮。
function claim(id: string, now: number) {
  return transaction(() => {
    const task = sql("SELECT * FROM web_bot_routines WHERE id=? AND nextAt<=?").get(id, now) as Due | undefined;
    if (!task) return;
    if (!canRun(task)) {
      sql("UPDATE web_bot_routines SET nextAt=NULL,revision=revision+1 WHERE id=?").run(id);
      return;
    }
    const job = beginRun(task, false);
    if (job === false) return;
    const next = nextRoutineAt(JSON.parse(task.schedule), task.timezone, now);
    sql("UPDATE web_bot_routines SET nextAt=? WHERE id=?").run(next, id);
    return job;
  });
}

function beginRun(task: Due, manual: boolean): RunJob | false | undefined {
  const key = "routine:" + task.id + ":" + task.nextAt;
  let message: BotMessage | undefined;
  if (task.mode === "run") {
    try {
      const turn = startTurn(task.userId, task.threadId, key, task.prompt);
      if (!turn.started) throw new Error("周期任务执行记录重复");
      message = turn.message;
    } catch (err) {
      if (!manual && err instanceof WebBotError && err.status === 409) return false; // 对话忙，稍后再领。
      if (!(err instanceof WebBotError) || err.status !== 429) throw err;
      // 当天额度用尽或并发已满。留下可检查的结果；短时并发冲突稍后再试。
      if (err.retryLater) { if (manual) throw err; return false; }
      const notice = appendBotNotice(task.userId, task.threadId, err.message);
      record(task, "failed", err.message, notice.id);
      enqueueBotNotice(task.userId, task.threadId, key, "reminder", notice.id);
    }
  } else {
    const result = "⏰ 提醒：" + task.prompt;
    const notice = appendBotNotice(task.userId, task.threadId, result);
    record(task, "done", result, notice.id);
    enqueueBotNotice(task.userId, task.threadId, key, "reminder", notice.id);
  }
  if (message) {
    record(task, "running", "", message.id);
    return { task, message, key };
  }
}

export function runRoutineNow(user: string, thread: string, id: string, requestId: unknown, revision: unknown) {
  const { dueAt, job } = transaction(() => {
    const row = getRoutine(user, thread, id);
    requireBotCapability(user, thread, "reminders");
    if (typeof requestId !== "string" || !/^[a-f0-9-]{24,64}$/i.test(requestId)) throw new WebBotError(400, "执行标识无效。");
    const prior = sql("SELECT dueAt FROM web_bot_routine_manual WHERE routine=? AND requestId=?").get(id, requestId);
    if (prior) return { dueAt: Number(prior.dueAt) };
    if (row.revision !== revision) throw new WebBotError(409, "任务已更改，请重新打开后执行。");
    let dueAt = Date.now();
    // Scheduled times fall on full seconds. Reserve a distinct millisecond for each manual run.
    while (dueAt % 1000 === 0 || dueAt === row.nextAt ||
      sql("SELECT 1 FROM web_bot_routine_manual WHERE routine=? AND dueAt=?").get(id, dueAt) ||
      sql("SELECT 1 FROM web_bot_routine_runs WHERE routine=? AND dueAt=?").get(id, dueAt)) dueAt++;
    sql("INSERT INTO web_bot_routine_manual(routine,requestId,dueAt) VALUES(?,?,?)").run(id, requestId, dueAt);
    return { dueAt, job: beginRun({ ...row, nextAt: dueAt }, true) };
  });
  if (job) {
    const work = execute(job, controller?.signal ?? new AbortController().signal)
      .catch(err => console.error("[bot] 立即执行任务失败", err))
      .finally(() => active.delete(work));
    active.add(work);
  }
  return { dueAt };
}

async function execute(job: RunJob, signal: AbortSignal) {
  const { task, key, message } = job;
  const check = () => {
    signal.throwIfAborted();
    if (!current(task, message.id)) throw new WebBotError(409, "周期任务已暂停或授权已变更。");
  };
  let result: string, failed = false, quiet = false;
  try {
    const answer = await answerScheduled(task.userId, task.threadId, message, task.timezone, { smart: !!task.smart, check, signal });
    result = answer.text;
    quiet = answer.quiet;
  } catch (err) {
    failed = true;
    result = err instanceof WebBotError ? err.message : "本次任务未能完成，请检查数据来源、工具和引擎连接。";
  }
  transaction(() => {
    const allowed = current(task, message.id);
    if (!allowed) { result = "周期任务已停止。"; failed = true; }
    const reply = finishTurn(task.userId, task.threadId, key, result, failed);
    if (!ownsRun(task, message.id)) return;
    record(task, failed ? "failed" : quiet ? "quiet" : "done", result, reply?.id);
    if (reply && allowed && (failed || !quiet)) enqueueBotNotice(task.userId, task.threadId, key, "reminder", reply.id);
  });
}

export async function runDueRoutines(now = Date.now(), signal = new AbortController().signal) {
  // The regular turn recovery marks the request failed. Notify once, without replaying a tool call.
  const interrupted = sql(`SELECT r.routine, r.dueAt, m.requestId, m.thread FROM web_bot_routine_runs r
    JOIN web_bot_messages m ON m.id=r.messageId WHERE r.status='running' AND m.status='failed'`).all();
  for (const entry of interrupted) transaction(() => {
    const id = String(entry.routine), dueAt = Number(entry.dueAt);
    const reply = sql("SELECT id FROM web_bot_messages WHERE thread=? AND requestId=? AND role='assistant' ORDER BY id DESC LIMIT 1")
      .get(String(entry.thread), String(entry.requestId));
    const changed = sql(`UPDATE web_bot_routine_runs SET status='failed',result='上次执行已中断。',messageId=?
      WHERE routine=? AND dueAt=? AND status='running'`).run(reply?.id ?? null, id, dueAt);
    if (!changed.changes) return;
    const task = sql("SELECT * FROM web_bot_routines WHERE id=?").get(id) as Due | undefined;
    if (task && (task.nextAt !== null || sql("SELECT 1 FROM web_bot_routine_manual WHERE routine=? AND dueAt=?").get(id, dueAt)) && canRun({ ...task, nextAt: dueAt }))
      enqueueBotNotice(task.userId, task.threadId, String(entry.requestId), "reminder", reply ? Number(reply.id) : undefined);
  });
  const due = sql("SELECT id FROM web_bot_routines WHERE nextAt<=? ORDER BY nextAt").all(now);
  const completed = await Promise.allSettled(due.map(async row => {
    if (signal.aborted) return;
    const job = claim(String(row.id), now);
    if (job) await execute(job, signal);
  }));
  for (const outcome of completed) if (outcome.status === "rejected") throw outcome.reason;
}

// Each claim advances its deadline in SQLite. New ticks can deliver reminders
// while a previous model call is still waiting for a tool or an approval.
let timer: NodeJS.Timeout | undefined;
let controller: AbortController | undefined;
const active = new Set<Promise<void>>();
export function startBotRoutines() {
  if (timer) return;
  const stop = controller = new AbortController();
  const tick = () => {
    const work = runDueRoutines(Date.now(), stop.signal)
      .catch(err => console.error("[bot] 周期任务调度失败", err))
      .finally(() => active.delete(work));
    active.add(work);
  };
  timer = setInterval(tick, 5000);
  timer.unref();
  tick();
}
export async function stopBotRoutines() {
  clearInterval(timer);
  timer = undefined;
  controller?.abort();
  await Promise.all(active);
}
