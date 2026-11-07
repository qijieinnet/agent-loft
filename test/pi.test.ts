// pi：授权判断、会话记录的读取、用假模型（pi-ai 的 faux 服务商）跑真实的 SDK 会话。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "loft-pi-"));
process.env.AGENT_LOFT_HOME = home;
const { loadConfig } = await import("../src/core/config.js");
loadConfig();
const { SESSIONS_DIR, AUTH_FILE, setModelRuntime, splitModelKey, nodeOk } = await import("../src/agents/pi/sdk.js");
const { activeBranch, listSessionFiles, readHistoryFile, rewindParent, sessionFile, sessionTitleOf } = await import("../src/agents/pi/history.js");
const { appendPrompt, buildPrompt, gateOf, mcpServers, PiSession } = await import("../src/agents/pi/session.js");
const { PiDriver, parseJson } = await import("../src/agents/pi/driver.js");
const { diagnose } = await import("../src/agents/pi/errors.js");
const { stripContext } = await import("../src/core/expert-prompt.js");

after(() => {
  setModelRuntime(null);
  fs.rmSync(home, { recursive: true, force: true });
});

test("凭据和会话记录都在 agent-loft 的 data/pi 下", () => {
  assert.ok(SESSIONS_DIR.startsWith(path.join(home, "data", "pi")));
  assert.equal(AUTH_FILE, path.join(home, "data", "pi", "auth.json"));
  assert.deepEqual(splitModelKey("openrouter/anthropic/claude-x"), { provider: "openrouter", id: "anthropic/claude-x" });
  assert.equal(splitModelKey("nope"), null);
  assert.equal(nodeOk("22.19.0"), true);
  assert.equal(nodeOk("22.18.9"), false);
  assert.equal(nodeOk("24.0.0"), true);
});

test("授权：只读工具放行；计划模式拦改动；自动改文件只放行工作目录里的；MCP 按配置", () => {
  const base = { level: "ask" as const, plan: false, cwd: "/w/proj", uploadsDir: "/w/up", agentLoftMcp: true };
  assert.deepEqual(gateOf("read", { path: "/etc/passwd" }, base), { allow: true });
  assert.deepEqual(gateOf("bash", { command: "ls" }, base), { ask: true, sessionable: true });
  assert.deepEqual(gateOf("write", { path: "a.txt" }, base), { ask: true, sessionable: true });
  const edit = { ...base, level: "edit" as const };
  assert.deepEqual(gateOf("write", { path: "src/a.ts" }, edit), { allow: true });
  assert.deepEqual(gateOf("edit", { path: "/w/up/x.md" }, edit), { allow: true });
  assert.deepEqual(gateOf("edit", { path: "../other/x.ts" }, edit), { ask: true, sessionable: true });
  assert.deepEqual(gateOf("bash", { command: "rm -rf x" }, edit), { ask: true, sessionable: true });
  const plan = gateOf("bash", { command: "ls" }, { ...base, plan: true });
  assert.equal("allow" in plan && plan.allow, false);
  assert.deepEqual(gateOf("mcp__agent_loft_memory__remember", {}, base), { allow: true });
  const mcp = { mcp: { gh: { type: "stdio", command: "gh-mcp", args: [], env: {} }, db: { type: "stdio", command: "db", args: [], env: {} } }, askMcp: ["db"] };
  assert.deepEqual(gateOf("mcp__gh__list", {}, { ...base, mcp }), { allow: true });
  assert.deepEqual(gateOf("mcp__db__drop", {}, { ...base, mcp }), { ask: true, sessionable: false });
  assert.deepEqual(gateOf("mcp__unknown__x", {}, base), { ask: true, sessionable: true });
});

test("提示：计划模式的说明用户看不到；MCP 直接给模型；系统提示追加回复格式和记忆", () => {
  const p = buildPrompt({ text: "看看", attachments: [] }, false, true);
  assert.match(p.text, /exit_plan_mode/);
  assert.equal(stripContext(p.text), "看看");
  const servers = mcpServers({ cwd: "/w", uploadsDir: "/u", memory: { userId: "u1", prompt: "记得他叫阿杰" }, tasks: { userId: "u1", convKey: "c1" } });
  assert.deepEqual(servers.map((s) => s.name).sort(), ["agent_loft_memory", "agent_loft_skills", "agent_loft_tasks"]);
  assert.ok(servers.every((s) => s.config.exposure === "direct" && s.config.type === "stdio"));
  assert.match(appendPrompt({ cwd: "/w", uploadsDir: "/u", memory: { userId: "u1", prompt: "记得他叫阿杰" } }), /记得他叫阿杰/);
});

