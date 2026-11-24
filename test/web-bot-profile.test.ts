import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PublicUser } from "../src/core/users.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "loft-bot-profile-"));
process.env.AGENT_LOFT_HOME = home;
process.env.AGENT_LOFT_BOT_MODEL = "faux/standard";
const { config, loadConfig, saveConfig } = await import("../src/core/config.js");
loadConfig();
const { createUser, getUser } = await import("../src/core/users.js");
const { listBots, createBot, createInvite, acceptInvite, stopSharing, removeMember, listMessages } =
  await import("../src/core/web-bots.js");
const { sql, closeDatabaseForTest } = await import("../src/core/db.js");
const { handleBotsApi } = await import("../src/channels/web/bots-api.js");
const {
  botMemoryPage,
  listBotMemories,
  getBotProfile,
  updateBotProfile,
  botModelChoices,
  pickBotModel,
  selectBotChatMemories,
  saveBotMemory,
} = await import("../src/core/web-bot-profile.js");
const { applyBotFollowup, setFollowupHook, checkFollowupHook } = await import("../src/core/web-bot-followups.js");
const { applyBotReminder, fireDueBotReminders, enqueueBotNotice } = await import("../src/core/web-bot-reminders.js");
const { loadSdk, setModelRuntime } = await import("../src/agents/pi/sdk.js");
after(() => {
  setModelRuntime(null);
  closeDatabaseForTest();
  fs.rmSync(home, { force: true, recursive: true });
});
const owner = createUser({ name: "owner", role: "admin", password: "owner-password" });
const ada = createUser({ name: "ada", password: "ada-password" });
const lin = createUser({ name: "lin", password: "lin-password" });

async function request(user: PublicUser, method: string, url: string, data?: object) {
  const req = Readable.from(data ? [Buffer.from(JSON.stringify(data))] : []) as unknown as IncomingMessage;
  Object.assign(req, { method, headers: {} });
  let result: any;
  const res = {
    writeHead() {},
    end(raw: string) {
      result = JSON.parse(raw);
    },
  } as unknown as ServerResponse;
  await handleBotsApi(req, res, new URL(url, "https://example.test"), getUser(user.id)!);
  return result;
}

test("独立设置按 Bot 保存并重启恢复，只有所有者可改，过期版本不能覆盖", async () => {
  const original = listBots(owner.id)[0]!,
    other = createBot(owner.id, "旅行搭子");
  const url = "/api/bots/" + original.id + "/profile";
  const { profile: before } = await request(owner, "GET", url);
  assert.deepEqual(before.capabilities, ["reminders", "followups", "delegation", "memory"]);
  acceptInvite(ada.id, createInvite(owner.id, original.id).token);
  await assert.rejects(request(ada, "PATCH", url, { revision: 0, style: "改" }), { status: 403 });
  await assert.rejects(request(lin, "GET", url), { status: 404 });
  await assert.rejects(request(owner, "PATCH", url, { revision: 0, capabilities: ["shell"] }), { status: 400 });
  const { profile } = await request(owner, "PATCH", url, {
    revision: 0,
    responsibility: "设计周末路线",
    style: "每段一两句话",
    capabilities: ["memory"],
  });
  assert.equal(profile.revision, 1);
  assert.deepEqual((await request(ada, "GET", url)).profile, profile);
  await assert.rejects(request(owner, "PATCH", url, { revision: 0, style: "覆盖" }), { status: 409 });
  closeDatabaseForTest();
  assert.deepEqual(getBotProfile(owner.id, original.id), profile);
  assert.deepEqual(listBots(ada.id).find((bot) => bot.id === original.id)?.capabilities, ["memory"]);
  assert.equal(getBotProfile(owner.id, other.id).style, "");
});

