import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { Readable } from "node:stream";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "loft-followups-"));
process.env.AGENT_LOFT_HOME = home;
const db = await import("../src/core/db.js");
const users = await import("../src/core/users.js");
const bots = await import("../src/core/web-bots.js");
const follow = await import("../src/core/web-bot-followups.js");
after(() => { db.closeDatabaseForTest(); fs.rmSync(home,{recursive:true,force:true}); });
const user = (name: string) => users.createUser({name,password:"test-only-password"}).id;
const denied = (code: number) => (e: unknown) => e instanceof bots.WebBotError && e.status === code;

test("同一事项可以交接和跨天跟进，只有指定成员能够批准当前版本", () => {
  const a = user("家长"), b = user("家人"), c = user("邻居");
  const bot = bots.listBots(a)[0]!;
  const thread = bots.acceptInvite(b, bots.createInvite(a, bot.id).token).sharedThreadId!;
  let item = follow.applyBotFollowup(a, thread, "create", {kind:"create",title:"周五出游准备"});
  assert.equal(follow.applyBotFollowup(a,thread,"create",{kind:"create",title:"重发"}).id,item.id);
  assert.equal(follow.listBotFollowups(a, bot.privateThreadId).length,0);
  assert.throws(() => follow.botFollowupDetail(c,thread,item.id),denied(404));
  assert.throws(() => follow.applyBotFollowup(b,thread,"other",{kind:"assign",id:item.id,revision:1,assigneeId:b}),denied(403));
  item = follow.applyBotFollowup(a,thread,"ask",{kind:"ask",id:item.id,revision:1,assigneeId:b,text:"同意预留两张票？"});
  assert.equal(item.status,"waiting");
  assert.equal(item.canDecide,false);
  assert.equal(follow.listBotFollowups(b,thread)[0]?.canDecide,true);
  assert.throws(() => follow.applyBotFollowup(a,thread,"no",{kind:"approve",id:item.id,revision:2}),denied(403));
  assert.throws(() => follow.applyBotFollowup(a,thread,"skip",{kind:"close",id:item.id,revision:2}),denied(409));
  assert.equal(follow.applyBotFollowup(b,thread,"note",{kind:"note",id:item.id,revision:2,text:"票还在。"}).question,"同意预留两张票？");
  assert.throws(() => follow.applyBotFollowup(b,thread,"stale",{kind:"approve",id:item.id,revision:2}),denied(409));
  item=follow.applyBotFollowup(b,thread,"agree",{kind:"approve",id:item.id,revision:3});
  assert.equal(item.status,"open");
  assert.equal(follow.applyBotFollowup(b,thread,"agree",{kind:"approve",id:item.id,revision:3}).revision,4);
  db.closeDatabaseForTest();
  assert.equal(follow.botFollowupDetail(a,thread,item.id).events.length,4);
  assert.equal(bots.listMessages(a,thread).length,4);
  assert.ok(db.sql("SELECT * FROM bot_notice_events WHERE kind='followup' AND userId=?").get(b));
  bots.startTurn(a,thread,"chat-turn","把出游准备结案。");
  const done = follow.applyBotFollowup(a, thread, "chat-turn", {kind:"close",id:item.id,revision:4});
  const reply = bots.finishTurn(a, thread, "chat-turn", "", false, done.noticeId);
  assert.equal(reply?.id, done.noticeId);
  assert.match(reply!.text,/已结束跟进/);
  assert.equal(bots.listMessages(a,thread).length,6);
});