test("报错翻译 / 后台调用抠 JSON", () => {
  assert.equal(diagnose(new Error("401 Unauthorized: invalid api key")).kind, "auth_missing");
  assert.equal(diagnose(new Error("429 rate limit")).kind, "rate_limit");
  assert.deepEqual(parseJson('好的：\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('结果是 {"a":{"b":2}} 完毕'), { a: { b: 2 } });
});

// ---------- 会话记录 ----------

const ID = "01a1b5e8-0000-7000-8000-000000000001";
function writeSession(id: string, cwd: string, lines: unknown[]): string {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const file = path.join(SESSIONS_DIR, `2026-11-07T00-00-00-000Z_${id}.jsonl`);
  fs.writeFileSync(file, [{ type: "session", version: 3, id, timestamp: "2026-11-07T00:00:00.000Z", cwd }, ...lines].map((l) => JSON.stringify(l)).join("\n") + "\n{\"type\":");
  return file;
}
const msg = (id: string, parentId: string | null, message: unknown) => ({ type: "message", id, parentId, timestamp: "2026-11-07T00:00:01.000Z", message });

writeSession(ID, "/home/u/proj", [
  { type: "model_change", id: "m0", parentId: null, provider: "deepseek", modelId: "deepseek-chat" },
  msg("s0", "m0", { role: "system", content: "" }),
  msg("u1", "s0", { role: "user", content: "列一下文件", timestamp: 1000 }),
  msg("a1", "u1", { role: "assistant", content: [{ type: "thinking", thinking: "用 ls" }, { type: "toolCall", id: "t1", name: "ls", arguments: { path: "." } }], stopReason: "toolUse", timestamp: 1500 }),
  msg("r1", "a1", { role: "toolResult", toolCallId: "t1", toolName: "ls", content: [{ type: "text", text: "a.txt" }], isError: false }),
  msg("a2", "r1", { role: "assistant", content: [{ type: "text", text: "有 a.txt" }], stopReason: "stop", timestamp: 2000 }),
  // 废弃的分支：从 a2 接着问了一句，后来回退了
  msg("u2x", "a2", { role: "user", content: "废弃的问题" }),
  msg("a3x", "u2x", { role: "assistant", content: [{ type: "text", text: "废弃的回答" }], stopReason: "stop" }),
  // 当前分支：从 a2 重新问
  msg("u2", "a2", { role: "user", content: [{ type: "text", text: "谢谢" }], timestamp: 3000 }),
  msg("a4", "u2", { role: "assistant", content: [{ type: "text", text: "不客气" }], stopReason: "stop", timestamp: 4000 }),
  { type: "session_info", id: "i1", parentId: "a4", name: "看文件" },
]);
writeSession("01a1b5e8-0000-7000-8000-000000000002", "/tmp", [msg("x", null, { role: "user", content: "别处的会话" })]);
writeSession("01a1b5e8-0000-7000-8000-000000000003", "/tmp", [{ type: "model_change", id: "m", parentId: null }]);

test("历史：沿当前分支读，工具和思考挂成过程，废弃的分支不出现", () => {
  const h = readHistoryFile(ID);
  assert.deepEqual(h.map((m) => [m.role, m.text]), [
    ["user", "列一下文件"],
    ["assistant", "有 a.txt"],
    ["user", "谢谢"],
    ["assistant", "不客气"],
  ]);
  assert.equal(h[0]!.anchor, "u1");
  assert.equal(h[1]!.anchor, "a2");
  assert.deepEqual(h[1]!.steps, ["💭 用 ls", "🔧 ls: ."]);
  assert.equal(h[3]!.ts, 4000);
  assert.equal(activeBranch([]).length, 0);
});

test("会话列表：按目录筛，标题用会话名，没说过话的不列；id 先验形", () => {
  assert.deepEqual(listSessionFiles("/home/u/proj", 10).map((s) => [s.id, s.title]), [[ID, "看文件"]]);
  assert.equal(listSessionFiles(undefined, 10).length, 2);
  assert.equal(sessionTitleOf(ID), "看文件");
  assert.equal(sessionFile("../../etc/passwd"), undefined);
  assert.deepEqual(readHistoryFile("../x"), []);
});

test("回退：保留到指定用户消息的上一条；第一条返回 null", () => {
  assert.equal(rewindParent(ID, "u2"), "a2");
  assert.equal(rewindParent(ID, "u1"), null);
  assert.equal(rewindParent(ID, "nope"), undefined);
});

// ---------- 用假模型跑真实的 SDK 会话 ----------

test("端到端：流式回复、授权卡（拒绝写文件）、锚点、恢复、分叉", async (t) => {
  const { pi, ai } = await (await import("../src/agents/pi/sdk.js")).loadSdk().catch((err) => {
    t.skip(`pi SDK 加载不了：${err.message}`);
    return { pi: null, ai: null };
  });
  if (!pi || !ai) return;
  const rt = await pi.ModelRuntime.create({ authPath: path.join(home, "auth-test.json"), modelsPath: null, refreshOnCreate: false });
  const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "m1", reasoning: true }] });
  rt.registerNativeProvider(faux.provider);
  await rt.setRuntimeApiKey("faux", "test");
  setModelRuntime(rt);

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "loft-pi-cwd-"));
  faux.setResponses([
    ai.fauxAssistantMessage([ai.fauxThinking("先看看"), ai.fauxToolCall("bash", { command: "echo hi" })], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage([ai.fauxToolCall("write", { path: "x.txt", content: "abc" })], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage("做完了"),
    ai.fauxAssistantMessage("第二轮"),
  ]);

  const seen = { deltas: "", steps: [] as string[], results: [] as string[], errors: [] as unknown[], ids: [] as string[], anchors: [] as string[], usage: 0 };
  const asked: string[] = [];
  let resolveTurn: () => void = () => {};
  const events = {
    onStep: (_k: string, s: string) => seen.steps.push(s),
    onTextDelta: (d: string) => (seen.deltas += d),
    onText: () => {},
    onResult: (r: { text: string }) => {
      seen.results.push(r.text);
      resolveTurn();
    },
    onError: (e: unknown) => {
      seen.errors.push(e);
      resolveTurn();
    },
    onSessionId: (id: string) => seen.ids.push(id),
    onUserAnchor: (_i: unknown, a: string) => seen.anchors.push(a),
    onUsage: () => seen.usage++,
  };
  // bash 允许一次、write 拒绝
  const host = async (spec: { kind: string; title: string }) => {
    asked.push(spec.title);
    return { settlement: (spec.title.includes("write") ? "deny" : "allow-once") as never, answers: {} };
  };
  const session = new PiSession({ cwd, uploadsDir: cwd, model: "faux/m1", permission: "ask" }, events as never, host as never);
  const turn = () => new Promise<void>((r) => (resolveTurn = r));

  let done = turn();
  session.send({ text: "你好", attachments: [] });
  await done;
  assert.deepEqual(seen.errors, []);
  assert.deepEqual(seen.results, ["做完了"]);
  assert.equal(seen.deltas.includes("做完了"), true);
  assert.deepEqual(asked, ["需要授权：bash", "需要授权：write"]);
  assert.ok(seen.steps.includes("💭 先看看"));
  assert.ok(seen.steps.some((s) => s.includes("bash: echo hi")));
  assert.equal(fs.existsSync(path.join(cwd, "x.txt")), false);
  assert.ok(seen.usage > 0);
  const id = seen.ids[0]!;
  assert.ok(id && sessionFile(id));
  assert.equal((await session.describeRuntime()).model, "faux/m1");

  done = turn();
  session.send({ text: "再来", attachments: [] });
  await done;
  assert.deepEqual(seen.results, ["做完了", "第二轮"]);
  await session.dispose();

  const history = readHistoryFile(id);
  assert.deepEqual(history.filter((m) => m.role === "user").map((m) => m.text), ["你好", "再来"]);
  assert.equal(history.at(-1)!.text, "第二轮");
  assert.equal(seen.anchors.length, 2);

  // 从第一轮的回复分叉：新会话只有第一轮
  const driver = new PiDriver();
  const firstReply = history[1]!.anchor!;
  const forked = await driver.forkAt(id, cwd, firstReply);
  assert.notEqual(forked, id);
  assert.deepEqual(readHistoryFile(forked).map((m) => m.text), ["你好", "做完了"]);
  // 回退到第二条用户消息之前
  const rewound = await driver.rewindTo(id, cwd, history[2]!.anchor!);
  assert.deepEqual(readHistoryFile(rewound!).map((m) => m.text), ["你好", "做完了"]);
  assert.equal(await driver.rewindTo(id, cwd, history[0]!.anchor!), undefined);

  // 恢复原会话接着聊：上下文还在
  faux.setResponses([(ctx) => ai.fauxAssistantMessage(`记得 ${ctx.messages.filter((m: { role: string }) => m.role === "user").length} 条`)]);
  const resumed = new PiSession({ cwd, uploadsDir: cwd, model: "faux/m1", resumeId: id, permission: "full" }, events as never, host as never);
  done = turn();
  resumed.send({ text: "还记得吗", attachments: [] });
  await done;
  assert.equal(seen.results.at(-1), "记得 3 条");
  await resumed.dispose();
  fs.rmSync(cwd, { recursive: true, force: true });
});

