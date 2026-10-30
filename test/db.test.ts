import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-db-"));
process.env.AGENT_LOFT_HOME = home;
const data = path.join(home, "data");
fs.mkdirSync(path.join(data, "history"), { recursive: true });
fs.mkdirSync(path.join(data, "memory"), { recursive: true });

// 升级前的 JSON：对话、会话归属、脚注、聊天记录（最后一行写到一半）
const conv = { key: "web:a", channel: "web", channelId: "web", agent: "claude", cwd: os.homedir(), perAgent: { claude: { sessionId: "s1" } }, activeAt: 1, createdAt: 1, title: "旧对话", hidden: true };
fs.writeFileSync(path.join(data, "conversations.json"), JSON.stringify({ "web:a": conv }));
fs.writeFileSync(path.join(data, "session-owners.json"), JSON.stringify({ s1: "u_alice" }));
fs.writeFileSync(path.join(data, "footers.json"), JSON.stringify({ s1: { at: 1, entries: [{ t: "好的", f: "用时 1.0秒" }] } }));
fs.writeFileSync(
  path.join(data, "history", "u_alice.jsonl"),
  [
    JSON.stringify({ k: "web:a", a: "claude", r: "u", t: "我家猫叫豆豆", ts: 10, id: "m1" }),
    JSON.stringify({ k: "web:a", a: "claude", r: "a", t: "豆豆这个名字真可爱", ts: 11 }),
    '{"k":"web:a","a":"cla',
  ].join("\n"),
);
fs.writeFileSync(path.join(data, "usage.json"), JSON.stringify({ s1: { input: 10, cacheRead: 20, cacheWrite: 0, output: 5, reasoning: 0, costUsd: 0.5, at: 3 } }));
fs.writeFileSync(path.join(data, "usage-daily.json"), JSON.stringify({ "2026-01-02": { "u_alice\tclaude\t": { input: 10, cacheRead: 20, cacheWrite: 0, output: 5, reasoning: 0 } } }));
fs.writeFileSync(path.join(data, "memory", "u_alice.json"), JSON.stringify({ enabled: true, about: "我是 alice", items: [{ id: "m_1", text: "喜欢猫", createdAt: 1, updatedAt: 1, source: "user" }] }));
fs.writeFileSync(path.join(data, "memory", ".default-off-migrated"), "1");
fs.writeFileSync(path.join(data, "history", "u_alice.meta.json"), JSON.stringify({ backfilled: true, extracted: { "web:a": 10 } }));

const store = await import("../src/core/store.js");
const history = await import("../src/core/chat-history.js");
const footers = await import("../src/core/footers.js");
const db = await import("../src/core/db.js");
const usage = await import("../src/core/usage.js");
const memory = await import("../src/core/memory.js");

test("第一次打开把升级前的 JSON 导进数据库，原文件改名留作备份；再打开不重复导入", () => {
  assert.equal(store.getConversation("web:a")?.title, "旧对话");
  assert.equal(store.sessionOwner("s1"), "u_alice");
  assert.equal(footers.attachFooters("s1", [{ role: "assistant", text: "好的" }])[0]?.footer, "用时 1.0秒");
  assert.deepEqual(history.readRecords("u_alice").map((r) => r.t), ["我家猫叫豆豆", "豆豆这个名字真可爱"], "写坏的行跳过");
  assert.equal(history.readRecords("u_alice")[0]?.id, "m1");
  assert.equal(history.readMeta("u_alice").backfilled, true);
  assert.deepEqual(history.pendingConversations("u_alice", 0).map((p) => p.records.length), [1], "整理到的时刻照旧生效");
  assert.deepEqual(usage.usageOf("s1"), { input: 10, cacheRead: 20, cacheWrite: 0, output: 5, reasoning: 0, costUsd: 0.5, at: 3 });
  assert.equal(usage.dailyUsage("2026-01-01", "2026-12-31")[0]?.owner, "u_alice");
  const m = memory.readMemory("u_alice");
  assert.equal(m.about, "我是 alice");
  assert.deepEqual(m.items.map((i) => i.text), ["喜欢猫"]);
  // 「默认关」那次迁移跑过的标记也带过来了：没存过记忆的老用户不会被补成开着
  memory.migrateMemoryDefault(["u_bob"]);
  assert.equal(memory.readMemory("u_bob").enabled, false);
  for (const f of ["conversations.json", "session-owners.json", "footers.json", "usage.json", "usage-daily.json", "memory/u_alice.json", "history/u_alice.jsonl", "history/u_alice.meta.json"]) {
    assert.ok(!fs.existsSync(path.join(data, f)), `${f} 改名了`);
    assert.ok(fs.existsSync(path.join(data, `${f}.imported`)), `${f}.imported 留着`);
  }
  // 同名的旧文件又出现了（比如降级跑过一次）：标记还在，不再导入
  fs.copyFileSync(path.join(data, "history/u_alice.jsonl.imported"), path.join(data, "history/u_alice.jsonl"));
  db.closeDatabaseForTest();
  db.database();
  assert.equal(history.readRecords("u_alice").length, 2);
});

test("对话：只写变了的；删掉的从库里删；记忆工具查得到标题和是否隐藏", () => {
  store.ensureConversation({ key: "web:b", channel: "web", channelId: "web", agent: "codex" });
  store.updateConversation("web:b", { title: "新对话" });
  store.flushStore();
  const labels = store.conversationLabels();
  assert.deepEqual(labels.get("web:a"), { title: "旧对话", hidden: true });
  assert.deepEqual(labels.get("web:b"), { title: "新对话" });
  store.deleteConversation("web:b");
  assert.equal(store.conversationLabels().has("web:b"), false);
});

test("搜索：两个字的中文、问答配对；回退后整条对话换掉", () => {
  const hits = history.searchHistory("u_alice", "豆豆");
  assert.equal(hits.length, 1, "问和答配成一对");
  assert.equal(hits[0]?.user, "我家猫叫豆豆");
  assert.equal(hits[0]?.assistant, "豆豆这个名字真可爱");
  history.replaceConversationRecords("u_alice", "web:a", [{ k: "web:a", a: "claude", r: "u", t: "换了", ts: 20 }]);
  assert.equal(history.searchHistory("u_alice", "豆豆").length, 0);
  assert.deepEqual(history.countRecords("u_alice"), { count: 1, conversations: 1 });
});

test("脚注：分叉沿用原会话的；一个会话只留最近 1000 轮", () => {
  footers.copyFooters("s1", "s2");
  assert.equal(footers.attachFooters("s2", [{ role: "assistant", text: "好的" }])[0]?.footer, "用时 1.0秒");
  for (let i = 0; i < 1005; i++) footers.recordFooter("s3", `第${i}轮`, `f${i}`);
  const n = (db.sql("SELECT count(*) AS n FROM footers WHERE session_id = 's3'").get() as { n: number }).n;
  assert.equal(n, 1000);
});
