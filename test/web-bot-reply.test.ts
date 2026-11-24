import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "loft-bot-reply-"));
process.env.AGENT_LOFT_HOME = home;
process.env.AGENT_LOFT_BOT_MODEL = "faux/bot";
const { loadConfig } = await import("../src/core/config.js");
loadConfig();
const { createUser } = await import("../src/core/users.js");
const { startTurn, finishTurn, createBot, listBots, listMessages, createInvite, acceptInvite, removeMember } = await import("../src/core/web-bots.js");
const { runBotTurn, parseBotReply } = await import("../src/core/web-bot-reply.js");
const { listBotReminders } = await import("../src/core/web-bot-reminders.js");
const { listBotFollowups, applyBotFollowup } = await import("../src/core/web-bot-followups.js");
const { closeDatabaseForTest } = await import("../src/core/db.js");
const { loadSdk, setModelRuntime } = await import("../src/agents/pi/sdk.js");
const { ai, pi } = await loadSdk();
const rt = await pi.ModelRuntime.create({ authPath: path.join(home, "auth.json"), modelsPath: null, refreshOnCreate: false });
const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "bot", input: ["image", "text"] }] });
rt.registerNativeProvider(faux.provider);
await rt.setRuntimeApiKey("faux", "fake");
setModelRuntime(rt);
after(() => {
  setModelRuntime(null);
  closeDatabaseForTest();
  fs.rmSync(home, { force: true, recursive: true });
});

test("仅把当前话题交给聊天模型：共享照片与可续改提醒，重放不会执行第二次", async () => {
  const owner = createUser({ name: "first", password: "password-123", role: "admin" });
  const member = createUser({ name: "member", password: "password-123" });
  const personal = listBots(owner.id)[0]!;
  const privateTurn = startTurn(owner.id, personal.privateThreadId, "private", "仅本人可见的内容");
  faux.setResponses([ai.fauxAssistantMessage('{"text":"收到。"}')]);
  await runBotTurn(owner.id, personal.privateThreadId, privateTurn.message, "private", "Asia/Hong_Kong");

  const invite = createInvite(owner.id, personal.id);
  const shared = acceptInvite(member.id, invite.token).sharedThreadId!;
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWNgcFkFQhAKABduA7lrxR6YAAAAAElFTkSuQmCC";
  const turn = startTurn(member.id, shared, "photo", "看一下通知，明天提醒我带水壶。", [{ name: "通知.png", mediaType: "image/png", data: image }]);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
  let called = false;
  faux.setResponses([ctx => {
    called = true;
    assert.doesNotMatch(JSON.stringify(ctx), /仅本人可见的内容/);
    assert.match(JSON.stringify(ctx), /image\/png/);
    assert.match(JSON.stringify(ctx), /Asia\/Hong_Kong/);
    assert.ok(ctx.messages.filter(m => m.role === "system").every(m => !m.toolsAdded?.length));
    return ai.fauxAssistantMessage(JSON.stringify({ text: "周五需要带水壶。我会在错误时间提醒你。", reminder: { kind: "create", text: "带水壶", dueAt: tomorrow } }));
  }]);
  await runBotTurn(member.id, shared, turn.message, "photo", "Asia/Hong_Kong");
  assert.equal(called, true);
  const receipt = listMessages(member.id, shared).at(-1)!.text;
  assert.match(receipt, /周五需要带水壶。/);
  assert.match(receipt, /已安排提醒：带水壶/);
  assert.doesNotMatch(receipt, /错误时间/);
  const [reminder] = listBotReminders(member.id, shared);
  assert.ok(reminder);
  assert.equal(listBotReminders(owner.id, shared).length, 0);
  assert.equal(startTurn(member.id, shared, "photo", "重试").started, false);

  const edit = startTurn(member.id, shared, "reschedule", "提前一个小时。");
  const next = new Date(Date.parse(tomorrow) - 3_600_000).toISOString();
  faux.setResponses([ctx => {
    assert.match(JSON.stringify(ctx), new RegExp(reminder.id));
    return ai.fauxAssistantMessage(JSON.stringify({ text: "", reminder: { kind: "update", id: reminder.id, dueAt: next } }));
  }]);
  await runBotTurn(member.id, shared, edit.message, "reschedule", "Asia/Hong_Kong");
  const rescheduled = listBotReminders(member.id, shared);
  assert.equal(rescheduled.length, 1);
  assert.deepEqual({ ...rescheduled[0] }, { ...reminder, dueAt: Date.parse(next) });
  const revoke = startTurn(member.id, shared, "after-revoke", "取消提醒");
  faux.setResponses([() => {
    removeMember(owner.id, personal.id, member.id);
    return ai.fauxAssistantMessage(JSON.stringify({ text: "不应写入的结果", reminder: { kind: "cancel", id: reminder.id } }));
  }]);
  await runBotTurn(member.id, shared, revoke.message, "after-revoke", "Asia/Hong_Kong");
  assert.doesNotMatch(JSON.stringify(listMessages(owner.id, shared)), /不应写入的结果/);
});

