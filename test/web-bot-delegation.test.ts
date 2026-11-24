import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "loft-delegation-"));
process.env.AGENT_LOFT_HOME = home;
process.env.AGENT_LOFT_BOT_MODEL = "faux/main";
const { loadConfig, saveConfig } = await import("../src/core/config.js");
const settings = loadConfig();
settings.agents.pi.enabled = true;
settings.agents.pi.models = ["faux/main", "faux/writer"];
saveConfig(settings);
const { createUser, getUser } = await import("../src/core/users.js");
const { closeDatabaseForTest, sql } = await import("../src/core/db.js");
const { createBot, createInvite, acceptInvite, removeMember, listBots, listMessages, startTurn, finishTurn } =
  await import("../src/core/web-bots.js");
const { updateBotProfile, saveBotMemory } = await import("../src/core/web-bot-profile.js");
const { createBotDelegation, changeBotDelegation, listBotDelegations, listDelegationTargets } =
  await import("../src/core/web-bot-delegation.js");
const { runQueuedBotDelegations } = await import("../src/core/web-bot-delegation-worker.js");
const { handleBotInbox } = await import("../src/channels/web/bot-access.js");
const { handleBotsApi } = await import("../src/channels/web/bots-api.js");
const { loadSdk, setModelRuntime } = await import("../src/agents/pi/sdk.js");
const { ai, pi } = await loadSdk();
const rt = await pi.ModelRuntime.create({ authPath: path.join(home, "auth.json"), modelsPath: null, refreshOnCreate: false });
const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "main" }, { id: "writer" }] });
rt.registerNativeProvider(faux.provider);
await rt.setRuntimeApiKey("faux", "fake");
setModelRuntime(rt);
after(() => {
  setModelRuntime(null);
  closeDatabaseForTest();
  fs.rmSync(home, { recursive: true, force: true });
});

function account(name: string) {
  return createUser({ name, password: "test-password" });
}
function oldConversation(actor: string, thread: string, text: string) {
  startTurn(actor, thread, "old", text);
  finishTurn(actor, thread, "old", "OK");
}

async function api(user: ReturnType<typeof createUser>, route: string, body?: unknown): Promise<Record<string, any>> {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method: body === undefined ? "GET" : "POST",
    headers: {},
  }) as unknown as IncomingMessage;
  let result: Record<string, any> = {};
  let code = 0;
  const res = {
    writeHead(status: number) {
      code = status;
    },
    end(raw: string) {
      result = JSON.parse(raw);
    },
  } as unknown as ServerResponse;
  if (route.startsWith("/api/bot-inbox")) {
    await handleBotInbox(req, res, new URL("http://localhost" + route), user.id, "test-session");
  } else {
    await handleBotsApi(req, res, new URL("http://localhost/api/bots/threads/" + route), getUser(user.id)!);
  }
  return { code, ...result };
}

