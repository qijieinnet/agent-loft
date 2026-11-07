import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-workspace-home-"));
process.env.AGENT_LOFT_HOME = home;
const { config, loadConfig, saveConfig } = await import("../src/core/config.js");
const { createUser, updateUser } = await import("../src/core/users.js");
const { createSession } = await import("../src/channels/web/auth.js");
const { startWeb, stopWeb } = await import("../src/channels/web/server.js");
const { ensureConversation } = await import("../src/core/store.js");
const { gitStatus, parseStatus } = await import("../src/core/git.js");
loadConfig();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
}

test("parseStatus：分支信息、重命名、带空格的路径、冲突", () => {
  const output = [
    "# branch.oid 0123456789abcdef",
    "# branch.head feature/a b",
    "# branch.upstream origin/feature",
    "# branch.ab +2 -3",
    "1 .M N... 100644 100644 100644 aaa bbb src/a b.ts",
    "1 MM N... 100644 100644 100644 aaa bbb both.ts",
    "2 R. N... 100644 100644 100644 aaa bbb R100 新 名字.ts",
    "旧 名字.ts",
    "u UU N... 100644 100644 100644 100644 aaa bbb ccc con flict.ts",
    "? 没 跟踪.txt",
    "",
  ].join("\0");
  const status = parseStatus("/repo", output);
  assert.equal(status.branch, "feature/a b");
  assert.equal(status.head, "0123456");
  assert.equal(status.upstream, "origin/feature");
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 3);
  assert.deepEqual(status.files, [
    { path: "src/a b.ts", unstaged: "modified" },
    { path: "both.ts", staged: "modified", unstaged: "modified" },
    { path: "新 名字.ts", staged: "renamed", oldPath: "旧 名字.ts" },
    { path: "con flict.ts", unstaged: "conflicted" },
    { path: "没 跟踪.txt", unstaged: "untracked" },
  ]);
});

test("parseStatus：还没有提交、分离头指针", () => {
  const initial = parseStatus("/repo", "# branch.oid (initial)\0# branch.head main\0");
  assert.equal(initial.head, null);
  assert.equal(initial.branch, "main");
  const detached = parseStatus("/repo", "# branch.oid abcdef1234\0# branch.head (detached)\0");
  assert.equal(detached.branch, null);
  assert.equal(detached.head, "abcdef1");
});