test("拒绝没有明确时区的提醒和未声明的操作", () => {
  assert.throws(() => parseBotReply('{"text":"","reminder":{"kind":"create","text":"回访","dueAt":"2029-05-01T08:00"}}'));
  assert.throws(() => parseBotReply('{"text":"","reminder":{"kind":"external"}}'));
  assert.throws(() => parseBotReply('{"text":"","reminder":{"kind":"create","text":"出门","dueAt":"2027-02-30T08:00:00Z"}}'));
  for (const kind of ["approve", "decline"]) {
    assert.throws(() => parseBotReply(JSON.stringify({ text: "", followup: { kind, id: "decision", revision: 1 } })));
  }
});

test("普通文本模型可以聊天或澄清，缺少实际操作时不能生成成功回执", () => {
  assert.deepEqual(parseBotReply("照片上写着带水壶和帽子。"), { text: "照片上写着带水壶和帽子。" });
  assert.deepEqual(parseBotReply("42"), { text: "42" });
  assert.deepEqual(parseBotReply('{"text":"可以。","reminder":null,"followup":null,"delegation":null}'), { text: "可以。" });
  assert.deepEqual(parseBotReply("需要几点提醒？", "提醒我带书"), { text: "需要几点提醒？" });
  assert.throws(() => parseBotReply("已帮你安排了提醒。", "明天提醒我。"), /没有保存/);
  assert.throws(() => parseBotReply('{"text":"我会在明天九点提醒你。"}', "明天提醒我。"), /没有保存/);
  assert.throws(() => parseBotReply('{"text":"","reminder":'));
});

test("按账号统计当天消息，跨 Bot 共享上限，重试或其他账号不受误计", () => {
  const old = process.env.AGENT_LOFT_BOT_DAILY_TURNS;
  process.env.AGENT_LOFT_BOT_DAILY_TURNS = "1";
  try {
    const a = createUser({ name: "daily-a", password: "password-123" });
    const b = createUser({ name: "daily-b", password: "password-123" });
    const thread = listBots(a.id)[0]!.privateThreadId;
    const other = createBot(a.id, "另一个助手").privateThreadId;
    startTurn(a.id, thread, "one", "第一次");
    finishTurn(a.id, thread, "one", "完成");
    assert.equal(startTurn(a.id, thread, "one", "第一次").started, false);
    assert.throws(() => startTurn(a.id, other, "two", "另一次"), /今天的 Bot 消息额度/);
    const bThread = listBots(b.id)[0]!.privateThreadId;
    assert.equal(startTurn(b.id, bThread, "other", "自己的").started, true);
    finishTurn(b.id, bThread, "other", "完成");
    process.env.AGENT_LOFT_BOT_DAILY_TURNS = "0";
    assert.equal(startTurn(a.id, other, "two", "另一次").started, true);
    finishTurn(a.id, other, "two", "完成");
  } finally {
    if (old === undefined) delete process.env.AGENT_LOFT_BOT_DAILY_TURNS;
    else process.env.AGENT_LOFT_BOT_DAILY_TURNS = old;
  }
});

test("对话可交办并跟进；等待确认的事项必须由成员亲自决定", async () => {
  const actor = createUser({ name: "team", password: "password-123" });
  const thread = listBots(actor.id)[0]!.privateThreadId;
  const start = startTurn(actor.id, thread, "watch", "帮我盯着备份恢复。");
  faux.setResponses([ai.fauxAssistantMessage('{"text":"","followup":{"kind":"create","title":"备份恢复","text":"尚未恢复"}}')]);
  await runBotTurn(actor.id, thread, start.message, "watch", "UTC");
  const [item] = listBotFollowups(actor.id, thread);
  assert.equal(item?.title, "备份恢复");
  const entries = listMessages(actor.id, thread);
  assert.equal(entries.length, 2, "交办和状态变更在对话里显示为一来一回");
  assert.equal(entries[1]?.requestId, "watch");
  const pending = applyBotFollowup(actor.id, thread, "pending", { kind: "ask", id: item!.id, revision: item!.revision, text: "恢复了吗？" });
  const finish = startTurn(actor.id, thread, "finish", "结束跟进");
  faux.setResponses([ai.fauxAssistantMessage(JSON.stringify({text:"", followup:{kind:"close", id: pending.id, revision:pending.revision}}))]);
  await runBotTurn(actor.id, thread, finish.message, "finish", "UTC");
  assert.equal(listBotFollowups(actor.id, thread)[0]?.status, "waiting");
  assert.match(listMessages(actor.id, thread).at(-1)!.text, /指定的成员/);
});