test("私人记忆、成员建议与已发布的共享记忆各有可见范围，重新共享不会带回旧资料", async () => {
  const bot = createBot(owner.id, "读书会"),
    member = acceptInvite(ada.id, createInvite(owner.id, bot.id).token);
  acceptInvite(lin.id, createInvite(owner.id, bot.id).token);
  const shared = member.sharedThreadId!,
    group = "/api/bots/threads/" + shared + "/memories",
    mine = "/api/bots/threads/" + member.privateThreadId + "/memories";
  await assert.rejects(request(ada, "POST", mine, { text: "未明确范围" }), { status: 400 });
  const personal = await request(ada, "POST", mine, { text: "自己的读书进度", scope: "private" });
  assert.equal(personal.pending, false);
  await assert.rejects(request(owner, "GET", mine), { status: 404 });
  const suggestion = await request(ada, "POST", group, { text: "每周三读书", scope: "shared" });
  const id = suggestion.memory.id;
  assert.equal(suggestion.pending, true);
  assert.deepEqual(await request(lin, "GET", group), { memories: [], proposals: [] });
  assert.deepEqual(listBotMemories(owner.id, shared), []);
  assert.deepEqual(
    (await request(ada, "GET", group)).proposals.map((p: any) => p.id),
    [id],
  );
  assert.equal((await request(owner, "GET", group)).proposals[0].canApprove, true);
  await assert.rejects(request(lin, "DELETE", group + "/" + id), { status: 404 });
  await assert.rejects(request(ada, "POST", group + "/" + id + "/approve", { scope: "shared" }), { status: 403 });
  await assert.rejects(request(owner, "POST", group + "/" + id + "/approve", {}), { status: 400 });
  const published = await request(owner, "POST", group + "/" + id + "/approve", { scope: "shared" });
  assert.equal(published.memory.canApprove, false);
  assert.deepEqual(
    listBotMemories(lin.id, shared).map((m) => m.text),
    ["每周三读书"],
  );
  const personalView = await request(ada, "GET", mine);
  assert.equal(personalView.memories.length, 2);
  assert.equal(personalView.memories.find((m: any) => m.scope === "shared").canDelete, false);
  assert.equal(listBotMemories(owner.id, bot.privateThreadId).length, 1);
  assert.equal(listBotMemories(ada.id, listBots(ada.id)[0]!.privateThreadId).length, 0);
  closeDatabaseForTest();
  assert.equal(listBotMemories(ada.id, member.privateThreadId).length, 2);
  const withdrawn = await request(ada, "POST", group, { text: "失效建议", scope: "shared" });
  removeMember(owner.id, bot.id, ada.id);
  acceptInvite(ada.id, createInvite(owner.id, bot.id).token);
  assert.deepEqual((await request(owner, "GET", group)).proposals, []);
  await assert.rejects(request(owner, "POST", group + "/" + withdrawn.memory.id + "/approve", { scope: "shared" }), {
    status: 404,
  });
  stopSharing(owner.id, bot.id);
  const next = acceptInvite(lin.id, createInvite(owner.id, bot.id).token);
  assert.deepEqual(listBotMemories(lin.id, next.sharedThreadId!), []);
  assert.deepEqual(listBotMemories(owner.id, bot.privateThreadId), []);
  await assert.rejects(request(lin, "GET", group), { status: 404 });
});

test("关闭能力同步阻止写记忆、提醒、跟进和旧 webhook，保护已入列推送", async () => {
  const bot = createBot(owner.id, "运动教练"),
    thread = bot.privateThreadId,
    memories = "/api/bots/threads/" + thread + "/memories";
  const saved = await request(owner, "POST", memories, { text: "跑步五公里", scope: "private" });
  const follow = applyBotFollowup(owner.id, thread, "once", { kind: "create", title: "训练计划" });
  const hook = setFollowupHook(owner.id, thread, follow.id, true)!;
  const dueAt = Date.now() + 30000;
  applyBotReminder(owner.id, thread, "alarm", { kind: "create", text: "出门跑步", dueAt });
  enqueueBotNotice(owner.id, thread, "prior", "reminder");
  await updateBotProfile(owner.id, bot.id, { revision: 0, capabilities: [] });
  assert.throws(() => applyBotReminder(owner.id, thread, "other", { kind: "create", text: "新的", dueAt }), { status: 403 });
  assert.throws(
    () => applyBotFollowup(owner.id, thread, "note", { kind: "note", id: follow.id, revision: 1, text: "更新" }),
    { status: 403 },
  );
  assert.throws(() => checkFollowupHook(follow.id, hook.token), { status: 404 });
  assert.throws(() => setFollowupHook(owner.id, thread, follow.id, true), { status: 403 });
  assert.equal(sql("SELECT id FROM bot_notice_events WHERE threadId=?").get(thread), undefined);
  fireDueBotReminders(dueAt + 5);
  assert.equal(
    listMessages(owner.id, thread).some((m) => m.text.includes("出门跑步")),
    false,
  );
  await assert.rejects(request(owner, "POST", memories, { text: "新的", scope: "private" }), { status: 403 });
  assert.deepEqual(listBotMemories(owner.id, thread), []);
  assert.equal(botMemoryPage(owner.id, thread).memories.length, 1);
  await request(owner, "DELETE", memories + "/" + saved.memory.id);
  assert.deepEqual(botMemoryPage(owner.id, thread).memories, []);
  await updateBotProfile(owner.id, bot.id, { revision: 1, capabilities: ["followups"] });
  assert.throws(() => checkFollowupHook(follow.id, hook.token), { status: 404 });
});