test("连接报告只处理变化、去重、验证恢复，并在原授权失效后停用", () => {
  const a=user("站长"), b=user("运维");
  const bot=bots.listBots(a)[0]!;
  const shared=bots.acceptInvite(b,bots.createInvite(a,bot.id).token).sharedThreadId!;
  let item=follow.applyBotFollowup(b,shared,"new",{kind:"create",title:"备份故障"});
  const hook=follow.setFollowupHook(b,shared,item.id,true)!;
  const current=follow.setFollowupHook(b,shared,item.id,true)!;
  assert.throws(()=>follow.checkFollowupHook(item.id,hook.token),denied(404));
  const event={eventId:"report1",state:"异常",evidence:"服务显示最新一轮失败"};
  follow.ingestFollowupEvent(item.id,current.token,event);
  follow.ingestFollowupEvent(item.id,current.token,event);
  follow.ingestFollowupEvent(item.id,current.token,{...event,eventId:"report2"});
  assert.equal(follow.listBotFollowups(b,shared)[0]?.revision,2);
  item=follow.applyBotFollowup(b,shared,"confirm",{kind:"ask",id:item.id,revision:2,assigneeId:b,text:"确认恢复？"});
  follow.ingestFollowupEvent(item.id,current.token,{eventId:"report3",state:"恢复正常",recovered:true});
  follow.ingestFollowupEvent(item.id,current.token,{eventId:"report3-again",state:"恢复正常",recovered:true});
  assert.equal(follow.listBotFollowups(b,shared)[0]?.status,"waiting");
  assert.equal(follow.listBotFollowups(b,shared)[0]?.revision,4);
  bots.removeMember(a,bot.id,b);
  bots.acceptInvite(b,bots.createInvite(a,bot.id).token);
  assert.equal(follow.listBotFollowups(b,shared)[0]?.canDecide,false);
  assert.throws(()=>follow.ingestFollowupEvent(item.id,current.token,event),denied(404));
  assert.throws(()=>follow.applyBotFollowup(b,shared,"old",{kind:"approve",id:item.id,revision:4}),denied(403));
  item=follow.applyBotFollowup(a,shared,"replace",{kind:"assign",assigneeId:a,revision:4,id:item.id});
  assert.equal(item.status,"waiting");
  item=follow.applyBotFollowup(a,shared,"confirmed",{kind:"approve",id:item.id,revision:5});
  const fresh=follow.setFollowupHook(a,shared,item.id,true)!;
  follow.ingestFollowupEvent(item.id,fresh.token,{eventId:"report4",state:"恢复正常",recovered:true});
  assert.equal(follow.listBotFollowups(a,shared)[0]!.status,"closed");
  follow.setFollowupHook(a,shared,item.id,false);
  assert.throws(()=>follow.checkFollowupHook(item.id,fresh.token),denied(404));
});

test("只向当前指定确认人投递一次，其他参与成员可以查阅同一依据", () => {
  const owner=user("负责人"), creator=user("发起人"), voter=user("确认人");
  const bot = bots.listBots(owner)[0]!;
  const shared = bots.acceptInvite(creator,bots.createInvite(owner,bot.id).token).sharedThreadId!;
  bots.acceptInvite(voter,bots.createInvite(owner,bot.id).token);
  const item = follow.applyBotFollowup(creator,shared,"create-test",{kind:"create", title:"周六出行"});
  const ask = { kind:"ask", id:item.id, revision:1, assigneeId:voter, text:"集合时间改到十点吗？" } as const;
  const waiting = follow.applyBotFollowup(owner,shared,"ask-test",ask);
  follow.applyBotFollowup(owner,shared,"ask-test",ask);
  for (const table of ["bot_inbox","bot_notice_events"]) {
    const rows = db.sql(`SELECT userId,messageId FROM ${table} WHERE threadId=? AND eventId=?`).all(shared,`followup:${item.id}:2`);
    assert.deepEqual(rows.map(r => [r.userId,r.messageId]),[[voter,waiting.noticeId]]);
  }
  for (const id of [owner,creator,voter]) {
    const details = follow.botFollowupDetail(id,shared,item.id);
    assert.match(String(details.events.at(-1)?.text),/集合时间改到十点/);
    assert.equal(details.followup.canDecide,id===voter);
  }
});

