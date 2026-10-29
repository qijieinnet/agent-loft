import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-memory-"));
process.env.AGENT_LOFT_HOME = home;
fs.mkdirSync(path.join(home, "data"), { recursive: true });
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({}));

const { loadConfig } = await import("../src/core/config.js");
loadConfig();
const users = await import("../src/core/users.js");
const memory = await import("../src/core/memory.js");
const links = await import("../src/core/feishu-links.js");
const personal = await import("../src/core/personal.js");
const { memoryMcpSpawn } = await import("../src/core/memory-mcp.js");
const { parseCommand } = await import("../src/core/commands.js");
const { buildCatalog } = await import("../src/core/command-catalog.js");
const uploads = await import("../src/core/uploads.js");

const admin = users.createUser({ name: "boss", password: "password-1", role: "admin" });
const alice = users.createUser({ name: "alice", password: "password-2" });
const bob = users.createUser({ name: "bob", password: "password-3" });

test("记忆：默认关着，打开后整理默认每天凌晨 2 点", () => {
  const erin = users.createUser({ name: "erin", password: "password-6" });
  const m = memory.readMemory(erin.id);
  assert.equal(m.enabled, false);
  assert.equal(m.curate.dailyHour, 2);
  // 存过的文件里写着 enabled，老用户不受默认值影响
  fs.writeFileSync(path.join(home, "data", "memory", "u_old.json"), JSON.stringify({ enabled: true, items: [] }));
  assert.equal(memory.readMemory("u_old").enabled, true);
});

test("升级迁移：已有用户没写过记忆文件的补成开着，只跑一次；之后新加的用户默认关", () => {
  const fred = users.createUser({ name: "fred", password: "password-7" });
  memory.migrateMemoryDefault([fred.id, "u_old"]);
  assert.equal(memory.readMemory(fred.id).enabled, true);
  assert.equal(memory.readMemory("u_old").enabled, true, "已有文件的不动");
  const gina = users.createUser({ name: "gina", password: "password-8" });
  memory.migrateMemoryDefault([fred.id, gina.id]);
  assert.equal(memory.readMemory(gina.id).enabled, false, "跑过一次就不再补");
});

// 下面的用例都在记忆打开的前提下
for (const u of [admin, alice, bob]) memory.setMemoryOptions(u.id, { enabled: true });

test("记忆：加、去重、改、删、清空", () => {
  const a = memory.addMemoryItem(alice.id, "喜欢喝美式咖啡", "agent");
  const again = memory.addMemoryItem(alice.id, "  喜欢喝美式咖啡 ", "agent");
  assert.equal(again.id, a.id, "同样的内容不重复记");
  memory.addMemoryItem(alice.id, "住在深圳", "user");
  assert.equal(memory.readMemory(alice.id).items.length, 2);
  memory.updateMemoryItem(alice.id, a.id, "喜欢喝拿铁");
  assert.equal(memory.readMemory(alice.id).items.find((i) => i.id === a.id)?.text, "喜欢喝拿铁");
  assert.ok(memory.removeMemoryItem(alice.id, a.id));
  assert.equal(memory.removeMemoryItem(alice.id, a.id), undefined);
  assert.throws(() => memory.addMemoryItem(alice.id, "x".repeat(memory.MEMORY_LIMITS.item + 1), "agent"));
  assert.throws(() => memory.addMemoryItem(alice.id, "   ", "agent"));
  // 别人的记忆不受影响
  assert.equal(memory.readMemory(bob.id).items.length, 0);
  memory.clearMemory(alice.id);
  assert.deepEqual(memory.readMemory(alice.id), { enabled: true, curate: memory.DEFAULT_CURATE, chatHistory: true, about: "", items: [] });
});

test("记忆：用户 id 不能拼出目录外的路径", () => {
  assert.throws(() => memory.readMemory("../config"));
  assert.throws(() => memory.readMemory("a/b"));
});

test("记忆：系统提示里有关于我、条目和 id；关掉就没有", () => {
  memory.setMemoryOptions(alice.id, { about: "后端工程师，爱用 TypeScript" });
  const item = memory.addMemoryItem(alice.id, "家里有台 QNAP NAS", "user");
  const prompt = memory.memoryPrompt(alice.id)!;
  assert.match(prompt, /后端工程师/);
  assert.ok(prompt.includes(`[${item.id}]`));
  assert.match(prompt, /remember/);
  memory.setMemoryOptions(alice.id, { enabled: false });
  assert.equal(memory.memoryPrompt(alice.id), undefined);
  memory.setMemoryOptions(alice.id, { enabled: true });
});

test("记忆：超出字数预算的旧条目不放进提示，但会说还有几条", () => {
  const n = Math.ceil(memory.MEMORY_LIMITS.promptItems / 400) + 3;
  for (let i = 0; i < n; i++) memory.addMemoryItem(bob.id, `${i} ${"长".repeat(400)}`, "agent");
  const prompt = memory.memoryPrompt(bob.id)!;
  assert.match(prompt, /条较早的记忆这次没有带上/);
  memory.clearMemory(bob.id);
});