// ---------- 第二期：自定义服务商、订阅账号登录、自定义专家 ----------

const { escapeConfigValue, listCustom, saveCustom, deleteCustom, discoverModels } = await import("../src/agents/pi/custom.js");
const { startOAuth, oauthState, answerOAuth, resetOAuth } = await import("../src/agents/pi/oauth.js");
const { MODELS_FILE, listProviders } = await import("../src/agents/pi/sdk.js");
const { promptParts, toolsFor } = await import("../src/agents/pi/session.js");

test("Key 按字面值写进 models.json：$ 不当环境变量、开头的 ! 不当命令", () => {
  assert.equal(escapeConfigValue("sk-abc"), "sk-abc");
  assert.equal(escapeConfigValue("a$HOME"), "a$$HOME");
  assert.equal(escapeConfigValue("!rm -rf /"), "$!rm -rf /");
  assert.equal(escapeConfigValue("$!x"), "$$!x");
});

test("专家的工具按文件权限给；提示词「只用专家的」换掉 pi 原装开头", () => {
  assert.deepEqual(toolsFor("web"), ["ask_user", "exit_plan_mode", "mcp__*"]);
  assert.deepEqual(toolsFor("read"), ["read", "grep", "find", "ls", "ask_user", "exit_plan_mode", "mcp__*"]);
  assert.ok(toolsFor("edit").includes("write") && !toolsFor("edit").includes("bash"));
  assert.ok(toolsFor(undefined).includes("bash"));
  const expert = { id: "e1", rev: 1, name: "周报助手", prompt: "只写周报", basePrompt: "lean", access: "read", webSearch: false, webFetch: false, skills: [], mcp: {}, askMcp: [], machineMcp: [], subagents: [], memory: true } as never;
  const lean = promptParts({ cwd: "/w", uploadsDir: "/u", expert, memory: { userId: "u", prompt: "他叫阿杰" } });
  assert.match(lean.system!, /周报助手/);
  assert.match(lean.system!, /只写周报/);
  assert.match(lean.system!, /他叫阿杰/);
  assert.match(lean.system!, /你不能联网/);
  const append = promptParts({ cwd: "/w", uploadsDir: "/u", expert: { ...(expert as object), basePrompt: "claude_code" } as never });
  assert.equal(append.system, undefined);
  assert.match(append.append, /周报助手/);
});

