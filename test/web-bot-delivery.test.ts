import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "loft-bot-delivery-"));
process.env.AGENT_LOFT_HOME = home;
const { loadConfig } = await import("../src/core/config.js");
loadConfig();
const { createUser, getUser } = await import("../src/core/users.js");
const { sql, closeDatabaseForTest } = await import("../src/core/db.js");
const { getBotThread, listBots, listMessages, createInvite, removeMember, acceptInvite } =
  await import("../src/core/web-bots.js");
const { listBotReminders, applyBotReminder, fireDueBotReminders } = await import("../src/core/web-bot-reminders.js");
const { deliverBotNotices } = await import("../src/channels/web/bot-delivery.js");
const { createSession, pushSessionId, revokeSession } = await import("../src/channels/web/auth.js");
const { addSubscription, browserPushEndpoint } = await import("../src/channels/web/push.js");
const { handleApi } = await import("../src/channels/web/api.js");
const owner = createUser({ name: "first", password: "password-first", role: "admin" }).id;
after(() => {
  closeDatabaseForTest();
  fs.rmSync(home, { recursive: true, force: true });
});

async function route(url: string, method = "GET", token = "", data?: object, headers: Record<string, string> = {}) {
  const req = Readable.from(data ? [Buffer.from(JSON.stringify(data))] : []) as unknown as IncomingMessage;
  Object.assign(req, { method, headers: { cookie: "aim_session=" + token, ...headers }, socket: { remoteAddress: "test" } });
  let status = 0;
  let json: any;
  let cookie = "";
  const res = {
    setHeader(name: string, value: string) {
      if (name === "Set-Cookie") cookie = value.split(";")[0]!.slice("aim_session=".length);
    },
    writeHead(code: number) {
      status = code;
    },
    end(body: string) {
      json = JSON.parse(body);
    },
  } as unknown as ServerResponse;
  await handleApi(req, res, new URL(url, "http://localhost"));
  return { status, json, cookie };
}

test("邀请码注册只授予 Bot 访问、回复和收件箱各自归属", async () => {
  const ownerSession = createSession(owner, "test", "browser");
  const { json: home } = await route("/api/bots", "GET", ownerSession);
  const bot = home.bots[0];
  const { json: invite } = await route("/api/bots/" + bot.id + "/invites", "POST", ownerSession);
  const signup = await route("/api/bot-join", "POST", "", { name: "invited", password: "new-account", token: invite.token });
  assert.equal(signup.status, 201);
  const user = (await route("/api/me", "GET", signup.cookie)).json.user;
  assert.ok(getUser(user.id)?.botOnly);
  await assert.rejects(route("/api/bootstrap", "GET", signup.cookie), { status: 403 });
  await assert.rejects(route("/api/bot-join", "POST", "", { name: "another", password: "new-account", token: invite.token }), {
    status: 404,
  });
  const thread = signup.json.bot.sharedThreadId;
  const dueAt = Date.now() + 600000;
  applyBotReminder(user.id, thread, "store", { kind: "create", text: "带水壶", dueAt });
  applyBotReminder(user.id, thread, "store", { kind: "create", text: "带水壶", dueAt });
  assert.equal(listBotReminders(user.id, thread).length, 1);
  assert.deepEqual(listBotReminders(owner, thread), []);
  const id = listBotReminders(user.id, thread)[0]!.id;
  assert.equal(
    (
      await route("/api/bot-reminders/" + id, "POST", signup.cookie, {
        kind: "update",
        requestId: "edit",
        threadId: thread,
        dueAt: dueAt + 3000,
      })
    ).status,
    200,
  );
  fireDueBotReminders(dueAt + 1000);
  assert.equal(listBotReminders(user.id, thread).length, 1);
  fireDueBotReminders(dueAt + 4000);
  fireDueBotReminders(dueAt + 4000);
  const inbox = (await route("/api/bot-inbox", "GET", signup.cookie)).json.items;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].seen, false);
  assert.equal((await route("/api/bot-inbox", "GET", ownerSession)).json.items.length, 0);
  assert.equal(listMessages(owner, thread).filter((m) => m.text.includes("⏰")).length, 1);
  await route("/api/bot-inbox/read", "POST", signup.cookie, { threadId: thread, through: inbox[0].messageId });
  assert.equal((await route("/api/bot-inbox", "GET", signup.cookie)).json.items[0].seen, true);
  const later = dueAt + 300000;
  applyBotReminder(user.id, thread, "another", { kind: "create", text: "旧成员提醒", dueAt: later });
  removeMember(owner, bot.id, user.id);
  acceptInvite(user.id, createInvite(owner, bot.id).token);
  assert.deepEqual((await route("/api/bot-inbox", "GET", signup.cookie)).json.items, []);
  fireDueBotReminders(later + 1);
  assert.ok(!listMessages(owner, thread).some((m) => m.text.includes("旧成员提醒")));
});