test("记忆的归属：有主人用主人的；主人没了谁的都不用；旧 Web 会话归最早的管理员；飞书没主人不用", () => {
  assert.equal(personal.memoryOwnerOf({ owner: alice.id, channel: "web" }), alice.id);
  assert.equal(personal.memoryOwnerOf({ owner: "u_gone", channel: "web" }), undefined, "主人被删了：不转给管理员");
  assert.equal(personal.memoryOwnerOf({ owner: undefined, channel: "web" }), admin.id);
  assert.equal(personal.memoryOwnerOf({ owner: undefined, channel: "feishu" }), undefined);
  users.updateUser(bob.id, { disabled: true });
  assert.equal(personal.memoryOwnerOf({ owner: bob.id, channel: "feishu" }), undefined, "停用的用户不用");
  users.updateUser(bob.id, { disabled: false });
  assert.equal(personal.sessionMemory({ owner: undefined, channel: "feishu" }), undefined);
  assert.equal(personal.sessionMemory({ owner: alice.id, channel: "web" })?.userId, alice.id);
});

test("飞书绑定：码只能用一次、按机器人分开、换绑就是换人、删用户一起删", () => {
  assert.throws(() => links.redeemLinkCode("NOPE1234", "bot_a", "ou_1"));
  const { code } = links.createLinkCode(alice.id);
  assert.equal(links.redeemLinkCode(code.toLowerCase(), "bot_a", "OU_Alice").id, alice.id, "码不分大小写，open_id 也不分");
  assert.throws(() => links.redeemLinkCode(code, "bot_a", "ou_alice"), /过期|不对/, "用过就作废");
  assert.equal(links.linkedUser("bot_a", "ou_alice")?.id, alice.id);
  assert.equal(links.linkedUser("bot_b", "ou_alice"), undefined, "open_id 按机器人分开");
  // 同一个人再生成一个码，旧的作废
  const first = links.createLinkCode(bob.id).code;
  const second = links.createLinkCode(bob.id).code;
  assert.throws(() => links.redeemLinkCode(first, "bot_a", "ou_bob"));
  // 同一个飞书账号用 bob 的码再绑：换成 bob
  links.redeemLinkCode(second, "bot_a", "ou_alice");
  assert.equal(links.linkedUser("bot_a", "ou_alice")?.id, bob.id);
  assert.equal(links.listLinks(alice.id).length, 0);
  // 只能解除自己的
  assert.equal(links.unlink("bot_a", "ou_alice", alice.id), false);
  assert.equal(links.unlink("bot_a", "ou_alice", bob.id), true);
  // 删用户：记忆和绑定一起删
  links.redeemLinkCode(links.createLinkCode(bob.id).code, "bot_a", "ou_bob");
  memory.addMemoryItem(bob.id, "bob 的秘密", "agent");
  personal.purgeUserData(bob.id);
  assert.equal(links.listLinks(bob.id).length, 0);
  assert.equal(memory.readMemory(bob.id).items.length, 0);
});

test("飞书绑定：停用的用户不算绑定", () => {
  links.redeemLinkCode(links.createLinkCode(bob.id).code, "bot_a", "ou_bob2");
  users.updateUser(bob.id, { disabled: true });
  assert.equal(links.linkedUser("bot_a", "ou_bob2"), undefined);
  users.updateUser(bob.id, { disabled: false });
  assert.equal(links.linkedUser("bot_a", "ou_bob2")?.id, bob.id);
});

test("命令：/expert /claude 只在飞书（网页上的对话不能换专家）；/chat /work 没有了；/bind 只在飞书", () => {
  assert.deepEqual(parseCommand("/expert 查资料"), { kind: "agent", agent: "查资料" });
  assert.deepEqual(parseCommand("/agent"), { kind: "agent" });
  assert.equal(parseCommand("/chat").kind, "chat", "当普通消息交给 agent");
  const web = buildCatalog({ allowedAgents: ["claude", "codex"], native: [], prefs: undefined, channel: "web" }).map((c) => c.name);
  assert.ok(!web.includes("chat") && !web.includes("work") && !web.includes("skills"));
  assert.ok(!web.includes("expert") && !web.includes("claude"));
  assert.ok(!web.includes("bind"));
  const feishu = buildCatalog({ allowedAgents: ["claude", "codex"], native: [], prefs: undefined, channel: "feishu" });
  assert.ok(feishu.some((c) => c.name === "expert") && feishu.some((c) => c.name === "codex"));
  assert.equal(feishu.find((c) => c.name === "bind")?.runnable, false, "要带绑定码，不能一键执行");
});

