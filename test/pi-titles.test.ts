// Pi 标题：真实 SDK + 假模型，不联网、不消耗真实 token。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEvents, CompleteRequest } from "../src/core/types.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "loft-pi-titles-"));
process.env.AGENT_LOFT_HOME = home;
const { config, loadConfig, saveConfig } = await import("../src/core/config.js");
loadConfig();
const { PiDriver } = await import("../src/agents/pi/driver.js");
const { loadSdk, setModelRuntime, SESSIONS_DIR } = await import("../src/agents/pi/sdk.js");
const { sessionFile, sessionTitleOf, readHistoryFile, readEntries, activeBranch } = await import("../src/agents/pi/history.js");
const { wrapContext } = await import("../src/core/expert-prompt.js");
const { pi, ai } = await loadSdk();
const rt = await pi.ModelRuntime.create({ authPath: path.join(home, "auth.json"), modelsPath: null, refreshOnCreate: false });
const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "chat" }, { id: "title" }] });
rt.registerNativeProvider(faux.provider);
await rt.setRuntimeApiKey("faux", "test");
setModelRuntime(rt);
const cwd = path.join(home, "workspace");
fs.mkdirSync(cwd);
after(() => { setModelRuntime(null); fs.rmSync(home, { recursive: true, force: true }); });

function chat(driver: InstanceType<typeof PiDriver>, resumeId?: string) {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const session = driver.createSession({ cwd, uploadsDir: cwd, model: "faux/chat", resumeId, permission: "full" }, {
    onSessionId() {}, onStep() {}, onTextDelta() {}, onText() {},
    onResult: () => resolve(), onError: (err) => reject(err),
  } as AgentEvents, async () => ({ settlement: "deny", answers: {} }));
  return {
    session,
    async send(text: string) {
      const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      session.send({ text, attachments: [] });
      await done;
      return session.sessionId!;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function setTitles(autoTitle: boolean, titleModel = "") {
  const cfg = config();
  saveConfig({ ...cfg, agents: { ...cfg.agents, pi: { ...cfg.agents.pi, autoTitle, titleModel } } });
}

function enable(titleModel = "") { setTitles(true, titleModel); }

test("旧配置默认启用 Pi 命名；可关闭并保存专用模型", () => {
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ agents: { pi: { enabled: true, defaultModel: "faux/title", models: [] } } }));
  loadConfig();
  assert.equal(config().agents.pi.autoTitle, true);
  setTitles(false, "faux/title");
  loadConfig();
  assert.equal(config().agents.pi.autoTitle, false);
  assert.equal(config().agents.pi.titleModel, "faux/title");
  enable();
});

test("真实 SDK 后台命名：合并并发请求、默认跟随会话模型、持久保存、续聊及分叉不丢消息", async (t) => {
  enable();
  const driver = new PiDriver();
  const c = chat(driver);
  t.after(() => c.session.dispose());
  let titles = 0;
  faux.setResponses([
    ai.fauxAssistantMessage("检查存储池和磁盘"),
    (ctx, _options, _state, model) => {
      titles++;
      assert.equal(model.id, "chat", "跟随会话实际模型，而非全局默认模型");
      assert.match(JSON.stringify(ctx.messages), /检查 NAS/);
      assert.doesNotMatch(JSON.stringify(ctx.messages), /不应发送的背景/);
      return ai.fauxAssistantMessage('{"title":"  “检查NAS存储”。  "}');
    },
    ai.fauxAssistantMessage("后续回答"),
  ]);
  const id = await c.send(`检查 NAS\n\n${wrapContext(["不应发送的背景"])}`);
  const files = fs.readdirSync(SESSIONS_DIR).length;
  assert.deepEqual(await Promise.all([driver.sessionTitle(id), driver.sessionTitle(id), driver.sessionTitle(id)]), ["检查NAS存储", "检查NAS存储", "检查NAS存储"]);
  assert.equal(titles, 1);
  assert.equal(sessionTitleOf(id), "检查NAS存储");
  assert.equal((await driver.listSessions(cwd, 100)).find((s) => s.id === id)?.title, "检查NAS存储");
  assert.equal(fs.readdirSync(SESSIONS_DIR).length, files, "后台调用不另建会话");
  await c.send("继续检查");
  const history = readHistoryFile(id);
  assert.deepEqual(history.map((m) => m.text), ["检查 NAS", "检查存储池和磁盘", "继续检查", "后续回答"]);
  const fork = await driver.forkAt(id, cwd);
  assert.equal(sessionTitleOf(fork), "检查NAS存储", "分叉能继承活实例里的标题");
  assert.deepEqual(readHistoryFile(fork).map((m) => m.text), history.map((m) => m.text));
  await c.session.dispose();
  const restarted = new PiDriver();
  restarted.complete = async () => { throw new Error("已有标题不该再调模型"); };
  assert.equal(await restarted.sessionTitle(id), "检查NAS存储");
});

