import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import sharp from "sharp";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "bot-lifecycle-test-"));
process.env.AGENT_LOFT_WEB_MODE = "bot";
process.env.AGENT_LOFT_HOME = home;
const { loadConfig } = await import("../src/core/config.js");
loadConfig();
const users = await import("../src/core/users.js");
const bots = await import("../src/core/web-bots.js");
const { sql, closeDatabaseForTest } = await import("../src/core/db.js");
const { saveBotMemory } = await import("../src/core/web-bot-profile.js");
const { applyBotFollowup, setFollowupHook, checkFollowupHook, ingestFollowupEvent } = await import("../src/core/web-bot-followups.js");
const { applyBotReminder, enqueueBotNotice } = await import("../src/core/web-bot-reminders.js");
const { createSession, pushSessionId, destroySession } = await import("../src/channels/web/auth.js");
const { handleApi } = await import("../src/channels/web/api.js");
const admin = users.createUser({ name:"admin", role:"admin", password:"test-admin-123" });
const add = (name:string) => users.createUser({ name, password:"test-member-123" }).id;
const session = (id:string) => createSession(id,"127.0.0.1","browser");
const join = (owner:string, botId:string, member:string) => bots.acceptInvite(member, bots.createInvite(owner,botId).token);
const status = (code:number) => (error:Error & { status?: number }) => error.status === code;
after(() => { closeDatabaseForTest(); fs.rmSync(home, {recursive:true,force:true}); });

async function route(token:string, url:string, method = "GET", body?: object) {
  const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
    method, headers: {cookie:"aim_session="+token}, socket:{remoteAddress:"127.0.0.1"},
  }) as unknown as IncomingMessage;
  let data: any;
  const res = { setHeader(){}, writeHead(){}, end(value: string | Buffer){ data = Buffer.isBuffer(value) ? value : JSON.parse(value); } } as unknown as ServerResponse;
  await handleApi(req,res,new URL(url,"http://localhost"));
  return data;
}

test("收回共用后的归档保留消息、照片、已发布记忆和跟进；重新共用与移交均不扩散权限", async () => {
  const a = add("archive-owner"), b = add("old-member"), c = add("new-member");
  const bot = bots.createBot(a, "亲友");
  const api = "/api/bots/"+bot.id;
  const old = join(a,bot.id,b).sharedThreadId!;
  const st = session(a), guest = session(b), newer = session(c);
  const pic = await sharp({create:{width:4,height:4,channels:3,background:"blue"}}).png().toBuffer();
  const turn = bots.startTurn(b,old,"photo","一起看的照片",[{name:"海边.png",mediaType:"image/png",data:pic.toString("base64")}]);
  bots.finishTurn(b,old,"photo","可以看清。");
  saveBotMemory(a,old,"已发布的约定","shared");
  saveBotMemory(b,old,"待审建议不在归档","shared");
  saveBotMemory(a,bot.privateThreadId,"只在私聊","private");
  applyBotReminder(a,bot.privateThreadId,"keep",{kind:"create",text:"保留自己的提醒",dueAt:Date.now()+60000});
  applyBotReminder(b,old,"clear",{kind:"create",text:"撤回共享时结束",dueAt:Date.now()+60000});
  applyBotFollowup(a,old,"plan",{kind:"create",title:"订餐",text:"先确定人数"});
  await route(st,api+"/sharing","DELETE");
  assert.equal(sql("SELECT 1 FROM bot_reminders WHERE threadId=?").get(old),undefined);
  assert.ok(sql("SELECT 1 FROM bot_reminders WHERE threadId=?").get(bot.privateThreadId));
  assert.equal(bots.getBot(a,bot.id).hasArchives,true);
  assert.equal((await route(st,api+"/archives")).archives[0].id,old);
  const archive = api+"/archives/"+old;
  assert.ok((await route(st,archive)).items.some((row: {text:string}) => row.text === "一起看的照片"));
  assert.deepEqual((await route(st,archive+"?section=memories")).items.map((r:{text:string}) => r.text),["已发布的约定"]);
  assert.ok((await route(st,archive+"?section=followups")).items.some((r:{label:string}) => r.label === "订餐"));
  const image = await route(st,archive+"/photos/"+turn.message.id);
  assert.ok((await sharp(image).metadata()).width);
  await assert.rejects(route(guest,archive),status(404));
  await assert.rejects(route(st,archive,"POST",{text:"更改"}),status(405));
  assert.throws(() => bots.startTurn(a,old,"extra","不能发送"),status(404));

  // Upgrade a candidate DB that already had a closed shared generation but no archive metadata.
  sql("DELETE FROM web_bot_archives WHERE thread=?").run(old);
  closeDatabaseForTest();
  assert.equal((await route(st,api+"/archives")).archives[0].id,old);
  const active = join(a,bot.id,c).sharedThreadId!;
  assert.notEqual(active,old);
  assert.deepEqual((await route(newer,api+"/archives")).archives,[]);
  const invite = bots.createInvite(a,bot.id);
  await route(st,api+"/owner","POST",{userId:c});
  assert.equal(bots.getBot(c,bot.id).ownerId,c);
  assert.equal(bots.validBotInvite(invite.token),false);
  await assert.rejects(route(newer,archive+"/photos/"+turn.message.id),status(404));
  assert.equal((await route(st,api+"/archives")).archives.length,1);
  await assert.rejects(route(st,api,"DELETE"),status(404));
  await assert.rejects(route(newer,api+"/leave","POST"),status(409));
  await route(st,api+"/leave","POST");
  await assert.rejects(route(st,archive),status(404));
});