test("只能联网的专家的附件：文本文件内容直接放进消息，二进制的说明读不了", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aim-att-"));
  const txt = path.join(dir, "notes.md");
  fs.writeFileSync(txt, "# 标题\n内容");
  const bin = path.join(dir, "data.md");
  fs.writeFileSync(bin, Buffer.from([0x23, 0x00, 0x01]));
  const doc = path.join(dir, "a.docx");
  fs.writeFileSync(doc, "PK");
  const att = (p: string) => ({ kind: "file" as const, path: p, name: path.basename(p), size: fs.statSync(p).size });
  assert.equal(uploads.readTextAttachment(att(txt)), "# 标题\n内容");
  assert.equal(uploads.readTextAttachment(att(bin)), undefined, "扩展名骗人的二进制不读");
  assert.equal(uploads.readTextAttachment(att(doc)), undefined);
  const blocks = uploads.inlineTextBlocks([att(txt), att(doc)], uploads.readTextAttachments([att(txt), att(doc)]));
  const gone = { kind: "file" as const, path: path.join(dir, "gone.txt"), name: "gone.txt", size: 10 };
  assert.equal(uploads.readTextAttachment(gone), undefined, "文件被清理了：返回 undefined，不抛错");
  assert.match(blocks, /附件「notes\.md」的内容/);
  assert.doesNotMatch(blocks, /a\.docx/);
  const note = uploads.describeAttachments([att(txt), att(doc)], (a) => a.name === "notes.md", true);
  assert.match(note, /你读不了这个文件/);
  // 历史里照样能把附件清单从正文里切出去
  const split = uploads.splitAttachmentNote(`你好\n\n${note}\n\n${blocks}`);
  assert.equal(split.text, "你好");
  assert.equal(split.attachments.length, 2);
});

test("记忆 MCP 服务：initialize、tools/list、remember 记给拉起它时指定的用户", async () => {
  const spawnSpec = memoryMcpSpawn(alice.id, "test");
  const child = spawn(spawnSpec.command, spawnSpec.args, { env: { ...process.env, ...spawnSpec.env }, stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  let buf = "";
  child.stdout.setEncoding("utf8");
  const got = new Promise<void>((resolve) => {
    child.stdout.on("data", (d: string) => {
      buf += d;
      let n;
      while ((n = buf.indexOf("\n")) >= 0) {
        lines.push(buf.slice(0, n));
        buf = buf.slice(n + 1);
        if (lines.length === 4) resolve();
      }
    });
  });
  const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "remember", arguments: { text: "MCP 记下的一条" } } });
  send({ jsonrpc: "2.0", id: 4, method: "nope" });
  await got;
  child.stdin.end();
  const [init, list, call, unknown] = lines.map((l) => JSON.parse(l));
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ["remember", "forget"]);
  assert.equal(call.result.isError, undefined);
  assert.equal(unknown.error.code, -32601);
  assert.ok(memory.readMemory(alice.id).items.some((i) => i.text === "MCP 记下的一条" && i.source === "agent"));
  assert.ok(!memory.readMemory(bob.id).items.some((i) => i.text === "MCP 记下的一条"));
});

// ---------- 聊天记录索引、自动整理 ----------

const history = await import("../src/core/chat-history.js");
const curator = await import("../src/core/memory-curator.js");
const { hub } = await import("../src/core/hub.js");

test("聊天记录搜索：两个字的中文、多个词、模糊匹配、问答配对、跳过指定对话", () => {
  const t0 = Date.now() - 3 * 86400_000;
  history.appendRecords(alice.id, [
    { k: "web:a", a: "claude", r: "u", t: "我家的猫叫什么来着", ts: t0 },
    { k: "web:a", a: "claude", r: "a", t: "你家的橘猫叫豆豆。", ts: t0 + 1 },
    { k: "web:b", a: "codex", r: "u", t: "软路由怎么防 DNS 污染？", ts: t0 + 2 },
    { k: "web:b", a: "codex", r: "a", t: "可以在 OpenClash 里开启 Fake-IP，再配上可信的 DoH 上游。", ts: t0 + 3 },
    { k: "web:c", a: "claude", r: "u", t: "今天天气不错", ts: t0 + 4 },
  ]);
  const cat = history.searchHistory(alice.id, "豆豆");
  assert.equal(cat[0]?.key, "web:a");
  assert.match(cat[0]!.user ?? "", /猫叫什么/, "答配上了问");
  assert.equal(history.searchHistory(alice.id, "dns 污染")[0]?.key, "web:b", "不分大小写、多个词");
  assert.equal(history.searchHistory(alice.id, "软路由防污染")[0]?.key, "web:b", "长中文按两字组合模糊匹配");
  assert.equal(history.searchHistory(alice.id, "豆豆", { skip: (k) => k === "web:a" }).length, 0);
  assert.equal(history.searchHistory(alice.id, "完全不相干的词").length, 0);
  assert.equal(history.searchHistory(bob.id, "豆豆").length, 0, "只搜自己的");
});

