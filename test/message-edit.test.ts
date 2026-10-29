import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import type { AgentDriver, AgentEvents, HistoryMessage, SessionOptions, UserInput } from "../src/core/types.js";
import type { EventEnvelope } from "../src/core/hub.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-message-edit-"));
process.env.AGENT_LOFT_HOME = home;
const { loadConfig, config, saveConfig } = await import("../src/core/config.js");
const { hub } = await import("../src/core/hub.js");
const { createUser } = await import("../src/core/users.js");
const { createSession } = await import("../src/channels/web/auth.js");
const { startWeb, stopWeb } = await import("../src/channels/web/server.js");
const { agentBinding, getConversation } = await import("../src/core/store.js");
const { saveBuffer, attachmentInfo } = await import("../src/core/uploads.js");
const { takeUploads } = await import("../src/channels/web/api.js");
const { startHistoryCapture } = await import("../src/core/memory-curator.js");
const { readRecords } = await import("../src/core/chat-history.js");
loadConfig();
startHistoryCapture();
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const histories = new Map<string, HistoryMessage[]>();
const states: { id: string; options: SessionOptions; events: AgentEvents; pending: UserInput[]; delivered: string[]; finish: () => void; disposed: boolean }[] = [];
let blockModel: (() => Promise<void>) | undefined;
const driver: AgentDriver = {
  id: "claude", label: "Fake", capabilities: { effort: true, fork: true, cost: false, streaming: true },
  start: async () => {}, stop: async () => {},
  createSession: (options, events) => {
    const id = options.resumeId ?? crypto.randomUUID();
    if (!histories.has(id)) histories.set(id, []);
    let busy = false;
    const state = { id, options, events, pending: [] as UserInput[], delivered: [] as string[], disposed: false, finish: () => {} };
    const deliver = (input: UserInput) => {
      busy = true; state.delivered.push(input.text);
      histories.get(id)!.push({ role: "user", text: input.text, anchor: input.id, attachments: input.attachments.map(attachmentInfo), ts: Date.now() });
      events.onSessionId(id);
      events.onUserAnchor?.(input, input.id!);
    };
    state.finish = () => {
      const text = `回复 ${state.delivered.at(-1)}`;
      const anchor = crypto.randomUUID();
      histories.get(id)!.push({ role: "assistant", text, anchor, ts: Date.now() });
      events.onResult({ text, anchor, durationMs: 100 }); busy = false;
      const next = state.pending.shift(); if (next && !state.disposed) deliver(next);
    };
    states.push(state);
    return {
      sessionId: id,
      send: (input) => { if (busy) state.pending.push(input); else deliver(input); },
      cancelQueued: (input) => { const i = state.pending.indexOf(input); if (i < 0) return false; state.pending.splice(i, 1); return true; },
      interrupt: async () => { state.pending = []; },
      dispose: async () => { state.disposed = true; state.pending = []; },
      setModel: async () => { if (blockModel) await blockModel(); },
      describeRuntime: async () => ({}),
    };
  },
  readHistory: async (id) => structuredClone(histories.get(id) ?? []),
  rewindTo: async (id, _cwd, anchor) => {
    const history = histories.get(id)!;
    const index = history.findIndex((m) => m.role === "user" && m.anchor === anchor);
    assert.ok(index >= 0);
    if (!index) return undefined;
    const next = crypto.randomUUID(); histories.set(next, structuredClone(history.slice(0, index))); return next;
  },
  listSessions: async () => [], sessionExists: async () => true, listModels: async () => [], catalog: async () => [], defaults: async () => ({}), statusLines: async () => [],
  diagnose: () => ({ kind: "test", chatMessage: "test", consoleHint: "" }),
};
hub.registerDriver(driver);