test("自定义服务商：存、列、能用、问服务要模型、删；内置的 id 不能占", async (t) => {
  const { pi, ai } = await (await import("../src/agents/pi/sdk.js")).loadSdk().catch(() => ({ pi: null, ai: null }));
  if (!pi || !ai) return t.skip("pi SDK 加载不了");
  const rt = await pi.ModelRuntime.create({ authPath: path.join(home, "auth-custom.json"), modelsPath: MODELS_FILE, refreshOnCreate: false });
  setModelRuntime(rt);
  await assert.rejects(saveCustom({ id: "deepseek", baseUrl: "http://x/v1", api: "openai-completions", models: [{ id: "m" }] }), /内置/);
  await assert.rejects(saveCustom({ id: "local", baseUrl: "ftp://x", api: "openai-completions", models: [{ id: "m" }] }), /http/);
  await saveCustom({ id: "local", name: "本地", baseUrl: "http://127.0.0.1:9/v1/", api: "openai-completions", apiKey: "", models: [{ id: "qwen2.5-coder:7b", reasoning: true, image: true, contextWindow: 32768 } as never] });
  assert.deepEqual(listCustom().map((p) => [p.id, p.name, p.baseUrl, p.hasKey, p.models[0]]), [["local", "本地", "http://127.0.0.1:9/v1", false, { id: "qwen2.5-coder:7b", reasoning: true, input: ["text", "image"], contextWindow: 32768 }]]);
  assert.equal((fs.statSync(MODELS_FILE).mode & 0o777).toString(8), "600");
  const available = (await rt.getAvailable()).map((m) => `${m.provider}/${m.id}`);
  assert.ok(available.includes("local/qwen2.5-coder:7b"), available.join(","));
  assert.ok((await listProviders()).find((p) => p.id === "local")?.custom);
  // 编辑时不填 Key = 沿用；填了就按字面值存
  await saveCustom({ id: "local", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "$SECRET", models: [{ id: "a" }] });
  assert.equal(JSON.parse(fs.readFileSync(MODELS_FILE, "utf8")).providers.local.apiKey, "$$SECRET");
  await saveCustom({ id: "local", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "a" }] });
  assert.equal(listCustom()[0]!.hasKey, true);

  const http = await import("node:http");
  let auth = "";
  const server = http.createServer((req, res) => {
    auth = String(req.headers.authorization ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "m-a" }, { id: "m-b" }, { id: "m-a" }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    assert.deepEqual(await discoverModels(`http://127.0.0.1:${port}/v1`, "openai-completions", undefined, "local"), ["m-a", "m-b"]);
    assert.equal(auth, "Bearer $SECRET");
  } finally {
    server.close();
  }

  await deleteCustom("local");
  assert.deepEqual(listCustom(), []);
  assert.ok(!(await rt.getAvailable()).some((m) => m.provider === "local"));
});