test("聊完了的对话才算待整理；整理过的不再算", () => {
  const now = Date.now();
  history.appendRecords(alice.id, [
    { k: "web:p", a: "claude", r: "u", t: "我最近在学 Rust", ts: now - 20 * 60_000 },
    { k: "web:q", a: "claude", r: "u", t: "刚说的", ts: now - 60_000 },
  ]);
  const idle = 10 * 60_000;
  const pending = history.pendingConversations(alice.id, idle, now).map((p) => p.key);
  assert.ok(pending.includes("web:p"));
  assert.ok(!pending.includes("web:q"), "还没聊完");
  for (const p of history.pendingConversations(alice.id, idle, now)) history.markExtracted(alice.id, p.key, p.last);
  assert.equal(history.pendingConversations(alice.id, idle, now).length, 0);
});

test("整理设置：默认每天一次；不合规的值收拢；自动选 agent 时不能指定模型；老版本关掉的「自动整理」= 不整理", () => {
  assert.equal(memory.readMemory(alice.id).curate.when, "daily");
  const c = memory.setMemoryOptions(alice.id, { curate: { when: "bogus" as never, idleMinutes: 1, dailyHour: 30, agent: "auto", model: "opus" } }).curate;
  assert.deepEqual(c, { when: "daily", scope: "all", experts: [], idleMinutes: 5, dailyHour: 23, agent: "auto", model: "" });
  assert.equal(memory.setMemoryOptions(alice.id, { curate: { agent: "codex", model: "gpt-x" } }).curate.model, "gpt-x");
  memory.setMemoryOptions(alice.id, { curate: { agent: "auto" } });
  fs.writeFileSync(path.join(home, "data", "memory", "u_legacy.json"), JSON.stringify({ enabled: true, autoExtract: false, items: [] }));
  assert.equal(memory.readMemory("u_legacy").curate.when, "off");
});

test("分批：加起来太长就分几批，单段太长的自己一批", () => {
  const big = (k: string, n: number) => ({ key: k, last: 1, records: [{ k, a: "claude", r: "u" as const, t: "字".repeat(n), ts: 1 }] });
  const batches = curator.chunk([big("a", 3000), big("b", 3000), big("c", 15000), big("d", 30000), big("e", 100)]);
  assert.deepEqual(batches.map((b) => b.map((p) => p.key)), [["a", "b"], ["c"], ["d"], ["e"]]);
});

test("整理的提议：用户自己加的不动、重复的不算新增、数量有上限", () => {
  memory.clearMemory(alice.id);
  const mine = memory.addMemoryItem(alice.id, "用户住在深圳", "user");
  const agentItem = memory.addMemoryItem(alice.id, "用户在学 Go", "agent");
  const r = curator.applyProposal(alice.id, {
    add: ["用户在学 Rust（2026-10 起）", "用户住在深圳", "a", "b", "c"],
    update: [{ id: mine.id, text: "用户搬到了北京" }, { id: agentItem.id, text: "用户在学 Go 和 Rust" }],
    remove: [mine.id, "m_nope"],
  });
  const items = memory.readMemory(alice.id).items;
  assert.ok(items.some((i) => i.id === mine.id && i.text === "用户住在深圳"), "用户加的没被改、没被删");
  assert.equal(items.find((i) => i.id === agentItem.id)?.text, "用户在学 Go 和 Rust");
  assert.deepEqual(r.removed, []);
  assert.ok(!r.added.includes("用户住在深圳"), "和已有的重复，不算新增");
  assert.ok(r.added.length <= 3);
  assert.equal(items.find((i) => i.text.startsWith("用户在学 Rust"))?.source, "auto");
  assert.match(curator.describeResult(r) ?? "", /记忆已更新/);
  assert.equal(curator.describeResult({ added: [], updated: [], removed: [] }), undefined);
  // 乱七八糟的输出：什么都不改
  assert.deepEqual(curator.applyProposal(alice.id, "not json"), { added: [], updated: [], removed: [] });
});

/** 假 agent：记录收到的整理请求，按预设回答；读历史时给两句 */
const completions: string[] = [];
let lastModel: string | undefined;
let completeAnswer: unknown = { add: [], update: [], remove: [] };
hub.registerDriver({
  id: "claude",
  label: "Claude Code",
  capabilities: { effort: false, fork: false, cost: false, streaming: false },
  start: async () => {},
  stop: async () => {},
  createSession: () => {
    throw new Error("测试里不开会话");
  },
  listSessions: async () => [],
  sessionExists: async () => true,
  readHistory: async () => [
    { role: "user", text: "以前问过：我的 NAS 是威联通的", ts: Date.now() - 86400_000 },
    { role: "assistant", text: "记下了，威联通 TS-264C。", ts: Date.now() - 86400_000 + 1 },
  ],
  listModels: async () => [],
  catalog: async () => [],
  defaults: async () => ({}),
  statusLines: async () => [],
  diagnose: () => ({ kind: "x", chatMessage: "", consoleHint: "" }),
  complete: async (req) => {
    completions.push(req.prompt);
    lastModel = req.model;
    return completeAnswer;
  },
});