test("真实聊天入口按 Bot 职责和对话范围提供记忆与协作目标，委派须等人确认", async () => {
  const { saveBotMemory, updateBotProfile } = await import("../src/core/web-bot-profile.js");
  const { listBotDelegations } = await import("../src/core/web-bot-delegation.js");
  const owner = createUser({ name: "bot-profiles", password: "password-123" }).id;
  const member = createUser({ name: "bot-guest", password: "password-123" }).id;
  const source = listBots(owner)[0]!;
  const secret = createBot(owner, "仅自己可用的私密助手");
  const target = createBot(owner, "共同的清单助手");
  const profile = await updateBotProfile(owner, source.id, { revision: 0, responsibility: "协助夏令营出行", style: "采用简短句子" });
  const shared = acceptInvite(member, createInvite(owner, source.id).token).sharedThreadId!;
  acceptInvite(member, createInvite(owner, target.id).token);
  saveBotMemory(owner, source.privateThreadId, "私人清单独有的标记", "private");
  saveBotMemory(owner, shared, "共同约定的集合点", "shared");
  const draft = { targetId: target.id, task: "准备出行清单" };
  const turn = startTurn(owner, shared, "make-draft", "请清单助手帮我准备出行清单");
  faux.setResponses([ctx => {
    const evidence = JSON.stringify(ctx);
    assert.match(evidence, /共同约定的集合点/);
    assert.match(evidence, /协助夏令营出行/);
    assert.match(evidence, /采用简短句子/);
    assert.match(evidence, new RegExp(target.id));
    assert.doesNotMatch(evidence, new RegExp(secret.id + "|仅自己可用的私密助手|私人清单独有的标记"));
    return ai.fauxAssistantMessage(JSON.stringify({ text: "擅自转发了私聊资料", delegation: draft }));
  }]);
  await runBotTurn(owner, shared, turn.message, "make-draft", "UTC");
  assert.equal(listBotDelegations(owner, shared)[0]?.status, "proposed");
  assert.equal(listBotDelegations(member, shared).length, 0);
  assert.match(listMessages(member, shared).at(-1)!.text, /确认后才会发送/);
  assert.doesNotMatch(listMessages(member, shared).at(-1)!.text, /擅自/);
  assert.equal(listMessages(owner, target.privateThreadId).length, 0);

  await updateBotProfile(owner, source.id, { revision: profile.revision, capabilities: ["memory"] });
  const disabled = startTurn(owner, source.privateThreadId, "disabled-act", "提醒我喝水");
  faux.setResponses([ctx => {
    const evidence = JSON.stringify(ctx);
    assert.match(evidence, /私人清单独有的标记/);
    assert.match(evidence, /共同约定的集合点/);
    return ai.fauxAssistantMessage(JSON.stringify({ text: "", reminder: { kind: "create", dueAt: new Date(Date.now() + 60000).toISOString(), text: "喝水" } }));
  }]);
  await runBotTurn(owner, source.privateThreadId, disabled.message, "disabled-act", "UTC");
  assert.match(listMessages(owner, source.privateThreadId).at(-1)!.text, /已关闭/);
  assert.deepEqual(listBotReminders(owner, source.privateThreadId), []);
  for (const extra of [{ approve: true }, { reminder: { kind: "cancel", id: "x" } }]) {
    assert.throws(() => parseBotReply(JSON.stringify({ text: "", delegation: draft, ...extra })));
  }
  assert.throws(() => parseBotReply(JSON.stringify({ text:"", delegation: { ...draft, confirmed:true } })));
});

test("生成回复期间换了 Bot 设置就丢弃旧结果，避免把撤销能力生成的内容写回", async () => {
  const { updateBotProfile } = await import("../src/core/web-bot-profile.js");
  const actor = createUser({ name: "settings-race", password: "password-123" }).id;
  const bot = listBots(actor)[0]!;
  const pending = startTurn(actor, bot.privateThreadId, "race-change", "处理一个提醒");
  faux.setResponses([() => {
    void updateBotProfile(actor, bot.id, { revision: 0, capabilities: [] });
    return ai.fauxAssistantMessage('{"text":"过期的模型回答"}');
  }]);
  await runBotTurn(actor, bot.privateThreadId, pending.message, "race-change", "UTC");
  const last = listMessages(actor, bot.privateThreadId).at(-1)!;
  assert.match(last.text, /设置刚刚更新/);
  assert.doesNotMatch(last.text, /过期的模型回答/);
});