test("私有目标只在本人确认页展示，共享话题按读者署名；真实目标模型仅收到本次任务", async () => {
  const owner = account("delegate-actor");
  const member = account("delegate-member");
  const source = listBots(owner.id)[0]!;
  const shared = acceptInvite(member.id, createInvite(owner.id, source.id).token).sharedThreadId!;
  const target = createBot(owner.id, "我的私密撰稿助手");
  await updateBotProfile(owner.id, target.id, {
    revision: 0,
    model: "faux/writer",
    responsibility: "负责润色短句",
    style: "用词温和",
  });
  oldConversation(owner.id, target.privateThreadId, "目标历史-不应转发");
  oldConversation(owner.id, source.privateThreadId, "源头私聊-不应转发");
  oldConversation(member.id, shared, "申请者未选中的共享消息");
  saveBotMemory(owner.id, target.privateThreadId, "目标的私人知识簿", "private");
  saveBotMemory(owner.id, shared, "未选中的共享长期记录", "shared");
  assert.ok(!listDelegationTargets(owner.id, shared).some((bot) => bot.id === target.id));
  const endpoint = shared + "/delegations";
  const picker = await api(owner, endpoint);
  assert.ok(picker.targets.some((bot: { id: string }) => bot.id === target.id));
  const draft = { targetId: target.id, task: "这周末一起逛公园吗？请润色这一句。", requestId: "compose" };
  const created = await api(owner, endpoint, draft);
  assert.equal(created.code, 201);
  const job = created.delegation;
  assert.equal(job.status, "proposed");
  assert.equal((await api(owner, endpoint, draft)).delegation.id, job.id);
  assert.deepEqual((await api(member, endpoint)).delegations, []);
  await assert.rejects(api(member, endpoint + "/" + job.id + "/confirm", { attempt: 0 }), /找不到/);
  await runQueuedBotDelegations();
  assert.equal(listBotDelegations(owner.id, shared)[0]?.status, "proposed");
  assert.equal(listMessages(owner.id, shared).length, 2);

  const approvedTask = "帮我写一句去公园散步的邀约。";
  const confirm = (task?: string) => api(owner, endpoint + "/" + job.id + "/confirm", { attempt: 0, task });
  await assert.rejects(confirm("  "), /4000/);
  await assert.rejects(confirm("a".repeat(4001)), /4000/);
  assert.equal((await confirm(" " + approvedTask + " ")).delegation.status, "queued");
  assert.equal((await confirm("另外一件事")).delegation.task, approvedTask);
  assert.equal((await api(owner, endpoint, draft)).delegation.task, approvedTask);
  let sawOnlyApprovedTask = false;
  faux.setResponses([
    (context, options, _state, model) => {
      assert.equal(model.id, "writer");
      assert.ok((options?.maxTokens ?? 0) > 0 && options!.maxTokens! <= 2000);
      const json = JSON.stringify(context);
      assert.match(json, /负责润色短句/);
      assert.match(json, /用词温和/);
      assert.doesNotMatch(json, /源头私聊|目标历史|未选中的共享|私密撰稿助手|私人知识簿/);
      assert.ok(context.messages.filter((m) => m.role === "system").every((m) => !m.toolsAdded?.length));
      const turns = context.messages.filter((m) => m.role === "user");
      assert.equal(turns.length, 1);
      assert.ok(JSON.stringify(turns[0]).includes(approvedTask));
      assert.ok(!json.includes(draft.task));
      sawOnlyApprovedTask = true;
      return ai.fauxAssistantMessage("这周末，要不要一起去公园走走？");
    },
  ]);
  await Promise.all([runQueuedBotDelegations(), runQueuedBotDelegations()]);
  assert.ok(sawOnlyApprovedTask);
  const done = (await confirm()).delegation;
  assert.equal(done.status, "done");
  assert.equal(done.attempt, 1);
  assert.equal((await api(owner, shared + "/messages")).messages.at(-1).delegatedBy, target.name);
  const visible = (await api(member, shared + "/messages")).messages.at(-1);
  assert.equal(visible.id, done.resultMessageId);
  assert.equal(visible.delegatedBy, undefined);
  assert.match(visible.text, /周末，要不要/);
  assert.ok(!JSON.stringify(visible).includes(target.name));
  assert.equal(listMessages(owner.id, target.privateThreadId).length, 2);
  assert.equal(sql("SELECT count(*) n FROM bot_inbox WHERE userId=? AND messageId=?").get(owner.id, visible.id)?.n, 1);
  assert.equal(sql("SELECT count(*) n FROM web_bot_delegation_attempts WHERE job=?").get(job.id)?.n, 1);
});