test("对话优先召回旧的相关记忆，限制总字数，检索词不会扩大访问范围", () => {
  const bot = createBot(owner.id, "课外活动");
  const member = acceptInvite(ada.id, createInvite(owner.id, bot.id).token);
  const shared = member.sharedThreadId!,
    personal = member.privateThreadId;
  const old = saveBotMemory(ada.id, personal, "游泳课每周六上午十点。" + "课程介绍".repeat(96), "private").memory;
  sql("UPDATE web_bot_memories SET createdAt=1 WHERE id=?").run(old.id);
  for (let i = 0; i < 18; i++) {
    const filler = saveBotMemory(ada.id, personal, "购物记录 " + i + " " + "番茄".repeat(195), "private").memory;
    sql("UPDATE web_bot_memories SET createdAt=? WHERE id=?").run(100 + i, filler.id);
  }
  saveBotMemory(owner.id, bot.privateThreadId, "游泳比赛报名账号属于所有者", "private");
  saveBotMemory(ada.id, shared, "未发布的游泳建议", "shared");
  saveBotMemory(owner.id, shared, "泳馆周一休息", "shared");
  const result = selectBotChatMemories(ada.id, personal, "游泳课几点开始？");
  assert.deepEqual(result[0], { text: old.text, scope: "private" });
  assert.ok(result.reduce((sum, m) => sum + m.text.length, 0) <= 5000);
  assert.ok(result.length < listBotMemories(ada.id, personal).length);
  assert.doesNotMatch(JSON.stringify(result), /报名账号|未发布/);
  assert.equal(
    selectBotChatMemories(ada.id, personal, "").some((m) => m.text === old.text),
    false,
  );
  assert.deepEqual(selectBotChatMemories(owner.id, shared, "游泳"), [{ scope: "shared", text: "泳馆周一休息" }]);
});

test("每个 Bot 只能选管理员允许且已连接的模型，模型下线和不支持读图分别反馈", async () => {
  const { ai, pi } = await loadSdk();
  const rt = await pi.ModelRuntime.create({
    authPath: path.join(home, "test-auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const provider = ai.fauxProvider({
    provider: "faux",
    models: [
      { id: "standard", input: ["text"] },
      { id: "photo", input: ["text", "image"] },
      { id: "unapproved", input: ["text"] },
    ],
  });
  rt.registerNativeProvider(provider.provider);
  await rt.setRuntimeApiKey("faux", "dummy");
  setModelRuntime(rt);
  const settings = structuredClone(config());
  settings.agents.pi.enabled = true;
  settings.agents.pi.models = ["faux/photo"];
  saveConfig(settings);
  const bot = createBot(owner.id, "照片助手"),
    base = createBot(owner.id, "聊天助手");
  acceptInvite(ada.id, createInvite(owner.id, bot.id).token);
  assert.deepEqual((await botModelChoices(owner.id, bot.id)).map((m) => m.id).sort(), ["faux/photo", "faux/standard"]);
  await assert.rejects(botModelChoices(ada.id, bot.id), { status: 403 });
  await assert.rejects(updateBotProfile(owner.id, bot.id, { revision: 0, model: "faux/unapproved" }), { status: 400 });
  await updateBotProfile(owner.id, bot.id, { revision: 0, model: "faux/photo" });
  assert.equal((await pickBotModel(ada.id, bot.id, true)).id, "photo");
  assert.equal((await pickBotModel(owner.id, base.id, false)).id, "standard");
  await assert.rejects(pickBotModel(owner.id, base.id, true), { status: 400 });
  const next = structuredClone(config());
  next.agents.pi.enabled = false;
  saveConfig(next);
  assert.deepEqual(
    (await botModelChoices(owner.id, bot.id)).map((m) => m.id),
    ["faux/standard"],
  );
  next.agents.pi.enabled = true;
  next.agents.pi.models = [];
  saveConfig(next);
  await assert.rejects(pickBotModel(ada.id, bot.id, false), { status: 503 });
  await updateBotProfile(owner.id, bot.id, { revision: 1, model: "" });
  assert.equal((await pickBotModel(ada.id, bot.id, false)).id, "standard");
});