test("录入：有主人的对话说的话进主人的索引；群聊（没主人）不进；关了记忆也进（搜索用），但不拿去整理", async () => {
  // 前面 purgeUserData 删过 bob 的记忆文件，回到了默认的关着
  memory.setMemoryOptions(bob.id, { enabled: true });
  history.purgeHistory(bob.id);
  history.writeMeta(bob.id, { backfilled: true, extracted: {} });
  curator.startHistoryCapture();
  hub.ensure({ key: "web:bob1", channel: "web", channelId: "web", defaultAgent: "claude", owner: bob.id });
  hub.ensure({ key: "feishu:b1:oc_group", channel: "feishu", channelId: "b1", defaultAgent: "claude" });
  hub.emitEvent("web:bob1", { type: "user", text: "我的显示器是 4K 的，平时主要用来写代码和看视频", attachments: [], origin: { channel: "web", channelId: "web" } });
  hub.emitEvent("web:bob1", { type: "result", text: "好的，4K 显示器。", footer: "", at: Date.now() });
  hub.emitEvent("feishu:b1:oc_group", { type: "user", text: "群里的话", attachments: [], origin: { channel: "feishu", channelId: "b1" } });
  assert.deepEqual(history.readRecords(bob.id).map((r) => r.r), ["u", "a"]);
  assert.ok(!history.readRecords(admin.id).some((r) => r.t === "群里的话"));
  memory.setMemoryOptions(bob.id, { enabled: false });
  hub.emitEvent("web:bob1", { type: "user", text: "关了记忆之后说的", attachments: [], origin: { channel: "web", channelId: "web" } });
  assert.equal(history.readRecords(bob.id).length, 3);
  // 关着记忆时扫一遍：记进来的都标成整理过了，之后打开记忆也不会整理这些
  await curator.sweepOnce({ now: Date.now() + 60_000 });
  assert.deepEqual(history.pendingConversations(bob.id, 0, Date.now() + 60_000), []);
  memory.setMemoryOptions(bob.id, { enabled: true });
});

const say = (text: string) =>
  hub.emitEvent("web:bob1", { type: "user", text, attachments: [], origin: { channel: "web", channelId: "web" } });

test("聊完后整理：回填只供搜索不整理；停够了才整理，改了什么在对话里说一声", async () => {
  // bob 还没回填过：回填 web:bob1 绑着的会话（假 agent 给两句）
  memory.setMemoryOptions(bob.id, { curate: { when: "idle", idleMinutes: 10 } });
  history.writeMeta(bob.id, { extracted: {} });
  hub.conversation("web:bob1")!.perAgent.claude = { sessionId: "s1" };
  const notices: string[] = [];
  const onEvent = (env: { key: string; ev: { type: string; text?: string } }) => {
    if (env.ev.type === "notice" && env.key === "web:bob1") notices.push(env.ev.text ?? "");
  };
  hub.on("event", onEvent as never);
  completeAnswer = { add: ["用户的显示器是 4K 的"], update: [], remove: [] };
  completions.length = 0;
  await curator.sweepOnce({ now: Date.now() + 5 * 60_000 });
  assert.equal(completions.length, 0, "才停了 5 分钟，还不算聊完");
  await curator.sweepOnce({ now: Date.now() + 11 * 60_000 });
  hub.off("event", onEvent as never);
  assert.ok(history.readRecords(bob.id).some((r) => r.t.includes("威联通")), "回填进来了");
  assert.equal(history.readMeta(bob.id).backfilled, true);
  assert.ok(completions.some((p) => p.includes("4K")), "实时录入的那段拿去整理了");
  assert.ok(!completions.some((p) => p.includes("威联通")), "回填的旧对话不拿去整理");
  assert.ok(memory.readMemory(bob.id).items.some((i) => i.text === "用户的显示器是 4K 的" && i.source === "auto"));
  assert.ok(notices.some((n) => /记忆已更新/.test(n)));
  assert.equal(lastModel, undefined, "没指定模型：用 agent 最省的默认");
  // 再扫一遍：没有新话，不再整理
  completions.length = 0;
  await curator.sweepOnce({ now: Date.now() + 22 * 60_000 });
  assert.equal(completions.length, 0);
});

