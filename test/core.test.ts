import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_IM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aim-core-"));
// 待处理项的计时器是 unref 的（不该把进程钉住），测试里得自己保持事件循环
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));
const { interactions, answerTextOf } = await import("../src/core/interactions.js");
const { parseCommand } = await import("../src/core/commands.js");
const { agentEnvironment } = await import("../src/core/agent-env.js");
const { decodeEnvelope, createEnvelope } = await import("../src/channels/feishu/envelope.js");

const question = (multi: boolean) => ({
  kind: "question" as const,
  title: "t",
  questions: [
    { id: "a", header: "A", question: "选A", options: [{ label: "x" }, { label: "y" }], multiSelect: multi, allowOther: true },
  ],
});

test("超时按拒绝收束，绝不放行", async () => {
  const outcome = await interactions.create("k1", { kind: "approval", title: "t", detail: "d" }, 30);
  assert.equal(outcome.settlement, "timeout");
});

test("单选答完自动收束；多选要提交，设成语义重投不变", async () => {
  const single = interactions.create("k2", question(false), 60_000);
  const id1 = interactions.listPending("k2")[0]!.id;
  assert.equal(interactions.select(id1, 0, 1, true, "me")?.submitted, true);
  assert.deepEqual((await single).answers, { a: ["y"] });

  const multi = interactions.create("k3", question(true), 60_000);
  const id2 = interactions.listPending("k3")[0]!.id;
  interactions.select(id2, 0, 0, true, "me");
  interactions.select(id2, 0, 0, true, "me"); // 重投
  interactions.select(id2, 0, 1, true, "me");
  const view = interactions.submit(id2, "me");
  assert.ok(view && !("missing" in view));
  assert.deepEqual((await multi).answers, { a: ["x", "y"] });
  assert.deepEqual(answerTextOf(view as never), { 选A: "x, y" });
});

test("取消会话：挂着的全部收束为 cancelled", async () => {
  const p = interactions.create("k4", { kind: "approval", title: "t", detail: "d" }, 60_000);
  assert.equal(interactions.cancelAll("k4", "新会话").length, 1);
  assert.equal((await p).settlement, "cancelled");
  assert.equal(interactions.decide(interactions.get("x")?.id ?? "x", "allow-once", "me"), undefined);
});

test("命令解析：整条才算命令，参数不对退化为聊天", () => {
  assert.deepEqual(parseCommand("/new"), { kind: "new" });
  assert.deepEqual(parseCommand("/agent codex"), { kind: "agent", agent: "codex" });
  assert.deepEqual(parseCommand("/claude"), { kind: "agent", agent: "claude" });
  assert.equal(parseCommand("/claude 帮我看下").kind, "chat");
  assert.equal(parseCommand("/resume").kind, "chat");
  assert.equal(parseCommand("/new\n第二行").kind, "chat");
  assert.deepEqual(parseCommand("/sessions all"), { kind: "sessions", all: true });
  assert.equal(parseCommand("/approve req_1 maybe").kind, "chat");
  // 不认识的命令原样交给 agent（它们自己也有斜杠命令）
  assert.equal(parseCommand("/compact").kind, "chat");
});