test("管理员删号清除私人内容及待发任务，共享 Bot 交给现有成员，管理员也读不到其他成员的私聊", async () => {
  const a=add("retire"), b=add("inherits"), disabled=add("inactive");
  const bot=bots.listBots(a)[0]!;
  const solo=bots.createBot(a,"个人草稿");
  const shared=join(a,bot.id,disabled).sharedThreadId!;
  const member=join(a,bot.id,b);
  users.updateUser(disabled,{disabled:true});
  const pic=bots.startTurn(a,bot.privateThreadId,"private","要删除的照片",[{name:"私人",mediaType:"image/jpeg",data:"dGVzdA=="}]);
  bots.finishTurn(a,bot.privateThreadId,"private","私人记录");
  saveBotMemory(a,bot.privateThreadId,"要删除的偏好","private");
  saveBotMemory(a,shared,"团队知识","shared");
  saveBotMemory(b,member.privateThreadId,"成员私有","private");
  applyBotReminder(a,bot.privateThreadId,"r",{kind:"create",text:"私人提醒",dueAt:Date.now()+60000});
  enqueueBotNotice(a,shared,"notice","reply");
  bots.appendBotNotice(b,shared,"集体记录");
  const st=session(admin.id), departed=session(a);
  const other = session(b);
  for (const token of [departed, other]) sql("INSERT INTO bot_device_reads VALUES (?,?,?,?)").run(pushSessionId(token),shared,1,Date.now());
  process.env.AGENT_LOFT_WEB_MODE = "system";
  try { await route(st,"/api/users/"+a,"DELETE"); }
  finally { process.env.AGENT_LOFT_WEB_MODE = "bot"; }
  assert.equal(users.getUser(a),undefined);
  assert.equal(bots.getBot(b,bot.id).ownerId,b);
  assert.equal(bots.getBot(b,bot.id).isDefault,false);
  assert.notEqual(bots.listBots(b).find(bot=>bot.isDefault)?.id,bot.id);
  assert.equal(bots.listMessages(b,shared).at(-1)?.text,"集体记录");
  assert.equal(sql("SELECT 1 FROM web_bot_images WHERE message=?").get(pic.message.id),undefined);
  assert.equal(sql("SELECT 1 FROM web_bot_threads WHERE private_user=?").get(a),undefined);
  assert.equal(sql("SELECT 1 FROM web_bot_memories WHERE text='要删除的偏好'").get(),undefined);
  assert.ok(sql("SELECT 1 FROM web_bot_memories WHERE text='团队知识'").get());
  assert.ok(sql("SELECT 1 FROM web_bot_memories WHERE text='成员私有'").get());
  for(const table of ["bot_reminders","bot_inbox","bot_notice_events","bot_notice_devices"])
    assert.equal(sql(`SELECT 1 FROM ${table} WHERE userId=?`).get(a),undefined);
  assert.equal(sql("SELECT 1 FROM web_bots WHERE id=?").get(solo.id),undefined);
  assert.throws(()=>bots.getBotThread(admin.id,member.privateThreadId),status(404));
  await assert.rejects(route(departed,"/api/bots"),status(401));
  const read = sql("SELECT 1 FROM bot_device_reads WHERE sessionId=?");
  assert.equal(read.get(pushSessionId(departed)), undefined);
  assert.ok(read.get(pushSessionId(other)));
  destroySession(other);
  assert.equal(read.get(pushSessionId(other)), undefined);
  users.recoverBotAccounts();
  assert.equal(bots.getBot(b,bot.id).ownerId,b);
});