test("中断的已发请求不自动重发，未领取的任务重启可运行；每次显式重试受尝试数和当日额度约束", async () => {
  const actor = account("delegate-recover");
  const { privateThreadId: thread } = listBots(actor.id)[0]!;
  const target = createBot(actor.id, "撰稿");
  const draft = createBotDelegation(actor.id, thread, "retry", { targetId: target.id, task: "写句话" });
  const change = (action: "confirm" | "retry" | "cancel", attempt: number) =>
    changeBotDelegation(actor.id, thread, draft.id, action, attempt);
  const prev = process.env.AGENT_LOFT_BOT_DAILY_TURNS;
  process.env.AGENT_LOFT_BOT_DAILY_TURNS = "1";
  try {
    change("confirm", 0);
    assert.throws(() => startTurn(actor.id, thread, "second", "另一条"), /今天的 Bot 消息额度/);
    sql("UPDATE web_bot_delegations SET status='running',worker=?,deadline=? WHERE id=?").run(
      process.pid,
      Date.now() - 1,
      draft.id,
    );
    closeDatabaseForTest();
    await runQueuedBotDelegations();
    await assert.rejects(
      api(actor, thread + "/delegations/" + draft.id + "/retry", { attempt: 1, task: "强行替换" }),
      /首次确认/,
    );
    const failed = change("confirm", 0);
    assert.equal(failed.status, "failed");
    assert.equal(failed.canRetry, true);
    assert.throws(() => change("retry", 1), /今天的 Bot 消息额度/);
    process.env.AGENT_LOFT_BOT_DAILY_TURNS = "3";
    assert.equal(change("retry", 1).attempt, 2);
    assert.equal(change("retry", 1).attempt, 2);
    // 第二次发送途中的服务端异常不直接暴露模型提供方返回的内容。
    faux.setResponses([ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "raw-provider-secret" })]);
    await runQueuedBotDelegations();
    const twice = listBotDelegations(actor.id, thread)[0]!;
    assert.equal(twice.status, "failed");
    assert.doesNotMatch(twice.error!, /raw-provider-secret/);
    change("retry", 2);
    closeDatabaseForTest();
    faux.setResponses([ai.fauxAssistantMessage("", { stopReason: "error" })]);
    await runQueuedBotDelegations();
    const thrice = listBotDelegations(actor.id, thread)[0]!;
    assert.equal(thrice.attempt, 3);
    assert.equal(thrice.canRetry, false);
    assert.throws(() => change("retry", 3), /重新交办/);
    assert.equal(listMessages(actor.id, thread).length, 0);
  } finally {
    if (prev === undefined) delete process.env.AGENT_LOFT_BOT_DAILY_TURNS;
    else process.env.AGENT_LOFT_BOT_DAILY_TURNS = prev;
  }
});

test("成员撤权、目标关闭能力、用户中途取消都阻止结果回写；模型输出无法递归交办", async () => {
  const owner = account("delegate-owner");
  const actor = account("delegate-invited");
  const source = createBot(owner.id, "共享小组");
  const shared = acceptInvite(actor.id, createInvite(owner.id, source.id).token).sharedThreadId!;
  const target = createBot(actor.id, "我的私人助手");
  const make = (request: string) => createBotDelegation(actor.id, shared, request, { targetId: target.id, task: request });
  const confirm = (id: string) => changeBotDelegation(actor.id, shared, id, "confirm", 0);
  const stale = make("原配置");
  await updateBotProfile(actor.id, target.id, { revision: 0, capabilities: ["memory"] });
  assert.deepEqual(
    listDelegationTargets(actor.id, shared, "requester").filter((t) => t.id === target.id),
    [],
  );
  assert.throws(() => confirm(stale.id), /关闭/);
  await updateBotProfile(actor.id, target.id, { revision: 1, capabilities: ["delegation"] });
  assert.throws(() => confirm(stale.id), /设置已变更/);
  const recursive = make("任务正文");
  confirm(recursive.id);
  const modelText = JSON.stringify({ delegation: { targetId: source.id, task: "再找一个助手" } });
  faux.setResponses([ai.fauxAssistantMessage(modelText)]);
  await runQueuedBotDelegations();
  assert.equal(listBotDelegations(actor.id, shared).length, 2);
  assert.match(listMessages(actor.id, shared).at(-1)!.text, /再找一个助手/);

  const cancelled = make("取消");
  confirm(cancelled.id);
  faux.setResponses([
    () => {
      changeBotDelegation(actor.id, shared, cancelled.id, "cancel", 1);
      return ai.fauxAssistantMessage("取消后不能发表");
    },
  ]);
  await runQueuedBotDelegations();
  assert.equal(listBotDelegations(actor.id, shared).find((j) => j.id === cancelled.id)?.status, "cancelled");
  const revoked = make("失效");
  confirm(revoked.id);
  faux.setResponses([
    () => {
      removeMember(owner.id, source.id, actor.id);
      acceptInvite(actor.id, createInvite(owner.id, source.id).token);
      return ai.fauxAssistantMessage("重新加入也不能恢复旧授权");
    },
  ]);
  await runQueuedBotDelegations();
  assert.deepEqual(listBotDelegations(actor.id, shared), []);
  assert.equal(sql("SELECT status FROM web_bot_delegations WHERE id=?").get(revoked.id)?.status, "failed");
  assert.equal(listMessages(owner.id, shared).length, 1);
});

