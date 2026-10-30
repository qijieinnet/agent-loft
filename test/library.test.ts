import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-library-"));
process.env.AGENT_LOFT_HOME = home;
// 工作区不能在 agent-loft 的家目录里：那里的文件 agent 回复里提到了也不给看（见 reply-files.ts）
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aim-library-ws-"));
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(path.join(home, "data"), { recursive: true });
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ workspaceRoot: workspace }));

const { loadConfig } = await import("../src/core/config.js");
loadConfig();
const users = await import("../src/core/users.js");
const store = await import("../src/core/store.js");
const uploads = await import("../src/core/uploads.js");
const library = await import("../src/core/library.js");
const { hub } = await import("../src/core/hub.js");

const admin = users.createUser({ name: "boss", password: "password-1", role: "admin" });
const alice = users.createUser({ name: "alice", password: "password-2" });
const bob = users.createUser({ name: "bob", password: "password-3" });

const conv = (key: string, owner?: string) => store.ensureConversation({ key, channel: "web", channelId: "web", agent: "claude", ...(owner ? { owner } : {}) });
conv("web:a1", alice.id);
conv("web:a2", alice.id);
conv("web:b1", bob.id);
conv("feishu:group");

const PNG = Buffer.from("89504e470d0a1a0a0000000d", "hex");
let seq = 0;
const emit = (key: string, ev: unknown, ts = Date.now()) => hub.emit("event", { key, seq: ++seq, ts, ev: ev as never });

library.startLibraryCapture();

/** 模拟用户发出一条带附件的消息 */
function send(key: string, name: string, data: Buffer, ts = Date.now()) {
  const a = uploads.saveBuffer({ key, data, name, subdir: `u${++seq}` });
  emit(key, { type: "user", text: "", attachments: [name], files: [{ kind: a.kind, name: a.name, path: a.path, size: a.size }], origin: { channel: "web" } }, ts);
  return a;
}

test("发出去的附件收进主人的资料库；别人看不到；没主人的对话归管理员", () => {
  send("web:a1", "猫.png", PNG, 1000);
  send("web:a2", "报告.pdf", Buffer.from("%PDF-1.4 test"), 2000);
  send("web:b1", "bob.txt", Buffer.from("hi"), 3000);
  send("feishu:group", "群文件.docx", Buffer.from("docx"), 4000);

  const mine = library.listLibrary(alice).files;
  assert.deepEqual(mine.map((f) => f.name), ["报告.pdf", "猫.png"], "新的在前，只有自己的");
  assert.equal(mine[1]!.kind, "image");
  assert.deepEqual(library.listLibrary(bob).files.map((f) => f.name), ["bob.txt"]);
  assert.deepEqual(library.listLibrary(admin).files.map((f) => f.name), ["群文件.docx"], "管理员看得到没主人的，看不到别人的");
  assert.equal(library.librarySummary(alice).count, 2);
  // 同一个文件再发一次（撤回后重发）：不重复收
  const again = library.listLibrary(alice).files[0]!;
  emit("web:a2", { type: "user", text: "", attachments: [], files: [{ kind: "file", name: again.name, path: again.path, size: again.size }], origin: { channel: "web" } });
  assert.equal(library.librarySummary(alice).count, 2);
});

test("按类型筛、按文件名搜、翻页", () => {
  assert.deepEqual(library.listLibrary(alice, { kind: "image" }).files.map((f) => f.name), ["猫.png"]);
  assert.deepEqual(library.listLibrary(alice, { kind: "file" }).files.map((f) => f.name), ["报告.pdf"]);
  assert.deepEqual(library.listLibrary(alice, { q: "报告" }).files.map((f) => f.name), ["报告.pdf"]);
  const first = library.listLibrary(alice, { limit: 1 });
  assert.equal(first.more, true);
  const last = first.files[0]!;
  const next = library.listLibrary(alice, { limit: 1, before: { at: last.createdAt, id: last.id } });
  assert.deepEqual(next.files.map((f) => f.name), ["猫.png"]);
  assert.equal(next.more, false);
});

