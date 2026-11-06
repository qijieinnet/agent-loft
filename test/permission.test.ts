// 权限级别：对话上的设置、封顶规则、定时任务的专用对话、网页接口。用假 driver，不起真进程。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AgentDriver, SessionOptions } from "../src/core/types.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-permission-"));
process.env.AGENT_LOFT_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ workspaceRoot: home, web: { quotaEnabled: false } }));
const { loadConfig, config, saveConfig } = await import("../src/core/config.js");
loadConfig();
const users = await import("../src/core/users.js");
const experts = await import("../src/core/experts.js");
const tasks = await import("../src/core/tasks.js");
const runner = await import("../src/core/task-runner.js");
const store = await import("../src/core/store.js");
const { hub } = await import("../src/core/hub.js");
const { parseCommand } = await import("../src/core/commands.js");
const builtinDefaults = await import("../src/core/builtin-agents.js");
const auth = await import("../src/channels/web/auth.js");
const { startWeb, stopWeb } = await import("../src/channels/web/server.js");

type Live = { agent: string; opts: SessionOptions; set: (string | undefined)[]; plans: boolean[]; events: Parameters<AgentDriver["createSession"]>[1]; failSet?: boolean; disposed: boolean };
const lives: Live[] = [];
for (const id of ["claude", "codex"]) {
  const driver: AgentDriver = {
    id, label: id, capabilities: { effort: false, fork: false, cost: false, streaming: false },
    start: async () => {}, stop: async () => {}, listSessions: async () => [], sessionExists: async () => true,
    readHistory: async () => [], listModels: async () => [], catalog: async () => [], defaults: async () => ({}), statusLines: async () => [],
    diagnose: (e) => ({ kind: "test", chatMessage: String(e), consoleHint: "test" }),
    createSession(opts, events) {
      const live: Live = { agent: id, opts: { ...opts }, set: [], plans: [], events, disposed: false };
      lives.push(live);
      return {
        sessionId: undefined,
        send: () => setTimeout(() => { events.onSessionId(`s-${id}`); events.onResult({ text: "好了", durationMs: 1 }); }, 1) as unknown as void,
        interrupt: async () => {}, setModel: async () => {}, describeRuntime: async () => ({}),
        dispose: async () => { live.disposed = true; },
        setPermission: async (level) => {
          live.set.push(level);
          if (live.failSet) throw new Error("切换失败");
        },
        setPlan: async (on) => {
          live.plans.push(on);
        },
      };
    },
  };
  hub.registerDriver(driver);
}
runner.startTaskRunner();
const keepAlive = setInterval(() => {}, 1000);
after(async () => {
  runner.stopTaskRunner();
  await stopWeb();
  await hub.shutdown();
  clearInterval(keepAlive);
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const admin = users.createUser({ name: "admin", password: "password-admin", role: "admin" });
const member = users.createUser({ name: "member", password: "password-member" });
let seq = 0;
const webConv = (owner: string, extra: { agent?: string; expert?: string } = {}) => {
  const key = `web:p${++seq}`;
  hub.ensure({ key, channel: "web", channelId: "web", defaultAgent: extra.agent ?? "claude", ...(extra.expert ? { expert: extra.expert } : {}), owner });
  return key;
};
const conv = (key: string) => store.getConversation(key)!;
const lastLive = () => lives[lives.length - 1]!;
const tick = () => new Promise((r) => setTimeout(r, 20));

test("/permission 解析：英文、中文、默认；不认识的当聊天", () => {
  assert.deepEqual(parseCommand("/permission"), { kind: "permission" });
  assert.deepEqual(parseCommand("/permission FULL"), { kind: "permission", level: "full" });
  assert.deepEqual(parseCommand("/permission 自动改文件"), { kind: "permission", level: "edit" });
  assert.deepEqual(parseCommand("/permission default"), { kind: "permission", level: "default" });
  assert.deepEqual(parseCommand("/permission hasOwnProperty"), { kind: "chat", text: "/permission hasOwnProperty" });
});

test("老对话不受影响：没选过不传级别；以前的 autoEdit 在 Claude 下算自动改文件，Codex 下不算", () => {
  const key = webConv(admin.id);
  hub.session(key);
  assert.equal(lastLive().opts.permission, undefined);
  assert.equal(hub.info(key)!.permission, "ask");

  const codex = webConv(admin.id, { agent: "codex" });
  assert.equal(hub.info(codex)!.permission, "edit", "Codex 没选过就按设置里的沙箱");
  store.updateConversation(codex, { autoEdit: true });
  hub.session(codex);
  assert.equal(lastLive().opts.permission, undefined);

  const legacy = webConv(admin.id);
  store.updateConversation(legacy, { autoEdit: true });
  hub.session(legacy);
  assert.equal(lastLive().opts.permission, "edit");
  assert.equal(hub.info(legacy)!.permission, "edit");
});

test("管理员切换：记在对话上、告诉活着的会话，新拉起的按新级别", async () => {
  const key = webConv(admin.id);
  hub.session(key);
  const live = lastLive();
  assert.match(await hub.setPermission(key, "full", true), /完全允许/);
  assert.equal(conv(key).permission, "full");
  assert.deepEqual(live.set, ["full"]);
  assert.equal(hub.info(key)!.permission, "full");
  await hub.setPermission(key, undefined, true);
  assert.equal(conv(key).permission, undefined);
  assert.deepEqual(live.set, ["full", undefined]);
});

test("切换失败：不能带着旧权限继续，空闲后重新拉起", async () => {
  const key = webConv(admin.id);
  hub.session(key);
  const live = lastLive();
  live.failSet = true;
  await hub.setPermission(key, "full", true);
  await tick();
  assert.equal(live.disposed, true);
  hub.session(key);
  assert.equal(lastLive().opts.permission, "full");
});

test("封顶：非管理员本人、成员的对话、飞书群聊、专家权限低的都到不了完全允许", async () => {
  const mine = webConv(admin.id);
  assert.match(await hub.setPermission(mine, "full", false), /只有管理员/);
  assert.equal(conv(mine).permission, undefined);

  const theirs = webConv(member.id);
  assert.equal(hub.info(theirs)!.permissionMax, "edit");
  assert.match(await hub.setPermission(theirs, "full", true), /最高只能到/, "管理员帮成员的对话调也不行：看的是对话的主人");
  await hub.setPermission(theirs, "edit", false);
  assert.equal(conv(theirs).permission, "edit");

  hub.ensure({ key: "feishu:group", channel: "feishu", channelId: "g", defaultAgent: "claude" });
  assert.equal(hub.info("feishu:group")!.permissionMax, "edit");
  assert.match(await hub.setPermission("feishu:group", "full", true), /最高只能到/);

  const reader = experts.createExpert(admin.id, { name: "只读", engine: "claude", access: "read" });
  const key = webConv(admin.id, { expert: reader.id });
  assert.equal(hub.info(key)!.permissionMax, "ask");
  assert.match(await hub.setPermission(key, "edit", true), /最高只能到/);

  // 存的是 full，主人后来被降级：传给 session 的要封顶
  const demoted = users.createUser({ name: "demoted", password: "password-demoted", role: "admin" });
  const was = webConv(demoted.id);
  await hub.setPermission(was, "full", true);
  users.updateUser(demoted.id, { role: "member" });
  assert.equal(hub.info(was)!.permission, "edit");
  hub.session(was);
  assert.equal(lastLive().opts.permission, "edit");
  // 专家不认识（被删了）按最低算
  store.updateConversation(was, { expert: "e_gone" });
  assert.equal(hub.info(was)!.permissionMax, "ask");
  store.updateConversation(was, { expert: undefined });
});

test("管理员收紧了 Codex 沙箱：成员不能自己放开，管理员可以", async () => {
  const before = structuredClone(config());
  saveConfig({ ...structuredClone(config()), agents: { ...config().agents, codex: { ...config().agents.codex, sandbox: "read-only" } } });
  const theirs = webConv(member.id, { agent: "codex" });
  assert.equal(hub.info(theirs)!.permissionMax, "ask");
  assert.match(await hub.setPermission(theirs, "edit", false), /最高只能到/);
  const mine = webConv(admin.id, { agent: "codex" });
  assert.equal(hub.info(mine)!.permission, "ask");
  await hub.setPermission(mine, "full", true);
  assert.equal(hub.info(mine)!.permission, "full");
  saveConfig(before);
});

test("「本会话全部允许」：成员的对话不给，管理员和没主人的对话照旧", () => {
  hub.session(webConv(member.id));
  assert.equal(lastLive().opts.noSessionGrant, true);
  hub.session(webConv(admin.id));
  assert.equal(lastLive().opts.noSessionGrant, undefined);
  hub.ensure({ key: "feishu:grant", channel: "feishu", channelId: "g2", defaultAgent: "claude" });
  hub.session("feishu:grant");
  assert.equal(lastLive().opts.noSessionGrant, undefined);
});

test("/new 清掉完全允许，自动改文件留着；/autoedit 是自动改文件的旧叫法", async () => {
  const key = webConv(admin.id);
  await hub.setPermission(key, "full", true);
  await hub.newSession(key);
  assert.equal(conv(key).permission, undefined);

  await hub.setAutoEdit(key, true);
  assert.equal(conv(key).permission, "edit");
  await hub.newSession(key);
  assert.equal(conv(key).permission, "edit");
  await hub.setAutoEdit(key);
  assert.equal(conv(key).permission, undefined, "不带参数是切换");
  await hub.setPermission(key, "full", true);
  await hub.setAutoEdit(key, false);
  assert.equal(conv(key).permission, undefined, "关掉就是恢复默认");
});

test("hub.command：/permission 只有渠道确认过的管理员才能选完全允许，默认不给", async () => {
  const key = webConv(admin.id);
  const ctx = { allowedAgents: ["claude", "codex"], by: "test" };
  const reply = await hub.command(key, { kind: "permission", level: "full" }, ctx);
  assert.equal(reply.type, "text");
  assert.equal(conv(key).permission, undefined);
  await hub.command(key, { kind: "permission", level: "full" }, { ...ctx, allowFullAccess: true });
  assert.equal(conv(key).permission, "full");
  const shown = await hub.command(key, { kind: "permission" }, ctx);
  assert.ok(shown.type === "text" && shown.text.includes("当前权限：完全允许"));
  const status = await hub.command(key, { kind: "status" }, ctx);
  assert.ok(status.type === "text" && status.text.includes("权限：完全允许"));
  await hub.command(key, { kind: "permission", level: "default" }, ctx);
  assert.equal(conv(key).permission, undefined);
});

test("定时任务：agent 建的不能带权限；专用对话到点按任务的级别跑，对话里改不了；降级后封顶并记一笔", async () => {
  const byAgent = tasks.createTask(admin.id, { prompt: "x", schedule: { kind: "daily", time: "09:00" }, permission: "full" }, "agent");
  assert.equal(byAgent.permission, undefined);
  assert.throws(() => tasks.createTask(admin.id, { prompt: "x", schedule: { kind: "daily", time: "09:00" }, permission: "god" }, "user"), /权限级别/);

  const task = tasks.createTask(admin.id, { prompt: "巡检", schedule: { kind: "daily", time: "09:00" }, permission: "full" }, "user");
  assert.equal(runner.runTaskNow(task), undefined);
  const key = task.target.key!;
  await tick(); // 会话是发消息时在串行队列里拉起的
  assert.equal(lastLive().opts.permission, "full");
  assert.equal(conv(key).taskId, task.id);
  assert.match(await hub.setPermission(key, "ask", true), /专用对话/);
  assert.equal(conv(key).permission, "full");

  // 用户手动 /new 清掉了也没关系：下次到点按任务的
  await hub.newSession(key);
  assert.equal(conv(key).permission, undefined);
  assert.equal(runner.runTaskNow(task), undefined);
  assert.equal(conv(key).permission, "full");
  await tick();

  // 主人被降级：照跑，但按上限，并记在运行记录里
  const demoted = users.createUser({ name: "demoted2", password: "password-demoted", role: "admin" });
  const theirs = tasks.createTask(demoted.id, { prompt: "巡检", schedule: { kind: "daily", time: "09:00" }, permission: "full" }, "user");
  users.updateUser(demoted.id, { role: "member" });
  assert.equal(runner.runTaskNow(theirs), undefined);
  assert.match(theirs.runs[0]!.note ?? "", /自动改文件/);
  await tick();
  assert.equal(lastLive().opts.permission, "edit");

  // 任务删了：对话留着，权限收回
  runner.forgetTask(task);
  assert.equal(conv(key).taskId, undefined);
  assert.equal(conv(key).permission, undefined);
});

test("定时任务发到已有对话：跟着那条对话，不动它的级别", async () => {
  const key = webConv(admin.id);
  await hub.setPermission(key, "edit", true);
  const task = tasks.createTask(admin.id, { prompt: "看看", schedule: { kind: "daily", time: "09:00" }, target: { kind: "conv", key }, permission: "full" }, "user");
  assert.equal(runner.runTaskNow(task), undefined);
  assert.equal(conv(key).permission, "edit");
  await tick();
});

test("HTTP：完全允许只给管理员；改任务马上生效，换对话收回旧对话的权限", async () => {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  saveConfig({ ...structuredClone(config()), web: { ...config().web, host: "127.0.0.1", port } });
  await startWeb();
  const session = (id: string) => `aim_session=${auth.createSession(id, "127.0.0.1", "test")}`;
  const asAdmin = session(admin.id);
  const asMember = session(member.id);
  const call = (p: string, method: string, body: unknown, cookie: string) =>
    fetch(`${base}${p}`, { method, headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const schedule = { kind: "daily", time: "09:00" };

  // 对话
  const theirs = webConv(member.id);
  const refused = await (await call(`/api/conversations/${encodeURIComponent(theirs)}/action`, "POST", { action: "permission", value: "full" }, asMember)).json() as { text: string; info: { permission: string } };
  assert.match(refused.text, /只有管理员/);
  assert.equal(refused.info.permission, "ask");
  assert.equal((await call(`/api/conversations/${encodeURIComponent(theirs)}/action`, "POST", { action: "permission", value: "god" }, asMember)).status, 400);
  const mine = webConv(admin.id);
  const done = await (await call(`/api/conversations/${encodeURIComponent(mine)}/action`, "POST", { action: "permission", value: "full" }, asAdmin)).json() as { info: { permission: string; permissionMax: string } };
  assert.deepEqual([done.info.permission, done.info.permissionMax], ["full", "full"]);

  // 任务
  assert.equal((await call("/api/tasks", "POST", { prompt: "x", schedule, expert: "claude", permission: "full" }, asMember)).status, 403);
  const reader = experts.createExpert(admin.id, { name: "只读 2", engine: "claude", access: "read" });
  assert.equal((await call("/api/tasks", "POST", { prompt: "x", schedule, expert: reader.id, permission: "edit" }, asAdmin)).status, 400);
  const created = await (await call("/api/tasks", "POST", { prompt: "x", schedule, expert: "claude", permission: "full" }, asAdmin)).json() as { id: string };
  const task = tasks.getTask(admin.id, created.id)!;
  assert.equal(task.permission, "full");
  assert.equal(runner.runTaskNow(task), undefined);
  await tick();
  const key = task.target.key!;
  assert.equal(conv(key).permission, "full");

  // 调低：不等下次运行，活着的会话也马上降下来
  const live = lastLive();
  assert.equal((await call(`/api/tasks/${created.id}`, "PATCH", { permission: "ask" }, asAdmin)).status, 200);
  assert.equal(conv(key).permission, "ask");
  assert.deepEqual(live.set, ["ask"]);
  // 清空级别
  assert.equal((await call(`/api/tasks/${created.id}`, "PATCH", { permission: "" }, asAdmin)).status, 200);
  assert.equal(task.permission, undefined);
  assert.equal(conv(key).permission, undefined);

  // 换目录会换专用对话：旧对话不再属于任务，权限也收回
  assert.equal((await call(`/api/tasks/${created.id}`, "PATCH", { permission: "full" }, asAdmin)).status, 200);
  assert.equal(conv(key).permission, "full");
  const dir = path.join(home, "sub");
  fs.mkdirSync(dir);
  assert.equal((await call(`/api/tasks/${created.id}`, "PATCH", { cwd: dir }, asAdmin)).status, 200);
  assert.equal(conv(key).permission, undefined);
  assert.equal(conv(key).taskId, undefined);

  // 降级：活着的会话要重新拉起
  const demoted = users.createUser({ name: "demoted3", password: "password-demoted", role: "admin" });
  const was = webConv(demoted.id);
  await hub.setPermission(was, "full", true);
  hub.session(was);
  const running = lastLive();
  assert.equal((await call(`/api/users/${demoted.id}`, "PATCH", { role: "member" }, asAdmin)).status, 200);
  await tick();
  assert.equal(running.disposed, true);
});

test("/permission auto、/planmode 解析；/plan 不占用，留给自定义命令", () => {
  assert.deepEqual(parseCommand("/permission auto"), { kind: "permission", level: "auto" });
  assert.deepEqual(parseCommand("/permission 自动判断"), { kind: "permission", level: "auto" });
  assert.deepEqual(parseCommand("/planmode"), { kind: "plan" });
  assert.deepEqual(parseCommand("/planmode on"), { kind: "plan", on: true });
  assert.deepEqual(parseCommand("/planmode 关"), { kind: "plan", on: false });
  assert.deepEqual(parseCommand("/planmode maybe"), { kind: "chat", text: "/planmode maybe" });
  assert.deepEqual(parseCommand("/plan"), { kind: "chat", text: "/plan" });
});

test("自动判断：只有 Claude 能选、成员到不了；Codex 对话里留着的按自动改文件算", async () => {
  const key = webConv(admin.id);
  hub.session(key);
  assert.match(await hub.setPermission(key, "auto", true), /自动判断/);
  assert.equal(lastLive().set.at(-1), "auto");
  assert.equal(hub.info(key)!.permission, "auto");

  const codex = webConv(admin.id, { agent: "codex" });
  assert.match(await hub.setPermission(codex, "auto", true), /只有 Claude Code/);
  assert.equal(conv(codex).permission, undefined);
  // 从 Claude 换到 Codex 的对话：存着的自动判断降成自动改文件交给 Codex
  store.updateConversation(codex, { permission: "auto" });
  hub.session(codex);
  assert.equal(lastLive().opts.permission, "edit");
  assert.equal(hub.info(codex)!.permission, "edit");

  const theirs = webConv(member.id);
  assert.match(await hub.setPermission(theirs, "auto", false), /最高只能到/);
});

test("默认权限：按账号、引擎存；没选过的对话按它，选过的、定时任务的专用对话不按；不能把完全允许设成默认", async () => {
  assert.throws(() => builtinDefaults.setBuiltinAgentDefaults(admin.id, { claude: { permission: "full" } }), /默认权限/);
  assert.throws(() => builtinDefaults.setBuiltinAgentDefaults(admin.id, { codex: { permission: "auto" } }), /只有 Claude Code/);
  assert.throws(() => builtinDefaults.setBuiltinAgentDefaults(member.id, { claude: { permission: "auto" } }), /只有管理员/);
  builtinDefaults.setBuiltinAgentDefaults(admin.id, { claude: { permission: "auto" }, codex: { permission: "ask" } });
  builtinDefaults.setBuiltinAgentDefaults(member.id, { claude: { permission: "edit" } });
  await tick();

  const key = webConv(admin.id);
  hub.session(key);
  assert.equal(lastLive().opts.permission, "auto");
  assert.equal(hub.info(key)!.permission, "auto");
  await hub.setPermission(key, "ask", true);
  assert.equal(hub.info(key)!.permission, "ask", "选过的按选的");
  assert.match(await hub.setPermission(key, undefined, true), /已恢复默认：自动判断/);

  const codex = webConv(admin.id, { agent: "codex" });
  assert.equal(hub.info(codex)!.permission, "ask", "Codex 按它自己的默认，不按沙箱");
  assert.equal(hub.info(webConv(member.id))!.permission, "edit");

  const task = webConv(admin.id);
  store.updateConversation(task, { taskId: "t-default" });
  assert.equal(hub.info(task)!.permission, "ask", "专用对话只跟着任务");

  builtinDefaults.setBuiltinAgentDefaults(admin.id, { claude: { permission: null }, codex: { permission: null } });
  builtinDefaults.setBuiltinAgentDefaults(member.id, { claude: { permission: null } });
  assert.equal(hub.info(key)!.permission, "ask");
});

test("计划模式：记在对话上、告诉活着的会话；agent 批准方案退出时跟着关；定时任务的专用对话开不了", async () => {
  const key = webConv(admin.id);
  hub.session(key);
  const live = lastLive();
  assert.match(await hub.setPlan(key, true), /已打开计划模式/);
  assert.equal(conv(key).plan, true);
  assert.equal(hub.info(key)!.plan, true);
  assert.deepEqual(live.plans, [true]);
  assert.match(await hub.setPlan(key, true), /本来就开着/);

  live.events.onPlanMode?.(false);
  assert.equal(conv(key).plan, undefined);
  assert.equal(hub.info(key)!.plan, undefined);

  assert.match(await hub.setPlan(key), /已打开/, "不给就是切换");
  live.disposed = true;
  await hub.newSession(key);
  hub.session(key);
  assert.equal(lastLive().opts.plan, true, "新拉起的会话带着计划模式");

  const task = webConv(admin.id);
  store.updateConversation(task, { taskId: "t-plan" });
  assert.match(await hub.setPlan(task, true), /不能开计划模式/);
  assert.equal(conv(task).plan, undefined);
});