test("同一连接先报恢复再批准，重启后仍会一次结案；回退到异常时继续跟进", () => {
  const owner = user("备份检查员");
  const thread = bots.listBots(owner)[0]!.privateThreadId;
  const create = (key: string) => {
    const item = follow.applyBotFollowup(owner, thread, key, { kind: "create", title: "夜间备份" });
    follow.applyBotFollowup(owner, thread, "ask-" + key, { kind: "ask", id: item.id, revision: 1, text: "收到后确认" });
    return { item, hook: follow.setFollowupHook(owner, thread, item.id, true)! };
  };
  const { item, hook } = create("recovered");
  const recovered = { eventId: "r1", state: "ok", recovered: true };
  follow.ingestFollowupEvent(item.id, hook.token, recovered);
  db.closeDatabaseForTest();
  const decision = { kind: "approve", id: item.id, revision: 3 } as const;
  assert.equal(follow.applyBotFollowup(owner, thread, "agree", decision).status, "closed");
  assert.equal(follow.applyBotFollowup(owner, thread, "agree", decision).revision, 4);
  follow.ingestFollowupEvent(item.id, hook.token, { ...recovered, eventId: "r2" });
  assert.equal(follow.botFollowupDetail(owner, thread, item.id).events.length, 4);
  assert.match(follow.botFollowupDetail(owner, thread, item.id).followup.latest, /同意.*已报告恢复/);
  const next = create("flapping");
  follow.ingestFollowupEvent(next.item.id, next.hook.token, recovered);
  follow.ingestFollowupEvent(next.item.id, next.hook.token, { eventId: "f1", state: "failed" });
  assert.equal(follow.applyBotFollowup(owner, thread, "approve-second", { kind: "approve", id: next.item.id, revision: 4 }).status, "open");
});

test("全局待确认仅含本人的有效话题；期限独立于进展，旧版待定需重新确认", () => {
  const owner = user("审批发起"), actor = user("审批成员"), other = user("其他成员");
  const personal = bots.listBots(actor)[0]!;
  const team = bots.listBots(owner)[0]!;
  const shared = bots.acceptInvite(actor, bots.createInvite(owner, team.id).token).sharedThreadId!;
  bots.acceptInvite(other, bots.createInvite(owner, team.id).token);
  const create = (uid: string, thread: string, assigneeId: string, key: string) => {
    const item = follow.applyBotFollowup(uid, thread, key, { kind: "create", title: key });
    return follow.applyBotFollowup(uid, thread, "ask-" + key, { kind: "ask", text: key + "？", assigneeId, id: item.id, revision: 1 });
  };
  const mine = create(actor, personal.privateThreadId, actor, "私人事项");
  const ours = create(owner, shared, actor, "共同事项");
  create(owner, shared, other, "其他人的问题");
  const pending = () => follow.pendingBotDecisions(actor);
  assert.deepEqual(new Set(pending().map(i => i.id)), new Set([mine.id, ours.id]));
  assert.deepEqual(follow.pendingBotDecisions(owner), []);
  assert.ok(ours.decisionExpiresAt! > Date.now());
  db.sql("UPDATE web_bot_followups SET decisionExpiresAt=? WHERE id=?").run(Date.now() - 1, ours.id);
  follow.applyBotFollowup(actor, shared, "note", { kind:"note", id:ours.id, revision:2, text:"更新进展" });
  assert.ok(pending().find(item => item.id === ours.id)?.decisionExpired);
  for (const kind of ["approve", "decline"] as const) {
    assert.throws(() => follow.applyBotFollowup(actor, shared, kind, { kind, id: ours.id, revision: 3 }), denied(409));
  }
  const renewed = follow.applyBotFollowup(owner, shared, "renew", { kind:"ask", id:ours.id, revision:3, text:"再核实一次？" });
  assert.equal(renewed.decisionExpired, false);
  assert.throws(() => follow.applyBotFollowup(actor, shared, "stale", { kind:"approve", id:ours.id, revision:3 }), denied(409));
  bots.removeMember(owner, team.id, actor);
  bots.acceptInvite(actor, bots.createInvite(owner, team.id).token);
  assert.deepEqual(pending().map(item => item.id), [mine.id]);
  db.sql("UPDATE web_bot_followups SET decisionExpiresAt=NULL WHERE id=?").run(mine.id);
  db.closeDatabaseForTest();
  assert.equal(follow.botFollowupDetail(actor, personal.privateThreadId, mine.id).followup.canDecide, false);
  assert.throws(() => follow.applyBotFollowup(actor, personal.privateThreadId, "legacy", { kind:"approve", id:mine.id, revision:2 }), denied(409));
});