test("拿到别的对话里用：硬链接进那条对话的上传目录，不再收一遍；删原件时连它一起删", () => {
  const cat = library.listLibrary(alice, { kind: "image" }).files[0]!;
  const copy = library.attachToConversation(cat, "web:a2");
  assert.ok(copy.path.startsWith(uploads.uploadsDirFor("web:a2")));
  assert.deepEqual(fs.readFileSync(copy.path), PNG);
  assert.equal(copy.mediaType, "image/png");
  emit("web:a2", { type: "user", text: "", attachments: [], files: [{ kind: copy.kind, name: copy.name, path: copy.path, size: copy.size }], origin: { channel: "web" } });
  assert.equal(library.librarySummary(alice).count, 2, "副本不算新文件");
  assert.equal(library.tidyLibrary(Date.now() + 2 * 86400_000).removed, 0);
  assert.ok(fs.existsSync(copy.path), "副本在索引里，不会被当成上传了没发的清掉");

  library.deleteLibraryFile(cat);
  assert.ok(!fs.existsSync(cat.path));
  assert.ok(!fs.existsSync(copy.path), "副本一起删了");
  assert.ok(!fs.existsSync(path.dirname(cat.path)), "空目录也删了");
  assert.deepEqual(library.listLibrary(alice).files.map((f) => f.name), ["报告.pdf"]);
});

test("agent 回复里提到的、这一轮新写出来的文件复制一份收进来；旧文件、代码、用户传的不收", async () => {
  const out = path.join(workspace, "out");
  fs.mkdirSync(out, { recursive: true });
  const old = path.join(out, "旧图.png");
  fs.writeFileSync(old, PNG);
  const past = new Date(Date.now() - 3600_000);
  fs.utimesSync(old, past, past);
  const since = Date.now() - 1000;
  fs.writeFileSync(path.join(out, "chart.png"), PNG);
  fs.writeFileSync(path.join(out, "数据.xlsx"), "xlsx");
  fs.writeFileSync(path.join(out, "main.ts"), "code");
  const uploaded = library.listLibrary(alice).files[0]!.path;
  const text = `画好了：![图](out/chart.png)，表格在 \`${path.join(out, "数据.xlsx")}\`。旧的 out/旧图.png 没动，代码在 out/main.ts，你传的是 ${uploaded}`;
  assert.equal(await library.captureAgentFiles("web:a1", text, since), 2);
  const made = library.listLibrary(alice).files.filter((f) => f.source === "agent");
  assert.deepEqual(made.map((f) => f.name).sort(), ["chart.png", "数据.xlsx"]);
  assert.equal(made.find((f) => f.name === "chart.png")!.kind, "image");
  // 复制进了这条对话的上传目录：原文件之后被改了也不影响
  fs.writeFileSync(path.join(out, "chart.png"), "changed");
  assert.deepEqual(fs.readFileSync(made.find((f) => f.name === "chart.png")!.path), PNG);
});

test("启动时收拾：对话没了的整个删、文件没了的索引删、上传了没发的一天后删；回填只做一次", () => {
  send("web:b1", "bob2.txt", Buffer.from("x"));
  const unsent = uploads.saveBuffer({ key: "web:b1", data: Buffer.from("草稿"), name: "没发.txt", subdir: "draft" });
  const gone = library.listLibrary(bob).files.find((f) => f.name === "bob.txt")!;
  fs.rmSync(gone.path);
  store.deleteConversation("feishu:group");

  assert.ok(library.tidyLibrary().removed >= 2);
  assert.ok(fs.existsSync(unsent.path), "还没满一天");
  assert.deepEqual(library.listLibrary(bob).files.map((f) => f.name), ["bob2.txt"]);
  assert.equal(library.listLibrary(admin).files.length, 0);
  assert.ok(!fs.existsSync(uploads.uploadsDirFor("feishu:group")));

  library.tidyLibrary(Date.now() + 2 * 86400_000);
  assert.ok(!fs.existsSync(unsent.path), "过了一天没发的删了");
  assert.equal(library.listLibrary(bob).files.length, 1, "发过的不动");

  // 回填：升级前就在上传目录里的文件
  const legacy = path.join(uploads.ensureUploadsDir("web:b1"), "以前的.png");
  fs.writeFileSync(legacy, PNG);
  assert.equal(library.backfillLibrary(), 1, "只收没在索引里的");
  assert.equal(library.listLibrary(bob, { kind: "image" }).files[0]?.name, "以前的.png");
  assert.equal(library.backfillLibrary(), 0, "只做一次");
});