test("订阅账号登录：设备码、选登录方式、粘贴回调地址，登完凭据落盘", async (t) => {
  const { pi, ai } = await (await import("../src/agents/pi/sdk.js")).loadSdk().catch(() => ({ pi: null, ai: null }));
  if (!pi || !ai) return t.skip("pi SDK 加载不了");
  const authPath = path.join(home, "auth-oauth.json");
  const rt = await pi.ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
  const base = ai.fauxProvider({ provider: "fake-sub", models: [{ id: "m" }] }).provider;
  let deviceId = "";
  const provider = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    auth: {
      oauth: {
        name: "Fake (Pro)",
        isSubscription: true,
        login: async (ia: { notify: (e: unknown) => void; prompt: (p: unknown) => Promise<string> }, opts?: { getDeviceId?: () => string }) => {
          deviceId = opts?.getDeviceId?.() ?? "";
          ia.notify({ type: "device_code", userCode: "AB-CD", verificationUri: "https://example.com/device" });
          ia.notify({ type: "auth_url", url: "javascript:alert(1)" });
          const how = await ia.prompt({ type: "select", message: "怎么登录", options: [{ id: "browser", label: "浏览器" }, { id: "code", label: "设备码" }] });
          const code = await ia.prompt({ type: "manual_code", message: "粘贴回调地址" });
          return { type: "oauth", access: `${how}:${code}`, refresh: "r", expires: Date.now() + 3600_000 };
        },
        refresh: async (c: unknown) => c,
        toAuth: async (c: { access: string }) => ({ apiKey: c.access }),
      },
    },
  });
  rt.registerNativeProvider(provider);
  setModelRuntime(rt);
  const view = (await listProviders()).find((p) => p.id === "fake-sub");
  assert.equal(view?.oauth, "Fake (Pro)");
  assert.equal(view?.subscription, true);

  await startOAuth("fake-sub");
  const waitFor = async (pred: () => boolean) => {
    for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(pred());
  };
  await waitFor(() => oauthState()?.prompt?.type === "select");
  const st = oauthState()!;
  // 不是 http(s) 的链接不给网页
  assert.deepEqual(st.notices, [{ type: "device_code", userCode: "AB-CD", verificationUri: "https://example.com/device" }]);
  assert.throws(() => answerOAuth(st.prompt!.id, "nope"), /选项/);
  assert.throws(() => answerOAuth("stale", "code"), /过期/);
  answerOAuth(st.prompt!.id, "code");
  await waitFor(() => oauthState()?.prompt?.type === "manual_code");
  answerOAuth(oauthState()!.prompt!.id, "http://localhost/cb?code=xyz");
  await waitFor(() => oauthState()?.status === "done");
  assert.match(deviceId, /^[0-9a-f-]{36}$/);
  const saved = JSON.parse(fs.readFileSync(authPath, "utf8"))["fake-sub"];
  assert.equal(saved.type, "oauth");
  assert.equal(saved.access, "code:http://localhost/cb?code=xyz");
  assert.equal((await listProviders()).find((p) => p.id === "fake-sub")?.stored, "oauth");

  // 取消：状态变成 cancelled，等着的问题作废
  await startOAuth("fake-sub");
  await waitFor(() => !!oauthState()?.prompt);
  resetOAuth();
  assert.equal(oauthState(), null);
});

