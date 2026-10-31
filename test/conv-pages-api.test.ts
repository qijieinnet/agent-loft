import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import type { Page } from "../src/channels/web/conv-pages.js";
import type { AgentDriver } from "../src/core/types.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-conv-pages-api-"));
process.env.AGENT_LOFT_HOME = home;
const { config, loadConfig, saveConfig } = await import("../src/core/config.js");
const { hub } = await import("../src/core/hub.js");
const { updateConversation, updateAgentBinding } = await import("../src/core/store.js");
const { createUser } = await import("../src/core/users.js");
const { createSession } = await import("../src/channels/web/auth.js");
const { startWeb, stopWeb } = await import("../src/channels/web/server.js");
loadConfig();
const driver: AgentDriver = {
  id: "claude", label: "Fake", capabilities: { effort: false, fork: false, cost: false, streaming: false },
  start: async () => {}, stop: async () => {},
  createSession: () => { throw new Error("列表不应该启动会话"); },
  readHistory: async (id) => [{ role: "user", text: `历史聊天内容 ${id}` }],
  listSessions: async () => [], sessionExists: async () => true, listModels: async () => [], catalog: async () => [], defaults: async () => ({}), statusLines: async () => [],
  diagnose: () => ({ kind: "test", chatMessage: "test", consoleHint: "" }),
};
hub.registerDriver(driver);

test("飞书侧栏分页：按机器人隔离、分叉跟随主会话、保留历史弹窗及权限", { timeout: 20000 }, async (t) => {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((err) => err ? reject(err) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  saveConfig({ ...structuredClone(config()), workspaceRoot: home, web: { ...config().web, host: "127.0.0.1", port, quotaEnabled: false } });
  const admin = createUser({ name: "admin", password: "password-1", role: "admin" });
  const member = createUser({ name: "member", password: "password-2" });
  const cookie = (id: string) => `aim_session=${createSession(id, "127.0.0.1", "test")}`;
  const adminCookie = cookie(admin.id);
  for (let i = 0; i < 7; i++) {
    const key = `feishu:bot:${i}`;
    hub.ensure({ key, channel: "feishu", channelId: "bot", defaultAgent: "claude" });
    updateConversation(key, { activeAt: 100 - i });
    updateAgentBinding(key, "claude", { sessionId: key });
  }
  hub.ensure({ key: "feishu:bot:fork", channel: "feishu", channelId: "bot", defaultAgent: "claude" });
  updateConversation("feishu:bot:fork", { forkOf: "feishu:bot:0", activeAt: 101 });
  updateAgentBinding("feishu:bot:fork", "claude", { sessionId: "fork" });
  updateConversation("feishu:bot:1", { title: "手动会话名", titleAuto: false });
  hub.ensure({ key: "feishu:other:1", channel: "feishu", channelId: "other", defaultAgent: "claude" });
  hub.ensure({ key: "feishu:bot:hidden", channel: "feishu", channelId: "bot", defaultAgent: "claude" });
  updateConversation("feishu:bot:hidden", { hidden: true });
  await startWeb();
  t.after(() => stopWeb());
  const get = async (params: string, auth = adminCookie): Promise<Page> => {
    const res = await fetch(`${base}/api/conversations/page?scope=bot&bot=bot${params}`, { headers: { Cookie: auth } });
    assert.equal(res.status, 200);
    return await res.json() as Page;
  };
  const bootstrap = await (await fetch(`${base}/api/bootstrap`, { headers: { Cookie: adminCookie } })).json() as { conversations: Page["conversations"] };
  assert.equal(bootstrap.conversations.find((c) => c.key === "feishu:bot:fork")?.title, "历史聊天内容 fork");
  const first = await get("&limit=5");
  assert.deepEqual(first.conversations.map((c) => c.key).sort(), ["feishu:bot:0", "feishu:bot:1", "feishu:bot:2", "feishu:bot:3", "feishu:bot:4", "feishu:bot:fork"]);
  assert.deepEqual(first.next, { at: 96, key: "feishu:bot:4" });
  assert.equal(first.conversations.find((c) => c.key === "feishu:bot:0")?.title, "历史聊天内容 feishu:bot:0");
  assert.equal(first.conversations.find((c) => c.key === "feishu:bot:1")?.title, "手动会话名");
  const second = await get(`&limit=5&at=${first.next!.at}&key=${encodeURIComponent(first.next!.key)}`);
  assert.deepEqual(second.conversations.map((c) => c.key), ["feishu:bot:5", "feishu:bot:6"]);
  assert.equal(second.next, null);
  const legacy = await get("");
  assert.equal(legacy.conversations.length, 8);
  assert.equal(legacy.next, null);
  assert.deepEqual(await get("&limit=5", cookie(member.id)), { conversations: [], next: null });
  assert.equal((await fetch(`${base}/api/conversations/page?scope=bot&bot=bot&limit=5`)).status, 401);
});
