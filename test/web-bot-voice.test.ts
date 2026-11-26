import { after, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "loft-bot-call-"));
process.env.AGENT_LOFT_HOME = home;
const { loadConfig } = await import("../src/core/config.js");
loadConfig();
const { createSession, destroySession } = await import("../src/channels/web/auth.js");
const { createUser } = await import("../src/core/users.js");
const { createInvite, acceptInvite, listBots, listMessages, appendBotNotice, removeMember } = await import("../src/core/web-bots.js");
const { updateBotProfile } = await import("../src/core/web-bot-profile.js");
const { serveBotVoice } = await import("../src/channels/web/bot-voice.js");
const { appServer } = await import("../src/agents/codex/app-server.js");
const { RealtimeRelay } = await import("../src/core/realtime-relay.js");
const { closeDatabaseForTest } = await import("../src/core/db.js");
after(() => { closeDatabaseForTest(); fs.rmSync(home, { recursive: true, force: true }); });

test("实时通话只向当前成员和话题传输音频、字幕，退出、撤权和建连中挂断都会释放会话", { timeout: 18000 }, async t => {
  const server = createServer();
  const stop = serveBotVoice(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { stop(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const owner = createUser({ name:"alice", role:"admin", password:"password1" });
  const guest = createUser({ name:"bob", password:"password2" });
  const bot = listBots(owner.id)[0]!;
  const shared = acceptInvite(guest.id, createInvite(owner.id,bot.id).token).sharedThreadId!;
  const token = createSession(guest.id, "", "test");
  const ownerToken = createSession(owner.id, "", "test");
  const open = (topic: string, cookie = token, site = origin) => new WebSocket(origin.replace("http:", "ws:") + "/ws/bot-voice/" + topic,
    { origin: site, headers: { Cookie: "aim_session=" + cookie } });
  const message = async (ws: WebSocket) => JSON.parse((await once(ws, "message"))[0].toString());
  await assert.rejects(once(open(bot.privateThreadId), "open"), /403/);
  await assert.rejects(once(open(shared, "", origin), "open"), /403/);
  await assert.rejects(once(open(shared, token, "https://elsewhere.invalid"), "open"), /403/);
  assert.match((await message(open(shared))).reason, /只有 Codex/);
  await updateBotProfile(owner.id, bot.id, { revision: 0, engine: "codex", style:"简洁回答" });
  appendBotNotice(owner.id, bot.privateThreadId, "绝密私人内容");
  appendBotNotice(owner.id, shared, "共享背景");
  let notify: Parameters<typeof appServer.onNotification>[0] = () => {};
  let expectedStop = 0, stopped = 0, released = 0, received = 0;
  let finishOffer: (() => void) | undefined;
  let gotOffer: (() => void) | undefined;
  let delayOffer = false;
  let afterUnsubscribe: (() => void) | undefined;
  const relay = { onAudio: (_buf: Buffer) => {}, onFailed: () => {}, accept: async (sdp: string) => assert.equal(sdp, "ANSWER"),
    pushAudio: (b: Buffer) => { received += b.length; relay.onAudio(b); }, close: () => { released++; } };
  t.mock.method(RealtimeRelay, "create", async () => {
    if (delayOffer) await new Promise<void>(resolve => { finishOffer = resolve; gotOffer?.(); });
    return { relay, offer:"OFFER" };
  });
  t.mock.method(appServer, "onNotification", (fn: typeof notify) => { notify = fn; return () => { notify = () => {}; }; });
  t.mock.method(appServer, "call", async (method: string, params: Record<string, any>) => {
    if (method === "config/read") return { config: { mcp_servers: { privateConnector:{} } } };
    if (method === "thread/start") {
      assert.equal(params.config["mcp_servers.privateConnector.enabled"], false);
      assert.equal(params.config["features.shell_tool"], false);
      assert.deepEqual([params.ephemeral, params.approvalPolicy, params.sandbox], [true,"never","read-only"]);
      return { thread: { id:"codex-voice-thread" } };
    }
    if (method === "thread/realtime/start") {
      expectedStop++;
      assert.equal(params.includeStartupContext, false);
      assert.equal(params.transport.sdp, "OFFER");
      assert.match(JSON.stringify(params.initialItems), /共享背景/);
      assert.doesNotMatch(JSON.stringify(params), /绝密私人内容/);
      notify("thread/realtime/sdp", { threadId:"codex-voice-thread", sdp:"ANSWER" });
    } else if (method === "thread/realtime/stop") stopped++;
    else { assert.equal(method, "thread/unsubscribe"); afterUnsubscribe?.(); }
    return {};
  });
  const ws = open(shared);
  assert.equal((await message(ws)).type, "ready");
  const second = open(shared);
  assert.match((await message(second)).reason, /先挂断/);
  const returned = once(ws,"message");
  ws.send(Buffer.alloc(960));
  assert.equal((await returned)[0].length, 960);
  assert.equal(received, 960);
  notify("thread/realtime/transcript/done", { threadId:"unrelated",role:"user",text:"不可见字幕" });
  const caption = message(ws);
  notify("thread/realtime/transcript/done", { threadId:"codex-voice-thread",role:"user",text:"周五见" });
  assert.equal((await caption).text, "周五见");
  const denied = message(ws);
  removeMember(owner.id, bot.id, guest.id);
  assert.match((await denied).reason, /权限/);
  const history = listMessages(owner.id, shared);
  assert.ok(history.some(m => m.text.includes("bob：周五见")));
  assert.ok(history.every(m => !m.text.includes("不可见字幕") && m.status !== "pending"));
  const next = open(shared, ownerToken);
  assert.equal((await message(next)).type, "ready");
  const loggedOut = message(next);
  destroySession(ownerToken);
  assert.match((await loggedOut).reason, /登录状态/);
  delayOffer = true;
  const pending = new Promise<void>(resolve => { gotOffer = resolve; });
  const last = open(shared, createSession(owner.id,"","test"));
  await Promise.all([pending, once(last, "open")]);
  const cancelled = new Promise<void>(resolve => { afterUnsubscribe = resolve; });
  const closed = once(last,"close");
  last.close();
  await Promise.all([closed, cancelled]);
  finishOffer!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, 3);
  assert.equal(expectedStop, 2);
  assert.equal(stopped, expectedStop);
});
