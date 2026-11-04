import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

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
});
