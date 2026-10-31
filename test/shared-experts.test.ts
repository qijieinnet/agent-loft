import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import type { AgentDriver, AgentEvents, SessionOptions } from "../src/core/types.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-shared-experts-"));
process.env.AGENT_LOFT_HOME = home;
process.env.HOME = path.join(home, "host");
delete process.env.CLAUDE_CONFIG_DIR;
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ workspaceRoot: home, web: { quotaEnabled: false } }));
const { loadConfig, config, saveConfig } = await import("../src/core/config.js");
loadConfig();
const users = await import("../src/core/users.js");
const experts = await import("../src/core/experts.js");
const mcp = await import("../src/core/mcp.js");
const skills = await import("../src/core/skills.js");
const memory = await import("../src/core/memory.js");
const { hub } = await import("../src/core/hub.js");
const { purgeUserData } = await import("../src/core/personal.js");
const { getConversation } = await import("../src/core/store.js");
const keepAlive = setInterval(() => {}, 1000);
after(async () => { clearInterval(keepAlive); await hub.shutdown(); await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
const creator = users.createUser({ name: "creator", password: "password-1", role: "admin" });
users.createUser({ name: "backup-admin", password: "password-1", role: "admin" });
const family = users.createUser({ name: "family", password: "password-1" });
const stranger = users.createUser({ name: "stranger", password: "password-1" });
const personal = skills.createSkill(creator.id, { name: "mine", description: "my skill", body: "my rules", vars: [{ name: "PERSONAL_TOKEN" }] }, "manual");
const familySkill = skills.createSkill(family.id, { name: "family", description: "family skill", body: "family rules", vars: [{ name: "PERSONAL_TOKEN" }] }, "manual");
skills.setSkillVars(creator.id, { PERSONAL_TOKEN: "creator-skill-secret" });
skills.setSkillVars(family.id, { PERSONAL_TOKEN: "family-skill-secret" });
const ownMcp = mcp.createMcp(creator.id, { name: "calendar", type: "http", url: "https://calendar.example/mcp", headers: [{ name: "Authorization", value: "creator-secret", secret: true }] });
const familyMcp = mcp.createMcp(family.id, { name: "calendar", type: "http", url: "https://calendar.example/mcp", headers: [{ name: "Authorization", value: "family-secret", secret: true }], ask: true });
memory.setMemoryOptions(creator.id, { enabled: true, about: "creator-memory" });
memory.setMemoryOptions(family.id, { enabled: true, about: "family-memory" });
const shared = experts.createExpert(creator.id, { name: "家庭助手", engine: "claude", model: "shared-model", access: "web", prompt: "共同的设定", shared: true, skills: [personal.id], mcp: [ownMcp.id, "machine:local"] });
const privateExpert = experts.createExpert(creator.id, { name: "私人助手", engine: "claude", access: "web", prompt: "private-prompt" });
const subPrompt = (e: { prompt: string }) => e.prompt;
const botExperts = await import("../src/core/feishu-experts.js");

type State = { opts: SessionOptions; events: AgentEvents; disposed: boolean; sent: string[] };
const states: State[] = [];
function driver(id: string): AgentDriver {
  return {
    id, label: id, capabilities: { effort: false, fork: false, cost: false, streaming: true },
    start: async () => {}, stop: async () => {}, listSessions: async () => [], sessionExists: async () => false,
    readHistory: async () => [], listModels: async () => [], catalog: async () => [], defaults: async () => ({}), statusLines: async () => [],
    diagnose: (e) => ({ kind: "test", chatMessage: String(e), consoleHint: "test" }),
    createSession(opts, events) {
      const state: State = { opts, events, disposed: false, sent: [] };
      states.push(state);
      return {
        sessionId: undefined, send: (i) => { state.sent.push(i.text); }, interrupt: async () => {}, setModel: async () => {},
        describeRuntime: async () => ({}), dispose: async () => { state.disposed = true; },
      };
    },
  };
}
hub.registerDriver(driver("claude"));
hub.registerDriver(driver("codex"));
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));
const done = (state: State) => state.events.onResult({ text: "done", durationMs: 1 });
const origin = { channel: "web", channelId: "web" };

