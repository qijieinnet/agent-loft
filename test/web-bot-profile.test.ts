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

test("Bot 直接绑定引擎，旧资料迁移、逐 Bot 路由、共享授权和跨引擎交办", async (t) => {
  const { hub } = await import("../src/core/hub.js");
  const { CodexDriver } = await import("../src/agents/codex/driver.js");
  const { ClaudeDriver } = await import("../src/agents/claude/driver.js");
  const { updateUser } = await import("../src/core/users.js");
  const { startTurn } = await import("../src/core/web-bots.js");
  const { runBotTurn } = await import("../src/core/web-bot-reply.js");
  const { createBotDelegation, changeBotDelegation } = await import("../src/core/web-bot-delegation.js");
  const { runQueuedBotDelegations } = await import("../src/core/web-bot-delegation-worker.js");
  const bot = createBot(owner.id, "问答"), writer = createBot(owner.id, "撰稿");
  const shared = acceptInvite(ada.id, createInvite(owner.id, bot.id).token).sharedThreadId!;
  const path = "/api/bots/" + bot.id;
  await updateBotProfile(owner.id, bot.id, { revision: 0, responsibility: "写短句" });
  sql("UPDATE web_bot_profiles SET model=? WHERE bot=?").run("faux/standard", bot.id);
  sql("ALTER TABLE web_bot_profiles DROP COLUMN engine").run();
  closeDatabaseForTest();
  const { profile: migrated, engines } = await request(owner, "GET", path + "/profile");
  assert.equal(migrated.engine, "pi");
  assert.equal(migrated.model, "faux/standard");
  assert.equal(migrated.responsibility, "写短句");
  assert.ok(engines.some((e: { id: string }) => e.id === "codex"));
  await assert.rejects(request(owner, "PATCH", path + "/profile", { revision: 1, engine: "expert1" }), { status: 400 });
  await assert.rejects(request(owner, "PATCH", path + "/profile", { revision: 1, engine: "codex", model: "faux/photo" }), { status: 400 });
  const switched = await request(owner, "PATCH", path + "/profile", { revision: 1, engine: "codex" });
  assert.equal(switched.profile.model, "");
  assert.equal(getBotProfile(owner.id, writer.id).engine, "pi");
  await updateBotProfile(owner.id, writer.id, { revision: 0, engine: "claude" });
  const codex = new CodexDriver(), claude = new ClaudeDriver();
  hub.registerDriver(codex);
  hub.registerDriver(claude);
  await request(owner, "PATCH", path + "/codex-tools", { revision: 0, webSearch: "members", terminal: false, edit: false });
  const direct = t.mock.method(codex, "reply", async (req: import("../src/core/types.js").EngineReplyRequest) => {
    assert.equal(JSON.parse(req.prompt).profile.responsibility, "写短句");
    assert.equal(req.codexTools?.webSearch, true);
    assert.equal(req.codexTools?.directory, undefined);
    return '{"text":"来自 Codex"}';
  });
  const delegated = t.mock.method(claude, "reply", async (req: import("../src/core/types.js").EngineReplyRequest) => {
    assert.equal(req.prompt, "写一首诗");
    assert.equal(req.codexTools, undefined);
    return "来自 Claude";
  });
  async function chat(id: string) {
    const turn = startTurn(ada.id, shared, id, "你好");
    await runBotTurn(ada.id, shared, turn.message, id, "Asia/Hong_Kong");
    return listMessages(ada.id, shared).at(-1)!.text;
  }
  assert.equal(await chat("allowed"), "来自 Codex");
  updateUser(ada.id, { permissions: { agents: [] } });
  assert.match(await chat("revoked"), /引擎.*权限/);
  assert.equal(direct.mock.callCount(), 1);
  const job = createBotDelegation(owner.id, shared, "write", { targetId: writer.id, task: "写一首诗" });
  changeBotDelegation(owner.id, shared, job.id, "confirm", 0);
  await runQueuedBotDelegations();
  assert.match(listMessages(owner.id, shared).at(-1)!.text, /来自 Claude/);
  assert.equal(delegated.mock.callCount(), 1);
});

