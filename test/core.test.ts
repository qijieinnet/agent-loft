import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.IM_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aim-core-"));
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

test("本会话全部允许：一并放行同一会话进程里挂着的同类卡，别的不动", async () => {
  const approval = (allowSession: boolean) => ({ kind: "approval" as const, title: "t", detail: "d", allowSession });
  const a = interactions.create("k5", approval(true), 60_000, 1);
  const b = interactions.create("k5", approval(true), 60_000, 1);
  const plan = interactions.create("k5", approval(false), 60_000, 1);
  const oldProc = interactions.create("k5", approval(true), 60_000, 0);
  const otherConv = interactions.create("k6", approval(true), 60_000, 1);
  const [ida, , idPlan] = interactions.listPending("k5").map((i) => i.id);

  // 卡上没这个按钮：手打 /approve 也不认
  assert.equal(interactions.decide(idPlan!, "allow-session", "me"), undefined);
  assert.equal(interactions.decide(ida!, "allow-session", "me")?.settled?.settlement, "allow-session");
  assert.equal((await a).settlement, "allow-session");
  assert.equal((await b).settlement, "allow-session");
  assert.equal(interactions.listPending("k5").length, 2, "批准计划和旧进程的卡留着");
  assert.equal(interactions.listPending("k6").length, 1);
  interactions.cancelAll("k5", "x");
  interactions.cancelAll("k6", "x");
  assert.equal((await plan).settlement, "cancelled");
  assert.equal((await oldProc).settlement, "cancelled");
  assert.equal((await otherConv).settlement, "cancelled");
  assert.deepEqual(parseCommand("/approve req_1 allow-session"), { kind: "approve", requestId: "req_1", decision: "allow-session" });
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
  const env = agentEnvironment({ FEISHU_APP_SECRET: "x", IM_AGENT_HOME: "y", PATH: "/bin", HOME: "/h" });
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

test("目录选择器只列工作区内的子目录，不列文件和跳出去的链接", async () => {
  const { loadConfig, saveConfig, config, listWorkspaceDirs } = await import("../src/core/config.js");
  loadConfig();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aim-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "aim-out-"));
  fs.mkdirSync(path.join(root, "b"));
  fs.mkdirSync(path.join(root, "a", "deep"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, "file.txt"), "x");
  fs.symlinkSync(outside, path.join(root, "escape"));
  fs.symlinkSync(path.join(root, "b"), path.join(root, "link-b"));
  saveConfig({ ...structuredClone(config()), workspaceRoot: root });
  const top = listWorkspaceDirs("")!;
  assert.equal(top.rel, "");
  assert.deepEqual(
    top.dirs.map((d) => d.name),
    ["a", "b", "link-b", ".git"],
  );
  assert.equal(top.dirs.find((d) => d.name === ".git")!.hidden, true);
  const sub = listWorkspaceDirs("a")!;
  assert.equal(sub.path, path.join(root, "a"));
  assert.equal(sub.rel, "a");
  assert.deepEqual(sub.dirs.map((d) => d.name), ["deep"]);
  assert.equal(listWorkspaceDirs("escape"), null);
  assert.equal(listWorkspaceDirs(".."), null);
  assert.equal(listWorkspaceDirs("file.txt"), null);
});