test("发起方模型停用后仍能完成已授权的协作；失败通知能定位且只由申请者读取消除", async () => {
  const owner = account("delegation-independent"), member = account("delegation-observer");
  const source = listBots(owner.id)[0]!, target = createBot(owner.id, "独立处理助手");
  const shared = acceptInvite(member.id, createInvite(owner.id, source.id).token).sharedThreadId!;
  await updateBotProfile(owner.id, source.id, {revision:0,model:"faux/writer"});
  const prev = settings.agents.pi.models;
  try {
    settings.agents.pi.models = ["faux/main"];
    saveConfig(settings);
    for (const key of ["good", "bad"]) {
      const job = createBotDelegation(owner.id, shared, key, {targetId:target.id,task:"写一句话"});
      changeBotDelegation(owner.id, shared, job.id, "confirm", 0);
      faux.setResponses([key === "good" ? ai.fauxAssistantMessage("使用目标模型完成")
        : ai.fauxAssistantMessage("", {stopReason:"error",errorMessage:"test-only"})]);
      await runQueuedBotDelegations();
      const detail = await api(owner, shared + "/delegations/" + job.id);
      assert.equal(detail.delegation.status, key === "good" ? "done" : "failed");
      await assert.rejects(api(member, shared + "/delegations/" + job.id), /找不到/);
      if (key === "good") continue;
      const event = "delegation-failed:" + job.id + ":1";
      assert.equal(sql("SELECT kind FROM bot_inbox WHERE userId=? AND eventId=?").get(owner.id, event)?.kind, "delegation-failed");
      for (const legacy of [false, true]) {
        if (legacy) sql("UPDATE bot_inbox SET kind='reply',seen=0 WHERE userId=? AND eventId=?").run(owner.id,event);
        const notices = (await api(owner, "/api/bot-inbox")).items;
        const failed = notices.find((n: {delegationId: string}) => n.delegationId === job.id);
        assert.equal(failed?.kind, "delegation-failed");
        assert.equal(failed.seen, false);
        assert.ok(!(await api(member, "/api/bot-inbox")).items.some((n: {delegationId: string}) => n.delegationId === job.id));
        await assert.rejects(api(member, "/api/bot-inbox/read", {threadId:shared,delegationId:job.id}), /找不到/);
        assert.equal((await api(owner, "/api/bot-inbox/read", {threadId:shared,delegationId:job.id})).ok, true);
        assert.equal(sql("SELECT seen FROM bot_inbox WHERE userId=? AND eventId=?").get(owner.id,event)?.seen, 1);
      }
    }
  } finally {
    settings.agents.pi.models = prev;
    saveConfig(settings);
  }
});