async function call(url: string, cookie: string, payload?: Record<string, unknown>, bearer?: string) {
  const { handleApi } = await import("../src/channels/web/api.js");
  const req = Readable.from(payload ? [Buffer.from(JSON.stringify(payload))] : []) as unknown as IncomingMessage;
  Object.assign(req, { method:payload ? "POST" : "GET", headers: { cookie:"aim_session=" + cookie, authorization:bearer && "Bearer " + bearer }, socket:{ remoteAddress:"test" } });
  let value;
  const res = { writeHead() {}, end(body: string) { value = JSON.parse(body); } } as unknown as ServerResponse;
  await handleApi(req, res, new URL(url, "http://localhost"));
  return value as any;
}

test("提醒编辑 API 拒绝未支持的重复规则，原提醒时间保持有效", async () => {
  const { createSession } = await import("../src/channels/web/auth.js");
  const { applyBotReminder, listBotReminders } = await import("../src/core/web-bot-reminders.js");
  const actor = user("单次提醒人");
  const threadId = bots.listBots(actor)[0]!.privateThreadId;
  const cookie = createSession(actor, "test", "phone");
  const dueAt = Date.now() + 60000;
  applyBotReminder(actor, threadId, "seed", {kind:"create", text:"带水壶", dueAt});
  const reminder = listBotReminders(actor,threadId)[0]!;
  const path = "/api/bot-reminders/" + reminder.id;
  const update = {requestId:"edit", threadId, kind:"update", dueAt:dueAt+60000};
  await assert.rejects(call(path,cookie,{...update,frequency:"weekly"}), (e:any) => e.status === 400);
  assert.equal(listBotReminders(actor, threadId)[0]?.dueAt, dueAt);
  await call(path,cookie,update);
  assert.equal(listBotReminders(actor, threadId)[0]?.dueAt, update.dueAt);
});

