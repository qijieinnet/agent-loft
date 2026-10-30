import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-builtin-agents-"));
process.env.AGENT_LOFT_HOME = home;
process.env.HOME = path.join(home, "host");
delete process.env.CLAUDE_CONFIG_DIR;
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.HOME, ".claude.json"), JSON.stringify({ mcpServers: { local: { command: "local-mcp", args: [] } } }));
const { loadConfig, config, saveConfig } = await import("../src/core/config.js");
loadConfig();
const users = await import("../src/core/users.js");
const skills = await import("../src/core/skills.js");
const mcp = await import("../src/core/mcp.js");
const defaults = await import("../src/core/builtin-agents.js");
const { expertOptions, ClaudeSession } = await import("../src/agents/claude/session.js");
const { createExpert } = await import("../src/core/experts.js");
const { hub } = await import("../src/core/hub.js");
const keepAlive = setInterval(() => {}, 1000);
after(async () => { clearInterval(keepAlive); await hub.shutdown(); });
const admin = users.createUser({ name: "admin", password: "password-1", role: "admin" });
const alice = users.createUser({ name: "alice", password: "password-1" });
const bob = users.createUser({ name: "bob", password: "password-1" });
const a = skills.createSkill(alice.id, { name: "alpha", description: "A", body: "A", vars: [{ name: "ALPHA_KEY" }] }, "manual");
const b = skills.createSkill(alice.id, { name: "beta", description: "B", body: "B" }, "manual");
const foreign = skills.createSkill(bob.id, { name: "foreign", description: "F", body: "F" }, "manual");
const server = mcp.createMcp(alice.id, { name: "remote", type: "http", url: "https://mcp.example.com", headers: [{ name: "Authorization", value: "secret-value", secret: true }], ask: true });
const otherServer = mcp.createMcp(bob.id, { name: "other", type: "stdio", command: "other-mcp" });

test("内置默认配置按账号、引擎保存，拒绝跨账号、越权和错误输入，失败不保存半份配置", () => {
  assert.deepEqual(defaults.builtinAgentDefaults(admin.id).claude, { skills: null, machineSkills: true, mcp: null });
  assert.deepEqual(defaults.builtinAgentDefaults(alice.id).claude, { skills: null, machineSkills: false, mcp: [] });
  const saved = defaults.setBuiltinAgentDefaults(alice.id, { claude: { skills: [a.id], mcp: [server.id] }, codex: { skills: [], mcp: [] } });
  assert.deepEqual(defaults.builtinAgentDefaults(alice.id), saved);
  assert.equal(defaults.builtinAgentDefaults(bob.id).claude.skills, null);
  for (const patch of [
    { claude: { skills: [foreign.id] } }, { claude: { mcp: [otherServer.id] } },
    { claude: { mcp: ["machine:local"] } }, { claude: { mcp: null } },
    { claude: { machineSkills: true } }, { claude: { skills: "all" } },
    { claude: { skills: [] }, codex: { mcp: "bad" } }, { unknown: {} },
  ]) {
    assert.throws(() => defaults.setBuiltinAgentDefaults(alice.id, patch));
    assert.deepEqual(defaults.builtinAgentDefaults(alice.id), saved);
  }
});

test("内置 Claude / Codex 只挂选中的技能与变量，Claude 插件目录与自定义专家分开", async () => {
  skills.setSkillVars(alice.id, { ALPHA_KEY: "alpha-secret" });
  const claude = defaults.builtinAgentSession(alice.id, "claude");
  const codex = defaults.builtinAgentSession(alice.id, "codex");
  assert.deepEqual(claude.skills?.list.map((s) => s.name), ["alpha"]);
  assert.deepEqual(codex.skills?.list, []);
  assert.deepEqual(claude.skills?.env, { ALPHA_KEY: "alpha-secret" });
  assert.deepEqual(codex.skills?.env, {});
  assert.ok(fs.existsSync(path.join(claude.skills!.pluginDir!, "skills/alpha/SKILL.md")));
  assert.equal(fs.existsSync(path.join(claude.skills!.pluginDir!, "skills/beta")), false);
  const runtime = await import("../src/core/skill-runtime.js");
  const custom = runtime.sessionSkills(alice.id, [b.id]);
  assert.notEqual(custom?.pluginDir, claude.skills?.pluginDir);
  assert.ok(fs.existsSync(path.join(custom!.pluginDir!, "skills/beta/SKILL.md")));
  assert.deepEqual(codex.skills?.list, [], "另一个引擎的选择不变");
  const options = expertOptions({ cwd: home, uploadsDir: home, ...claude });
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(Object.keys(options.mcpServers!), ["remote"]);
  assert.deepEqual(options.skills, ["loft:alpha"]);
  const empty = expertOptions({ cwd: home, uploadsDir: home, ...codex });
  assert.deepEqual(empty.mcpServers, {});
  const events = { onStep() {}, onTextDelta() {}, onText() {}, onResult() {}, onError() {}, onSessionId() {} };
  const session = new ClaudeSession({ cwd: home, uploadsDir: home, ...claude }, events, async () => ({ settlement: "deny", answers: {} }));
  assert.equal((session as any).expertPreApproved("mcp__remote__lookup"), false, "保留调用前询问");
  mcp.updateMcp(alice.id, server.id, { ask: false });
  const noAsk = new ClaudeSession({ cwd: home, uploadsDir: home, ...defaults.builtinAgentSession(alice.id, "claude") }, events, async () => ({ settlement: "deny", answers: {} }));
  assert.equal((noAsk as any).expertPreApproved("mcp__remote__lookup"), true);
  defaults.setBuiltinAgentDefaults(admin.id, { claude: { machineSkills: false, mcp: ["machine:local"] } });
  const adminOptions = expertOptions({ cwd: home, uploadsDir: home, ...defaults.builtinAgentSession(admin.id, "claude") });
  assert.equal(adminOptions.strictMcpConfig, true);
  assert.deepEqual(Object.keys(adminOptions.mcpServers!), ["local"]);
  assert.deepEqual(adminOptions.skills, [], "管理员也能关闭机器技能");
});

