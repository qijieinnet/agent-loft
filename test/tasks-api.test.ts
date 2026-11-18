import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import type { EventEnvelope } from "../src/core/hub.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-tasks-api-"));
process.env.AGENT_LOFT_HOME = home;
const { config, loadConfig, saveConfig } = await import("../src/core/config.js");
const { createUser } = await import("../src/core/users.js");
const { createSession } = await import("../src/channels/web/auth.js");
const { startWeb, stopWeb } = await import("../src/channels/web/server.js");
const { ensureConversation, getConversation, updateConversation } = await import("../src/core/store.js");
const { hub } = await import("../src/core/hub.js");
const { getTask } = await import("../src/core/tasks.js");
loadConfig();

test("定时任务接口：发到已有对话时专家和目录以对话为准，权限改的是对话", { timeout: 20000 }, async (t) => {
  const root = path.join(home, "workspace");
  const project = path.join(root, "proj");
  fs.mkdirSync(project, { recursive: true });
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())));
  const base = `http://127.0.0.1:${port}`;
  saveConfig({ ...structuredClone(config()), workspaceRoot: root, web: { ...config().web, host: "127.0.0.1", port, quotaEnabled: false } });
  hub.registerDriver({
    id: "claude",
    label: "Fake",
    capabilities: { effort: false, fork: false, cost: false, streaming: false },
    start: async () => {},
    stop: async () => {},
    createSession: () => {
      throw new Error("不该拉起会话");
    },
    listSessions: async () => [],
    sessionExists: async () => true,
    readHistory: async () => [],
    listModels: async () => [],
    catalog: async () => [],
    defaults: async () => ({}),
    statusLines: async () => [],
    diagnose: () => ({ kind: "x", chatMessage: "x", consoleHint: "" }),
  });
  const admin = createUser({ name: "tasks-admin", password: "password-1", role: "admin" });
  const member = createUser({ name: "tasks-member", password: "password-1" });
  const adminCookie = `aim_session=${createSession(admin.id, "127.0.0.1", "test")}`;
  const memberCookie = `aim_session=${createSession(member.id, "127.0.0.1", "test")}`;
  await startWeb();
  t.after(() => stopWeb());
  const call = (method: string, url: string, body: unknown, cookie = memberCookie) =>
    fetch(`${base}${url}`, { method, headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const conv = (key: string, owner: string) => ensureConversation({ key, cwd: project, owner, channel: "web", channelId: "web", agent: "claude" });
  conv("web:mine", member.id);
  conv("web:admin", admin.id);
  const schedule = { kind: "daily", time: "08:00" };

  // 不是自己的对话：不能发过去
  const stranger = await call("POST", "/api/tasks", { prompt: "看看", schedule, target: { kind: "conv", key: "web:admin" } });
  assert.equal(stranger.status, 400);

  // 表单给的专家、目录不算数，不携带上下文记下来
  const created = await call("POST", "/api/tasks", { prompt: "看看", schedule, target: { kind: "conv", key: "web:mine" }, cwd: root, expert: "claude", freshContext: true });
  assert.equal(created.status, 200);
  const task = (await created.json()) as { id: string; cwd?: string; freshContext?: boolean; convCwd: string; convPermissionMax: string; convExpert: { name: string } };
  assert.equal(task.cwd, project);
  assert.equal(task.freshContext, true);
  assert.equal(task.convCwd, project);
  assert.equal(task.convPermissionMax, "edit", "成员最高到自动改文件");
  assert.ok(task.convExpert.name);

  // 权限：成员不能选完全允许，失败时任务也不改
  const full = await call("PATCH", `/api/tasks/${task.id}`, { title: "新名字", target: { kind: "conv", key: "web:mine" }, convPermission: "full" });
  assert.equal(full.status, 403);
  assert.notEqual(getTask(member.id, task.id)!.title, "新名字");
  assert.equal(getConversation("web:mine")!.permission, undefined);

  const edit = await call("PATCH", `/api/tasks/${task.id}`, { target: { kind: "conv", key: "web:mine" }, convPermission: "edit" });
  assert.equal(edit.status, 200);
  assert.equal(getConversation("web:mine")!.permission, "edit");
  assert.equal(getTask(member.id, task.id)!.permission, undefined, "权限记在对话上，不记在任务上");

  // 只改开关：不碰目标和权限
  assert.equal((await call("PATCH", `/api/tasks/${task.id}`, { enabled: false })).status, 200);
  assert.equal(getTask(member.id, task.id)!.target.key, "web:mine");
  assert.equal(getConversation("web:mine")!.permission, "edit");

  // 别的任务的专用对话：权限不能从这里改
  conv("web:dedicated", admin.id);
  updateConversation("web:dedicated", { taskId: "t_other" });
  const locked = await call("POST", "/api/tasks", { prompt: "看看", schedule, target: { kind: "conv", key: "web:dedicated" }, convPermission: "edit" }, adminCookie);
  assert.equal(locked.status, 400);

  // 改成专用对话后还能改回来；专用对话的不再绑这条对话
  const toDedicated = await call("PATCH", `/api/tasks/${task.id}`, { target: { kind: "dedicated" } });
  assert.equal(toDedicated.status, 200);
  assert.equal(getTask(member.id, task.id)!.target.kind, "dedicated");
  assert.equal(hub.info("web:mine")?.tasks, undefined);
  const back = await call("PATCH", `/api/tasks/${task.id}`, { target: { kind: "conv", key: "web:mine" } });
  assert.equal(back.status, 200);
  assert.deepEqual(getTask(member.id, task.id)!.target, { kind: "conv", key: "web:mine" });
  assert.equal(hub.info("web:mine")?.tasks?.[0]?.id, task.id);
  await t.test("bot 固定会话、跨用户隔离、独立任务归属和移除恢复", async () => {
    type Contact = { key: string; unavailable?: string; tasks: { id: string }[] };
    const contacts = async (cookie = memberCookie) => {
      const response = await call("GET", "/api/assistants", undefined, cookie);
      return (await response.json() as { assistants: Contact[] }).assistants;
    };
    const add = async (cookie = memberCookie) => {
      const response = await call("POST", "/api/assistants", { expert: "claude" }, cookie);
      assert.equal(response.status, 200);
      return (await response.json() as { key: string }).key;
    };
    const { sql } = await import("../src/core/db.js");
    const [key, repeated, other] = await Promise.all([add(), add(), add(adminCookie)]);
    const saved = sql("SELECT data FROM conversations WHERE key = ?").get(key) as { data: string };
    assert.equal(JSON.parse(saved.data).assistant, "active");
    assert.equal(key, repeated);
    assert.notEqual(key, other);
    assert.deepEqual((await contacts()).map((a: { key: string }) => a.key), [key]);
    assert.equal((await call("DELETE", "/api/assistants", { key }, adminCookie)).status, 404);
    const make = (source: string, target: object) => call("POST", "/api/tasks", {
      prompt: "检查", schedule, assistantKey: source, expert: "claude", target,
    });
    assert.equal((await make(other, { kind: "dedicated" })).status, 400);
    const first = await make(key, { kind: "conv", key });
    const second = await make(key, { kind: "dedicated" });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const ids = [(await first.json() as { id: string }).id, (await second.json() as { id: string }).id];
    assert.deepEqual((await contacts())[0]!.tasks.map((t: { id: string }) => t.id).sort(), ids.sort());
    assert.deepEqual((await contacts(adminCookie))[0]!.tasks, []);
    assert.equal((await call("DELETE", "/api/assistants", { key })).status, 200);
    assert.deepEqual(await contacts(), []);
    assert.equal(getConversation(key)?.hidden, undefined);
    assert.ok(getTask(member.id, ids[0]!));
    assert.equal(await add(), key);
    const { createExpert, updateExpert } = await import("../src/core/experts.js");
    const shared = createExpert(admin.id, { name: "共享专家", shared: true, access: "web", engine: "claude" });
    const createShared = (cookie: string) => call("POST", "/api/assistants", { expert: shared.id }, cookie);
    const sharedA = (await (await createShared(adminCookie)).json() as Contact).key;
    const sharedB = (await (await createShared(memberCookie)).json() as Contact).key;
    assert.ok(sharedA && sharedB && sharedA !== sharedB);
    updateExpert(admin.id, shared.id, { shared: false });
    assert.equal((await createShared(memberCookie)).status, 400);
    assert.match((await contacts()).find((a) => a.key === sharedB)!.unavailable ?? "", /撤销|删除/);
  });
  await t.test("bot 备份事件走完整 HTTP 入口，重启和投递重试只派发一次分析", async (t) => {
    const { closeDatabaseForTest, sql } = await import("../src/core/db.js");
    const { drainBotEvents, startBotEvents, stopBotEvents } = await import("../src/bot-event-runner.js");
    const { backupNow } = await import("../src/core/backup.js");
    const { incidentsFor, getWatch } = await import("../src/core/bot-events.js");
    const send = t.mock.method(hub, "send");
    const inputs: string[] = [];
    const driver = hub.driver("claude")!;
    hub.registerDriver({ ...driver, createSession: (options, events) => ({
      sessionId: options.resumeId,
      send: (input) => { inputs.push(input.text); events.onResult({ text: "检查存储空间", durationMs: 1 }); },
      interrupt: async () => {}, dispose: async () => {}, setModel: async () => {}, describeRuntime: async () => ({}),
    }) });
    t.after(() => hub.registerDriver(driver));
    const nextResult = () => new Promise<boolean>((resolve, reject) => {
      const listener = ({ ev }: EventEnvelope) => {
        if (ev.type !== "result" && ev.type !== "error") return;
        hub.off("event", listener);
        if (ev.type === "error") reject(new Error(ev.message));
        else resolve(!!ev.botAnalysis);
      };
      hub.on("event", listener);
    });
    const contactKey = async (cookie: string) => (await (await call("POST", "/api/assistants", { expert: "claude" }, cookie)).json() as { key: string }).key;
    const key = await contactKey(memberCookie);
    const adminKey = await contactKey(adminCookie);
    const root = "/api/bot-events";
    const spec = { key, name: "NAS 夜间备份", source: "webhook", destination: "web", analyze: true };
    assert.equal((await call("POST", root, { ...spec, key: adminKey })).status, 404);
    assert.equal((await call("POST", root, { ...spec, source: "backup" })).status, 403);
    assert.equal((await call("POST", root, { ...spec, destination: "feishu:other" })).status, 400);
    const created = await call("POST", root, spec);
    assert.equal(created.status, 201);
    const { id, token } = await created.json() as { id: string; token: string };
    const read = root + "?watch=" + id;
    assert.equal((await call("GET", read, undefined, adminCookie)).status, 404);
    assert.equal((await call("DELETE", root + "/" + id, undefined, adminCookie)).status, 404);
    assert.ok(!(await (await call("GET", read, undefined)).text()).includes(token));
    const hook = (payload: object, bearer = token) => fetch(base + root + "/receive", {
      method: "POST", headers: { Authorization: "Bearer " + bearer, "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const event = { status: "failed", runId: "backup-009", reason: "disk_full" };
    assert.equal((await call("POST", root + "/receive", event)).status, 401);
    assert.equal((await hook(event, "bad")).status, 401);
    assert.equal((await hook({ ...event, reason: "unsupported" })).status, 400);
    assert.equal((await hook({ ...event, runId: "large".repeat(1024) })).status, 413);
    assert.equal(getWatch(id)?.last_seen, null);
    assert.deepEqual(await (await hook({ ...event, runId: "backup-008", status: "ok" })).json(), { result: "quiet" });
    await drainBotEvents();
    assert.equal(send.mock.callCount(), 0);
    assert.equal(incidentsFor(id).length, 0);
    const receipts = await Promise.all([hook(event), hook(event)].map(async (r) => (await (await r).json() as { result: string }).result));
    assert.deepEqual(receipts.sort(), ["accepted", "duplicate"]);
    closeDatabaseForTest();
    assert.deepEqual(await (await hook(event)).json(), { result: "duplicate" });
    const automated = nextResult();
    await drainBotEvents();
    assert.equal(await automated, true);
    assert.equal(inputs.length, 1);
    assert.ok(!inputs[0]!.includes(event.runId));
    assert.equal(send.mock.callCount(), 1);
    const analysis = getConversation(incidentsFor(id)[0]!.analysis_key!)!;
    assert.equal(analysis.owner, member.id);
    assert.equal(analysis.permission, "ask");
    assert.equal(analysis.assistant, "related");
    for (let i = 0; i < 3; i++) {
      sql("UPDATE bot_incidents SET next_try=0 WHERE watch=?").run(id);
      await drainBotEvents();
    }
    const failure = incidentsFor(id)[0]!;
    assert.equal(failure.attempts, 4);
    assert.equal(failure.delivery, "failed");
    assert.equal(send.mock.callCount(), 1);
    const retry = root + "/" + id + "/retry/" + failure.id;
    assert.equal((await call("POST", retry, {}, adminCookie)).status, 404);
    assert.equal((await call("POST", retry, {})).status, 200);
    await drainBotEvents();
    assert.equal(incidentsFor(id)[0]!.attempts, 1);
    assert.equal(send.mock.callCount(), 1);
    const quiet = await call("POST", root, { ...spec, destination: "inbox", analyze: false });
    const inbox = await quiet.json() as { id: string; token: string };
    await hook(event, inbox.token);
    await drainBotEvents();
    assert.equal(incidentsFor(inbox.id)[0]!.delivery, "inbox");
    assert.equal(send.mock.callCount(), 1);
    const { FeishuBot } = await import("../src/channels/feishu/bot.js");
    const { FeishuClient } = await import("../src/channels/feishu/client.js");
    const { startFeishu, stopFeishu } = await import("../src/channels/feishu/index.js");
    const { createLinkCode, redeemLinkCode, unlink } = await import("../src/core/feishu-links.js");
    const oldConfig = structuredClone(config());
    t.mock.method(FeishuBot.prototype, "start", () => {});
    t.mock.method(FeishuBot.prototype, "stop", () => {});
    const outbound = t.mock.method(FeishuClient.prototype, "sendText", async () => "mock-message");
    const fsBot = { id: "event-test", name: "通知", enabled: true, appId: "mock", appSecret: "mock",
      domain: "feishu" as const, allowFrom: [], agents: ["claude"], defaultAgent: "claude" };
    saveConfig({ ...oldConfig, feishu: { ...oldConfig.feishu, bots: [fsBot] } });
    startFeishu();
    try {
      redeemLinkCode(createLinkCode(member.id).code, fsBot.id, "ou_member");
      const created = await call("POST", root, { ...spec, destination: "feishu:" + fsBot.id, analyze: false });
      const target = await created.json() as { id: string; token: string };
      await hook(event, target.token);
      await drainBotEvents();
      const receipt = incidentsFor(target.id)[0]!;
      assert.equal(receipt.delivery, "sent");
      assert.deepEqual(outbound.mock.calls[0]?.arguments, ["ou_member", "NAS 夜间备份 · 备份失败\n存储空间不足（backup-009）", "open_id", target.id + "-" + receipt.id]);
      await hook({ ...event, runId: "backup-010" }, target.token);
      unlink(fsBot.id, "ou_member", member.id);
      await drainBotEvents();
      assert.equal(incidentsFor(target.id)[0]!.delivery, "pending");
      assert.equal(outbound.mock.callCount(), 1);
      assert.equal(send.mock.callCount(), 1);
    } finally {
      stopFeishu();
      saveConfig(oldConfig);
    }
    await call("DELETE", "/api/assistants", { key });
    assert.equal((await hook(event)).status, 401);
    assert.deepEqual(incidentsFor(id), []);

    const local = await call("POST", root, { ...spec, key: adminKey, source: "backup", destination: "inbox", analyze: false }, adminCookie);
    assert.equal(local.status, 201);
    const localWatch = await local.json() as { id: string; token?: string };
    assert.equal(localWatch.token, undefined);
    const originalDir = process.env.AGENT_LOFT_BACKUP_DIR;
    startBotEvents();
    try {
      process.env.AGENT_LOFT_BACKUP_DIR = path.join(home, "valid-backup");
      await backupNow();
      assert.equal(getWatch(localWatch.id)?.last_status, "ok");
      const blocked = path.join(home, "not-a-directory");
      fs.writeFileSync(blocked, "");
      process.env.AGENT_LOFT_BACKUP_DIR = path.join(blocked, "backups");
      await assert.rejects(backupNow());
      assert.equal(getWatch(localWatch.id)?.last_status, "failed");
      assert.equal(incidentsFor(localWatch.id).length, 1);
      assert.equal(send.mock.callCount(), 1);
    } finally {
      stopBotEvents();
      if (originalDir === undefined) delete process.env.AGENT_LOFT_BACKUP_DIR;
      else process.env.AGENT_LOFT_BACKUP_DIR = originalDir;
    }
    assert.equal(inputs.length, 1);
    const followUp = nextResult();
    hub.send(analysis.key, { text: "接着说", attachments: [] }, { channel: "web", channelId: "web" });
    assert.equal(await followUp, false, "用户追问仍使用普通回复通知");
    await hub.drop(analysis.key, "测试结束");
  });
});