test("查询、含糊或错误目标的指令不改提醒；唯一且明确命名的取消才提交", async () => {
  const actor = createUser({ name: "reminder-consent", password: "password-123" }).id;
  const thread = listBots(actor)[0]!.privateThreadId;
  const { applyBotReminder } = await import("../src/core/web-bot-reminders.js");
  for (const text of ["带水壶", "取快递"])
    applyBotReminder(actor, thread, "init-" + text, { kind:"create", text, dueAt: Date.now() + 86400_000 });
  const first = listBotReminders(actor, thread).find(item => item.text === "带水壶")!;
  async function chat(key: string, request: string, modelReply: Record<string, unknown>) {
    const turn = startTurn(actor, thread, key, request);
    faux.setResponses([ai.fauxAssistantMessage(JSON.stringify(modelReply))]);
    await runBotTurn(actor, thread, turn.message, key, "Asia/Hong_Kong");
    return listMessages(actor, thread).at(-1)!.text;
  }
  const cancel = { text:"取消成功", reminder:{kind:"cancel",id:first.id} };
  assert.match(await chat("list", "我有哪些提醒？只把列表发给我。", cancel), /带水壶/);
  for (const [id, message] of [["none", "如何取消带水壶提醒？"], ["negated", "不要取消带水壶提醒"], ["wrong", "取消取快递提醒"]]) {
    assert.match(await chat(id!, message!, cancel), /仍然保留/);
  }
  assert.equal(listBotReminders(actor, thread).length, 2);
  assert.match(await chat("confirmed", "请取消「带水壶」", cancel), /已取消提醒/);
  assert.deepEqual(listBotReminders(actor, thread).map(item => item.text), ["取快递"]);
});

test("周期性请求与模型输出中的重复设置均不会降级成单次提醒", async () => {
  const actor = createUser({ name: "recurrence", password: "password-123" }).id;
  const thread = listBots(actor)[0]!.privateThreadId;
  const dueAt = new Date(Date.now() + 86400_000).toISOString();
  const requests = ["每周一，早晨八点提醒我带水壶", "Remind me every Tuesday to bring water",
    "工作日提醒我带水壶", "天天提醒我带水壶", "提醒我隔周带水壶", "Remind me on Mondays to bring water", "明天提醒我带水壶"];
  for (const [index, request] of requests.entries()) {
    const key = "repeat-" + index;
    const turn = startTurn(actor, thread, key, request);
    const reminder = { kind: "create", dueAt, text: "带水壶", ...(request === requests.at(-1) ? {frequency:"weekly"} : {}) };
    faux.setResponses([ai.fauxAssistantMessage(JSON.stringify({text:"已安排", reminder}))]);
    await runBotTurn(actor, thread, turn.message, key, "Asia/Hong_Kong");
    assert.equal(listBotReminders(actor, thread).length, 0);
    assert.match(listMessages(actor, thread).at(-1)!.text, /只支持一次性提醒/);
  }
  assert.throws(() => parseBotReply(JSON.stringify({text:"",reminder:{kind:"create",dueAt,text:"看书",extra:true}})));
});

test("照片只在发送当轮和明确指向前图的追问中交给模型", async () => {
  const actor = createUser({ name: "photo-context", password: "password-123" }).id;
  const thread = listBots(actor)[0]!.privateThreadId;
  const { default: sharp } = await import("sharp");
  const photo = await sharp({ create: { width: 2, height: 2, channels: 3, background: "teal" } }).png().toBuffer();
  const seen: boolean[] = [];
  for (const [index, text] of ["拍了一张照片", "写一句野餐邀约", "上一张照片里有什么？"].entries()) {
    const key = "image-context-" + index;
    const { message } = startTurn(actor, thread, key, text, index === 0 ? [{ name:"photo.png", mediaType:"image/png", data:photo.toString("base64") }] : []);
    faux.setResponses([ctx => {
      seen.push(JSON.stringify(ctx).includes("image/png"));
      return ai.fauxAssistantMessage('{"text":"收到"}');
    }]);
    await runBotTurn(actor, thread, message, key, "UTC");
  }
  assert.deepEqual(seen, [true, false, true]);
});