test("每天一次：几段对话合起来整理一次，当天不再整理，不在对话里插提示；第二天再来", async () => {
  memory.setMemoryOptions(bob.id, { curate: { when: "daily", dailyHour: 0 } });
  hub.ensure({ key: "web:bob2", channel: "web", channelId: "web", defaultAgent: "claude", owner: bob.id });
  say("今天开始每天早上 7 点跑步，目标 5 公里");
  hub.emitEvent("web:bob2", { type: "user", text: "我把笔记本换成了 MacBook Pro", attachments: [], origin: { channel: "web", channelId: "web" } });
  const notices: string[] = [];
  const onEvent = (env: { ev: { type: string; text?: string } }) => env.ev.type === "notice" && notices.push(env.ev.text ?? "");
  hub.on("event", onEvent as never);
  completeAnswer = { add: ["用户每天早上 7 点跑步"], update: [], remove: [] };
  completions.length = 0;
  const now = Date.now() + 20 * 60_000;
  await curator.sweepOnce({ now });
  hub.off("event", onEvent as never);
  assert.equal(completions.length, 1, "两段对话合成一次调用");
  assert.ok(completions[0]!.includes("跑步") && completions[0]!.includes("MacBook"));
  assert.equal(notices.length, 0);
  const log = history.readMeta(bob.id).lastCuration!;
  assert.equal(log.conversations, 2);
  assert.deepEqual(log.added, ["用户每天早上 7 点跑步"]);
  // 当天又聊了：不再整理
  say("又聊了一段比较长的话，关于周末去爬山的计划");
  completions.length = 0;
  // 同一天稍后（不跨过零点）
  const endOfDay = new Date(now).setHours(23, 59, 59, 0);
  await curator.sweepOnce({ now: Math.min(now + 3600_000, endOfDay) });
  assert.equal(completions.length, 0);
  // 第二天
  await curator.sweepOnce({ now: now + 86400_000 });
  assert.equal(completions.length, 1);
  assert.ok(completions[0]!.includes("爬山"));
});

test("手动：定时不整理，点「现在整理」才整理（刚聊完的也算）；指定的模型带过去", async () => {
  memory.setMemoryOptions(bob.id, { curate: { when: "manual", agent: "claude", model: "sonnet" } });
  say("我在考虑买一台 4090 的台式机做本地模型");
  completions.length = 0;
  await curator.sweepOnce({ now: Date.now() + 3 * 86400_000 });
  assert.equal(completions.length, 0);
  assert.equal(curator.pendingCount(bob.id), 1);
  const log = await curator.curateNow(bob.id);
  assert.equal(log.conversations, 1);
  assert.equal(lastModel, "sonnet");
  assert.match(log.by ?? "", /sonnet/);
  assert.equal(curator.pendingCount(bob.id), 0);
});

test("指定的 agent 用不了：不悄悄换成别的，对话留着，记下原因", async () => {
  memory.setMemoryOptions(bob.id, { curate: { when: "manual", agent: "codex" } });
  say("这段话要等 Codex 能用了再整理，内容足够长");
  completions.length = 0;
  const log = await curator.curateNow(bob.id);
  assert.equal(completions.length, 0);
  assert.match(log.error ?? "", /Codex/);
  assert.equal(curator.pendingCount(bob.id), 1, "还留着");
  assert.match(history.readMeta(bob.id).lastCuration?.error ?? "", /Codex/);
});

test("不整理：聊过的不攒着，之后再打开也不补整理", async () => {
  memory.setMemoryOptions(bob.id, { curate: { when: "off", agent: "auto" } });
  say("关了整理之后说的一段比较长的话");
  completions.length = 0;
  await curator.sweepOnce({ now: Date.now() + 3600_000 });
  assert.equal(curator.pendingCount(bob.id), 0);
  memory.setMemoryOptions(bob.id, { curate: { when: "idle", idleMinutes: 10 } });
  await curator.sweepOnce({ now: Date.now() + 7200_000 });
  assert.equal(completions.length, 0);
});

test("整理范围：只整理选中专家的对话，范围外的直接跳过、改回来也不补", async () => {
  const experts = await import("../src/core/experts.js");
  const chatty = experts.createExpert(bob.id, { name: "闲聊", engine: "claude", access: "web" });
  hub.ensure({ key: "web:bob3", channel: "web", channelId: "web", defaultAgent: "claude", expert: chatty.id, owner: bob.id });
  const sayIn = (key: string, text: string) =>
    hub.emitEvent(key, { type: "user", text, attachments: [], origin: { channel: "web", channelId: "web" } });
  memory.setMemoryOptions(bob.id, { curate: { when: "manual", scope: "experts", experts: [chatty.id] } });
  assert.deepEqual(memory.readMemory(bob.id).curate.experts, [chatty.id]);
  sayIn("web:bob1", "内置专家那里说的一段比较长的话，关于部署脚本");
  sayIn("web:bob3", "闲聊专家那里说的一段比较长的话，关于周末看电影");
  assert.equal(curator.pendingCount(bob.id), 1, "只数选中专家的");
  completions.length = 0;
  let log = await curator.curateNow(bob.id);
  assert.equal(log.conversations, 1);
  assert.ok(completions[0]!.includes("看电影") && !completions[0]!.includes("部署脚本"));
  memory.setMemoryOptions(bob.id, { curate: { scope: "all" } });
  assert.equal(curator.pendingCount(bob.id), 0, "范围外那段已经跳过了，不补");

  // 内置专家按 agent 选
  memory.setMemoryOptions(bob.id, { curate: { scope: "experts", experts: ["claude"] } });
  sayIn("web:bob1", "内置专家那里又说了一段比较长的话，关于 CI 配置");
  sayIn("web:bob3", "闲聊专家那里又说了一段比较长的话，关于做饭");
  completions.length = 0;
  log = await curator.curateNow(bob.id);
  assert.equal(log.conversations, 1);
  assert.ok(completions[0]!.includes("CI 配置") && !completions[0]!.includes("做饭"));
  memory.setMemoryOptions(bob.id, { curate: { scope: "bogus" as never } });
  assert.equal(memory.readMemory(bob.id).curate.scope, "experts", "不认识的值不改");
  memory.setMemoryOptions(bob.id, { curate: { scope: "chat" as never } });
  assert.equal(memory.readMemory(bob.id).curate.scope, "all", "以前的聊天 / 工作模式范围回到全部");
});