test("共享只授予使用权：私有兼容、持久化、个人工具校验和两种引擎的凭据隔离", () => {
  assert.equal(experts.canUseExpert(family.id, privateExpert.id), false);
  assert.equal(experts.canUseExpert(undefined, shared.id), false);
  assert.equal(experts.canUseExpert(family.id, shared.id), true);
  assert.ok(experts.availableExperts(family.id).some((e) => e.id === shared.id));
  assert.equal(experts.listExperts(family.id).length, 0, "共享专家不占使用者的创建配额");
  assert.throws(() => experts.updateExpert(family.id, shared.id, { prompt: "steal" }), /不存在/);
  assert.throws(() => experts.deleteExpert(family.id, shared.id), /不存在/);
  assert.throws(() => experts.createExpert(family.id, { name: "bad", engine: "claude", access: "web", shared: "true" }), /布尔值/);
  assert.deepEqual(experts.expertTools(family.id, shared), { skills: [], mcp: [] });
  for (const input of [
    { skills: [personal.id], mcp: [] }, { skills: [], mcp: [ownMcp.id] },
    { skills: [], mcp: ["machine:local"] }, { skills: "all", mcp: [] }, { skills: [], mcp: null },
  ]) assert.throws(() => experts.setExpertTools(family.id, shared.id, input));
  assert.deepEqual(experts.expertTools(family.id, shared), { skills: [], mcp: [] }, "校验失败不保存半份配置");
  experts.setExpertTools(family.id, shared.id, { skills: [familySkill.id], mcp: [familyMcp.id] });
  experts.resetExpertCache();
  assert.equal(experts.getExpert(shared.id)?.shared, true);
  for (const engine of ["claude", "codex"] as const) {
    const e = engine === "claude" ? experts.getExpert(shared.id)! : experts.createExpert(creator.id, { name: "Codex 家庭助手", shared: true, engine, access: "web", mcp: [ownMcp.id, "machine:local"] });
    experts.setExpertTools(family.id, e.id, { skills: [familySkill.id], mcp: [familyMcp.id] });
    const rt = experts.expertRuntime(e, subPrompt, family.id);
    assert.deepEqual(rt.skills, [familySkill.id]);
    assert.deepEqual(rt.machineMcp, []);
    assert.deepEqual(rt.askMcp, ["calendar"]);
    assert.match(JSON.stringify(rt.mcp), /family-secret/);
    assert.doesNotMatch(JSON.stringify(rt), /creator-secret|machine:local/);
  }
});

test("共享子智能体也使用聊天者自己的工具，私人子专家不能随主专家泄露", () => {
  const helper = experts.createExpert(creator.id, { name: "Shared Child", shared: true, engine: "claude", access: "read", prompt: "shared child", mcp: [ownMcp.id], skills: [personal.id] });
  assert.throws(() => experts.createExpert(creator.id, { name: "bad parent", shared: true, engine: "claude", access: "read", subagents: [privateExpert.id] }), /也需要先共享/);
  const lead = experts.createExpert(creator.id, { name: "Shared Parent", shared: true, engine: "claude", access: "read", subagents: [helper.id] });
  let rt = experts.expertRuntime(lead, subPrompt, family.id);
  assert.deepEqual(rt.subagents[0]?.mcp, {});
  assert.deepEqual(rt.subagents[0]?.skills, []);
  experts.setExpertTools(family.id, helper.id, { skills: [familySkill.id], mcp: [familyMcp.id] });
  rt = experts.expertRuntime(lead, subPrompt, family.id);
  assert.deepEqual(rt.subagents[0]?.skills, ["family"]);
  assert.match(JSON.stringify(rt.subagents[0]?.mcp), /family-secret/);
  assert.doesNotMatch(JSON.stringify(rt), /creator-secret/);
  experts.updateExpert(creator.id, helper.id, { shared: false });
  assert.deepEqual(experts.expertRuntime(lead, subPrompt, family.id).subagents, []);
});

