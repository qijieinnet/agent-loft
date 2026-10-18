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