test("记忆 MCP 服务：开了「参考以前的聊天」才有搜索工具；搜的是指定用户的、跳过当前对话", async () => {
  const run = async (opts: { search?: boolean; convKey?: string }, calls: unknown[]) => {
    const spec = memoryMcpSpawn(alice.id, "test", opts);
    const child = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env }, stdio: ["pipe", "pipe", "pipe"] });
    const lines: string[] = [];
    let buf = "";
    child.stdout.setEncoding("utf8");
    const got = new Promise<void>((resolve) => {
      child.stdout.on("data", (d: string) => {
        buf += d;
        let n;
        while ((n = buf.indexOf("\n")) >= 0) {
          lines.push(buf.slice(0, n));
          buf = buf.slice(n + 1);
          if (lines.length === calls.length) resolve();
        }
      });
    });
    for (const c of calls) child.stdin.write(`${JSON.stringify(c)}\n`);
    await got;
    child.stdin.end();
    return lines.map((l) => JSON.parse(l));
  };
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const call = (id: number, query: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "search_past_chats", arguments: { query } } });
  const [off] = await run({}, [list]);
  assert.ok(!off.result.tools.some((t: { name: string }) => t.name === "search_past_chats"));
  const [on, found, skipped] = await run({ search: true, convKey: "web:b" }, [list, call(2, "豆豆"), call(3, "DNS 污染")]);
  assert.ok(on.result.tools.some((t: { name: string }) => t.name === "search_past_chats"));
  assert.match(found.result.content[0].text, /豆豆/);
  assert.match(skipped.result.content[0].text, /没找到/, "当前对话 web:b 被跳过");
});

test("删用户：聊天记录索引一起删", () => {
  history.appendRecords(bob.id, [{ k: "web:x", a: "claude", r: "u", t: "bob 的话", ts: Date.now() }]);
  personal.purgeUserData(bob.id);
  assert.equal(history.readRecords(bob.id).length, 0);
});

// ---------- 审查后补的 ----------

test("清空记忆只清内容，开关和整理设置保留（关着的人清空后不能变成开着）", () => {
  memory.setMemoryOptions(alice.id, { enabled: false, chatHistory: false, curate: { when: "manual" } });
  memory.addMemoryItem(alice.id, "要被清掉的", "user");
  memory.clearMemory(alice.id);
  const m = memory.readMemory(alice.id);
  assert.equal(m.items.length, 0);
  assert.equal(m.enabled, false);
  assert.equal(m.chatHistory, false);
  assert.equal(m.curate.when, "manual");
  memory.setMemoryOptions(alice.id, { enabled: true, chatHistory: true, curate: { when: "daily" } });
});

test("记忆满了：挤掉最旧的非用户条目（自动整理的也算），整理结果如实报告新增和挤掉的", () => {
  memory.clearMemory(alice.id);
  const file = path.join(home, "data", "memory", `${alice.id}.json`);
  const m = memory.readMemory(alice.id);
  const t0 = Date.now() - 86400_000;
  m.items = Array.from({ length: memory.MEMORY_LIMITS.items }, (_, i) => ({
    id: `m_${String(i).padStart(6, "0")}`,
    text: `第 ${i} 条`,
    createdAt: t0 + i,
    updatedAt: t0 + i,
    source: i === 0 ? ("user" as const) : ("auto" as const),
  }));
  fs.writeFileSync(file, JSON.stringify(m));
  const r = curator.applyProposal(alice.id, { add: ["用户新学了日语"], update: [], remove: [] });
  assert.deepEqual(r.added, ["用户新学了日语"]);
  assert.deepEqual(r.removed, ["第 1 条"], "挤掉的是最旧的自动整理条目，不是用户加的第 0 条");
  const items = memory.readMemory(alice.id).items;
  assert.equal(items.length, memory.MEMORY_LIMITS.items);
  assert.ok(items.some((i) => i.text === "第 0 条"));
  memory.clearMemory(alice.id);
});