test("事件补发：缓冲区截断过就要求整页重拉，即使之后压缩变短", async () => {
  const { hub } = await import("../src/core/hub.js");
  const key = "k-buffer";
  hub.emitEvent(key, { type: "turn_start" });
  const since = hub.currentSeq();
  for (let i = 0; i < 450; i++) hub.emitEvent(key, { type: "delta", text: "x" });
  hub.emitEvent(key, { type: "result", text: "done", footer: "", at: Date.now() });
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
    catalog: async () => [],
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
  const staleGen = hub.generation(key);
  await hub.stop(key);
  const question = interactions.create(key, {
    kind: "question",
    title: "t",
    questions: [{ id: "q", header: "Q", question: "?", options: [{ label: "a" }], multiSelect: false, allowOther: true }],
  }, 60_000, hub.liveSessionId(key));
  hub.send(key, { text: "旧文字", attachments: [] }, origin, staleGen);
  const qid = interactions.listPending(key)[0]!.id;
  assert.ok(interactions.isPending(qid));
  interactions.skip(qid, "test");
  await question;

  // 渠道带着收到时的代次来：中途点过停止就不发
  const gen = hub.generation(key);
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

test("按目录批准连带子目录，但不越进隐藏目录、不从家目录/根目录往下延伸", async () => {
  const os = await import("node:os");
  const { rememberAlways, isPreApproved } = await import("../src/agents/claude/permissions.js");
  rememberAlways("Edit:/srv/proj");
  assert.equal(isPreApproved("Edit", "Edit:/srv/proj"), true);
  assert.equal(isPreApproved("Edit", "Edit:/srv/proj/src/core"), true);
  assert.equal(isPreApproved("Edit", "Edit:/srv/proj-evil"), false, "前缀相同的兄弟目录不算");
  assert.equal(isPreApproved("Edit", "Edit:/srv"), false, "上级目录不算");
  assert.equal(isPreApproved("Edit", "Edit:/srv/proj/.git/hooks"), false);
  assert.equal(isPreApproved("Edit", "Edit:/srv/proj/src/.husky"), false);
  assert.equal(isPreApproved("Write", "Write:/srv/proj/src"), false, "Edit 的批准不等于 Write");
  rememberAlways(`Write:${os.homedir()}`);
  assert.equal(isPreApproved("Write", `Write:${os.homedir()}/project`), false, "家目录的批准不往下延伸");
  rememberAlways("Write:/");
  assert.equal(isPreApproved("Write", "Write:/etc"), false);
});

test("Web 上传：同名文件每次存到不同路径，重置后旧 id 撞不上新文件", async () => {
  const { saveBuffer, clearUploads } = await import("../src/core/uploads.js");
  const a = saveBuffer({ key: "k-up", data: Buffer.from("A"), name: "report.png", subdir: "id1" });
  clearUploads("k-up");
  const b = saveBuffer({ key: "k-up", data: Buffer.from("B"), name: "report.png", subdir: "id2" });
  assert.notEqual(a.path, b.path);
  assert.equal(fs.existsSync(a.path), false);
  assert.equal(fs.readFileSync(b.path, "utf8"), "B");
});

test("/fork 只记意图并落盘：切走再切回、或重建会话，下一条消息仍然分叉", async () => {
  const { hub } = await import("../src/core/hub.js");
  const { getConversation } = await import("../src/core/store.js");
  const created: { resumeId?: string; fork?: boolean }[] = [];
  const fake = (id: string) => ({
    id,
    label: id,
    capabilities: { effort: false, fork: true, cost: false, streaming: false },
    start: async () => {},
    stop: async () => {},
    createSession: (opts: { resumeId?: string; fork?: boolean }, events: { onSessionId: (s: string) => void }) => {
      created.push({ resumeId: opts.resumeId, fork: opts.fork });
      return {
        sessionId: undefined,
        send: () => events.onSessionId(opts.fork ? `${id}-forked` : `${id}-orig`),
        interrupt: async () => {},
        setModel: async () => {},
        describeRuntime: async () => ({}),
        dispose: async () => {},
      };
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
  hub.registerDriver(fake("claude") as never);
  hub.registerDriver(fake("codex") as never);
  const key = "web:forktest";
  hub.ensure({ key, channel: "web", channelId: "web", defaultAgent: "claude" });
  const origin = { channel: "web", channelId: "web" };
  hub.send(key, { text: "1", attachments: [] }, origin);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(getConversation(key)!.perAgent.claude!.sessionId, "claude-orig");
  await hub.fork(key);
  assert.equal(getConversation(key)!.perAgent.claude!.forkFrom, "claude-orig");
  // 切到 codex 再切回 claude，然后才说话
  await hub.setAgent(key, "codex", ["claude", "codex"]);
  await hub.setAgent(key, "claude", ["claude", "codex"]);
  created.length = 0;
  hub.send(key, { text: "2", attachments: [] }, origin);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(created[0], { resumeId: "claude-orig", fork: true });
  const b = getConversation(key)!.perAgent.claude!;
  assert.equal(b.sessionId, "claude-forked");
  assert.equal(b.forkFrom, undefined);
});

test("代次：下载附件期间 /cd 或 /new，旧消息作废；关掉的 agent 不能再用", async () => {
  const { hub } = await import("../src/core/hub.js");
  const { loadConfig, saveConfig, config } = await import("../src/core/config.js");
  const sent: string[] = [];
  hub.registerDriver({
    id: "codex",
    label: "C",
    capabilities: { effort: false, fork: false, cost: false, streaming: false },
    start: async () => {},
    stop: async () => {},
    createSession: () => ({
      sessionId: undefined,
      send: (input) => sent.push(input.text),
      interrupt: async () => {},
      setModel: async () => {},
      describeRuntime: async () => ({}),
      dispose: async () => {},
    }),
    listSessions: async () => [],
    sessionExists: async () => true,
    readHistory: async () => [],
    listModels: async () => [],
    catalog: async () => [],
    defaults: async () => ({}),
    statusLines: async () => [],
    diagnose: (e) => ({ kind: "x", chatMessage: String(e), consoleHint: "" }),
  });
  loadConfig();
  const key = "feishu:b:gen";
  hub.ensure({ key, channel: "feishu", channelId: "b", defaultAgent: "codex" });
  const origin = { channel: "feishu", channelId: "b" };
  const gen = hub.generation(key);
  await hub.newSession(key); // 下载附件期间开了新会话
  hub.send(key, { text: "旧", attachments: [] }, origin, gen);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, []);
  hub.send(key, { text: "新", attachments: [] }, origin, hub.generation(key));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, ["新"]);
  // 关掉 codex：活着的会话也不能再用
  const cfg = structuredClone(config());
  cfg.agents.codex.enabled = false;
  saveConfig(cfg);
  await new Promise((r) => setTimeout(r, 20));
  hub.send(key, { text: "关了之后", attachments: [] }, origin);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, ["新"]);
  cfg.agents.codex.enabled = true;
  saveConfig(cfg);
});

test("顶栏模型：没起进程时用 agent 默认，跑起来后显示实际的，进程退了还记得", async () => {
  const { hub } = await import("../src/core/hub.js");
  const { loadConfig, saveConfig, config } = await import("../src/core/config.js");
  loadConfig();
  const cfg = structuredClone(config());
  cfg.agents.codex.enabled = true;
  cfg.agents.codex.defaultModel = "";
  cfg.agents.codex.defaultEffort = "";
  saveConfig(cfg);
  let runtime: { model?: string; effort?: string } = {};
  hub.registerDriver({
    id: "codex",
    label: "C",
    capabilities: { effort: true, fork: false, cost: false, streaming: false },
    start: async () => {},
    stop: async () => {},
    createSession: () => ({
      sessionId: undefined,
      send: () => {},
      interrupt: async () => {},
      setModel: async () => {},
      describeRuntime: async () => runtime,
      peekRuntime: () => runtime,
      dispose: async () => {},
    }),
    listSessions: async () => [],
    sessionExists: async () => true,
    readHistory: async () => [],
    listModels: async () => [],
    catalog: async () => [],
    defaults: async () => ({ model: "toml-model", effort: "medium" }),
    statusLines: async () => [],
    diagnose: (e) => ({ kind: "x", chatMessage: String(e), consoleHint: "" }),
  });
  const key = "web:runtime";
  hub.ensure({ key, channel: "web", channelId: "web", defaultAgent: "codex" });
  hub.info(key); // 第一次触发后台读默认
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(hub.info(key)!.runtimeModel, "toml-model");
  assert.equal(hub.info(key)!.runtimeEffort, "medium");
  assert.equal(hub.info(key)!.model, undefined);
  hub.session(key);
  runtime = { model: "gpt-real", effort: "high" };
  assert.equal(hub.info(key)!.runtimeModel, "gpt-real");
  assert.equal(hub.info(key)!.runtimeEffort, "high");
  await hub.drop(key, "test");
  assert.equal(hub.info(key)!.runtimeModel, "gpt-real");
});

test("切换途中收到的附件不被清掉；改 workspaceRoot 让下载中的旧消息作废", async () => {
  const { hub } = await import("../src/core/hub.js");
  const { saveBuffer } = await import("../src/core/uploads.js");
  const { saveConfig, config } = await import("../src/core/config.js");
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  const sent: string[] = [];
  hub.registerDriver({
    id: "claude",
    label: "S",
    capabilities: { effort: false, fork: false, cost: false, streaming: false },
    start: async () => {},
    stop: async () => {},
    createSession: () => ({
      sessionId: undefined,
      send: (input) => sent.push(input.text),
      interrupt: async () => {},
      setModel: async () => {},
      describeRuntime: async () => ({}),
      dispose: () => slow,
    }),
    listSessions: async () => [],
    sessionExists: async () => true,
    readHistory: async () => [],
    listModels: async () => [],
    catalog: async () => [],
    defaults: async () => ({}),
    statusLines: async () => [],
    diagnose: (e) => ({ kind: "x", chatMessage: String(e), consoleHint: "" }),
  });
  const key = "web:uploadclean";
  hub.ensure({ key, channel: "web", channelId: "web", defaultAgent: "claude" });
  const origin = { channel: "web", channelId: "web" };
  const old = saveBuffer({ key, data: Buffer.from("old"), name: "old.txt", subdir: "u1" });
  hub.send(key, { text: "建立会话", attachments: [] }, origin);
  await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 5));
  const pending = hub.newSession(key); // 卡在 dispose 上
  await new Promise((r) => setTimeout(r, 5));
  const fresh = saveBuffer({ key, data: Buffer.from("new"), name: "new.txt", subdir: "u2" });
  release();
  await pending;
  assert.equal(fs.existsSync(old.path), false);
  assert.equal(fs.existsSync(fresh.path), true);

  // 改工作区根目录：之前收到、还在下载的消息作废
  const gen = hub.generation(key);
  const next = structuredClone(config());
  next.workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aim-root2-"));
  saveConfig(next);
  const before = sent.length;
  hub.send(key, { text: "下载期间改了根目录", attachments: [] }, origin, gen);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, before);
});

