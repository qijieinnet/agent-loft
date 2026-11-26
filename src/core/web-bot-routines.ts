// Bot 私人周期任务。保存当地钟表时间，每次按同一 IANA 时区求下一次日期。
import { Temporal } from "@js-temporal/polyfill";
import { sql, transaction } from "./db.js";
import { describeSchedule, normalizeSchedule, type TaskSchedule } from "./task-schedule.js";
import { getBotThread, WebBotError } from "./web-bots.js";
import { requireBotCapability } from "./web-bot-profile.js";

type Schedule = Extract<TaskSchedule, { kind: "daily" | "weekdays" | "weekly" }>;
export type BotRoutine = {
  id: string; userId: string; threadId: string; accessId: string; prompt: string; mode: "remind" | "run";
  schedule: string; timezone: string; smart: number; nextAt: number | null; revision: number;
};

export function nextRoutineAt(schedule: Schedule, timezone: string, from: number): number {
  const today = Temporal.Instant.fromEpochMilliseconds(from).toZonedDateTimeISO(timezone).toPlainDate();
  const time = Temporal.PlainTime.from(schedule.time);
  for (let offset = 0; offset <= 7; offset++) {
    const date = today.add({ days: offset });
    if (schedule.kind === "weekdays" && date.dayOfWeek > 5) continue;
    if (schedule.kind === "weekly" && !schedule.days.includes(date.dayOfWeek % 7)) continue;
    const next = date.toPlainDateTime(time).toZonedDateTime(timezone, { disambiguation: "compatible" }).epochMilliseconds;
    if (next > from) return next;
  }
  throw new Error("无法计算下次执行时间");
}

function privateThread(user: string, thread: string) {
  const info = getBotThread(user, thread);
  if (info.scope !== "private") throw new WebBotError(400, "请在自己的私聊中管理周期任务。");
  return info;
}

export function getRoutine(user: string, thread: string, id: string) {
  const { accessId } = privateThread(user, thread);
  const row = sql("SELECT * FROM web_bot_routines WHERE id=? AND userId=? AND threadId=? AND accessId=?")
    .get(id, user, thread, accessId) as BotRoutine | undefined;
  if (!row) throw new WebBotError(404, "找不到这项周期任务。");
  return row;
}

function routineFields(body: Record<string, unknown>) {
  const { mode, timezone, smart } = body;
  const prompt = typeof body.prompt === "string" && body.prompt.trim();
  if (!prompt || prompt.length > 4000 ||
    (mode !== "remind" && mode !== "run") || typeof timezone !== "string" || !timezone || timezone.length > 100 ||
    typeof smart !== "boolean") throw new WebBotError(400, "请检查任务内容、时区和提醒方式。");
  const rawSchedule = body.schedule as Partial<Schedule> | undefined;
  if (!rawSchedule || !["daily", "weekdays", "weekly"].includes(String(rawSchedule.kind))) throw new WebBotError(400, "请选择每天、工作日或每周。");
  let schedule: string, next: number;
  try {
    const normalized = normalizeSchedule(rawSchedule) as Schedule;
    schedule = JSON.stringify(normalized);
    next = nextRoutineAt(normalized, timezone, Date.now());
  } catch { throw new WebBotError(400, "请选择有效的日期、时间和时区。"); }
  return { mode, timezone, smart, prompt, schedule, next };
}

export function createRoutine(user: string, thread: string, body: Record<string, unknown>) {
  return transaction(() => {
    const { accessId } = privateThread(user, thread);
    requireBotCapability(user, thread, "reminders");
    const id = body.id;
    if (typeof id !== "string" || !/^[a-f0-9-]{24,64}$/i.test(id)) throw new WebBotError(400, "任务标识无效。");
    const { mode, timezone, smart, prompt, schedule, next } = routineFields(body);
    const existing = sql("SELECT 1 FROM web_bot_routines WHERE id=?").get(id);
    if (existing) {
      const row = getRoutine(user, thread, id);
      if (row.prompt !== prompt || row.schedule !== schedule || row.mode !== mode || row.timezone !== timezone || !!row.smart !== smart)
        throw new WebBotError(409, "任务已创建，请重新打开。");
      return;
    }
    if (Number(sql("SELECT count(*) n FROM web_bot_routines WHERE userId=?").get(user)?.n) >= 100)
      throw new WebBotError(400, "最多可保存 100 项周期任务。");
    sql(`INSERT INTO web_bot_routines (id,userId,threadId,accessId,prompt,mode,schedule,timezone,smart,nextAt)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, user, thread, accessId, prompt, mode, schedule, timezone, Number(smart), next);
  });
}

export function listRoutines(user: string, thread: string) {
  const { accessId } = privateThread(user, thread);
  return (sql("SELECT * FROM web_bot_routines WHERE userId=? AND threadId=? AND accessId=? ORDER BY nextAt IS NULL,nextAt,rowid DESC")
    .all(user, thread, accessId) as BotRoutine[]).map(row => ({
      id: row.id, prompt: row.prompt, mode: row.mode, schedule: describeSchedule(JSON.parse(row.schedule)),
      timing: JSON.parse(row.schedule) as Schedule, revision: row.revision, timezone: row.timezone, nextAt: row.nextAt, smart: !!row.smart,
    }));
}

export function routineHistory(user: string, thread: string, id: string) {
  getRoutine(user, thread, id);
  return sql("SELECT r.dueAt,r.status,r.result,r.messageId,m.requestId IS NOT NULL AS manual FROM web_bot_routine_runs r LEFT JOIN web_bot_routine_manual m USING(routine,dueAt) WHERE r.routine=? ORDER BY r.dueAt DESC LIMIT 30").all(id);
}

export function editRoutine(user: string, thread: string, id: string, body: Record<string, unknown>) {
  transaction(() => {
    const row = getRoutine(user, thread, id);
    requireBotCapability(user, thread, "reminders");
    const { mode, prompt, smart, schedule, timezone, next } = routineFields(body);
    const timingChanged = row.schedule !== schedule || row.timezone !== timezone;
    if (!timingChanged && row.mode === mode && row.prompt === prompt && !!row.smart === smart) return;
    if (row.revision !== body.revision) throw new WebBotError(409, "任务已在别处更改，请重新打开后再编辑。");
    if (sql("SELECT 1 FROM web_bot_routine_runs WHERE routine=? AND status='running'").get(id))
      throw new WebBotError(409, "任务正在执行，请在本次结束后编辑。");
    const nextAt = timingChanged && row.nextAt !== null ? next : row.nextAt;
    sql(`UPDATE web_bot_routines SET mode=?,prompt=?,smart=?,schedule=?,timezone=?,nextAt=?,revision=revision+1 WHERE id=?`)
      .run(mode, prompt, Number(smart), schedule, timezone, nextAt, id);
  });
}

export function changeRoutine(user: string, thread: string, id: string, action: unknown) {
  transaction(() => {
    const row = getRoutine(user, thread, id);
    if (action === "delete") {
      sql("DELETE FROM web_bot_routines WHERE id=?").run(id);
      return;
    }
    if (action !== "pause" && action !== "resume") throw new WebBotError(400, "请选择暂停或恢复。");
    if ((action === "pause") === (row.nextAt === null)) return;
    let next = null;
    if (action === "resume") {
      requireBotCapability(user, thread, "reminders");
      next = nextRoutineAt(JSON.parse(row.schedule), row.timezone, Date.now());
    }
    sql("UPDATE web_bot_routines SET nextAt=?, revision=revision+1 WHERE id=?").run(next, id);
  });
}