test("机器人直接选择共享专家，自动推导引擎；旧配置兼容，无效选择不退回内置专家", () => {
  const selected = botExperts.botExpertSelection([shared.id], shared.id);
  assert.deepEqual(selected.agents, ["claude"]);
  assert.equal(selected.defaultAgent, "claude");
  assert.equal(selected.defaultExpert, shared.id);
  assert.deepEqual(selected.experts, [shared.id]);
  for (const ids of [[], [privateExpert.id], ["e_dead"], ["bad"], "all"]) assert.throws(() => botExperts.botExpertSelection(ids, shared.id));
  const bot = { id: "unit", name: "unit", enabled: false, appId: "", appSecret: "", domain: "feishu" as const, allowFrom: [], agents: ["codex"], defaultAgent: "codex" };
  assert.deepEqual(botExperts.botAgentIds(bot), ["codex"]);
  assert.equal(botExperts.botExpertIds(bot), undefined);
  assert.deepEqual(botExperts.botAgentIds({ ...bot, experts: [shared.id] }), ["claude"]);
  assert.deepEqual(botExperts.botAgentIds({ ...bot, experts: ["e_dead"] }), []);
  assert.deepEqual(botExperts.botExpertIds({ ...bot, experts: [privateExpert.id] }), []);
});

test("两个人同时使用同一个专家：记忆、技能变量、MCP 独立，更新和撤回共享正确重载", async () => {
  for (const owner of [creator.id, family.id]) {
    const key = `web:shared-${owner}`;
    hub.ensure({ key, channel: "web", channelId: "web", defaultAgent: "claude", owner, expert: shared.id });
    hub.send(key, { text: "hello", attachments: [] }, origin);
  }
  await tick();
  const mine = states.find((s) => s.opts.memory?.userId === creator.id)!;
  const theirs = states.find((s) => s.opts.memory?.userId === family.id)!;
  assert.ok(mine && theirs && mine !== theirs);
  for (const [state, prefix] of [[mine, "creator"], [theirs, "family"]] as const) {
    assert.equal(state.opts.expert?.id, shared.id);
    assert.equal(state.opts.expert?.prompt, "共同的设定");
    assert.match(state.opts.memory!.prompt, new RegExp(`${prefix}-memory`));
    assert.equal(state.opts.skills?.env.PERSONAL_TOKEN, `${prefix}-skill-secret`);
    assert.match(JSON.stringify(state.opts.expert?.mcp), new RegExp(`${prefix}-secret`));
    assert.equal(state.opts.tasks?.userId, state.opts.memory?.userId);
  }
  experts.setExpertTools(family.id, shared.id, { skills: [], mcp: [] });
  assert.equal(theirs.disposed, false, "修改不打断正在执行的回复");
  done(theirs); done(mine); await tick();
  assert.equal(theirs.disposed, true);
  assert.equal(mine.disposed, false, "别人的工具变化不影响我的会话");
  const familyKey = `web:shared-${family.id}`;
  hub.send(familyKey, { text: "next", attachments: [] }, origin); await tick();
  const next = states.at(-1)!;
  assert.deepEqual(next.opts.expert?.mcp, {});
  assert.deepEqual(next.opts.skills?.list, []);
  experts.setExpertTools(creator.id, shared.id, { skills: [], mcp: [ownMcp.id] }); await tick();
  assert.equal(mine.disposed, true, "发布者的工具更新也只刷新他自己");
  assert.equal(next.disposed, false, "发布者修改个人工具不刷新家人的会话");
  experts.updateExpert(creator.id, shared.id, { prompt: "新的共同设定" });
  assert.equal(next.disposed, false);
  done(next); await tick();
  hub.send(familyKey, { text: "new prompt", attachments: [] }, origin); await tick();
  const updated = states.at(-1)!;
  assert.equal(updated.opts.expert?.prompt, "新的共同设定");
  done(updated); await tick();
  experts.updateExpert(creator.id, shared.id, { model: "" }); await tick();
  assert.equal(updated.disposed, true, "清空模型等可选字段也要更新所有使用者");
  hub.send(familyKey, { text: "one last turn", attachments: [] }, origin); await tick();
  const running = states.at(-1)!;
  assert.equal(running.opts.model, undefined);
  const sentBefore = running.sent.length;
  experts.updateExpert(creator.id, shared.id, { shared: false });
  hub.send(familyKey, { text: "cannot queue after revocation", attachments: [] }, origin); await tick();
  assert.equal(running.sent.length, sentBefore, "撤回共享立即阻止新输入，即使旧一轮还在运行");
  done(running); await tick();
  assert.equal(updated.disposed, true);
  assert.equal(hub.info(familyKey)?.expert.missing, true);
  const count = states.length;
  hub.send(familyKey, { text: "must fail", attachments: [] }, origin); await tick();
  assert.equal(states.length, count, "不能退回内置引擎继续运行");
  assert.equal(getConversation(familyKey)?.expert, shared.id, "历史记录仍保留原专家");
  experts.updateExpert(creator.id, shared.id, { shared: true });
});