test("现在整理：记忆关着或设成不整理时不调用模型", async () => {
  const carol = users.createUser({ name: "carol", password: "password-4" });
  hub.ensure({ key: "web:carol1", channel: "web", channelId: "web", defaultAgent: "claude", owner: carol.id });
  history.appendRecords(carol.id, [{ k: "web:carol1", a: "claude", r: "u", t: "一段足够长的、值得整理的话，关于我的工作", ts: Date.now() - 3600_000 }]);
  completions.length = 0;
  memory.setMemoryOptions(carol.id, { enabled: true, curate: { when: "off" } });
  assert.match((await curator.curateNow(carol.id)).error ?? "", /整理已关闭/);
  memory.setMemoryOptions(carol.id, { enabled: false, curate: { when: "manual" } });
  assert.match((await curator.curateNow(carol.id)).error ?? "", /记忆已关闭/);
  assert.equal(completions.length, 0);
});

test("回填不会把还没整理的实时录入标成整理过", async () => {
  const dave = users.createUser({ name: "dave", password: "password-5" });
  memory.setMemoryOptions(dave.id, { enabled: true, chatHistory: false, curate: { when: "manual" } });
  hub.ensure({ key: "web:dave1", channel: "web", channelId: "web", defaultAgent: "claude", owner: dave.id });
  hub.conversation("web:dave1")!.perAgent.claude = { sessionId: "s-dave" };
  // 实时录入了一句（还没整理）。假 agent 的历史里是一天前的两句
  hub.emitEvent("web:dave1", { type: "user", text: "实时录入的一段话，内容足够长要整理", attachments: [], origin: { channel: "web", channelId: "web" } });
  memory.setMemoryOptions(dave.id, { chatHistory: true });
  await curator.backfill(dave.id);
  const pending = history.pendingConversations(dave.id, 0);
  assert.ok(pending.some((p) => p.records.some((r) => r.t.startsWith("实时录入"))), "实时录入的那句还等着整理");
  assert.ok(!pending.some((p) => p.records.some((r) => r.t.includes("威联通"))), "回填的旧对话不整理");
});

test("Claude 的系统提示一律不固定（snapshot: false），改专家、改记忆才生效", async () => {
  const { expertOptions } = await import("../src/agents/claude/session.js");
  const base = { cwd: "/tmp", uploadsDir: "/tmp" };
  const expert = {
    id: "e_1",
    rev: 1,
    name: "聊天助手",
    prompt: "说人话",
    basePrompt: "lean" as const,
    access: "web" as const,
    webSearch: true,
    webFetch: false,
    skills: [],
    mcp: {},
    askMcp: [],
    machineMcp: [],
    subagents: [],
    memory: true,
  };
  const lean = expertOptions({ ...base, expert, memory: { userId: alice.id, prompt: "记忆内容" } });
  const sp = lean.systemPrompt as { type: string; snapshot?: boolean; prompt: string };
  assert.deepEqual([sp.type, sp.snapshot], ["custom", false]);
  assert.match(sp.prompt, /你是「聊天助手」/);
  assert.match(sp.prompt, /说人话/);
  assert.match(sp.prompt, /记忆内容/);
  assert.deepEqual(lean.tools, ["WebSearch"], "只给打开的联网工具");
  assert.deepEqual(lean.settingSources, []);
  assert.equal(lean.strictMcpConfig, true);
  assert.deepEqual(lean.skills, []);
  const work = expertOptions(base).systemPrompt as { type: string; snapshot?: boolean; append?: string };
  const withMemory = expertOptions({ ...base, memory: { userId: alice.id, prompt: "记忆内容" } }).systemPrompt as { append?: string; snapshot?: boolean };
  assert.deepEqual([work.type, work.snapshot, work.append], ["preset", false, undefined]);
  assert.deepEqual([withMemory.append, withMemory.snapshot], ["记忆内容", false]);
});

test("两个进程同时写记忆：一条都不丢（跨进程锁）", async () => {
  memory.clearMemory(alice.id);
  const spec = memoryMcpSpawn(alice.id, "test");
  const child = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env }, stdio: ["pipe", "pipe", "pipe"] });
  const N = 30;
  let got = 0;
  let buf = "";
  child.stdout.setEncoding("utf8");
  const done = new Promise<void>((resolve) => {
    child.stdout.on("data", (d: string) => {
      buf += d;
      let n;
      while ((n = buf.indexOf("\n")) >= 0) {
        buf = buf.slice(n + 1);
        if (++got === N) resolve();
      }
    });
  });
  for (let i = 0; i < N; i++) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: "remember", arguments: { text: `子进程记的第 ${i} 条` } } })}\n`);
  }
  for (let i = 0; i < N; i++) {
    memory.addMemoryItem(alice.id, `主进程记的第 ${i} 条`, "user");
    await new Promise((r) => setImmediate(r));
  }
  await done;
  child.stdin.end();
  const items = memory.readMemory(alice.id).items;
  assert.equal(items.filter((i) => i.text.startsWith("子进程")).length, N);
  assert.equal(items.filter((i) => i.text.startsWith("主进程")).length, N);
  memory.clearMemory(alice.id);
});
