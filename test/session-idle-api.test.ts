import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import type { AgentDriver } from "../src/core/types.js";
import type { ConversationInfo } from "../src/core/hub.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-session-idle-"));
process.env.AGENT_LOFT_HOME = home;
const { config, loadConfig, saveConfig } = await import("../src/core/config.js");
const { hub } = await import("../src/core/hub.js");
const { getConversation, updateConversation, updateAgentBinding } = await import("../src/core/store.js");
const { createUser } = await import("../src/core/users.js");
const { createSession } = await import("../src/channels/web/auth.js");
const { startWeb, stopWeb } = await import("../src/channels/web/server.js");
loadConfig();
const sent: string[] = [];
const driver: AgentDriver = {
  id: "claude", label: "Fake", capabilities: { effort: false, fork: false, cost: false, streaming: false },
  start: async () => {}, stop: async () => {},
  createSession: (options, events) => ({
    sessionId: options.resumeId,
    send: () => { sent.push(options.resumeId ?? "new"); events.onSessionId(options.resumeId ?? "new"); events.onResult({ text: "ok", durationMs: 0 }); },
    interrupt: async () => {}, dispose: async () => {}, setModel: async () => {}, describeRuntime: async () => ({}),
  }),
  readHistory: async () => [{ role: "user", text: "原来的上下文" }],
  listSessions: async () => [], sessionExists: async () => true, listModels: async () => [], catalog: async () => [], defaults: async () => ({}), statusLines: async () => [],
  diagnose: () => ({ kind: "test", chatMessage: "test", consoleHint: "" }),
};
hub.registerDriver(driver);

test("闲置会话：打开不续期，点击继续保留上下文，直接发送开新会话", { timeout: 20000 }, async (t) => {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((err) => err ? reject(err) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  saveConfig({ ...structuredClone(config()), workspaceRoot: home, sessionTtlMs: 3600000, web: { ...config().web, host: "127.0.0.1", port, quotaEnabled: false } });
  const alice = createUser({ name: "alice", password: "password-1" });
  const bob = createUser({ name: "bob", password: "password-2" });
  const cookie = (id: string) => `aim_session=${createSession(id, "127.0.0.1", "test")}`;
  const aliceCookie = cookie(alice.id), bobCookie = cookie(bob.id);
  const key = "web:idle";
  hub.ensure({ key, channel: "web", channelId: "web", defaultAgent: "claude", owner: alice.id });
  updateAgentBinding(key, "claude", { sessionId: "old-context" });
  const oldActive = Date.now() - 7200000;
  updateConversation(key, { activeAt: oldActive });
  await startWeb(); t.after(() => stopWeb());
  const history = () => fetch(`${base}/api/conversations/${encodeURIComponent(key)}/history`, { headers: { Cookie: aliceCookie } }).then((res) => res.json() as Promise<{ info: ConversationInfo }>);
  const keep = (auth = aliceCookie, sessionId = "old-context") => fetch(`${base}/api/conversations/${encodeURIComponent(key)}/continue`, {
    method: "POST", headers: { Cookie: auth, Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ agent: "claude", sessionId }),
  });
  assert.equal((await history()).info.idleExpired, true);
  assert.equal(getConversation(key)!.activeAt, oldActive, "读历史不能自动续期");
  assert.equal((await keep(bobCookie)).status, 404);
  assert.equal((await keep(aliceCookie, "stale-context")).status, 409);
  assert.equal(getConversation(key)!.activeAt, oldActive);
  const continued = await keep();
  assert.equal(continued.status, 200);
  assert.equal((await continued.json() as { idleExpired: boolean }).idleExpired, false);
  assert.ok(getConversation(key)!.activeAt > oldActive);
  assert.equal((await history()).info.sessionId, "old-context");
  assert.deepEqual(sent, [], "继续本身不向 Agent 发送消息");
  const origin = { channel: "web", channelId: "web" };
  hub.send(key, { text: "继续旧任务", attachments: [] }, origin);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(sent, ["old-context"]);

  updateConversation(key, { activeAt: oldActive });
  hub.send(key, { text: "直接开始新任务", attachments: [] }, origin);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(sent, ["old-context", "new"]);

  updateConversation(key, { activeAt: oldActive });
  saveConfig({ ...structuredClone(config()), sessionTtlMs: 0 });
  assert.equal((await history()).info.idleExpired, false, "永不过期时不显示提示");
  saveConfig({ ...structuredClone(config()), sessionTtlMs: 3600000 });
  updateAgentBinding(key, "claude", { sessionId: undefined });
  assert.equal((await history()).info.idleExpired, false, "没有旧上下文的新对话不提示");
});