test("agent 子进程拿不到我们自己的凭据", () => {
  const env = agentEnvironment({ FEISHU_APP_SECRET: "x", AGENT_IM_HOME: "y", PATH: "/bin", HOME: "/h" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h" });
});

test("卡片信封：过期、换人、换会话都被拒；不指定人时任何授权用户可点", () => {
  const ctx = { operatorOpenId: "ou_a", chatId: "oc_1", expiresAt: Date.now() + 1000 };
  const env = createEnvelope({ a: "approval", r: "req_1", d: "allow-once" }, ctx);
  const allow = () => true;
  assert.equal(decodeEnvelope({ value: env, operatorOpenId: "ou_a", chatId: "oc_1", isAllowed: allow }).ok, true);
  assert.deepEqual(decodeEnvelope({ value: env, operatorOpenId: "ou_b", chatId: "oc_1", isAllowed: allow }), { ok: false, reason: "wrong_user" });
  assert.deepEqual(decodeEnvelope({ value: env, operatorOpenId: "ou_a", chatId: "oc_2", isAllowed: allow }), { ok: false, reason: "wrong_conversation" });
  assert.deepEqual(decodeEnvelope({ value: env, operatorOpenId: "ou_a", chatId: "oc_1", isAllowed: allow, now: Date.now() + 5000 }), { ok: false, reason: "stale" });
  const open = createEnvelope({ a: "approval", r: "req_1", d: "deny" }, { chatId: "oc_1", expiresAt: Date.now() + 1000 });
  assert.equal(decodeEnvelope({ value: open, operatorOpenId: "ou_b", chatId: "oc_1", isAllowed: allow }).ok, true);
  assert.deepEqual(decodeEnvelope({ value: open, operatorOpenId: "ou_b", chatId: "oc_1", isAllowed: () => false }), { ok: false, reason: "not_allowed" });
});

test("Claude 总是允许：复合命令、包装命令拿不到首词签名", async () => {
  const { signatureOf, rememberAlways, isPreApproved } = await import("../src/agents/claude/permissions.js");
  const sig = (command: string) => signatureOf("Bash", { command });
  assert.equal(sig("git status"), "Bash:git status");
  assert.equal(sig("ls -la"), "Bash:ls");
  rememberAlways("Bash:git status");
  rememberAlways("Bash:ls");
  assert.equal(isPreApproved("Bash", sig("git status -s")), true);
  assert.equal(isPreApproved("Bash", sig("git push --force")), false);
  assert.equal(sig("rg foo"), "BashExact:rg foo");
  assert.equal(isPreApproved("Bash", sig("ls /etc")), true);
  // 不在白名单里的命令只能完整匹配：批准过 npm --version 不等于批准 npm exec
  assert.equal(sig("npm --version"), "BashExact:npm --version");
  rememberAlways(sig("npm --version"));
  assert.equal(isPreApproved("Bash", sig("npm --version")), true);
  for (const bad of ["git diff '--output=/x'", 'git diff "--output=/x"', "git diff --outp=/x", "git log --ou=/x", "date --se=2020", "ls *", "cat ~/.ssh/id_rsa", "rg --pre=sh xyz payload", "sort -o /important /dev/null", "git diff --output=/important", "git diff --ext-diff", "git push", "date -s 2020-01-01", "hostname evil", "npm exec -- node -e 1", "python3.12 -c 'import os'", "git -c core.pager=sh status", "git status; rm -rf ~", "ls && curl x|sh", "ls $(rm -rf /)", "ls `id`", "ls > /etc/x", "sudo ls", "bash -c 'ls'", "X=1 ls", "ls\nrm -rf ~"]) {
    assert.ok(sig(bad).startsWith("BashExact:"), bad);
    assert.equal(isPreApproved("Bash", sig(bad)), false, bad);
  }
});

test("多问题时用消息作答：答完一问不提前交卷", async () => {
  const p = interactions.create("k5", {
    kind: "question",
    title: "t",
    questions: [
      { id: "a", header: "A", question: "一", options: [{ label: "x" }], multiSelect: false, allowOther: true },
      { id: "b", header: "B", question: "二", options: [{ label: "y" }], multiSelect: false, allowOther: true },
    ],
  }, 60_000);
  const id = interactions.listPending("k5")[0]!.id;
  assert.equal(interactions.answerWithText(id, "第一", "me"), true);
  assert.ok(interactions.isPending(id));
  assert.equal(interactions.answerWithText(id, "第二", "me"), true);
  assert.deepEqual((await p).answers, { a: ["第一"], b: ["第二"] });
});

test("思考程度按钮：取值不被过期时间覆盖", () => {
  const env = createEnvelope({ a: "effort", f: "high", k: "key" }, { expiresAt: Date.now() + 1000 });
  const decoded = decodeEnvelope({ value: env, operatorOpenId: "ou_a", chatId: undefined, isAllowed: () => true });
  assert.ok(decoded.ok && decoded.envelope.a === "effort" && decoded.envelope.f === "high");
  // 字段类型不对的一律当损坏
  const bad = { ...env, f: 123 };
  assert.deepEqual(decodeEnvelope({ value: bad, operatorOpenId: "ou_a", chatId: undefined, isAllowed: () => true }), { ok: false, reason: "malformed" });
});

test("/cd 不能经符号链接跳出工作区，也不能进不存在的目录", async () => {
  const { loadConfig, saveConfig, config, resolveWorkspacePath } = await import("../src/core/config.js");
  loadConfig();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aim-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "aim-out-"));
  fs.mkdirSync(path.join(root, "sub"));
  fs.symlinkSync(outside, path.join(root, "escape"));
  saveConfig({ ...structuredClone(config()), workspaceRoot: root });
  assert.equal(resolveWorkspacePath("sub"), path.join(root, "sub"));
  assert.equal(resolveWorkspacePath("escape"), null);
  assert.equal(resolveWorkspacePath("nope"), null);
  assert.equal(resolveWorkspacePath("../"), null);
});

test("事件补发：缓冲区截断过就要求整页重拉，即使之后压缩变短", async () => {
  const { hub } = await import("../src/core/hub.js");
  const key = "k-buffer";
  hub.emitEvent(key, { type: "turn_start" });
  const since = hub.currentSeq();
  for (let i = 0; i < 450; i++) hub.emitEvent(key, { type: "delta", text: "x" });
  hub.emitEvent(key, { type: "result", text: "done", footer: "" });
  assert.equal(hub.eventsSince(key, since), null);
  assert.ok(hub.eventsSince(key, hub.currentSeq() - 1));
});