test("主动删除默认 Bot 会得到空白助手，删除并新建仍受当日额度控制", async () => {
  const id=add("delete-bot"), st=session(id);
  const old=bots.listBots(id)[0]!;
  bots.startTurn(id,old.privateThreadId,"one","今日的一次");
  bots.finishTurn(id,old.privateThreadId,"one","回答");
  await route(st,"/api/bots/"+old.id,"DELETE");
  const fresh=bots.listBots(id)[0]!;
  assert.equal(fresh.isDefault,true);
  assert.notEqual(fresh.id,old.id);
  assert.deepEqual(bots.listMessages(id,fresh.privateThreadId),[]);
  const prev=process.env.AGENT_LOFT_BOT_DAILY_TURNS;
  try {
    process.env.AGENT_LOFT_BOT_DAILY_TURNS="1";
    assert.throws(()=>bots.startTurn(id,fresh.privateThreadId,"two","第二次"),status(429));
  } finally { if (prev === undefined) delete process.env.AGENT_LOFT_BOT_DAILY_TURNS; else process.env.AGENT_LOFT_BOT_DAILY_TURNS=prev; }
});

test("从旧包升级可以接续已删账号的共用 Bot 并清除该账号的私人内容", () => {
  const former = add("legacy-owner"), successor = add("legacy-member");
  const sharedBot = bots.createBot(former, "旧共享 Bot");
  const solo = bots.createBot(former, "旧私聊 Bot");
  const shared = join(former, sharedBot.id, successor).sharedThreadId!;
  sql("INSERT INTO bot_reminders VALUES (?,?,?,?,?,?)").run("legacy-queue", "removed-queue-only", shared, "old-access", "残留提醒", Date.now()+60000);
  bots.appendBotNotice(former, shared, "交接前的共用记录");
  saveBotMemory(former, sharedBot.privateThreadId, "交接前的私人信息", "private");
  const file = path.join(home, "data", "users.json");
  const store = JSON.parse(fs.readFileSync(file, "utf8"));
  store.users = store.users.filter((account:{id:string}) => account.id !== former);
  fs.writeFileSync(file, JSON.stringify(store));
  users.resetUsersForTest();
  users.recoverBotAccounts();
  users.recoverBotAccounts();
  assert.equal(bots.getBot(successor, sharedBot.id).ownerId, successor);
  assert.equal(bots.listMessages(successor, shared).at(-1)?.text, "交接前的共用记录");
  assert.equal(sql("SELECT 1 FROM web_bot_threads WHERE id=?").get(sharedBot.privateThreadId), undefined);
  assert.equal(sql("SELECT 1 FROM web_bots WHERE id=?").get(solo.id), undefined);
  assert.equal(sql("SELECT 1 FROM bot_reminders WHERE id='legacy-queue'").get(), undefined);
});

test("清理中途失败会回滚，重试可以完整删除同一账号", () => {
  const user = add("retry-retire");
  const bot = bots.createBot(user, "私有记录");
  saveBotMemory(user, bot.privateThreadId, "回滚时应保留", "private");
  sql("CREATE TEMP TRIGGER fail_cleanup BEFORE DELETE ON web_bot_members BEGIN SELECT RAISE(ABORT,'injected'); END").run();
  try {
    assert.throws(() => users.removeUser(user), /injected/);
    assert.ok(users.getUser(user));
    assert.ok(sql("SELECT 1 FROM web_bot_memories WHERE thread=?").get(bot.privateThreadId));
  } finally { sql("DROP TRIGGER fail_cleanup").run(); }
  users.removeUser(user);
  assert.equal(users.getUser(user), undefined);
  assert.equal(sql("SELECT 1 FROM web_bot_memories WHERE thread=?").get(bot.privateThreadId), undefined);
});

test("移交使仅凭旧所有权签发的跟进链接永久失效，保留创建者与私聊的链接", async () => {
  const owner = add("hook-owner"), member = add("hook-member");
  const bot = bots.createBot(owner, "团队助手"), shared = join(owner, bot.id, member).sharedThreadId!;
  function hook(creator: string, signer: string, thread: string, title: string) {
    const item = applyBotFollowup(creator, thread, title, {kind:"create",title});
    return {id:item.id, token:setFollowupHook(signer,thread,item.id,true)!.token};
  }
  const ownerOnly = hook(member, owner, shared, "成员的事项");
  const asCreator = hook(owner, owner, shared, "原所有者创建的事项");
  const ownPrivate = hook(owner, owner, bot.privateThreadId, "私人事项");
  const memberLink = hook(member, member, shared, "其他成员的来源");
  const api = "/api/bots/" + bot.id + "/owner";
  await route(session(owner), api, "POST", {userId:member});
  assert.throws(() => checkFollowupHook(ownerOnly.id,ownerOnly.token),status(404));
  assert.equal(sql("SELECT 1 FROM web_bot_followup_hooks WHERE followup=?").get(ownerOnly.id),undefined);
  for (const link of [asCreator,ownPrivate,memberLink]) checkFollowupHook(link.id,link.token);
  await route(session(member), api, "POST", {userId:owner});
  assert.throws(() => ingestFollowupEvent(ownerOnly.id,ownerOnly.token,{eventId:"stale",state:"old"}),status(404));
  assert.equal(sql("SELECT revision FROM web_bot_followups WHERE id=?").get(ownerOnly.id)?.revision,1);
});