test("从共享对话用表单创建提醒，只在创建者的私聊确认和投递，重试不会重复创建", async () => {
  const member = createUser({ name: "reminder-member", password: "private-reminder" }).id;
  const bot = acceptInvite(member, createInvite(owner, listBots(owner)[0]!.id).token);
  const shared = bot.sharedThreadId!;
  const cookie = createSession(member, "local", "test");
  const dueAt = Date.now() + 600000, text = "仅此成员可读";
  const body = { kind: "create", threadId: shared, requestId: "shared-form", text, dueAt };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await route("/api/bot-reminders", "POST", cookie, body);
    assert.equal(response.status, 200);
    assert.equal(response.json.threadId, bot.privateThreadId);
  }
  assert.equal(listBotReminders(member, bot.privateThreadId).length, 1);
  assert.equal(listBotReminders(member, shared).length, 0);
  fireDueBotReminders(dueAt + 1);
  assert.ok(listMessages(member, bot.privateThreadId).some(m => m.text.includes("⏰ 提醒：" + text)));
  assert.ok(!listMessages(owner, shared).some(m => m.text.includes(text)));
  assert.deepEqual((await route("/api/bot-inbox", "GET", cookie)).json.items.map((row: { threadId: string }) => row.threadId), [bot.privateThreadId]);
  await assert.rejects(route("/api/bot-reminders", "POST", cookie, { ...body, threadId: listBots(owner)[0]!.privateThreadId }), { status: 404 });
});