test("hub：停止会作废还在排队的消息；闲置过期按说话之前的时间判断", async () => {
  const { hub } = await import("../src/core/hub.js");
  const { updateConversation } = await import("../src/core/store.js");
  const sent: string[] = [];
  let releaseDispose!: () => void;
  const slowDispose = new Promise<void>((r) => (releaseDispose = r));
  let sessions = 0;
  hub.registerDriver({
    id: "claude",
    label: "Fake",
    capabilities: { effort: false, fork: false, cost: false, streaming: false },
    start: async () => {},
    stop: async () => {},
    createSession: (opts, events) => {
      sessions += 1;
      return {
        sessionId: undefined,
        send: (input) => {
          sent.push(`${opts.resumeId ?? "new"}:${input.text}`);
          events.onSessionId("s-1");
        },
        interrupt: async () => {},
        setModel: async () => {},
        describeRuntime: async () => ({}),
        dispose: () => slowDispose,
      };
    },
    listSessions: async () => [],
    sessionExists: async () => true,
    readHistory: async () => [],
    listModels: async () => [],
    defaults: async () => ({}),
    statusLines: async () => [],
    diagnose: () => ({ kind: "x", chatMessage: "x", consoleHint: "" }),
  });
  const key = "web:hubtest";
  hub.ensure({ key, channel: "web", channelId: "web", defaultAgent: "claude" });
  const origin = { channel: "web", channelId: "web" };
  hub.send(key, { text: "第一条", attachments: [] }, origin);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, ["new:第一条"]);

  // /new 正在等旧会话 dispose（卡住），这期间发的消息排队；点停止后它不该再发出去
  const pendingNew = hub.newSession(key);
  hub.send(key, { text: "排队的", attachments: [] }, origin);
  await hub.stop(key);
  releaseDispose();
  await pendingNew;
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, ["new:第一条"]);

  // 没过期：沿用活着的会话，不新建
  hub.send(key, { text: "续用", attachments: [] }, origin);
  await new Promise((r) => setTimeout(r, 20));
  const before = sessions;
  hub.send(key, { text: "再来", attachments: [] }, origin);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sessions, before);
  // 闲置过期：上次活跃时间很早，这次说话要丢掉活着的会话、清掉 s-1，开新的
  updateConversation(key, { activeAt: Date.now() - 365 * 24 * 3600 * 1000 });
  hub.send(key, { text: "过期后", attachments: [] }, origin);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sessions, before + 1);
  assert.equal(sent.at(-1), "new:过期后");

  // 过期清理不删上传目录：本次和排在后面的消息的附件都还在
  const { saveBuffer } = await import("../src/core/uploads.js");
  const fresh = saveBuffer({ key, data: Buffer.from("new"), name: "new.txt" });
  const later = saveBuffer({ key, data: Buffer.from("later"), name: "later.txt" });
  updateConversation(key, { activeAt: Date.now() - 365 * 24 * 3600 * 1000 });
  hub.send(key, { text: "带附件", attachments: [fresh] }, origin);
  hub.send(key, { text: "排在后面", attachments: [later] }, origin);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.existsSync(fresh.path), true);
  assert.equal(fs.existsSync(later.path), true);

  // 停止之前收到的旧消息，不能回答停止之后的新提问
  const staleGen = hub.stopGeneration(key);
  await hub.stop(key);
  const question = interactions.create(key, {
    kind: "question",
    title: "t",
    questions: [{ id: "q", header: "Q", question: "?", options: [{ label: "a" }], multiSelect: false, allowOther: true }],
  }, 60_000);
  hub.send(key, { text: "旧文字", attachments: [] }, origin, staleGen);
  const qid = interactions.listPending(key)[0]!.id;
  assert.ok(interactions.isPending(qid));
  interactions.skip(qid, "test");
  await question;

  // 渠道带着收到时的代次来：中途点过停止就不发
  const gen = hub.stopGeneration(key);
  await hub.stop(key);
  const n = sent.length;
  hub.send(key, { text: "下载附件期间被停止", attachments: [] }, origin, gen);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, n);
});

test("登录限流：同一 IP 的额度同步扣减，并发请求也绕不过", async () => {
  const { takeAttempt, clearAttempts } = await import("../src/channels/web/auth.js");
  const results = Array.from({ length: 40 }, () => takeAttempt("9.9.9.9"));
  assert.equal(results.filter((r) => r === 0).length, 5);
  clearAttempts("9.9.9.9");
  assert.equal(takeAttempt("9.9.9.9"), 0);
});

test("NotebookEdit 按 notebook_path 的目录记，拿不到路径不给总是允许", async () => {
  const { signatureOf, isRememberableSignature, rememberAlways, isPreApproved } = await import("../src/agents/claude/permissions.js");
  const a = signatureOf("NotebookEdit", { notebook_path: "/proj/allowed/a.ipynb" });
  const b = signatureOf("NotebookEdit", { notebook_path: "/proj/protected/b.ipynb" });
  assert.equal(a, "NotebookEdit:/proj/allowed");
  assert.notEqual(a, b);
  rememberAlways(a);
  assert.equal(isPreApproved("NotebookEdit", b), false);
  const none = signatureOf("NotebookEdit", {});
  assert.equal(isRememberableSignature("NotebookEdit", none), false);
  rememberAlways("NotebookEdit:.");
  assert.equal(isPreApproved("NotebookEdit", "NotebookEdit:."), false);
});