test("默认配置的 HTTP 接口按登录账号保存，成员可用，密钥不返回，跨站和未登录请求拒绝", async (t) => {
  const { createSession } = await import("../src/channels/web/auth.js");
  const { startWeb, stopWeb } = await import("../src/channels/web/server.js");
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  saveConfig({ ...structuredClone(config()), workspaceRoot: home, web: { ...config().web, host: "127.0.0.1", port, quotaEnabled: false } });
  await startWeb();
  t.after(() => stopWeb());
  const base = `http://127.0.0.1:${port}`;
  const cookie = `aim_session=${createSession(alice.id, "127.0.0.1", "test")}`;
  const put = (agents: unknown, auth = cookie, origin = base) => fetch(`${base}/api/agents/defaults`, { method: "PUT", headers: { Cookie: auth, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ agents, userId: bob.id }) });
  assert.equal((await put({}, "")).status, 401);
  assert.equal((await put({}, cookie, "https://other.example")).status, 403);
  assert.equal((await put({ claude: { mcp: [otherServer.id] } })).status, 400);
  const bobBefore = defaults.builtinAgentDefaults(bob.id);
  assert.equal((await put({ codex: { skills: null, mcp: [server.id] } })).status, 200);
  assert.deepEqual(defaults.builtinAgentDefaults(bob.id), bobBefore);
  const view = await (await fetch(`${base}/api/agents/defaults`, { headers: { Cookie: cookie } })).text();
  assert.ok(view.includes(server.id));
  assert.ok(!view.includes("secret-value") && !view.includes(otherServer.id));
});

test("Hub：内置会话带个人选择，修改后忙碌会话完成再重载，自定义专家保持自己的选择", async () => {
  const states: { options: import("../src/core/types.js").SessionOptions; events: import("../src/core/types.js").AgentEvents; disposed: boolean }[] = [];
  hub.registerDriver({ listSessions: async () => [], sessionExists: async () => false, readHistory: async () => [], listModels: async () => [], catalog: async () => [], defaults: async () => ({}), statusLines: async () => [], diagnose: () => ({ chatMessage: "test", consoleHint: "test", kind: "test" }), id: "claude", label: "Fake", capabilities: { effort: false, fork: false, cost: false, streaming: true }, start: async () => {}, stop: async () => {}, createSession(options, events) {
    const state = { options, events, disposed: false }; states.push(state);
    return { sessionId: undefined, send() {}, interrupt: async () => {}, setModel: async () => {}, describeRuntime: async () => ({}), dispose: async () => { state.disposed = true; } };
  } });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
  const key = "web:builtin-test";
  hub.ensure({ key, channel: "web", channelId: "web", defaultAgent: "claude", owner: alice.id });
  const origin = { channel: "web", channelId: "web" };
  hub.send(key, { text: "first", attachments: [] }, origin); await tick();
  const first = states.at(-1)!;
  assert.deepEqual(first.options.skills?.list.map((s) => s.name), ["alpha"]);
  defaults.setBuiltinAgentDefaults(alice.id, { claude: { skills: [b.id], mcp: [] } });
  assert.equal(first.disposed, false, "配置修改不打断正在运行的回复");
  first.events.onResult({ text: "done", durationMs: 1 }); await tick();
  hub.send(key, { text: "second", attachments: [] }, origin); await tick();
  assert.notEqual(states.at(-1), first);
  assert.deepEqual(states.at(-1)!.options.skills?.list.map((s) => s.name), ["beta"]);
  assert.deepEqual(states.at(-1)!.options.builtinMcp?.mcp, {});
  states.at(-1)!.events.onResult({ text: "done", durationMs: 1 });
  const expert = createExpert(alice.id, { name: "Custom", engine: "claude", access: "exec", skills: [a.id], mcp: [server.id] });
  hub.ensure({ key: "web:custom-test", channel: "web", channelId: "web", defaultAgent: "claude", owner: alice.id, expert: expert.id });
  hub.send("web:custom-test", { text: "custom", attachments: [] }, origin); await tick();
  assert.deepEqual(states.at(-1)!.options.skills?.list.map((s) => s.name), ["alpha"]);
  assert.equal(states.at(-1)!.options.builtinMcp, undefined);
  assert.ok(states.at(-1)!.options.expert?.mcp.remote);
  states.at(-1)!.events.onResult({ text: "done", durationMs: 1 });
});