test("审批通过真实 API 跨 Bot 汇总，来源恢复在续期批准后只结案一次、按账号已读", async () => {
  const { createSession } = await import("../src/channels/web/auth.js");
  const admin = user("排期负责人"), decider = user("排期确认人"), observer = user("排期观察者");
  const a = createSession(admin, "test", "desktop"), b = createSession(decider, "test", "phone"), c = createSession(observer, "test", "desktop");
  const bot = bots.listBots(admin)[0]!;
  const shared = bots.acceptInvite(decider, bots.createInvite(admin, bot.id).token).sharedThreadId!;
  bots.acceptInvite(observer, bots.createInvite(admin, bot.id).token);
  const thread = bots.listBots(decider).find(bot => bot.isDefault)!.privateThreadId;
  const prefix = (threadId: string) => "/api/bots/threads/" + threadId + "/followups";
  const { followup: mine } = await call(prefix(thread), b, {requestId:"private",title:"自用确认"});
  await call(prefix(thread) + "/" + mine.id + "/actions", b, {kind:"ask",requestId:"priv-ask",revision:1,text:"明早取件？"});
  const { followup: item } = await call(prefix(shared), a, {requestId:"shared-item",title:"备份恢复确认"});
  const path = prefix(shared) + "/" + item.id;
  const action = (who: string, kind: string, revision: number, requestId: string, extra = {}) =>
    call(path + "/actions", who, { kind, revision, requestId, ...extra });
  const { token, url } = await call(path + "/hook", a, {});
  await action(a, "ask", 1, "first-question", {text:"确认最新进展？",assigneeId:decider});
  const page = "/api/bots/followups/pending";
  assert.deepEqual(new Set((await call(page, b)).items.map((i: {id:string}) => i.id)), new Set([mine.id,item.id]));
  assert.equal((await call(page, c)).items.length, 0);
  const rejected = (status: number) => (e: any) => e.status === status;
  await assert.rejects(call(page, ""), rejected(401));
  await assert.rejects(action(c, "approve", 2, "wrong-member"), rejected(403));
  db.sql("UPDATE web_bot_followups SET decisionExpiresAt=0 WHERE id=?").run(item.id);
  await assert.rejects(action(b, "approve", 2, "expired"), rejected(409));
  await action(a, "ask", 2, "renewed", {text:"请重新核对最新进展",assigneeId:decider});
  await call(url, "", {eventId:"recovered-v1",state:"ok",recovered:true}, token);
  await call(url, "", {eventId:"recovered-v2",state:"ok",recovered:true}, token);
  assert.equal((await call(path,b)).followup.revision, 4);
  await assert.rejects(action(b, "approve", 2, "stale-confirm"), rejected(409));
  assert.equal((await action(b, "approve", 4, "approved")).followup.status, "closed");
  await call(url, "", {eventId:"recovered-v3",state:"ok",recovered:true}, token);
  assert.equal((await call(path,b)).followup.revision, 5);
  assert.equal((await call(page,b)).items.some((i: {id:string}) => i.id === item.id),false);
  const inbox = "/api/bot-inbox";
  const mineNotices = (await call(inbox,b)).items.filter((i: {threadId:string}) => i.threadId === shared);
  assert.ok(mineNotices.length >= 1 && mineNotices.every((i: {seen:boolean}) => !i.seen));
  await call(inbox + "/read",b,{threadId:shared,through:mineNotices[0].messageId});
  assert.ok((await call(inbox,b)).items.filter((i: {threadId:string}) => i.threadId === shared).every((i: {seen:boolean}) => i.seen));
  assert.ok((await call(inbox,a)).items.some((i: {seen:boolean}) => !i.seen));
  assert.equal((await call(inbox,c)).items.length, 0);
});

test("两个独立连接同时打开旧版跟进表，保留原始事项并将旧审批转为需重确认", async () => {
  const root = fs.mkdtempSync(path.join(home, "legacy-"));
  fs.mkdirSync(path.join(root,"data"), {recursive:true});
  const actor = user("升级审批人");
  const thread = bots.listBots(actor)[0]!.privateThreadId;
  const item = follow.applyBotFollowup(actor,thread,"new",{kind:"create",title:"旧包事项"});
  follow.applyBotFollowup(actor,thread,"ask",{kind:"ask",id:item.id,revision:1,text:"仍需本人的确认"});
  const filename = path.join(root,"data","agent-loft.db");
  db.sql("VACUUM INTO ?").run(filename);
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const legacy = new DatabaseSync(filename);
  legacy.exec("ALTER TABLE web_bot_followups DROP COLUMN decisionExpiresAt");
  legacy.close();
  const inspect = `
    import { parentPort, workerData } from "node:worker_threads";
    import { tsImport } from "tsx/esm/api";
    const {sql, closeDatabaseForTest} = await tsImport(workerData.module, import.meta.url);
    parentPort.once("message", () => {
      const row = sql("SELECT status,revision,decisionExpiresAt FROM web_bot_followups WHERE id=?").get(workerData.id);
      closeDatabaseForTest();
      parentPort.postMessage(row);
    });
    parentPort.postMessage("ready");
  `;
  const workers = [1, 2].map(() => new Worker(inspect, {eval:true,
    env:{...process.env, AGENT_LOFT_HOME:root},
    workerData:{module:new URL("../src/core/db.ts", import.meta.url).href, id:item.id}
  }));
  try {
    await Promise.all(workers.map(worker => once(worker, "message")));
    const answers = workers.map(worker => once(worker, "message"));
    for (const worker of workers) worker.postMessage("open");
    for (const [row] of await Promise.all(answers))
      assert.deepEqual(row,{status:"waiting", revision:2, decisionExpiresAt:null});
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
});