test("排队中的消息也核对生命周期代次；连续两次切换不会误删中间收到的附件", async () => {
  const { hub } = await import("../src/core/hub.js");
  const { saveBuffer } = await import("../src/core/uploads.js");
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  const sent: string[] = [];
  hub.registerDriver({
    id: "claude",
    label: "S",
    capabilities: { effort: false, fork: false, cost: false, streaming: false },
    start: async () => {},
    stop: async () => {},
    createSession: () => ({
      sessionId: undefined,
      send: (input) => sent.push(input.text),
      interrupt: async () => {},
      setModel: async () => {},
      describeRuntime: async () => ({}),
      dispose: () => slow,
    }),
    listSessions: async () => [],
    sessionExists: async () => true,
    readHistory: async () => [],
    listModels: async () => [],
    catalog: async () => [],
    defaults: async () => ({}),
    statusLines: async () => [],
    diagnose: (e) => ({ kind: "x", chatMessage: String(e), consoleHint: "" }),
  });
  const key = "web:queuegen";
  hub.ensure({ key, channel: "web", channelId: "web", defaultAgent: "claude" });
  const origin = { channel: "web", channelId: "web" };
  hub.send(key, { text: "建立", attachments: [] }, origin);
  await new Promise((r) => setTimeout(r, 20));

  // t1 /new 卡在 dispose；t2 收到新附件；t3 再来一个（无效的）/cd
  const first = hub.newSession(key);
  await new Promise((r) => setTimeout(r, 5));
  const fresh = saveBuffer({ key, data: Buffer.from("n"), name: "n.txt", subdir: "uq" });
  // 此时排进一条消息：它是在 /new 之后发的，冲着新会话说的 —— 应当送进新会话；
  // 之后那个无效的 /cd 没有实际切换，也不该让它作废
  hub.send(key, { text: "排队中", attachments: [] }, origin);
  await new Promise((r) => setTimeout(r, 5));
  const second = hub.cd(key, "/outside");
  release();
  await first;
  assert.equal(fs.existsSync(fresh.path), true);
  await second;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.includes("排队中"), true);

  // 收到消息之后才发起的切换（飞书下载附件期间 /new）：旧消息作废
  const gen = hub.generation(key);
  await hub.newSession(key);
  hub.send(key, { text: "下载期间被切换", attachments: [] }, origin, gen);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.includes("下载期间被切换"), false);

  // 没有实际效果的操作（切到当前 agent）：挂着的提问照样能用文字作答
  hub.send(key, { text: "建立新进程", attachments: [] }, origin);
  await new Promise((r) => setTimeout(r, 20));
  const q = interactions.create(key, {
    kind: "question",
    title: "t",
    questions: [{ id: "q", header: "Q", question: "?", options: [{ label: "a" }], multiSelect: false, allowOther: true }],
  }, 60_000, hub.liveSessionId(key));
  await hub.setAgent(key, "claude", ["claude"]);
  hub.send(key, { text: "我的答案", attachments: [] }, origin);
  assert.deepEqual((await q).answers, { q: ["我的答案"] });
});