test("工作区面板接口", { timeout: 60000 }, async (t) => {
  // 工作区不能放在 AGENT_LOFT_HOME 里：那里面的东西都算敏感
  const base0 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aim-workspace-")));
  t.after(() => {
    fs.rmSync(base0, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const root = path.join(base0, "workspace");
  const outside = path.join(base0, "outside");
  const project = path.join(root, "project");
  const plain = path.join(root, "plain");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(plain);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside-secret");
  fs.writeFileSync(path.join(root, "sibling.txt"), "sibling");

  git(project, "init");
  fs.writeFileSync(path.join(project, "src/a.ts"), "const a = 1;\nconst b = 2;\n");
  fs.writeFileSync(path.join(project, "deleted.txt"), "bye\n");
  fs.writeFileSync(path.join(project, ".env"), "TOKEN=old-token\n");
  fs.writeFileSync(path.join(project, "logo.bin"), Buffer.from([0, 1, 2, 3]));
  git(project, "add", "-A");
  git(project, "commit", "-m", "第一次提交");
  git(project, "branch", "feature");
  fs.writeFileSync(path.join(project, "src/a.ts"), "const a = 1;\nconst b = 3;\n");
  fs.writeFileSync(path.join(project, ".env"), "TOKEN=new-token\n");
  fs.writeFileSync(path.join(project, "logo.bin"), Buffer.from([0, 9, 9, 9]));
  fs.rmSync(path.join(project, "deleted.txt"));
  fs.writeFileSync(path.join(project, "新 文件.txt"), "你好\n");
  fs.writeFileSync(path.join(project, "staged.txt"), "暂存的\n");
  git(project, "add", "staged.txt");
  fs.writeFileSync(path.join(project, "image.html"), "<h1>hi</h1>");
  fs.writeFileSync(path.join(project, "id_rsa"), "PRIVATE");
  fs.symlinkSync(outside, path.join(project, "escape-dir"));
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(project, "escape-file"));
  fs.symlinkSync(path.join(project, "src"), path.join(project, "inside-link"));

  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())));
  const base = `http://127.0.0.1:${port}`;
  saveConfig({ ...structuredClone(config()), workspaceRoot: root, web: { ...config().web, host: "127.0.0.1", port, quotaEnabled: false } });

  const admin = createUser({ name: "boss", password: "password-1", role: "admin" });
  const member = createUser({ name: "member", password: "password-1" });
  const other = createUser({ name: "other", password: "password-1", files: true });
  const adminCookie = `aim_session=${createSession(admin.id, "127.0.0.1", "test")}`;
  const memberCookie = `aim_session=${createSession(member.id, "127.0.0.1", "test")}`;
  const otherCookie = `aim_session=${createSession(other.id, "127.0.0.1", "test")}`;
  await startWeb();
  t.after(() => stopWeb());

  const conv = (key: string, cwd: string, owner = admin.id) => ensureConversation({ key, cwd, owner, channel: "web", channelId: "web", agent: "claude" });
  conv("web:admin", project);
  conv("web:member", project, member.id);
  conv("web:plain", plain);
  conv("web:sub", path.join(project, "src"));

  const get = (key: string, sub: string, params: Record<string, string> = {}, cookie = adminCookie) =>
    fetch(`${base}/api/conversations/${encodeURIComponent(key)}/${sub}?${new URLSearchParams(params)}`, { headers: { Cookie: cookie } });
  const json = async (res: Response) => {
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as any;
  };
  const tree = async (key = "web:admin", p = "") => (await json(await get(key, "workspace-tree", { path: p }))).entries.map((e: { name: string }) => e.name) as string[];

  await t.test("权限：成员默认用不了，开通后只能看自己的会话", async () => {
    const res = await get("web:member", "workspace-tree", {}, memberCookie);
    assert.equal(res.status, 403);
    assert.equal((await get("web:member", "git-status", {}, memberCookie)).status, 403);
    const me = await (await fetch(`${base}/api/me`, { headers: { Cookie: memberCookie } })).json() as { user?: { files?: boolean } };
    assert.equal(me.user?.files, undefined);
    updateUser(member.id, { files: true });
    assert.equal((await get("web:member", "workspace-tree", {}, memberCookie)).status, 200);
    updateUser(member.id, { files: false });
    assert.equal((await get("web:member", "workspace-tree", {}, memberCookie)).status, 403);
    // 开通了也看不到别人的会话
    assert.equal((await get("web:admin", "workspace-tree", {}, otherCookie)).status, 404);
    assert.equal((await get("web:admin", "git-status", {}, otherCookie)).status, 404);
  });

  await t.test("文件树：目录在前，挡掉敏感文件、.git 和跳出工作区的链接", async () => {
    const names = await tree();
    assert.ok(names.includes("src"));
    assert.ok(names.includes("新 文件.txt"));
    assert.ok(names.includes("inside-link"), "工作区内部的链接可以看");
    for (const hidden of [".git", ".env", "id_rsa", "escape-dir", "escape-file"]) assert.ok(!names.includes(hidden), `${hidden} 不该出现`);
    assert.ok(names.indexOf("src") < names.indexOf("image.html"));
    assert.deepEqual(await tree("web:admin", "src"), ["a.ts"]);
    assert.deepEqual(await tree("web:admin", "inside-link"), ["a.ts"]);
  });

  await t.test("文件树：Git 忽略规则、嵌套规则、已跟踪文件和规则刷新", async () => {
    const repo = path.join(root, "ignored-project");
    fs.mkdirSync(path.join(repo, "build"), { recursive: true });
    fs.mkdirSync(path.join(repo, "src"));
    git(repo, "init");
    fs.writeFileSync(path.join(repo, ".gitignore"), "build/\n*.log\n!keep.log\n");
    fs.writeFileSync(path.join(repo, "src/.gitignore"), "!nested.log\n");
    const ignoredNames = ["debug.log", "中文 空格.log", "换\n行.log", "-option.log", ".hidden.log"];
    for (const name of [...ignoredNames, "keep.log", "tracked.log", ".hidden", "build/result.txt", "src/debug.log", "src/nested.log"]) {
      fs.writeFileSync(path.join(repo, name), "content\n");
    }
    git(repo, "add", "-f", "tracked.log");
    conv("web:ignored", repo);
    conv("web:ignored-sub", path.join(repo, "src"));
    const listing = async (key = "web:ignored", p = "") => (await json(await get(key, "workspace-tree", { path: p }))).entries as { name: string; ignored?: boolean }[];
    const entries = await listing();
    for (const name of ["build", ...ignoredNames]) assert.equal(entries.find((e) => e.name === name)?.ignored, true, name);
    for (const name of ["src", "keep.log", "tracked.log", ".hidden", ".gitignore"]) {
      assert.equal(entries.find((e) => e.name === name)?.ignored, undefined, name);
    }
    assert.equal((await listing("web:ignored", "build"))[0]?.ignored, true, "忽略目录的子文件也标记");
    for (const nested of [await listing("web:ignored", "src"), await listing("web:ignored-sub")]) {
      assert.equal(nested.find((e) => e.name === "debug.log")?.ignored, true, "继承父目录规则");
      assert.equal(nested.find((e) => e.name === "nested.log")?.ignored, undefined, "嵌套例外规则");
    }
    fs.writeFileSync(path.join(repo, ".gitignore"), "build/\n");
    assert.equal((await listing()).find((e) => e.name === "debug.log")?.ignored, undefined, "刷新后使用最新规则");
    assert.ok((await listing("web:plain")).every((e) => !e.ignored), "普通目录仍能浏览");
  });

  await t.test("路径：跳不出工作目录", async () => {
    for (const p of ["..", "../plain", "../sibling.txt", path.join(outside, "secret.txt"), ".git", ".git/config", "escape-dir", "escape-dir/secret.txt", "a\0b"]) {
      assert.equal((await get("web:admin", "workspace-tree", { path: p })).status, 404, `tree ${p}`);
      assert.equal((await get("web:admin", "workspace-file", { path: p })).status, 404, `file ${p}`);
    }
    for (const p of [".env", "id_rsa", "escape-file", "src", "不存在.txt", ""]) {
      assert.equal((await get("web:admin", "workspace-file", { path: p })).status, 404, `file ${p}`);
    }
  });

  await t.test("读文件：内容、stat、下载和网页沙箱", async () => {
    const res = await get("web:admin", "workspace-file", { path: "src/a.ts" });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "const a = 1;\nconst b = 3;\n");
    const info = await json(await get("web:admin", "workspace-file", { path: "src/a.ts", stat: "1" }));
    assert.equal(info.name, "a.ts");
    const dl = await get("web:admin", "workspace-file", { path: "image.html", download: "1" });
    assert.match(dl.headers.get("content-disposition") ?? "", /^attachment/);
    // HTML 不能在本站域名下当网页打开
    const raw = await get("web:admin", "workspace-file", { path: "image.html" });
    assert.equal(raw.headers.get("content-type"), "application/octet-stream");
    assert.match(raw.headers.get("content-security-policy") ?? "", /sandbox/);
    const page = await get("web:admin", "workspace-html", { path: "image.html" });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /sandbox|default-src/);
    assert.equal((await get("web:admin", "workspace-html", { path: "src/a.ts" })).status, 404);
  });

  await t.test("不是仓库：status 说明，别的接口 404", async () => {
    assert.deepEqual(await json(await get("web:plain", "git-status")), { repo: false });
    assert.equal((await get("web:plain", "git-diff", { path: "a" })).status, 404);
    assert.equal((await get("web:plain", "git-branches")).status, 404);
  });

  await t.test("status：分支和各类改动", async () => {
    const s = await json(await get("web:admin", "git-status"));
    assert.equal(s.repo, true);
    assert.equal(s.branch, "main");
    assert.equal(s.prefix, "");
    const by = (p: string) => s.files.find((f: { path: string }) => f.path === p);
    assert.equal(by("src/a.ts").unstaged, "modified");
    assert.equal(by("deleted.txt").unstaged, "deleted");
    assert.equal(by("新 文件.txt").unstaged, "untracked");
    assert.equal(by("staged.txt").staged, "added");
    assert.equal(by(".env").sensitive, true);
    assert.equal(by("id_rsa").sensitive, true);
    assert.deepEqual(s.stats, { added: 4, removed: 2 }, "统计文本新增、删除行数，跳过二进制、敏感文件及链接");
    // 工作目录是仓库的子目录：路径还是相对根目录，并给出换算用的前缀
    const sub = await json(await get("web:sub", "git-status"));
    assert.equal(sub.prefix, "src");
    assert.ok(sub.files.some((f: { path: string }) => f.path === "src/a.ts"));
    assert.deepEqual(sub.stats, s.stats, "子目录会话也显示当前分支的总改动");
  });

  await t.test("行数统计：暂存和未暂存按净变动计算，支持未提交仓库、重命名及特殊文件名", async () => {
    const repo = path.join(root, "stats");
    fs.mkdirSync(repo);
    git(repo, "init");
    const file = path.join(repo, "a\tb.txt");
    fs.writeFileSync(file, "first\nsecond\n");
    assert.deepEqual((await gitStatus(repo, { stats: true })).stats, { added: 2, removed: 0 });
    git(repo, "add", "-A");
    fs.writeFileSync(file, "first\nsecond\nthird");
    assert.deepEqual((await gitStatus(repo, { stats: true })).stats, { added: 3, removed: 0 });
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "init");
    assert.deepEqual((await gitStatus(repo, { stats: true })).stats, { added: 0, removed: 0 });
    fs.writeFileSync(file, "first\nstaged\nthird");
    git(repo, "add", "-A");
    fs.writeFileSync(file, "first\nfinal\nextra\nthird");
    const index = git(repo, "ls-files", "--stage");
    assert.deepEqual((await gitStatus(repo, { stats: true })).stats, { added: 2, removed: 1 });
    assert.equal(git(repo, "ls-files", "--stage"), index, "统计不修改暂存区");
    fs.writeFileSync(file, "first\nsecond\nthird");
    assert.deepEqual((await gitStatus(repo, { stats: true })).stats, { added: 0, removed: 0 }, "工作区抵消暂存改动时不重复计数");
    git(repo, "reset", "--hard", "HEAD");
    git(repo, "mv", "a\tb.txt", "renamed\nfile.txt");
    assert.deepEqual((await gitStatus(repo, { stats: true })).stats, { added: 0, removed: 0 }, "纯重命名没有行数变化");
    fs.writeFileSync(path.join(repo, "renamed\nfile.txt"), "first\nsecond\nthird\nextra");
    assert.deepEqual((await gitStatus(repo, { stats: true })).stats, { added: 2, removed: 1 });
  });

  await t.test("diff：修改、新增、已暂存、删除、二进制", async () => {
    const modified = await json(await get("web:admin", "git-diff", { path: "src/a.ts" }));
    assert.match(modified.diff, /^-const b = 2;$/m);
    assert.match(modified.diff, /^\+const b = 3;$/m);
    const untracked = await json(await get("web:admin", "git-diff", { path: "新 文件.txt" }));
    assert.match(untracked.diff, /^\+你好$/m);
    const staged = await json(await get("web:admin", "git-diff", { path: "staged.txt", staged: "1" }));
    assert.match(staged.diff, /^\+暂存的$/m);
    const deleted = await json(await get("web:admin", "git-diff", { path: "deleted.txt" }));
    assert.match(deleted.diff, /^-bye$/m);
    const binary = await json(await get("web:admin", "git-diff", { path: "logo.bin" }));
    assert.equal(binary.binary, true);
    assert.equal(binary.diff, "");
  });

  await t.test("diff：只认改动列表里的文件，敏感文件不给内容", async () => {
    const env = await json(await get("web:admin", "git-diff", { path: ".env" }));
    assert.equal(env.diff, "");
    assert.ok(env.note);
    assert.doesNotMatch(JSON.stringify(env), /token/i);
    const key = await json(await get("web:admin", "git-diff", { path: "id_rsa" }));
    assert.equal(key.diff, "");
    for (const p of ["src", ".", "--help", "*", ":(glob)**", "../sibling.txt", "没改过.txt", ""]) {
      assert.equal((await get("web:admin", "git-diff", { path: p })).status, 404, `diff ${p}`);
    }
    // 这种改动不存在
    assert.equal((await get("web:admin", "git-diff", { path: "src/a.ts", staged: "1" })).status, 404);
    assert.equal((await get("web:admin", "git-diff", { path: "staged.txt" })).status, 404);
  });

  await t.test("分支列表", async () => {
    const { branches } = await json(await get("web:admin", "git-branches"));
    const names = branches.map((b: { name: string }) => b.name).sort();
    assert.deepEqual(names, ["feature", "main"]);
    const main = branches.find((b: { name: string }) => b.name === "main");
    assert.equal(main.current, true);
    assert.equal(main.subject, "第一次提交");
    assert.ok(main.date > 0);
  });

  const post = (key: string, sub: string, body: unknown, cookie = adminCookie, origin = base) =>
    fetch(`${base}/api/conversations/${encodeURIComponent(key)}/${sub}`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const rw = path.join(root, "rw");
  const inRw = (...p: string[]) => path.join(rw, ...p);
  fs.mkdirSync(inRw("sub"), { recursive: true });
  fs.writeFileSync(inRw(".env"), "TOKEN=keep\n");
  fs.symlinkSync(outside, inRw("escape-dir"));
  fs.symlinkSync(path.join(outside, "secret.txt"), inRw("escape-file"));
  fs.mkdirSync(inRw(".git"));
  fs.writeFileSync(inRw(".git", "config"), "keep\n");
  conv("web:rw", rw);
  const text = async (p: string) => (await json(await get("web:rw", "workspace-text", { path: p }))) as { content: string; hash: string };
  const save = (p: string, content: string, extra: Record<string, unknown> = {}) => post("web:rw", "workspace-save", { path: p, content, ...extra });

  await t.test("写接口：成员没开通不能用，跨站请求不行", async () => {
    conv("web:rw-member", rw, member.id);
    fs.writeFileSync(inRw("guard.txt"), "原样\n");
    for (const [sub, body] of [
      ["workspace-save", { path: "guard.txt", content: "改了", force: true }],
      ["workspace-new", { dir: "", name: "x.txt" }],
      ["workspace-rename", { path: "guard.txt", name: "y.txt" }],
      ["workspace-delete", { path: "guard.txt" }],
    ] as const) {
      assert.equal((await post("web:rw-member", sub, body, memberCookie)).status, 403, sub);
      assert.equal((await post("web:rw", sub, body, adminCookie, "https://other.example")).status, 403, `${sub} 跨站`);
      // 开通了也动不了别人的会话
      assert.equal((await post("web:rw", sub, body, otherCookie)).status, 404, `${sub} 别人的会话`);
    }
    assert.equal(fs.readFileSync(inRw("guard.txt"), "utf8"), "原样\n");
    fs.rmSync(inRw("guard.txt"));
  });

  await t.test("保存：hash 对得上才写，冲突不覆盖，覆盖要明说", async () => {
    fs.writeFileSync(inRw("a.txt"), "一\n");
    const first = await text("a.txt");
    assert.equal(first.content, "一\n");
    const saved = await json(await save("a.txt", "二\n", { baseHash: first.hash }));
    assert.equal(fs.readFileSync(inRw("a.txt"), "utf8"), "二\n");
    assert.notEqual(saved.hash, first.hash);
    // 拿旧 hash 再存：被别人改过，不覆盖
    const stale = await save("a.txt", "三\n", { baseHash: first.hash });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { conflict: string }).conflict, "changed");
    assert.equal(fs.readFileSync(inRw("a.txt"), "utf8"), "二\n");
    // 没给 hash 也不行
    assert.equal((await save("a.txt", "三\n")).status, 409);
    await json(await save("a.txt", "三\n", { force: true }));
    assert.equal(fs.readFileSync(inRw("a.txt"), "utf8"), "三\n");
    // 文件被删了：算冲突，明说才重新创建
    const before = await text("a.txt");
    fs.rmSync(inRw("a.txt"));
    const gone = await save("a.txt", "四\n", { baseHash: before.hash });
    assert.equal(gone.status, 409);
    assert.equal(((await gone.json()) as { conflict: string }).conflict, "deleted");
    assert.equal(fs.existsSync(inRw("a.txt")), false);
    await json(await save("a.txt", "四\n", { baseHash: before.hash, force: true }));
    assert.equal(fs.readFileSync(inRw("a.txt"), "utf8"), "四\n");
    assert.equal(fs.readdirSync(rw).filter((n) => n.endsWith(".aloft-tmp")).length, 0, "不留临时文件");
  });

  await t.test("保存：字节不变、权限不变、链接还是链接", async () => {
    fs.writeFileSync(inRw("run.sh"), "#!/bin/sh\r\necho 你好\r\n");
    fs.chmodSync(inRw("run.sh"), 0o750);
    const crlf = await text("run.sh");
    assert.equal(crlf.content, "#!/bin/sh\r\necho 你好\r\n", "换行符原样给前端");
    await json(await save("run.sh", "#!/bin/sh\r\necho 改\r\n", { baseHash: crlf.hash }));
    assert.equal(fs.readFileSync(inRw("run.sh"), "utf8"), "#!/bin/sh\r\necho 改\r\n");
    assert.equal(fs.statSync(inRw("run.sh")).mode & 0o777, 0o750);
    // 工作区内的链接：改的是它指向的文件，链接还在
    fs.writeFileSync(inRw("target.txt"), "原文\n");
    fs.symlinkSync(inRw("target.txt"), inRw("link.txt"));
    const linked = await text("link.txt");
    await json(await save("link.txt", "新文\n", { baseHash: linked.hash }));
    assert.equal(fs.readFileSync(inRw("target.txt"), "utf8"), "新文\n");
    assert.equal(fs.lstatSync(inRw("link.txt")).isSymbolicLink(), true);
    // 只读文件不能靠改名绕过（root 不受文件权限限制，这项跳过）
    if (process.getuid?.() !== 0) {
      fs.writeFileSync(inRw("ro.txt"), "只读\n");
      fs.chmodSync(inRw("ro.txt"), 0o444);
      const ro = await text("ro.txt");
      assert.equal((await save("ro.txt", "改\n", { baseHash: ro.hash })).status, 403);
      assert.equal(fs.readFileSync(inRw("ro.txt"), "utf8"), "只读\n");
    }
  });

  await t.test("编辑：太大、二进制、非 UTF-8 不给编辑", async () => {
    fs.writeFileSync(inRw("big.txt"), Buffer.alloc(1024 * 1024 + 1, 97));
    fs.writeFileSync(inRw("bin.dat"), Buffer.from([1, 0, 2]));
    fs.writeFileSync(inRw("gbk.txt"), Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
    assert.equal((await get("web:rw", "workspace-text", { path: "big.txt" })).status, 413);
    assert.equal((await get("web:rw", "workspace-text", { path: "bin.dat" })).status, 415);
    assert.equal((await get("web:rw", "workspace-text", { path: "gbk.txt" })).status, 415);
  });

  await t.test("写不到工作目录外、敏感文件和 .git", async () => {
    for (const p of [".env", ".git/config", "../sibling.txt", "../outside.txt", path.join(outside, "x.txt"), "escape-file", "escape-dir/secret.txt", "escape-dir/new.txt", "new.pem", "id_rsa", "sub/../../sibling.txt", ""]) {
      const res = await save(p, "坏", { force: true });
      assert.ok([400, 403, 404].includes(res.status), `save ${p} → ${res.status}`);
    }
    assert.equal(fs.readFileSync(inRw(".env"), "utf8"), "TOKEN=keep\n");
    assert.equal(fs.readFileSync(inRw(".git", "config"), "utf8"), "keep\n");
    assert.equal(fs.readFileSync(path.join(root, "sibling.txt"), "utf8"), "sibling");
    assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "outside-secret");
    assert.equal(fs.lstatSync(inRw("escape-file")).isSymbolicLink(), true, "链接没有被换成文件");
    assert.deepEqual(fs.readdirSync(outside).filter((n) => n === "new.txt" || n === "x.txt"), []);
    assert.equal(fs.existsSync(path.join(root, "outside.txt")), false);
    assert.equal(fs.existsSync(inRw("new.pem")), false);
  });

  await t.test("新建", async () => {
    assert.deepEqual(await (await post("web:rw", "workspace-new", { dir: "sub", name: "新 文件.md" })).json(), { path: "sub/新 文件.md", type: "file" });
    assert.equal(fs.readFileSync(inRw("sub", "新 文件.md"), "utf8"), "");
    assert.equal((await post("web:rw", "workspace-new", { dir: "sub", name: "目录", type: "dir" })).status, 201);
    assert.equal(fs.statSync(inRw("sub", "目录")).isDirectory(), true);
    assert.equal((await post("web:rw", "workspace-new", { dir: "sub", name: "目录" })).status, 409);
    for (const name of ["", ".", "..", "a/b", "../x", "a\\b", "a\nb", 123]) {
      assert.equal((await post("web:rw", "workspace-new", { dir: "", name })).status, 400, `名字 ${name}`);
    }
    for (const name of [".env", "id_rsa", "server.key", ".git"]) {
      assert.ok([403, 409].includes((await post("web:rw", "workspace-new", { dir: "", name })).status), `名字 ${name}`);
    }
    assert.equal((await post("web:rw", "workspace-new", { dir: ".git", name: "hooks.sh" })).status, 404);
    assert.equal((await post("web:rw", "workspace-new", { dir: "escape-dir", name: "x" })).status, 404);
    assert.equal((await post("web:rw", "workspace-new", { dir: "..", name: "x" })).status, 404);
    assert.equal(fs.existsSync(path.join(outside, "x")), false);
  });

  await t.test("重命名", async () => {
    fs.writeFileSync(inRw("old.txt"), "内容");
    fs.writeFileSync(inRw("other.txt"), "别的");
    assert.deepEqual(await (await post("web:rw", "workspace-rename", { path: "old.txt", name: "new.txt" })).json(), { path: "new.txt" });
    assert.equal(fs.readFileSync(inRw("new.txt"), "utf8"), "内容");
    assert.equal((await post("web:rw", "workspace-rename", { path: "new.txt", name: "other.txt" })).status, 409);
    assert.equal(fs.readFileSync(inRw("other.txt"), "utf8"), "别的", "不覆盖同名文件");
    // Linux 上只差大小写的是两个文件，也不能覆盖
    fs.writeFileSync(inRw("Other.txt"), "大写的");
    assert.equal((await post("web:rw", "workspace-rename", { path: "other.txt", name: "Other.txt" })).status, 409);
    assert.equal(fs.readFileSync(inRw("Other.txt"), "utf8"), "大写的");
    assert.equal((await post("web:rw", "workspace-rename", { path: "new.txt", name: "stolen.pem" })).status, 403);
    assert.equal((await post("web:rw", "workspace-rename", { path: ".env", name: "plain.txt" })).status, 404, "不能把敏感文件改成能看的名字");
    assert.equal((await post("web:rw", "workspace-rename", { path: "new.txt", name: "../up.txt" })).status, 400);
    assert.equal((await post("web:rw", "workspace-rename", { path: "../sibling.txt", name: "x" })).status, 403);
    // 符号链接：改的是链接自己
    assert.equal((await post("web:rw", "workspace-rename", { path: "escape-dir", name: "escape-dir2" })).status, 200);
    assert.equal(fs.lstatSync(inRw("escape-dir2")).isSymbolicLink(), true);
    assert.equal((await post("web:rw", "workspace-rename", { path: "escape-dir2", name: "escape-dir" })).status, 200);
  });

  await t.test("删除", async () => {
    fs.writeFileSync(inRw("del.txt"), "x");
    assert.equal((await post("web:rw", "workspace-delete", { path: "del.txt" })).status, 200);
    assert.equal(fs.existsSync(inRw("del.txt")), false);
    fs.mkdirSync(inRw("deldir", "inner"), { recursive: true });
    fs.writeFileSync(inRw("deldir", "inner", "x.txt"), "x");
    assert.equal((await post("web:rw", "workspace-delete", { path: "deldir" })).status, 200);
    assert.equal(fs.existsSync(inRw("deldir")), false);
    // 指向外面的链接：只删链接，外面的东西还在
    assert.equal((await post("web:rw", "workspace-delete", { path: "escape-dir" })).status, 200);
    assert.equal(fs.existsSync(inRw("escape-dir")), false);
    assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "outside-secret");
    for (const p of ["", ".", "..", "../sibling.txt", ".env", ".git", ".git/config", "不存在.txt", path.join(outside, "secret.txt")]) {
      assert.ok([403, 404].includes((await post("web:rw", "workspace-delete", { path: p })).status), `删除 ${p}`);
    }
    assert.equal(fs.existsSync(rw), true);
    assert.equal(fs.existsSync(inRw(".env")), true);
    assert.equal(fs.existsSync(path.join(root, "sibling.txt")), true);
    // 别的会话的工作目录（或者它的上级）不能删、不能改名
    fs.mkdirSync(inRw("nested", "project"), { recursive: true });
    conv("web:nested", inRw("nested", "project"));
    assert.equal((await post("web:rw", "workspace-delete", { path: "nested" })).status, 409);
    assert.equal((await post("web:rw", "workspace-delete", { path: "nested/project" })).status, 409);
    assert.equal((await post("web:rw", "workspace-rename", { path: "nested", name: "moved" })).status, 409);
    assert.equal(fs.existsSync(inRw("nested", "project")), true);
  });

  await t.test("上传", async () => {
    const upload = (params: Record<string, string>, data: Uint8Array) =>
      fetch(`${base}/api/conversations/web%3Arw/workspace-upload?${new URLSearchParams(params)}`, { method: "POST", headers: { Cookie: adminCookie, Origin: base }, body: data });
    const bytes = new Uint8Array([0, 255, 1, 254]);
    assert.equal((await upload({ dir: "sub", name: "图.bin" }, bytes)).status, 201);
    assert.deepEqual([...fs.readFileSync(inRw("sub", "图.bin"))], [...bytes]);
    const again = await upload({ dir: "sub", name: "图.bin" }, new Uint8Array([9]));
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as { conflict: string }).conflict, "exists");
    assert.deepEqual([...fs.readFileSync(inRw("sub", "图.bin"))], [...bytes]);
    assert.equal((await upload({ dir: "sub", name: "图.bin", overwrite: "1" }, new Uint8Array([9]))).status, 201);
    assert.deepEqual([...fs.readFileSync(inRw("sub", "图.bin"))], [9]);
    // 不能覆盖目录、链接
    assert.equal((await upload({ dir: "", name: "sub", overwrite: "1" }, bytes)).status, 409);
    assert.equal((await upload({ dir: "", name: "escape-file", overwrite: "1" }, bytes)).status, 409);
    assert.equal(fs.lstatSync(inRw("escape-file")).isSymbolicLink(), true);
    for (const [dir, name] of [["", "../up.bin"], ["", ".env"], ["..", "x.bin"], [".git", "x"], ["", ""]] as const) {
      assert.ok([400, 403, 404].includes((await upload({ dir, name, overwrite: "1" }, bytes)).status), `上传 ${dir}/${name}`);
    }
    assert.equal(fs.readFileSync(inRw(".env"), "utf8"), "TOKEN=keep\n");
  });

  // ---------- Git 操作 ----------
  let gitRepoSeq = 0;
  /** 一个新仓库和它的会话。a.txt、b.txt 是提交过的 */
  const gitRepo = () => {
    const repo = path.join(root, `ops${++gitRepoSeq}`);
    fs.mkdirSync(repo);
    git(repo, "init");
    fs.writeFileSync(path.join(repo, "a.txt"), "一\n");
    fs.writeFileSync(path.join(repo, "b.txt"), "二\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "第一次提交");
    git(repo, "config", "user.name", "t");
    git(repo, "config", "user.email", "t@example.test");
    const key = `web:ops${gitRepoSeq}`;
    conv(key, repo);
    const act = (sub: string, body: unknown) => post(key, sub, body);
    return { repo, key, act, file: (...p: string[]) => path.join(repo, ...p) };
  };
  const porcelain = (repo: string) => git(repo, "status", "--porcelain=v1", "-uall").split("\n").filter(Boolean).sort();

  await t.test("暂存和取消暂存，只认改动列表里的文件", async () => {
    const { repo, act, file } = gitRepo();
    fs.writeFileSync(file("a.txt"), "改\n");
    fs.writeFileSync(file("new.txt"), "新\n");
    fs.rmSync(file("b.txt"));
    assert.equal((await act("git-stage", { paths: ["a.txt", "new.txt", "b.txt"] })).status, 200);
    assert.deepEqual(porcelain(repo), ["A  new.txt", "D  b.txt", "M  a.txt"]);
    assert.equal((await act("git-unstage", { paths: ["a.txt", "new.txt"] })).status, 200);
    assert.deepEqual(porcelain(repo), [" M a.txt", "?? new.txt", "D  b.txt"]);
    assert.equal(fs.readFileSync(file("a.txt"), "utf8"), "改\n", "取消暂存不动工作区");
    for (const paths of [["没有改动.txt"], ["."], ["*"], [":(glob)**"], ["--all"], ["../x"], [], "a.txt", [1], undefined]) {
      for (const sub of ["git-stage", "git-unstage", "git-discard"]) {
        assert.ok([400, 404].includes((await act(sub, { paths })).status), `${sub} ${JSON.stringify(paths)}`);
      }
    }
    assert.deepEqual(porcelain(repo), [" M a.txt", "?? new.txt", "D  b.txt"]);
  });

  await t.test("还没有提交的仓库也能暂存、取消暂存、提交", async () => {
    const repo = path.join(root, "unborn");
    fs.mkdirSync(repo);
    git(repo, "init");
    git(repo, "config", "user.name", "t");
    git(repo, "config", "user.email", "t@example.test");
    fs.writeFileSync(path.join(repo, "first.txt"), "x\n");
    conv("web:unborn", repo);
    assert.equal((await post("web:unborn", "git-stage", { paths: ["first.txt"] })).status, 200);
    assert.equal((await post("web:unborn", "git-unstage", { paths: ["first.txt"] })).status, 200);
    assert.deepEqual(porcelain(repo), ["?? first.txt"]);
    assert.deepEqual((await json(await get("web:unborn", "git-log"))).commits, []);
    await post("web:unborn", "git-stage", { paths: ["first.txt"] });
    assert.equal((await post("web:unborn", "git-commit", { message: "第一次" })).status, 200);
    assert.equal(git(repo, "log", "--format=%s").trim(), "第一次");
    const { commits } = await json(await get("web:unborn", "git-log"));
    const { files } = await json(await get("web:unborn", "git-commit-files", { hash: commits[0].hash }));
    assert.deepEqual(files.map((f: { path: string; status: string }) => `${f.status}:${f.path}`), ["added:first.txt"]);
  });

  await t.test("丢弃：只动指定的文件，暂存的不动，没跟踪的删掉", async () => {
    const { repo, act, file } = gitRepo();
    fs.writeFileSync(file("a.txt"), "丢掉\n");
    fs.writeFileSync(file("b.txt"), "保留\n");
    assert.equal((await act("git-discard", { paths: ["a.txt"] })).status, 200);
    assert.equal(fs.readFileSync(file("a.txt"), "utf8"), "一\n");
    assert.equal(fs.readFileSync(file("b.txt"), "utf8"), "保留\n", "别的文件不动");
    // 暂存之后又改：恢复成暂存的样子，不是 HEAD
    fs.writeFileSync(file("a.txt"), "暂存的\n");
    git(repo, "add", "a.txt");
    fs.writeFileSync(file("a.txt"), "又改了\n");
    assert.equal((await act("git-discard", { paths: ["a.txt"] })).status, 200);
    assert.equal(fs.readFileSync(file("a.txt"), "utf8"), "暂存的\n");
    // 只有暂存的改动：不能丢
    assert.equal((await act("git-discard", { paths: ["a.txt"] })).status, 409);
    // 没跟踪的：删掉，空目录也收拾
    fs.mkdirSync(file("deep", "er"), { recursive: true });
    fs.writeFileSync(file("deep", "er", "x.txt"), "x");
    fs.writeFileSync(file("deep", "keep.txt"), "y");
    assert.equal((await act("git-discard", { paths: ["deep/er/x.txt"] })).status, 200);
    assert.equal(fs.existsSync(file("deep", "er")), false);
    assert.equal(fs.existsSync(file("deep", "keep.txt")), true);
    // 删掉的文件能找回来
    fs.rmSync(file("b.txt"));
    assert.equal((await act("git-discard", { paths: ["b.txt"] })).status, 200);
    assert.equal(fs.readFileSync(file("b.txt"), "utf8"), "二\n");
  });

  await t.test("敏感文件不能暂存、丢弃、提交", async () => {
    const { repo, act, file } = gitRepo();
    fs.writeFileSync(file(".env"), "TOKEN=x\n");
    assert.equal((await act("git-stage", { paths: [".env"] })).status, 403);
    assert.equal((await act("git-discard", { paths: [".env"] })).status, 403);
    assert.equal(fs.existsSync(file(".env")), true);
    assert.deepEqual(porcelain(repo), ["?? .env"]);
    // 在终端里暂存了：面板不帮着提交
    git(repo, "add", "-f", ".env");
    const res = await act("git-commit", { message: "带密钥" });
    assert.equal(res.status, 403);
    assert.equal(git(repo, "log", "--format=%s").trim(), "第一次提交");
  });

  await t.test("提交：要有说明和暂存的内容，只提交暂存的", async () => {
    const { repo, act, file } = gitRepo();
    assert.equal((await act("git-commit", { message: "没东西" })).status, 409);
    fs.writeFileSync(file("a.txt"), "提交的\n");
    fs.writeFileSync(file("b.txt"), "没暂存的\n");
    git(repo, "add", "a.txt");
    assert.equal((await act("git-commit", { message: "   " })).status, 400);
    assert.equal((await act("git-commit", {})).status, 400);
    const ok = await json(await act("git-commit", { message: "-看起来像选项的说明\n\n第二段" }));
    assert.match(ok.short, /^[0-9a-f]+$/);
    assert.equal(git(repo, "log", "-1", "--format=%B").trim(), "-看起来像选项的说明\n\n第二段");
    assert.deepEqual(porcelain(repo), [" M b.txt"]);
    assert.equal(git(repo, "show", "HEAD:a.txt"), "提交的\n");
  });

  await t.test("提交：默认不跑钩子，勾选才跑；仓库配置的签名程序不跑", async () => {
    const { repo, act, file } = gitRepo();
    const marker = path.join(outside, "hook-ran");
    const hook = file(".git", "hooks", "pre-commit");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, `#!/bin/sh\necho ran >> ${marker}\n`, { mode: 0o755 });
    fs.rmSync(marker, { force: true });
    fs.writeFileSync(file("a.txt"), "1\n");
    git(repo, "add", "a.txt");
    assert.equal((await act("git-commit", { message: "不跑钩子" })).status, 200);
    assert.equal(fs.existsSync(marker), false, "默认不跑");
    fs.writeFileSync(file("a.txt"), "2\n");
    git(repo, "add", "a.txt");
    assert.equal((await act("git-commit", { message: "跑钩子", hooks: true })).status, 200);
    assert.equal(fs.existsSync(marker), true, "勾选了才跑");
    // 钩子拒绝：提交失败，原因告诉用户
    fs.writeFileSync(hook, "#!/bin/sh\necho 不许提交 >&2\nexit 1\n", { mode: 0o755 });
    fs.writeFileSync(file("a.txt"), "3\n");
    git(repo, "add", "a.txt");
    const refused = await act("git-commit", { message: "被拒绝", hooks: true });
    assert.equal(refused.status, 409);
    assert.match(((await refused.json()) as { error: string }).error, /不许提交/);
    fs.rmSync(hook);
    // .git/config 里的签名程序
    const gpg = path.join(outside, "evil-gpg.sh");
    const gpgMarker = path.join(outside, "gpg-ran");
    fs.writeFileSync(gpg, `#!/bin/sh\necho ran >> ${gpgMarker}\nexit 1\n`, { mode: 0o755 });
    git(repo, "config", "commit.gpgsign", "true");
    git(repo, "config", "gpg.program", gpg);
    assert.equal((await act("git-commit", { message: "不签名" })).status, 200);
    assert.equal(fs.existsSync(gpgMarker), false);
  });

  await t.test("切换分支：不丢改动；新建分支；跟踪远程分支", async () => {
    const { repo, act, file } = gitRepo();
    git(repo, "branch", "other");
    assert.equal((await act("git-switch", { branch: "other" })).status, 200);
    assert.equal(git(repo, "branch", "--show-current").trim(), "other");
    fs.writeFileSync(file("a.txt"), "other 的\n");
    git(repo, "commit", "-qam", "other");
    assert.equal((await act("git-switch", { branch: "main" })).status, 200);
    // 有改动会被覆盖：git 拒绝，改动还在
    fs.writeFileSync(file("a.txt"), "没提交的\n");
    const refused = await act("git-switch", { branch: "other" });
    assert.equal(refused.status, 409);
    assert.match(((await refused.json()) as { error: string }).error, /覆盖/);
    assert.equal(git(repo, "branch", "--show-current").trim(), "main");
    assert.equal(fs.readFileSync(file("a.txt"), "utf8"), "没提交的\n");
    git(repo, "checkout", "--", "a.txt");
    for (const branch of ["不存在", "--orphan=x", "HEAD~1", "-", "", 1, undefined]) {
      assert.ok([400, 404].includes((await act("git-switch", { branch })).status), `切到 ${branch}`);
    }
    assert.equal(git(repo, "branch", "--show-current").trim(), "main");
    // 新建
    assert.equal((await act("git-branch-new", { name: "feature/新功能" })).status, 200);
    assert.equal(git(repo, "branch", "--show-current").trim(), "feature/新功能");
    assert.equal((await act("git-branch-new", { name: "feature/新功能" })).status, 409);
    for (const name of ["", " ", "-x", "--orphan", "a b", "a..b", "a~1", "a^", "a:b", "x.lock", "HEAD", 1]) {
      assert.equal((await act("git-branch-new", { name })).status, 400, `分支名 ${name}`);
    }
    // 远程分支：建一个跟踪它的本地分支
    git(repo, "update-ref", "refs/remotes/origin/remote/x", "HEAD");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(repo, "config", "remote.origin.url", "/nonexistent");
    git(repo, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    assert.equal((await act("git-switch", { branch: "origin/remote/x" })).status, 200);
    assert.equal(git(repo, "branch", "--show-current").trim(), "remote/x");
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "@{upstream}").trim(), "origin/remote/x");
    // 本地已经有同名分支：切过去，不新建
    assert.equal((await act("git-switch", { branch: "origin/main" })).status, 200);
    assert.equal(git(repo, "branch", "--show-current").trim(), "main");
  });

  await t.test("自定义 filter 的仓库：所有写操作都拒绝，也不跑 filter", async () => {
    const { repo, act, file } = gitRepo();
    const marker = path.join(outside, "crypt-ran");
    const script = path.join(outside, "crypt.sh");
    fs.writeFileSync(script, `#!/bin/sh\necho ran >> ${marker}\ncat\n`, { mode: 0o755 });
    fs.writeFileSync(file(".gitattributes"), "secret.txt filter=git-crypt\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "attrs");
    git(repo, "branch", "other");
    fs.writeFileSync(file("secret.txt"), "明文\n");
    fs.writeFileSync(file("a.txt"), "改\n");
    git(repo, "config", "filter.git-crypt.clean", script);
    git(repo, "config", "filter.git-crypt.smudge", script);
    git(repo, "config", "filter.git-crypt.required", "true");
    for (const [sub, body] of [
      ["git-stage", { paths: ["secret.txt"] }],
      ["git-unstage", { paths: ["a.txt"] }],
      ["git-discard", { paths: ["a.txt"] }],
      ["git-commit", { message: "x" }],
      ["git-switch", { branch: "other" }],
      ["git-branch-new", { name: "y" }],
    ] as const) {
      const res = await act(sub, body);
      assert.equal(res.status, 409, sub);
      assert.match(((await res.json()) as { error: string }).error, /过滤器/, sub);
    }
    assert.equal(fs.readFileSync(file("a.txt"), "utf8"), "改\n");
    assert.deepEqual(porcelain(repo), [" M a.txt", "?? secret.txt"]);
    // 读还是可以的
    assert.equal((await act("git-stage", { paths: [] })).status, 409);
    assert.equal(fs.existsSync(marker), false);
  });

  await t.test("agent 在这个仓库里干活：不能丢弃、切分支；可以暂存、提交", async () => {
    const { hub } = await import("../src/core/hub.js");
    const { repo, key, act, file } = gitRepo();
    git(repo, "branch", "other");
    fs.writeFileSync(file("a.txt"), "改\n");
    const inflight = (hub as unknown as { inflight: Map<string, number> }).inflight;
    inflight.set(key, 1);
    try {
      for (const [sub, body] of [["git-discard", { paths: ["a.txt"] }], ["git-switch", { branch: "other" }], ["git-branch-new", { name: "y" }], ["git-turn-revert", { id: "x" }]] as const) {
        const res = await act(sub, body);
        assert.equal(res.status, 409, sub);
        assert.match(((await res.json()) as { error: string }).error, /agent 正在/, sub);
      }
      assert.equal(fs.readFileSync(file("a.txt"), "utf8"), "改\n");
      assert.equal((await act("git-stage", { paths: ["a.txt"] })).status, 200);
      assert.equal((await act("git-commit", { message: "干活时提交" })).status, 200);
    } finally {
      inflight.delete(key);
    }
  });

  await t.test("Git 写操作：权限和跨站", async () => {
    const { key, repo, file } = gitRepo();
    fs.writeFileSync(file("a.txt"), "改\n");
    conv(`${key}-m`, repo, member.id);
    for (const [sub, body] of [["git-stage", { paths: ["a.txt"] }], ["git-discard", { paths: ["a.txt"] }], ["git-commit", { message: "x" }], ["git-switch", { branch: "main" }], ["git-turn-revert", { id: "x" }]] as const) {
      assert.equal((await post(`${key}-m`, sub, body, memberCookie)).status, 403, `${sub} 没开通`);
      assert.equal((await post(key, sub, body, adminCookie, "https://other.example")).status, 403, `${sub} 跨站`);
      assert.equal((await post(key, sub, body, otherCookie)).status, 404, `${sub} 别人的会话`);
    }
    assert.equal(fs.readFileSync(file("a.txt"), "utf8"), "改\n");
    assert.deepEqual(porcelain(repo), [" M a.txt"]);
  });

  await t.test("提交历史：分页、文件列表、diff，不接受奇怪的编号", async () => {
    const { repo, key, file } = gitRepo();
    for (let i = 0; i < 55; i++) {
      fs.writeFileSync(file("a.txt"), `${i}\n`);
      git(repo, "commit", "-qam", `提交 ${i}`);
    }
    const first = await json(await get(key, "git-log"));
    assert.equal(first.commits.length, 50);
    assert.equal(first.more, true);
    assert.equal(first.commits[0].subject, "提交 54");
    const second = await json(await get(key, "git-log", { skip: "50" }));
    assert.equal(second.commits.length, 6);
    assert.equal(second.more, false);
    assert.equal(second.commits[5].subject, "第一次提交");
    const latest = first.commits[0].hash;
    const { files } = await json(await get(key, "git-commit-files", { hash: latest }));
    assert.deepEqual(files.map((f: { path: string }) => f.path), ["a.txt"]);
    const diff = await json(await get(key, "git-commit-diff", { hash: latest, path: "a.txt" }));
    assert.match(diff.diff, /^-53$/m);
    assert.match(diff.diff, /^\+54$/m);
    // 第一个提交：和空目录比
    const root0 = second.commits[5].hash;
    const rootFiles = await json(await get(key, "git-commit-files", { hash: root0 }));
    assert.deepEqual(rootFiles.files.map((f: { path: string }) => f.path).sort(), ["a.txt", "b.txt"]);
    assert.equal((await get(key, "git-commit-diff", { hash: latest, path: "b.txt" })).status, 404);
    for (const hash of ["HEAD", "HEAD~1", "--all", "main", "zzzzzzz", "", "0".repeat(40)]) {
      assert.equal((await get(key, "git-commit-files", { hash })).status, 404, `编号 ${hash}`);
      assert.equal((await get(key, "git-commit-diff", { hash, path: "a.txt" })).status, 404, `编号 ${hash}`);
    }
    // 历史里的敏感文件：列出来，不给内容
    fs.writeFileSync(file(".env"), "TOKEN=history-secret\n");
    git(repo, "add", "-f", ".env");
    git(repo, "commit", "-qm", "误提交");
    const head = git(repo, "rev-parse", "HEAD").trim();
    const leaked = await json(await get(key, "git-commit-diff", { hash: head, path: ".env" }));
    assert.equal(leaked.diff, "");
    assert.doesNotMatch(JSON.stringify(leaked), /history-secret/);
  });

  await t.test("仓库配置不能让 git 执行程序", async () => {
    const evil = path.join(root, "evil");
    fs.mkdirSync(evil);
    git(evil, "init");
    const marker = path.join(outside, "pwned");
    const script = path.join(outside, "evil.sh");
    fs.writeFileSync(script, `#!/bin/sh\necho pwned >> ${marker}\ncat\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(evil, "a.txt"), "one\n");
    fs.writeFileSync(path.join(evil, ".gitattributes"), "*.txt filter=evil diff=evil\n");
    git(evil, "add", "-A");
    git(evil, "commit", "-m", "init");
    for (const [k, v] of [
      ["core.fsmonitor", script],
      ["diff.external", script],
      ["diff.evil.textconv", script],
      ["diff.evil.command", script],
      ["filter.evil.clean", script],
      ["filter.evil.smudge", script],
      ["filter.evil.process", script],
      ["core.pager", script],
    ] as const) git(evil, "config", k, v);
    fs.rmSync(marker, { force: true });
    fs.writeFileSync(path.join(evil, "a.txt"), "two\n");
    fs.writeFileSync(path.join(evil, "new.txt"), "new\n");
    conv("web:evil", evil);
    const s = await json(await get("web:evil", "git-status"));
    assert.ok(s.files.some((f: { path: string }) => f.path === "a.txt"));
    const d = await json(await get("web:evil", "git-diff", { path: "a.txt" }));
    assert.match(d.diff, /^\+two$/m);
    await json(await get("web:evil", "git-diff", { path: "new.txt" }));
    await json(await get("web:evil", "git-branches"));
    assert.equal(fs.existsSync(marker), false, "配置里的程序被执行了");
  });

  await t.test("不会向上找到工作区之外的仓库", async () => {
    // 工作区所在的目录是个仓库：工作区里的普通目录不算在仓库里
    git(base0, "init");
    assert.deepEqual(await json(await get("web:plain", "git-status")), { repo: false });
    fs.rmSync(path.join(base0, ".git"), { recursive: true, force: true });
  });
});