test("自定义专家跑真实会话：只给读文件的工具，提示词是专家的", async (t) => {
  const { pi, ai } = await (await import("../src/agents/pi/sdk.js")).loadSdk().catch(() => ({ pi: null, ai: null }));
  if (!pi || !ai) return t.skip("pi SDK 加载不了");
  const rt = await pi.ModelRuntime.create({ authPath: path.join(home, "auth-expert.json"), modelsPath: null, refreshOnCreate: false });
  const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "m1" }] });
  rt.registerNativeProvider(faux.provider);
  await rt.setRuntimeApiKey("faux", "test");
  setModelRuntime(rt);
  let system = "";
  faux.setResponses([
    (ctx) => {
      system = JSON.stringify(ctx);
      return ai.fauxAssistantMessage([ai.fauxToolCall("bash", { command: "rm -rf /" })], { stopReason: "toolUse" });
    },
    ai.fauxAssistantMessage("只能看不能改"),
  ]);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "loft-pi-expert-"));
  const expert = { id: "e1", rev: 1, name: "代码审查员", prompt: "只提意见，不动手", basePrompt: "lean", access: "read", webSearch: false, webFetch: false, skills: [], mcp: {}, askMcp: [], machineMcp: [], subagents: [], memory: false };
  let done: () => void = () => {};
  const results: string[] = [];
  const asked: string[] = [];
  const session = new PiSession(
    { cwd, uploadsDir: cwd, model: "faux/m1", permission: "full", expert: expert as never },
    { onStep() {}, onTextDelta() {}, onText() {}, onResult: (r: { text: string }) => (results.push(r.text), done()), onError: (e: unknown) => (results.push(`ERR ${e}`), done()), onSessionId() {} } as never,
    (async (spec: { title: string }) => (asked.push(spec.title), { settlement: "allow-once", answers: {} })) as never,
  );
  const turn = new Promise<void>((r) => (done = r));
  session.send({ text: "看看", attachments: [] });
  await turn;
  const declared = (session as unknown as { session: { getActiveToolNames(): string[] } }).session.getActiveToolNames();
  await session.dispose();
  fs.rmSync(cwd, { recursive: true, force: true });
  assert.deepEqual(results, ["只能看不能改"]);
  // 没有 bash 这个工具：调不了，也不会弹授权卡
  assert.deepEqual(asked, []);
  assert.match(system, /代码审查员/);
  assert.doesNotMatch(system, /You are a coding assistant running inside pi/);
  assert.deepEqual(declared, ["read", "grep", "find", "ls", "ask_user"]);
});