test("HTTP：共享专家可选，设定只读；个人工具接口不返回他人配置，任务支持共享与撤回", async (t) => {
  const { createSession } = await import("../src/channels/web/auth.js");
  const { startWeb, stopWeb } = await import("../src/channels/web/server.js");
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  saveConfig({ ...structuredClone(config()), web: { ...config().web, host: "127.0.0.1", port } });
  await startWeb();
  t.after(() => stopWeb());
  const base = `http://127.0.0.1:${port}`;
  const cookie = `aim_session=${createSession(family.id, "127.0.0.1", "test")}`;
  const adminCookie = `aim_session=${createSession(creator.id, "127.0.0.1", "test")}`;
  const request = (p: string, method = "GET", body?: unknown, auth = cookie, origin = base) => fetch(`${base}${p}`, {
    method, headers: { Cookie: auth, Origin: origin, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const bot = { id: "family-bot", name: "family", enabled: false, appId: "", appSecret: "", domain: "feishu", allowFrom: [], agents: [], defaultAgent: "codex", experts: [shared.id], defaultExpert: shared.id };
  assert.equal((await request("/api/config", "PUT", { feishu: { bots: [bot] } })).status, 403);
  assert.equal((await request("/api/config", "PUT", { feishu: { bots: [{ ...bot, experts: [privateExpert.id] }] } }, adminCookie)).status, 400);
  assert.equal((await request("/api/config", "PUT", { feishu: { bots: [bot] } }, adminCookie)).status, 200);
  assert.deepEqual(config().feishu.bots[0]?.experts, [shared.id]);
  assert.deepEqual(config().feishu.bots[0]?.agents, ["claude"]);
  assert.equal(config().feishu.bots[0]?.defaultExpert, shared.id);
  loadConfig();
  assert.equal(config().feishu.bots[0]?.defaultExpert, shared.id, "重载配置后仍保留专家选择");
  for (const endpoint of ["/api/bootstrap", "/api/experts", "/api/experts/brief"]) {
    const res = await request(endpoint);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes(shared.id));
    assert.ok(!body.includes(privateExpert.id) && !body.includes("creator-secret") && !body.includes(ownMcp.id));
  }
  const view = await (await request(`/api/experts/${shared.id}`)).json() as { editable: boolean; shared: boolean; skills: string[]; mcp: string[] };
  assert.equal(view.editable, false);
  assert.equal(view.shared, true);
  assert.deepEqual(view.skills, []);
  assert.deepEqual(view.mcp, []);
  assert.equal((await request(`/api/experts/${shared.id}`, "PATCH", { prompt: "stolen" })).status, 403);
  assert.equal((await request(`/api/experts/${shared.id}`, "DELETE")).status, 403);
  assert.equal((await request(`/api/experts/${privateExpert.id}`)).status, 404);
  const toolsUrl = `/api/experts/${shared.id}/tools`;
  assert.equal((await request(toolsUrl, "PUT", { skills: [], mcp: [] }, "")).status, 401);
  assert.equal((await request(toolsUrl, "PUT", { skills: [], mcp: [] }, cookie, "https://foreign.example")).status, 403);
  assert.equal((await request(toolsUrl, "PUT", { skills: [], mcp: [ownMcp.id] })).status, 400);
  assert.equal((await request(toolsUrl, "PUT", { skills: [familySkill.id], mcp: [familyMcp.id], owner: creator.id })).status, 200);
  assert.deepEqual(experts.expertTools(creator.id, experts.getExpert(shared.id)!).mcp, [ownMcp.id]);
  const convRes = await request("/api/conversations", "POST", { expert: shared.id });
  assert.equal(convRes.status, 200);
  const conv = await convRes.json() as { key: string; expert: { id: string } };
  assert.equal(conv.expert.id, shared.id);
  assert.equal(getConversation(conv.key)?.owner, family.id);
  const taskRes = await request("/api/tasks", "POST", { prompt: "family task", expert: shared.id, schedule: { kind: "daily", time: "08:00" } });
  assert.equal(taskRes.status, 200);
  const taskView = await taskRes.json() as { id: string };
  const tasks = await import("../src/core/tasks.js");
  const runner = await import("../src/core/task-runner.js");
  runner.startTaskRunner();
  t.after(() => runner.stopTaskRunner());
  const task = tasks.getTask(family.id, taskView.id)!;
  assert.equal(runner.runTaskNow(task), undefined); await tick();
  const state = states.at(-1)!;
  assert.equal(state.opts.memory?.userId, family.id);
  assert.match(JSON.stringify(state.opts.expert?.mcp), /family-secret/);
  done(state); await tick();
  experts.updateExpert(creator.id, shared.id, { shared: false });
  assert.match(runner.runTaskNow(task) ?? "", /取消共享/);
  assert.equal(task.enabled, false);
  assert.equal((await request(toolsUrl, "PUT", { skills: [], mcp: [] })).status, 404);
  assert.equal((await request(`/api/experts/${shared.id}`)).status, 404);
  assert.equal((await request("/api/conversations", "POST", { expert: shared.id })).status, 400, "旧页面选到撤回的专家不能悄悄退回内置引擎");
  assert.equal((await request(`/api/conversations/${encodeURIComponent(conv.key)}/history`)).status, 200, "旧对话仍能查看");
  experts.updateExpert(creator.id, shared.id, { shared: true });
});

test("停用发布者收回共享使用权，删用户清理本人及所发布专家的个人工具绑定", () => {
  users.updateUser(creator.id, { disabled: true });
  assert.equal(experts.canUseExpert(family.id, shared.id), false);
  assert.ok(!experts.availableExperts(family.id).some((e) => e.id === shared.id));
  users.updateUser(creator.id, { disabled: false });
  experts.setExpertTools(stranger.id, shared.id, { skills: [], mcp: [] });
  purgeUserData(stranger.id);
  let tools = JSON.parse(fs.readFileSync(path.join(home, "data", "expert-tools.json"), "utf8"));
  assert.equal(tools[stranger.id], undefined);
  experts.deleteExpert(creator.id, shared.id);
  tools = JSON.parse(fs.readFileSync(path.join(home, "data", "expert-tools.json"), "utf8"));
  assert.equal(tools[family.id]?.[shared.id], undefined);
});