test("消息编辑：队列撤销、回退、附件回填和账号隔离", { timeout: 20000 }, async (t) => {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((err) => err ? reject(err) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  saveConfig({ ...structuredClone(config()), workspaceRoot: home, sessionTtlMs: 0, web: { ...config().web, host: "127.0.0.1", port, quotaEnabled: false } });
  const alice = createUser({ name: "alice", password: "password-1" });
  const bob = createUser({ name: "bob", password: "password-2" });
  const cookie = (id: string) => `aim_session=${createSession(id, "127.0.0.1", "test")}`;
  const aliceCookie = cookie(alice.id), bobCookie = cookie(bob.id);
  await startWeb(); t.after(() => stopWeb());
  const post = (key: string, action: string, body: unknown, auth = aliceCookie) => fetch(`${base}/api/conversations/${encodeURIComponent(key)}/${action}`, { method: "POST", headers: { Cookie: auth, Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const origin = { channel: "web", channelId: "web" };
  const key = "web:edit";
  hub.ensure({ key, channel: "web", channelId: "web", defaultAgent: "claude", owner: alice.id });
  const send = (text: string, attachments: UserInput["attachments"] = []) => hub.send(key, { text, attachments }, origin);
  const users: { id: string; text: string }[] = [];
  hub.on("event", ({ key: eventKey, ev }) => { if (eventKey === key && ev.type === "user" && ev.id) users.push({ id: ev.id, text: ev.text }); });
  const idOf = (text: string) => users.findLast((message) => message.text === text)!;

  await t.test("撤销排队消息不打断当前回复，附件可以重新发送，其他排队消息不受影响", async () => {
    send("A"); await tick();
    const file = saveBuffer({ key, data: Buffer.from("original attachment"), name: "note.txt" });
    send("B", [file]); send("C"); await tick();
    const state = states.at(-1)!;
    assert.deepEqual(state.delivered, ["A"]);
    assert.equal((await post(key, "cancel-queued", { id: idOf("B").id }, bobCookie)).status, 404);
    const res = await post(key, "cancel-queued", { id: idOf("B").id }); assert.equal(res.status, 200);
    const data = await res.json() as { draft: { text: string; uploads: { id: string }[] } };
    assert.equal(data.draft.text, "B");
    assert.equal(takeUploads(key, data.draft.uploads.map((u) => u.id))[0]!.path, file.path);
    assert.equal(state.disposed, false); assert.equal(hub.isBusy(key), true);
    assert.equal(readRecords(alice.id).some((r) => r.t.startsWith("B")), false);
    state.finish(); assert.deepEqual(state.delivered, ["A", "C"]);
    state.finish(); assert.equal(hub.isBusy(key), false);
    assert.equal((await hub.history(key)).some((m) => m.text === "B"), false);
  });
  await t.test("尚在串行操作后等待的消息也能撤销，不会晚些时候又发出", async () => {
    let release!: () => void;
    blockModel = () => new Promise<void>((resolve) => { release = resolve; });
    const model = hub.setModel(key, "test-model"); await tick();
    send("prior-waiting"); send("waiting");
    try {
      assert.equal(hub.cancelQueued(key, idOf("waiting").id).text, "waiting");
    } finally {
      release(); blockModel = undefined;
    }
    await model; await tick();
    assert.equal(states.at(-1)!.delivered.includes("waiting"), false);
    states.at(-1)!.finish();
  });
  await t.test("回退会保留之前上下文，去掉目标和后续内容，搜索索引也同步", async () => {
    const before = await hub.history(key); const target = before.find((m) => m.role === "user" && m.text === "C")!;
    const sessionId = agentBinding(getConversation(key)!).sessionId!;
    const res = await post(key, "rewind", { anchor: target.anchor, sessionId }); assert.equal(res.status, 200);
    assert.equal((await res.json() as { draft: { text: string } }).draft.text, "C");
    assert.deepEqual((await hub.history(key)).map((m) => m.text), ["A", "回复 A"]);
    assert.deepEqual(readRecords(alice.id).filter((r) => r.k === key).map((r) => r.t), ["A", "回复 A"]);
    assert.notEqual(agentBinding(getConversation(key)!).sessionId, sessionId);
    send("编辑后的 C"); await tick();
    assert.equal(states.at(-1)!.options.resumeId, agentBinding(getConversation(key)!).sessionId);
    states.at(-1)!.finish();
    assert.deepEqual((await hub.history(key)).map((m) => m.text), ["A", "回复 A", "编辑后的 C", "回复 编辑后的 C"]);
    assert.equal((await post(key, "rewind", { anchor: target.anchor, sessionId })).status, 409);
  });
  await t.test("回退首条消息清空上下文；运行中的回复被停止，晚到结果不会回来", async () => {
    send("正在生成"); await tick(); const old = states.at(-1)!;
    const anchor = (await hub.history(key)).find((m) => m.role === "user")!.anchor;
    const res = await post(key, "rewind", { anchor }); assert.equal(res.status, 200);
    assert.equal(old.disposed, true); assert.equal(hub.isBusy(key), false);
    old.events.onTextDelta("late"); old.events.onResult({ text: "late", durationMs: 0 });
    assert.deepEqual(await hub.history(key), []);
    assert.equal(hub.eventsSince(key, hub.currentSeq() - 2)?.some(({ ev }) => ev.type === "result"), false);
    send("全新的第一条"); await tick(); assert.equal(states.at(-1)!.options.resumeId, undefined);
    states.at(-1)!.finish();
  });
  await t.test("回退排队消息仅撤掉它和后面的排队消息", async () => {
    send("running"); await tick(); send("queue1"); send("queue2"); await tick();
    const old = states.at(-1)!;
    const res = await post(key, "rewind", { id: idOf("queue1").id }); assert.equal(res.status, 200);
    assert.equal((await res.json() as { queued: boolean }).queued, true);
    assert.equal(old.disposed, false); assert.deepEqual(old.pending, []);
    old.finish(); assert.equal(hub.isBusy(key), false);
  });
  await t.test("恢复进行中的会话：保留当前轮全部输出和多条排队输入，队列推进后不重放上一轮", async () => {
    const replayKey = "web:queue-replay";
    hub.ensure({ key: replayKey, channel: "web", channelId: "web", defaultAgent: "claude", owner: alice.id });
    const sendReplay = (text: string, attachments: UserInput["attachments"] = []) => hub.send(replayKey, { text, attachments }, origin);
    const snapshot = async () => {
      const res = await fetch(`${base}/api/conversations/${encodeURIComponent(replayKey)}/history`, { headers: { Cookie: aliceCookie } });
      assert.equal(res.status, 200);
      return await res.json() as { messages: HistoryMessage[]; live: EventEnvelope[]; seq: number };
    };
    const liveUsers = (live: EventEnvelope[]) => live.flatMap(({ ev }) => ev.type === "user" ? [{ text: ev.text, queued: ev.queued }] : []);
    sendReplay("earlier"); await tick();
    const state = states.at(-1)!;
    state.finish();
    sendReplay("active"); await tick();
    state.events.onStep("tool", "排队前的步骤");
    state.events.onTextDelta("排队前的输出");
    sendReplay("next"); sendReplay("last"); await tick();
    state.events.onTextDelta("排队后的输出");
    state.events.onStep("tool", "排队后的步骤");
    const first = await snapshot();
    assert.deepEqual(first.messages.map((m) => m.text), ["earlier", "回复 earlier"]);
    assert.deepEqual(liveUsers(first.live), [{ text: "active", queued: false }, { text: "next", queued: true }, { text: "last", queued: true }]);
    assert.equal(first.live.flatMap(({ ev }) => ev.type === "delta" ? [ev.text] : []).join(""), "排队前的输出排队后的输出");
    assert.deepEqual(first.live.flatMap(({ ev }) => ev.type === "step" ? [ev.text] : []), ["排队前的步骤", "排队后的步骤"]);
    state.finish();
    state.events.onTextDelta("第二轮正在输出");
    const second = await snapshot();
    assert.deepEqual(second.messages.map((m) => m.text), ["earlier", "回复 earlier", "active", "回复 active"]);
    assert.deepEqual(liveUsers(second.live), [{ text: "next", queued: false }, { text: "last", queued: true }]);
    assert.equal(second.live.some(({ ev }) => ev.type === "result" || ev.type === "step"), false);
    assert.equal(second.live.flatMap(({ ev }) => ev.type === "delta" ? [ev.text] : []).join(""), "第二轮正在输出");
    state.finish();
    const third = await snapshot();
    assert.deepEqual(liveUsers(third.live), [{ text: "last", queued: false }]);
    state.finish();
    assert.deepEqual((await snapshot()).live, []);

    const file = saveBuffer({ key: replayKey, data: Buffer.from("attachment-only"), name: "attachment.txt" });
    sendReplay("", [file]); await tick();
    const attachment = await snapshot();
    assert.equal(attachment.messages.filter((m) => m.role === "user").length, 4);
    assert.deepEqual(liveUsers(attachment.live), [{ text: "", queued: false }]);
    state.finish();
    await hub.drop(replayKey, "test complete");
  });
  await hub.drop(key, "test complete");
});

test("Codex 回退：用户消息带轮次位置，分叉只保留目标之前的轮次", async () => {
  const { CodexDriver } = await import("../src/agents/codex/driver.js");
  const { appServer } = await import("../src/agents/codex/app-server.js");
  const original = appServer.call;
  const forks: { lastTurnId?: string }[] = [];
  (appServer as any).call = async (method: string, params: { lastTurnId?: string }) => {
    if (method === "thread/read") return { thread: { turns: ["one", "two", "three"].map((id) => ({ id, items: [{ type: "userMessage", content: [{ type: "text", text: id }] }] })) } };
    if (method === "thread/fork") { forks.push(params); return { thread: { id: "rewound-thread" } }; }
    return {};
  };
  try {
    const codex = new CodexDriver();
    assert.deepEqual((await codex.readHistory("thread")).map((m) => m.anchor), ["one", "two", "three"]);
    assert.equal(await codex.rewindTo("thread", home, "two"), "rewound-thread");
    assert.equal(forks[0]!.lastTurnId, "one");
    assert.equal(await codex.rewindTo("thread", home, "one"), undefined);
    assert.equal(forks.length, 1);
    await assert.rejects(codex.rewindTo("thread", home, "missing"), /找不到这条消息/);
  } finally {
    appServer.call = original;
  }
});