test("命名只取第一轮问答，清除背景；专用模型优先于会话模型", async (t) => {
  enable("faux/title");
  const driver = new PiDriver();
  const c = chat(driver);
  t.after(() => c.session.dispose());
  faux.setResponses([ai.fauxAssistantMessage("第一轮回答"), ai.fauxAssistantMessage("第二轮回答")]);
  const id = await c.send(`第一轮问题\n\n${wrapContext(["隐藏背景"])}`);
  await c.send("第二轮问题");
  let request: CompleteRequest | undefined;
  driver.complete = async (req) => { request = req; return { title: "第一轮总结" }; };
  assert.equal(await driver.sessionTitle(id), "第一轮总结");
  assert.equal(request?.model, "faux/title");
  assert.match(request!.prompt, /第一轮问题/);
  assert.match(request!.prompt, /第一轮回答/);
  assert.doesNotMatch(request!.prompt, /第二轮|隐藏背景/);
});

for (const mode of ["live", "closed", "resumed"] as const) {
  test(`生成期间续聊 / 释放 / 恢复（${mode}）：标题接在最新 leaf，不切走后续分支`, async (t) => {
    enable();
    const driver = new PiDriver();
    const c = chat(driver);
    t.after(() => c.session.dispose());
    faux.setResponses([ai.fauxAssistantMessage("第一轮"), ai.fauxAssistantMessage("第二轮")]);
    const id = await c.send("问题一");
    const started = deferred<void>();
    const result = deferred<{ title: string }>();
    driver.complete = async () => { started.resolve(); return result.promise; };
    const title = driver.sessionTitle(id);
    await started.promise;
    let current = c;
    if (mode !== "live") await c.session.dispose();
    if (mode === "resumed") {
      current = chat(driver, id);
      t.after(() => current.session.dispose());
    }
    if (mode !== "closed") await current.send("问题二");
    result.resolve({ title: "两轮检查" });
    assert.equal(await title, "两轮检查");
    const entries = readEntries(sessionFile(id)!);
    const branch = activeBranch(entries);
    assert.equal(branch.at(-1)?.type, "session_info");
    assert.deepEqual(readHistoryFile(id).map((m) => m.text), mode === "closed" ? ["问题一", "第一轮"] : ["问题一", "第一轮", "问题二", "第二轮"]);
    if (mode !== "closed") {
      const fork = await driver.forkAt(id, cwd);
      assert.equal(sessionTitleOf(fork), "两轮检查");
    }
  });
}

test("关闭命名、已有名称、无效 id、空会话不调用模型；空会话之后仍可命名", async () => {
  enable();
  const driver = new PiDriver();
  let calls = 0;
  driver.complete = async () => { calls++; return { title: "空会话的第一问" }; };
  assert.equal(await driver.sessionTitle("../../bad"), undefined);
  const sm = pi.SessionManager.create(cwd, SESSIONS_DIR);
  // 仅 setup 不落盘，模拟尚未提交问题的会话。
  assert.equal(await driver.sessionTitle(sm.getSessionId()), undefined);
  sm.appendMessage({ role: "user", content: "第一问", timestamp: Date.now() });
  setTitles(false);
  assert.equal(await driver.sessionTitle(sm.getSessionId()), undefined);
  assert.equal(calls, 0);
  enable();
  assert.equal(await driver.sessionTitle(sm.getSessionId()), "空会话的第一问");
  assert.equal(calls, 1);
  sm.setSessionFile(sm.getSessionFile()!);
  sm.appendSessionInfo("手动名称");
  assert.equal(await driver.sessionTitle(sm.getSessionId()), "手动名称");
  assert.equal(calls, 1);
});

for (const action of ["rename", "delete", "disable"] as const) {
  test(`命名期间 ${action}：不覆盖新名称、不复活已删记录、关闭设置立即生效`, async () => {
    enable();
    const driver = new PiDriver();
    const sm = pi.SessionManager.create(cwd, SESSIONS_DIR);
    sm.appendMessage({ role: "user", content: "测试问题", timestamp: Date.now() });
    const started = deferred<void>();
    const result = deferred<{ title: string }>();
    driver.complete = async () => { started.resolve(); return result.promise; };
    const title = driver.sessionTitle(sm.getSessionId());
    await started.promise;
    if (action === "rename") sm.appendSessionInfo("我起的名称");
    if (action === "delete") fs.unlinkSync(sm.getSessionFile()!);
    if (action === "disable") setTitles(false);
    result.resolve({ title: "迟到的自动名称" });
    assert.equal(await title, action === "rename" ? "我起的名称" : undefined);
    assert.equal(sessionTitleOf(sm.getSessionId()), action === "rename" ? "我起的名称" : undefined);
    if (action === "delete") assert.equal(fs.existsSync(sm.getSessionFile()!), false);
  });
}

test("后台失败或空 / 非字符串标题：不影响聊天，不反复调用", async () => {
  enable();
  for (const output of [undefined, { title: "  " }, { title: {} }]) {
    const driver = new PiDriver();
    const sm = pi.SessionManager.create(cwd, SESSIONS_DIR);
    sm.appendMessage({ role: "user", content: "测试问题", timestamp: Date.now() });
    let calls = 0;
    driver.complete = async () => { calls++; if (!output) throw new Error("模拟超时"); return output; };
    assert.equal(await driver.sessionTitle(sm.getSessionId()), undefined);
    assert.equal(await driver.sessionTitle(sm.getSessionId()), undefined);
    assert.equal(calls, 1);
    assert.equal(sessionTitleOf(sm.getSessionId()), undefined);
  }
});
