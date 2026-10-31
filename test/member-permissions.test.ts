import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import type { AgentDriver, AgentEvents } from "../src/core/types.js";
import type { PublicUser } from "../src/core/users.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-member-permissions-"));
process.env.AGENT_LOFT_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ workspaceRoot: home, web: { quotaEnabled: false } }));
const { loadConfig, config, saveConfig } = await import("../src/core/config.js");
loadConfig();
const users = await import("../src/core/users.js");
const experts = await import("../src/core/experts.js");
const { hub } = await import("../src/core/hub.js");
const auth = await import("../src/channels/web/auth.js");
const { startWeb, stopWeb } = await import("../src/channels/web/server.js");
const tasks = await import("../src/core/tasks.js");
const runner = await import("../src/core/task-runner.js");
const states: { events: AgentEvents; sent: string[] }[] = [];
for (const id of ["claude", "codex"]) {
  const driver: AgentDriver = {
    id, label: id, capabilities: { effort: false, fork: false, cost: false, streaming: true },
    start: async () => {}, stop: async () => {}, listSessions: async () => [], sessionExists: async () => false,
    readHistory: async () => [], listModels: async () => [], catalog: async () => [], defaults: async () => ({}), statusLines: async () => [],
    diagnose: (e) => ({ kind: "test", chatMessage: String(e), consoleHint: "test" }),
    createSession(_opts, events) {
      const state = { events, sent: [] as string[] };
      states.push(state);
      return { sessionId: undefined, send: (input) => { state.sent.push(input.text); }, interrupt: async () => {}, setModel: async () => {}, describeRuntime: async () => ({}), dispose: async () => {} };
    },
  };
  hub.registerDriver(driver);
}
const keepAlive = setInterval(() => {}, 1000);
after(async () => {
  runner.stopTaskRunner();
  await stopWeb();
  await hub.shutdown();
  clearInterval(keepAlive);
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test("成员资源授权：兼容旧账号、校验原子性、管理员豁免和持久化", () => {
  const admin = users.createUser({ name: "admin", password: "password-admin", role: "admin" });
  const legacy = users.createUser({ name: "legacy", password: "password-legacy" });
  for (const kind of ["experts", "agents", "servers"] as const) assert.equal(users.canUseResource(users.getUser(legacy.id), kind, "claude"), true);
  const member = users.createUser({ name: "member", password: "password-member", remote: true, permissions: { agents: ["codex", "codex"], experts: [], servers: ["nas"] } });
  assert.equal(member.remote, true);
  assert.deepEqual(member.permissions?.agents, ["codex"]);
  assert.equal(users.canUseResource(users.getUser(member.id), "agents", "claude"), false);
  assert.equal(users.canUseResource(users.getUser(member.id), "servers", "nas"), true);
  assert.equal(users.canUseResource(users.getUser(member.id), "servers", "other"), false);
  for (const permissions of [{ agents: ["other"] }, { experts: "all" }, { servers: [42] }, { agents: undefined }, [], null, { unknown: [] }]) {
    assert.throws(() => users.updateUser(member.id, { name: "changed", permissions }));
    assert.equal(users.getUser(member.id)?.name, "member", "权限校验失败不修改其他字段");
  }
  assert.throws(() => users.createUser({ name: "invalid", password: "password-invalid", permissions: { agents: "codex" } }));
  assert.equal(users.findUserByName("invalid"), undefined);
  users.updateUser(member.id, { permissions: { agents: null } });
  assert.equal(users.canUseResource(users.getUser(member.id), "agents", "claude"), true);
  assert.equal(users.canUseResource(users.getUser(member.id), "experts", "e_test"), false, "部分更新保留其他权限");
  users.updateUser(admin.id, { permissions: { agents: [], experts: [], servers: [] } });
  assert.equal(users.canUseResource(users.getUser(admin.id), "agents", "claude"), true);
  users.updateUser(member.id, { disabled: true });
  assert.equal(users.canUseResource(users.getUser(member.id), "agents", "claude"), false);
  users.updateUser(member.id, { disabled: false });
  users.resetUsersForTest();
  assert.deepEqual(users.getUser(member.id)?.permissions, { agents: null, experts: [], servers: ["nas"] });
});

test("HTTP 与运行时：按成员过滤资源，阻止越权、旧会话和任务；用户只能修改自己的名称", async (t) => {
  const admin = users.findUserByName("admin")!;
  const member = users.findUserByName("member")!;
  const shared = experts.createExpert(admin.id, { name: "允许的专家", engine: "claude", access: "web", shared: true });
  const child = experts.createExpert(admin.id, { name: "子专家", engine: "claude", access: "web", shared: true });
  const blocked = experts.createExpert(admin.id, { name: "未授权专家", engine: "codex", access: "web", shared: true });
  const lead = experts.createExpert(admin.id, { name: "主专家", engine: "claude", access: "web", shared: true, subagents: [child.id] });
  const own = experts.createExpert(member.id, { name: "自己的专家", engine: "claude", access: "web" });
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  saveConfig({ ...structuredClone(config()), web: { ...config().web, host: "127.0.0.1", port }, servers: { ...config().servers, list: [{ id: "nas", name: "NAS", icon: "", url: "https://nas.example.test" }, { id: "other", name: "其他", icon: "", url: "https://other.example.test" }] } });
  await startWeb();
  const cookie = `aim_session=${auth.createSession(member.id, "127.0.0.1", "test")}`;
  const adminCookie = `aim_session=${auth.createSession(admin.id, "127.0.0.1", "test")}`;
  const call = (p: string, method = "GET", body?: unknown, session = cookie, origin = base) => fetch(`${base}${p}`, {
    method, headers: { Cookie: session, Origin: origin, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const patchPermissions = async (permissions: unknown) => {
    assert.equal((await call(`/api/users/${member.id}`, "PATCH", { permissions }, adminCookie)).status, 200);
  };

  await t.test("管理员可在新增时配置权限，成员不能自行扩权", async () => {
    const body = { name: "new-member", password: "password-new", remote: true, permissions: { experts: [shared.id], agents: ["codex"], servers: [] } };
    assert.equal((await call("/api/users", "POST", body)).status, 403);
    const created = await (await call("/api/users", "POST", body, adminCookie)).json() as PublicUser;
    assert.equal(created.remote, true);
    assert.deepEqual(created.permissions, body.permissions);
    assert.equal((await call(`/api/users/${member.id}`, "PATCH", { permissions: { agents: null } })).status, 403);
    assert.equal((await call(`/api/users/${member.id}`, "PATCH", { name: "partial", permissions: { agents: "all" } }, adminCookie)).status, 400);
    assert.equal(users.getUser(member.id)?.name, "member");
    const data = await (await call("/api/users", "GET", undefined, adminCookie)).json() as { resources: { experts: { id: string }[]; agents: { id: string }[]; servers: { id: string }[] } };
    assert.ok(data.resources.experts.some((e) => e.id === shared.id));
    assert.deepEqual(data.resources.agents.map((a) => a.id), ["claude", "codex"]);
    assert.equal(data.resources.servers.length, 2);
  });

  await patchPermissions({ experts: [shared.id, lead.id], agents: ["codex"], servers: ["nas"] });
  await t.test("共享专家、内置 Agent 与服务器分别过滤，自己的专家保留", async () => {
    for (const p of ["/api/bootstrap", "/api/experts", "/api/experts/brief"]) {
      const data = await (await call(p)).json() as { experts: { id: string }[]; builtin?: (string | { id: string })[]; servers?: { list: { id: string }[] } };
      const ids = data.experts.map((e) => e.id);
      assert.ok(ids.includes(shared.id) && ids.includes(own.id));
      assert.ok(!ids.includes(blocked.id) && !ids.includes(child.id));
      if (data.builtin) assert.deepEqual(data.builtin.map((a) => typeof a === "string" ? a : a.id), ["codex"]);
      if (data.servers) assert.deepEqual(data.servers.list.map((s) => s.id), ["nas"]);
    }
    const boot = await (await call("/api/bootstrap")).json() as { agents: { id: string; enabled: boolean; allowed: boolean }[] };
    assert.equal(boot.agents.find((a) => a.id === "claude")?.allowed, false);
    assert.equal(boot.agents.find((a) => a.id === "claude")?.enabled, true, "专家仍能用它自己的引擎");
    assert.equal((await call(`/api/experts/${blocked.id}`)).status, 404);
    assert.equal((await call("/api/conversations", "POST", { expert: "claude" })).status, 400);
    assert.equal((await call("/api/conversations", "POST", { expert: blocked.id })).status, 400);
    assert.equal((await call("/api/conversations", "POST", { expert: shared.id })).status, 200);
    const defaults = await (await call("/api/agents/defaults")).json() as { agents: object };
    assert.deepEqual(Object.keys(defaults.agents), ["codex"]);
    assert.equal((await call("/api/agents/defaults", "PUT", { agents: { claude: { skills: [] } } })).status, 403);
    assert.deepEqual(experts.expertRuntime(lead, (e) => e.prompt, member.id).subagents, []);
    assert.deepEqual(hub.expertChoices(member.id, ["claude", "codex"]).map((e) => e.id), ["codex", shared.id, lead.id, own.id]);
  });

  await t.test("撤权立即阻止复用运行中的会话，保留历史；任务在执行时重新校验", async () => {
    const conv = await (await call("/api/conversations", "POST", { expert: "codex" })).json() as { key: string };
    hub.send(conv.key, { text: "running", attachments: [] }, { channel: "web", channelId: "web" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(hub.isBusy(conv.key), true);
    const task = tasks.createTask(member.id, { expert: "codex", prompt: "check permissions", schedule: { kind: "daily", time: "08:00" } }, "user");
    const sharedConv = await (await call("/api/conversations", "POST", { expert: shared.id })).json() as { key: string };
    hub.session(sharedConv.key);
    await patchPermissions({ agents: [], experts: [], servers: [] });
    assert.throws(() => hub.session(conv.key), /未获授权/);
    assert.throws(() => hub.session(sharedConv.key), /未获授权/);
    assert.equal((await call(`/api/conversations/${encodeURIComponent(conv.key)}/history`)).status, 200);
    assert.equal((await call("/api/conversations", "POST", {})).status, 200, "仍可默认选择自己的专家");
    const data = await (await call("/api/experts/brief")).json() as { builtin: unknown[]; servers: unknown };
    assert.deepEqual(data.builtin, []);
    assert.equal(data.servers, null);
    assert.equal((await call("/api/push/relay-key")).status, 404);
    runner.startTaskRunner();
    assert.match(runner.runTaskNow(task) ?? "", /未获授权/);
    assert.equal(task.enabled, false);
    assert.equal((await call("/api/tasks", "POST", { expert: "codex", prompt: "forbidden", schedule: { kind: "daily", time: "09:00" } })).status, 400);
    const isolated = users.createUser({ name: "no-resources", password: "password-none", permissions: { agents: [], experts: [] } });
    assert.equal((await call("/api/conversations", "POST", {}, `aim_session=${auth.createSession(isolated.id, "127.0.0.1", "test")}`)).status, 400);
  });

  await t.test("名称校验、防重名与自助改名：保留 ID、权限、密码、设备和对话归属", async () => {
    const endpoint = "/api/account";
    assert.equal((await call(endpoint, "PATCH", { name: "renamed" }, "")).status, 401);
    assert.equal((await call(endpoint, "PATCH", { name: "renamed" }, cookie, "https://foreign.example")).status, 403);
    for (const name of ["ADMIN", "", "bad name", "a".repeat(33), 123]) assert.equal((await call(endpoint, "PATCH", { name })).status, 400);
    assert.equal(users.getUser(member.id)?.name, "member");
    const before = users.getUser(member.id)!;
    const live = await (await call("/api/conversations", "POST", { expert: own.id })).json() as { key: string };
    const liveSession = hub.session(live.key);
    const result = await (await call(endpoint, "PATCH", { name: " 新名字 ", role: "admin", remote: false, permissions: { agents: null }, id: admin.id })).json() as { user: { id: string; name: string; role: string } };
    assert.deepEqual(result.user, { id: member.id, name: "新名字", role: "member" });
    const renamed = users.getUser(member.id)!;
    assert.deepEqual(renamed.permissions, before.permissions);
    assert.equal(renamed.remote, before.remote);
    assert.equal(renamed.passwordHash, before.passwordHash);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(hub.session(live.key), liveSession, "改名不重建正在使用的专家会话");
    assert.equal(auth.sessionUser(cookie.slice("aim_session=".length))?.name, "新名字");
    assert.equal(users.verifyLogin("member", "password-member"), undefined);
    assert.equal(users.verifyLogin("新名字", "password-member")?.id, member.id);
    assert.equal((await call("/api/me")).status, 200);
    assert.equal((await call(endpoint, "PATCH", { name: "admin-renamed" }, adminCookie)).status, 200);
  });
});