test("/new 之后的消息不会被旧会话的提问吃掉；显式恢复后第一条消息不判过期", async () => {
  const { hub } = await import("../src/core/hub.js");
  const { updateConversation, getConversation } = await import("../src/core/store.js");
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  const sent: string[] = [];
  let created = 0;
  hub.registerDriver({
    id: "claude",
    label: "S",
    capabilities: { effort: false, fork: false, cost: false, streaming: false },
    start: async () => {},
    stop: async () => {},
    createSession: (opts, events) => {
      created += 1;
      return {
        sessionId: undefined,
        send: (input) => {
          sent.push(`${opts.resumeId ?? "new"}:${input.text}`);
          events.onSessionId(opts.resumeId ?? `s${created}`);
        },
        interrupt: async () => {},
        setModel: async () => {},
        describeRuntime: async () => ({}),
        dispose: () => slow,
      };
    },
    listSessions: async () => [],
    sessionExists: async () => true,
    readHistory: async () => [],
    listModels: async () => [],
    catalog: async () => [],
    defaults: async () => ({}),
    statusLines: async () => [],
    diagnose: (e) => ({ kind: "x", chatMessage: String(e), consoleHint: "" }),
  });
  const key = "web:askgen";
  hub.ensure({ key, channel: "web", channelId: "web", defaultAgent: "claude" });
  const origin = { channel: "web", channelId: "web" };
  hub.send(key, { text: "建立", attachments: [] }, origin);
  await new Promise((r) => setTimeout(r, 20));
  const q = interactions.create(key, {
    kind: "question",
    title: "t",
    questions: [{ id: "q", header: "Q", question: "?", options: [{ label: "a" }], multiSelect: false, allowOther: true }],
  }, 60_000, hub.liveSessionId(key));
  const pendingNew = hub.newSession(key); // 卡在 dispose，旧提问还没取消
  hub.send(key, { text: "给新会话的话", attachments: [] }, origin);
  const qid = interactions.listPending(key)[0]?.id;
  assert.ok(qid && interactions.isPending(qid), "旧提问不该被新代次的消息作答");
  release();
  await pendingNew;
  assert.equal((await q).settlement, "cancelled");

  // 显式恢复：闲置很久的会话，恢复后第一条消息接着它聊，不判过期
  updateConversation(key, { activeAt: Date.now() - 365 * 24 * 3600 * 1000 });
  await hub.resume(key, "old-session");
  sent.length = 0;
  hub.send(key, { text: "继续之前的任务", attachments: [] }, origin);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, ["old-session:继续之前的任务"]);
  assert.equal(getConversation(key)!.perAgent.claude!.sessionId, "old-session");
});