test("每台设备分别重试；远程退出后该订阅不再投递", async () => {
  const user = createUser({ name: "pushuser", password: "my-password" }).id;
  const thread = listBots(user)[0]!.privateThreadId;
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const keys = { p256dh: ecdh.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") };
  const suffixes = ["first", "second"];
  const tokens = suffixes.map((device) => {
    const token = createSession(user, "test", device);
    addSubscription({ endpoint: "https://web.push.apple.com/" + device, keys }, device, user, pushSessionId(token), "bot");
    return token;
  });
  assert.equal(browserPushEndpoint("https://localhost:8080/send"), false);
  const due = Date.now() + 60000;
  applyBotReminder(user, thread, "device-reminder", { kind: "create", text: "正文", dueAt: due });
  const endpoints: string[] = [];
  const old = globalThis.fetch;
  globalThis.fetch = async (resource, options) => {
    const uri = String(resource);
    endpoints.push(uri);
    assert.equal(options?.redirect, "error");
    return new Response(null, { status: uri.endsWith("second") ? 503 : 201 });
  };
  try {
    await deliverBotNotices(due + 1);
    assert.equal(endpoints.length, 2);
    assert.equal(Number(sql("SELECT COUNT(*) n FROM bot_notice_devices WHERE userId=?").get(user)?.n), 1);
    revokeSession(pushSessionId(tokens[1]!).slice(0, 12), user);
    await deliverBotNotices(due + 60000);
    assert.equal(endpoints.length, 2);
    assert.equal(Number(sql("SELECT COUNT(*) n FROM bot_notice_devices WHERE userId=?").get(user)?.n), 0);
  } finally {
    globalThis.fetch = old;
  }
});

test("独立 Bot 部署同样限制管理员的工作台接口", async () => {
  const token = createSession(owner, "test", "test");
  process.env.AGENT_LOFT_WEB_MODE = "bot";
  try {
    await assert.rejects(route("/api/bootstrap", "GET", token), { status: 403 });
    assert.equal((await route("/api/bots", "GET", token)).status, 200);
  } finally {
    delete process.env.AGENT_LOFT_WEB_MODE;
  }
});

test("锁屏自测只投递给主动申请的本次登录和设备，并保留锁屏时间", async () => {
  const user = createUser({ name: "lockscreen", password: "password-notice" }).id;
  const threadId = listBots(user)[0]!.privateThreadId;
  const endpoint = "https://web.push.apple.com/current-phone";
  const key = crypto.createECDH("prime256v1");
  key.generateKeys();
  const keys = { p256dh: key.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") };
  const token = createSession(user, "test", "phone");
  const other = createSession(user, "test", "tablet");
  addSubscription({ endpoint, keys }, "phone", user, pushSessionId(token), "bot");
  const url = "/api/bot-inbox/test-device";
  const body = { threadId, endpoint };
  await assert.rejects(route(url, "POST", other, body), { status: 403 });
  await assert.rejects(route(url, "POST", token, { ...body, threadId: listBots(owner)[0]!.privateThreadId }), { status: 404 });
  assert.equal((await route(url, "POST", token, body)).status, 202);
  assert.equal((await route(url, "POST", token, body)).status, 202);
  const rows = sql("SELECT * FROM bot_notice_devices WHERE kind='test' AND userId=?").all(user);
  assert.equal(rows.length, 1);
  const at = Number(rows[0]!.nextAt);
  const sent: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => { sent.push(String(url)); return new Response(null, {status:201}); };
  try {
    await deliverBotNotices(at - 1);
    assert.deepEqual(sent, []);
    await deliverBotNotices(at + 1);
    assert.deepEqual(sent, [endpoint]);
    assert.equal((await route("/api/bot-inbox", "GET", token)).json.items.length, 0);
  } finally { globalThis.fetch = original; }
});

test("同一账号可以分别开启两个入口；相同端点也只停止选中的用途", async () => {
  const { pushToAll, botPushDevices, sendBotPush } = await import("../src/channels/web/push.js");
  const { pushOwnedBy } = await import("../src/channels/web/access.js");
  const user = createUser({name:"surface-test",password:"password-both"}).id;
  const session = createSession(user, "local", "phone");
  const sid = pushSessionId(session);
  const key = crypto.createECDH("prime256v1");
  key.generateKeys();
  const keys = { p256dh:key.getPublicKey().toString("base64url"), auth:crypto.randomBytes(16).toString("base64url") };
  const device = (name: string) => "https://web.push.apple.com/surface-" + name;
  async function enable(purpose: string, name: string) {
    const response = await route("/api/push/subscribe", "POST", session, {purpose, subscription:{endpoint:device(name),keys}});
    assert.equal(response.status, 200);
  }
  await enable("bot", "phone");
  await enable("workbench", "desk");
  await enable("bot", "shared");
  await enable("workbench", "shared");
  const visible = async (purpose:string) => (await route("/api/push?purpose=" + purpose,"GET",session)).json.subscriptions.map((s: {endpoint:string}) => s.endpoint).sort();
  assert.deepEqual(await visible("bot"), ["phone","shared"].map(device));
  assert.deepEqual(await visible("workbench"), ["desk","shared"].map(device));
  assert.deepEqual(botPushDevices(user).map(x => x.endpoint).sort(), ["phone","shared"].map(device));
  const sent: string[] = [];
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (url) => { sent.push(String(url)); return new Response(null,{status:201}); };
  try {
    const preview = {title:"workbench",body:"private workbench preview"};
    await pushToAll(preview,pushOwnedBy(user));
    assert.deepEqual(sent.sort(), ["desk","shared"].map(device));
    sent.length = 0;
    for (const endpoint of ["phone","desk","shared"].map(device)) await sendBotPush(user,endpoint,sid,{title:"Bot",body:"新消息"});
    assert.deepEqual(sent.sort(), ["phone","shared"].map(device));
    const disabled = await route("/api/push/unsubscribe","POST",session,{purpose:"bot",endpoint:device("shared")});
    assert.equal(disabled.json.retained,true);
    sent.length = 0;
    await sendBotPush(user,device("shared"),sid,{title:"Bot",body:"排队中的旧消息"});
    assert.deepEqual(sent,[]);
    assert.deepEqual(await visible("workbench"), ["desk","shared"].map(device));
    assert.equal((await route("/api/push/unsubscribe","POST",session,{purpose:"workbench",endpoint:device("shared")})).json.retained,false);
    await enable("bot","shared");
    await enable("workbench","shared");
    assert.equal((await route("/api/push/unsubscribe","POST",session,{purpose:"workbench",endpoint:device("shared")})).json.retained,true);
    assert.deepEqual(await visible("bot"), ["phone","shared"].map(device));
    const oldWorkbench = { subscription: { endpoint:device("legacy-tab"), keys } };
    await assert.rejects(route("/api/push/subscribe","POST",session,oldWorkbench), { status:400 });
    assert.equal((await route("/api/push/subscribe","POST",session,oldWorkbench,{
      referer:"https://loft.example/", "sec-fetch-site":"same-origin",
    })).status, 200);
    addSubscription({endpoint:device("legacy-device"),keys}, "Mac", user);
    const anotherSession = createSession(user, "another-device", "browser");
    addSubscription({endpoint:device("another-device"),keys}, "Mac", user, pushSessionId(anotherSession));
    await route("/api/logout","POST",session,{localPushEndpoints:[device("legacy-device")]});
    assert.deepEqual(botPushDevices(user),[]);
    await pushToAll(preview,pushOwnedBy(user));
    assert.deepEqual(sent,[device("another-device")]);
  } finally { globalThis.fetch=fetchBefore; }
});
