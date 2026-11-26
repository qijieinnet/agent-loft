import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const home = mkdtempSync(join(tmpdir(), "loft-bot-routines-"));
process.env.AGENT_LOFT_HOME = home;
const { closeDatabaseForTest, sql } = await import("../src/core/db.js");
const { createUser } = await import("../src/core/users.js");
const { editRoutine, createRoutine, nextRoutineAt, changeRoutine, listRoutines, routineHistory } = await import("../src/core/web-bot-routines.js");
const { runRoutineNow, runDueRoutines } = await import("../src/core/web-bot-routine-worker.js");
const { getBotProfile, updateBotProfile } = await import("../src/core/web-bot-profile.js");
const { listBots, createInvite, acceptInvite, removeMember, appendBotNotice, searchBotMessages, stopSharing, startTurn, recoverPendingBotTurns } = await import("../src/core/web-bots.js");
after(() => { closeDatabaseForTest(); rmSync(home, { recursive: true, force: true }); });

test("每周、工作日按任务时区计算；夏令时跳过及重复的小时每天只执行一次", () => {
  const zone = "America/New_York";
  assert.equal(nextRoutineAt({ kind: "daily", time: "02:30" }, zone, Date.parse("2026-03-08T05:00Z")), Date.parse("2026-03-08T07:30Z"));
  assert.equal(nextRoutineAt({ kind: "daily", time: "01:30" }, zone, Date.parse("2026-11-01T05:30Z")), Date.parse("2026-11-02T06:30Z"));
  const afterFriday = Date.parse("2026-11-27T01:00Z");
  const schedules: Parameters<typeof nextRoutineAt>[0][] = [
    { kind: "weekly", days: [1], time: "09:00" }, { kind: "weekdays", time: "09:00" },
  ];
  for (const schedule of schedules)
    assert.equal(nextRoutineAt(schedule, "Asia/Hong_Kong", afterFriday), Date.parse("2026-11-30T01:00Z"));
});

test("幂等确认、暂停恢复、关停提醒能力、积压合并和权限回收", async () => {
  const { id: owner } = createUser({ name: "routine-owner", password: "password-123" });
  const { id: member } = createUser({ name: "routine-member", password: "password-123" });
  const bot = listBots(owner)[0]!;
  const joined = acceptInvite(member, createInvite(owner, bot.id).token);
  const thread = joined.privateThreadId, id = randomUUID();
  const body = { id, prompt: "备份提醒", mode: "remind", smart: false, timezone: "Asia/Hong_Kong", schedule: { kind: "daily", time: "09:00" } };
  assert.throws(() => createRoutine(member, joined.sharedThreadId!, body));
  assert.throws(() => createRoutine(member, thread, { ...body, timezone: "Invalid/City" }));
  createRoutine(member, thread, body);
  createRoutine(member, thread, body);
  assert.equal(listRoutines(member, thread).length, 1);
  assert.throws(() => routineHistory(owner, thread, id));
  const due = Date.now() - 7 * 86400000;
  sql("UPDATE web_bot_routines SET nextAt=? WHERE id=?").run(due, id);
  await Promise.all([runDueRoutines(), runDueRoutines()]);
  assert.equal(routineHistory(member, thread, id).length, 1);
  assert.match(String(routineHistory(member, thread, id)[0]?.result), /备份提醒/);
  assert.ok(listRoutines(member, thread)[0]!.nextAt! > Date.now());
  changeRoutine(member, thread, id, "pause");
  assert.equal(listRoutines(member, thread)[0]?.nextAt, null);
  changeRoutine(member, thread, id, "resume");
  assert.ok(listRoutines(member, thread)[0]?.nextAt);
  const profile = getBotProfile(owner, bot.id);
  await updateBotProfile(owner, bot.id, { revision: profile.revision, capabilities: [] });
  assert.equal(listRoutines(member, thread)[0]?.nextAt, null);
  assert.throws(() => changeRoutine(member, thread, id, "resume"));
  removeMember(owner, bot.id, member);
  assert.equal(sql("SELECT id FROM web_bot_routines WHERE id=?").get(id), undefined);
  assert.equal(sql("SELECT routine FROM web_bot_routine_runs WHERE routine=?").get(id), undefined);
});