test("被丢弃进程晚到的提问直接取消；恢复排队期间发的消息不会把刚恢复的会话判过期", async () => {
  const { hub } = await import("../src/core/hub.js");
  const { updateConversation, getConversation } = await import("../src/core/store.js");
  type Host = (spec: unknown) => Promise<{ settlement: string }>;
  const hosts: Host[] = [];
  let release!: () => void;
  let slow = new Promise<void>((r) => (release = r));
  const sent: string[] = [];
  hub.registerDriver({
    id: "claude",
    label: "S",
    capabilities: { effort: false, fork: false, cost: false, streaming: false },
    start: async () => {},
    stop: async () => {},
    createSession: (opts, events, host) => {
      hosts.push(host as unknown as Host);
      return {
        sessionId: undefined,
        send: (input) => {
          sent.push(`${opts.resumeId ?? "new"}:${input.text}`);
          events.onSessionId(opts.resumeId ?? "fresh");
        },
        interrupt: async () => {},
        setModel: async () => {},
        describeRuntime: async () => ({}),
        dispose: () => slow,
      };
    },
    listSessions: async () => [],
    sessionExists: async () => true,
    readHistory: async () => [],
    listModels: async () => [],
    catalog: async () => [],
    defaults: async () => ({}),
    statusLines: async () => [],
    diagnose: (e) => ({ kind: "x", chatMessage: String(e), consoleHint: "" }),
  });
  const key = "web:late";
  hub.ensure({ key, channel: "web", channelId: "web", defaultAgent: "claude" });
  const origin = { channel: "web", channelId: "web" };
  hub.send(key, { text: "建立", attachments: [] }, origin);
  await new Promise((r) => setTimeout(r, 20));
  const oldHost = hosts.at(-1)!;
  const pendingNew = hub.newSession(key);
  await new Promise((r) => setTimeout(r, 5));
  // 旧进程在退出途中晚到一个提问
  const late = await oldHost({ kind: "question", title: "t", questions: [] });
  assert.equal(late.settlement, "cancelled");
  assert.equal(interactions.listPending(key).length, 0);
  release();
  await pendingNew;

  // 会话闲置很久；发起 /resume（卡在旧会话 dispose），期间发消息
  hub.send(key, { text: "新进程", attachments: [] }, origin);
  await new Promise((r) => setTimeout(r, 20));
  slow = new Promise<void>((r) => (release = r));
  updateConversation(key, { activeAt: Date.now() - 365 * 24 * 3600 * 1000 });
  const pendingResume = hub.resume(key, "target");
  hub.send(key, { text: "继续", attachments: [] }, origin);
  release();
  await pendingResume;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.at(-1), "target:继续");
  assert.equal(getConversation(key)!.perAgent.claude!.sessionId, "target");
});