test("Codex 自带工具按 Bot 和对话授权，切换引擎、撤销与移交后生效", async () => {
  const { botCodexTurn } = await import("../src/core/web-bot-codex-tools.js");
  const bot = createBot(owner.id, "本机工具"), other = createBot(owner.id, "另一个 Codex");
  const settings = "/api/bots/" + bot.id + "/codex-tools";
  const payload = { revision: 0, webSearch: "members", terminal: true, edit: false, directory: home };
  const extensions = "/api/bots/" + bot.id + "/extensions";
  assert.equal((await request(owner, "GET", extensions)).codex, null);
  await assert.rejects(request(owner, "PATCH", settings, payload), { status: 409 });
  await updateBotProfile(owner.id, bot.id, { revision: 0, engine: "codex" });
  assert.equal((await request(owner, "GET", extensions)).codex.webSearch, "off");
  acceptInvite(lin.id, createInvite(owner.id, bot.id).token);
  await assert.rejects(request(lin, "PATCH", settings, payload), { status: 404 });
  await assert.rejects(request(owner, "PATCH", settings, { ...payload, directory: "/" }), { status: 400 });
  await request(owner, "PATCH", settings, payload);
  const active = botCodexTurn(owner.id, bot.id, false);
  assert.deepEqual(active.tools, { webSearch: true, terminal: true, edit: false, directory: fs.realpathSync(home) });
  assert.equal(botCodexTurn(owner.id, other.id, false).tools, undefined);
  for (const who of [lin, owner]) {
    const tools = botCodexTurn(who.id, bot.id, true).tools;
    assert.deepEqual(tools, { webSearch: true, terminal: false, edit: false, directory: undefined });
  }
  const updated = { ...payload, revision: 1, webSearch: "private", terminal: false, edit: true };
  await request(owner, "PATCH", settings, updated);
  assert.throws(active.check, { status: 409 });
  await assert.rejects(request(owner, "PATCH", settings, updated), { status: 409 });
  assert.equal(botCodexTurn(lin.id, bot.id, false).tools, undefined);
  assert.equal(botCodexTurn(owner.id, bot.id, true).tools, undefined);
  await updateBotProfile(owner.id, bot.id, { revision: 1, engine: "pi" });
  assert.equal((await request(owner, "GET", extensions)).codex, null);
  await updateBotProfile(owner.id, bot.id, { revision: 2, engine: "codex" });
  assert.equal((await request(owner, "GET", extensions)).codex.edit, true);
  const { transferBot } = await import("../src/core/web-bots.js");
  transferBot(owner.id, bot.id, lin.id);
  assert.equal(botCodexTurn(lin.id, bot.id, false).tools, undefined);
  await assert.rejects(request(lin, "PATCH", settings, payload), { status: 403 });
});

test("Bot 能力清单按本机引擎过滤，私聊授权和失效版本在运行时生效", async t => {
  const { appServer } = await import("../src/agents/codex/app-server.js");
  const { botCodexTurn } = await import("../src/core/web-bot-codex-tools.js");
  const { claudeTurn } = await import("../src/core/web-bot-claude-tools.js");
  const bot = createBot(owner.id, "能力选择");
  await updateBotProfile(owner.id, bot.id, { revision: 0, engine: "codex" });
  const url = "/api/bots/" + bot.id;
  t.mock.method(appServer, "call", async (method: string) => {
    assert.equal(method, "experimentalFeature/list");
    return { data: ["image_generation", "multi_agent", "multi_agent_v2", "view_image"].map(name => ({ name, stage: "stable" })), nextCursor: null };
  });
  const { options } = await request(owner, "GET", url + "/codex-tools");
  assert.equal(options.find((o: {id: string}) => o.id === "image_generation").available, true);
  assert.equal(options.find((o: {id: string}) => o.id === "computer_use").available, false);
  assert.equal(options.find((o: {id: string}) => o.id === "multi_agent").available, false);
  const grants = { revision: 0, webSearch: "off", terminal: false, edit: false };
  await assert.rejects(request(owner, "PATCH", url + "/codex-tools", { ...grants, extra: ["computer_use"] }), { status: 400 });
  await request(owner, "PATCH", url + "/codex-tools", { ...grants, extra: ["image_generation"] });
  assert.deepEqual(botCodexTurn(owner.id, bot.id, false).tools?.extra, ["image_generation"]);
  assert.equal(botCodexTurn(owner.id, bot.id, true).tools, undefined);
  await updateBotProfile(owner.id, bot.id, { revision: 1, engine: "claude" });
  await request(owner, "PATCH", url + "/claude-tools", { revision: 0, settings: { WebFetch: "private", WebSearch: "members" } });
  assert.deepEqual(claudeTurn(owner.id, bot.id, false).names, ["WebSearch", "WebFetch"]);
  const shared = claudeTurn(owner.id, bot.id, true);
  assert.deepEqual(shared.names, ["WebSearch"]);
  await request(owner, "PATCH", url + "/claude-tools", { revision: 1, settings: { WebFetch: "off", WebSearch: "off" } });
  assert.throws(shared.check, { status: 409 });
});