test("消息正文支持字面关键词与翻页，隔离私聊和已撤销或归档的共享对话", () => {
  const { id: owner } = createUser({ name: "search-owner", password: "password-123" });
  const { id: member } = createUser({ name: "search-member", password: "password-123" });
  const bot = listBots(owner)[0]!;
  const joined = acceptInvite(member, createInvite(owner, bot.id).token);
  const shared = joined.sharedThreadId!;
  appendBotNotice(owner, bot.privateThreadId, "我的私人 ABC%_ 权限");
  for (let i = 0; i < 31; i++) appendBotNotice(member, shared, "共享 ABC%_ 权限" + i);
  appendBotNotice(member, shared, "ABC 这条不包含字面百分号");
  const first = searchBotMessages(member, "abc%_");
  assert.equal(first.matches.length, 30);
  assert.ok(first.matches.every(row => row.thread === shared));
  const second = searchBotMessages(member, "abc%_", Number(first.nextBefore));
  assert.equal(second.matches.length, 1);
  assert.equal(second.nextBefore, null);
  assert.ok(first.matches.every(row => row.id !== second.matches[0]!.id));
  removeMember(owner, bot.id, member);
  assert.equal(searchBotMessages(member, "权限").matches.length, 0);
  stopSharing(owner, bot.id);
  assert.deepEqual(searchBotMessages(owner, "权限").matches.map(row => row.thread), [bot.privateThreadId]);
});


test("进程中断后保留失败记录并通知一次，不重放已认领的任务", async () => {
  const { id: user } = createUser({ name: "routine-recovery", password: "password-123" });
  const { privateThreadId: thread } = listBots(user)[0]!;
  const id = randomUUID(), dueAt = Date.now() - 60000;
  createRoutine(user, thread, { id, prompt: "检查备份", mode: "run", smart: true, timezone: "UTC", schedule: { kind: "daily", time: "08:00" } });
  const key = "routine:" + id + ":" + dueAt;
  const { message } = startTurn(user, thread, key, "检查备份");
  sql("INSERT INTO web_bot_routine_runs(routine,dueAt,status,messageId) VALUES(?,?,'running',?)").run(id, dueAt, message.id);
  sql("UPDATE web_bot_messages SET createdAt=? WHERE id=?").run(Date.now() - 3600000, message.id);
  recoverPendingBotTurns();
  await runDueRoutines();
  await runDueRoutines();
  const [interrupted] = routineHistory(user, thread, id);
  assert.equal(interrupted?.status, "failed");
  assert.match(String(interrupted?.result), /中断/);
  assert.equal(sql("SELECT count(*) n FROM bot_inbox WHERE eventId=?").get(key)?.n, 1);
  assert.equal(sql("SELECT count(*) n FROM web_bot_messages WHERE role='user' AND requestId=?").get(key)?.n, 1);
});

test("编辑和手动执行保留原计划和历史，同一请求只发送一次", () => {
  const user = createUser({ name: "edit-owner", password: "password-123" }).id;
  const other = createUser({ name: "edit-other", password: "password-123" }).id;
  const thread = listBots(user)[0]!.privateThreadId;
  const id = randomUUID(), key = randomUUID();
  const body = { id, prompt: "检查备份", mode: "remind", smart: false, timezone: "Asia/Hong_Kong", schedule: { kind: "daily", time: "09:00" } };
  createRoutine(user, thread, body);
  const state = () => listRoutines(user, thread)[0]!;
  const start = state();
  assert.throws(() => runRoutineNow(other, thread, id, key, start.revision));
  const run = runRoutineNow(user, thread, id, key, start.revision);
  assert.deepEqual(runRoutineNow(user, thread, id, key, start.revision), run);
  assert.equal(state().nextAt, start.nextAt);
  assert.equal(routineHistory(user, thread, id).length, 1);
  assert.equal(routineHistory(user, thread, id)[0]?.manual, 1);
  assert.equal(sql("SELECT count(*) n FROM bot_inbox WHERE threadId=?").get(thread)?.n, 1);
  const updated = { ...body, prompt: "检查周报", revision: start.revision };
  editRoutine(user, thread, id, updated);
  assert.equal(state().nextAt, start.nextAt);
  assert.throws(() => editRoutine(user, thread, id, { ...body, revision: start.revision }));
  assert.throws(() => runRoutineNow(user, thread, id, randomUUID(), start.revision));
  editRoutine(user, thread, id, { ...updated, schedule: { kind: "daily", time: "10:00" }, revision: state().revision });
  assert.notEqual(state().nextAt, start.nextAt);
  changeRoutine(user, thread, id, "pause");
  editRoutine(user, thread, id, { ...updated, timezone: "UTC", revision: state().revision });
  runRoutineNow(user, thread, id, randomUUID(), state().revision);
  assert.equal(state().nextAt, null);
  assert.deepEqual(routineHistory(user, thread, id).map(r => r.result), ["⏰ 提醒：检查周报", "⏰ 提醒：检查备份"]);
});