test("操作序号边界：无效操作的占位、同一次切换都不会给旧消息留出越过新切换的余量", async () => {
  const { hub } = await import("../src/core/hub.js");
  const { config } = await import("../src/core/config.js");
  let exists = false;
  const sent: string[] = [];
  let gate!: () => void;
  let blocker = Promise.resolve();
  hub.registerDriver({
    id: "claude",
    label: "S",
    capabilities: { effort: false, fork: false, cost: false, streaming: false },
    start: async () => {},
    stop: async () => {},
    createSession: () => ({
      sessionId: undefined,
      send: (input) => sent.push(input.text),
      interrupt: async () => {},
      setModel: async () => {},
      describeRuntime: async () => ({}),
      dispose: async () => {},
    }),
    listSessions: async () => [],
    sessionExists: async () => {
      await blocker;
      return exists;
    },
    readHistory: async () => [],
    listModels: async () => [],
    catalog: async () => [],
    defaults: async () => ({}),
    statusLines: async () => [],
    diagnose: (e) => ({ kind: "x", chatMessage: String(e), consoleHint: "" }),
  });
  const key = "feishu:b:seq";
  hub.ensure({ key, channel: "feishu", channelId: "b", defaultAgent: "claude" });
  const origin = { channel: "feishu", channelId: "b" };
  hub.send(key, { text: "建立", attachments: [] }, origin);
  await new Promise((r) => setTimeout(r, 20));

  // 场景一：/resume 不存在的 id 正在查询时收到附件消息；查询失败后用户 /cd B；附件下载完 → 必须作废
  blocker = new Promise<void>((r) => (gate = r));
  const bad = hub.resume(key, "missing");
  const g1 = hub.generation(key);
  gate();
  await bad;
  const dir = fs.mkdtempSync(path.join(config().workspaceRoot, "b-"));
  await hub.cd(key, path.basename(dir));
  sent.length = 0;
  hub.send(key, { text: "旧指令1", attachments: [] }, origin, g1);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, []);

  // 场景二：/new 生效后还在收尾时收到消息；之后用户 /cd C；下载完 → 必须作废
  const pendingNew = hub.newSession(key);
  await Promise.resolve();
  const g2 = hub.generation(key);
  await pendingNew;
  const dir2 = fs.mkdtempSync(path.join(config().workspaceRoot, "c-"));
  await hub.cd(key, path.basename(dir2));
  hub.send(key, { text: "旧指令2", attachments: [] }, origin, g2);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, []);

  // 无效操作执行期间打字作答：操作结束后仍当作答案，不会变成下一轮输入
  hub.send(key, { text: "建立进程", attachments: [] }, origin);
  await new Promise((r) => setTimeout(r, 20));
  sent.length = 0;
  const q = interactions.create(key, {
    kind: "question",
    title: "t",
    questions: [{ id: "q", header: "Q", question: "?", options: [{ label: "a" }], multiSelect: false, allowOther: true }],
  }, 60_000, hub.liveSessionId(key));
  blocker = new Promise<void>((r) => (gate = r));
  const bad2 = hub.resume(key, "missing");
  hub.send(key, { text: "我的答案", attachments: [] }, origin);
  gate();
  await bad2;
  assert.deepEqual((await q).answers, { q: ["我的答案"] });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, []);
  exists = true;
});

test("回复脚注：重新加载历史后按正文结尾对回去，同样的回复按先后对应", async () => {
  const { recordFooter, attachFooters } = await import("../src/core/footers.js");
  const sid = "sess-footer";
  recordFooter(sid, "最后一段结论", "用时 3.0s　约 $0.0100");
  recordFooter(sid, "好的", "用时 1.0s");
  recordFooter(sid, "好的", "用时 2.0s");
  const history = attachFooters(sid, [
    { role: "user", text: "问" },
    // Claude 记录里同一轮的多段文字拼在一起，result 只是最后一段
    { role: "assistant", text: "先看看代码\n\n最后一段   结论" },
    { role: "user", text: "再问" },
    { role: "assistant", text: "没记录过的回复" },
    { role: "assistant", text: "好的" },
    { role: "assistant", text: "好的" },
  ]);
  assert.deepEqual(
    history.map((m) => m.footer),
    [undefined, "用时 3.0s　约 $0.0100", undefined, undefined, "用时 1.0s", "用时 2.0s"],
  );
  assert.deepEqual(attachFooters("没有的会话", [{ role: "assistant", text: "x" }]), [{ role: "assistant", text: "x" }]);
});
