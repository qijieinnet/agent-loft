// 攻击和怪异输入：仓库配置不可信、文件名什么都可能有。普通用法见 workspace-api.test.ts、turn-changes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-hard-home-"));
process.env.AGENT_LOFT_HOME = home;
const { config, loadConfig, saveConfig } = await import("../src/core/config.js");
const git_ = await import("../src/core/git.js");
const { findRepo, gitBranches, gitCommit, gitDiff, gitDiscard, gitStage, gitStatus, gitSwitch, gitUnstage, keepTrees, snapshotTree, gitLog, diffTrees } = git_;
const { listWorkspaceEntries, resolveWorkspaceFile, readWorkspaceText, saveWorkspaceText } = await import("../src/core/workspace-files.js");
loadConfig();

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aim-hard-")));
const workspace = path.join(root, "workspace");
const outside = path.join(root, "outside");
fs.mkdirSync(workspace);
fs.mkdirSync(outside);
saveConfig({ ...structuredClone(config()), workspaceRoot: workspace });
process.on("exit", () => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

let seq = 0;
function repo(): string {
  const dir = path.join(workspace, `r${++seq}`);
  fs.mkdirSync(dir);
  git(dir, "init");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@example.test");
  fs.writeFileSync(path.join(dir, "a.txt"), "一\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  return dir;
}

/** 一个会留下痕迹的程序。返回脚本路径和「它跑过没有」 */
function trap(extra = ""): { script: string; ran: () => boolean } {
  const marker = path.join(outside, `ran-${++seq}`);
  const script = path.join(outside, `evil-${seq}.sh`);
  fs.writeFileSync(script, `#!/bin/sh\necho ran >> ${marker}\n${extra}\ncat\n`, { mode: 0o755 });
  return { script, ran: () => fs.existsSync(marker) };
}

const statusOf = async (dir: string) => gitStatus(dir);

test("攻击：filter 藏在 include 进来的配置文件里，也不能跑", async () => {
  const r = repo();
  const t = trap();
  fs.writeFileSync(path.join(r, ".gitattributes"), "*.txt filter=evil\n");
  git(r, "add", "-A");
  git(r, "commit", "-m", "attrs");
  const inc = path.join(outside, `inc-${seq}`);
  fs.writeFileSync(inc, `[filter "evil"]\n\tclean = ${t.script}\n\tsmudge = ${t.script}\n\tprocess = ${t.script}\n`);
  git(r, "config", "include.path", inc);
  fs.writeFileSync(path.join(r, "a.txt"), "改\n");
  await statusOf(r);
  await gitDiff(r, "a.txt", false);
  assert.equal(await snapshotTree(r), undefined, "这样的仓库不做快照");
  await assert.rejects(gitStage(r, ["a.txt"]), /过滤器/);
  assert.equal(t.ran(), false, "filter 被执行了");
});

test("攻击：core.worktree 指到工作区外面，不算这个工作区的仓库", async () => {
  const r = repo();
  // 工作树指到工作区的上级：工作目录还在工作树之内，git 会把上级目录的所有文件当成仓库内容
  fs.writeFileSync(path.join(outside, "secret-outside.txt"), "外面的\n");
  git(r, "config", "core.worktree", root);
  const found = await findRepo(r);
  assert.equal(found.repo, false);
  // 工作树在工作区之内的还是正常的
  const fine = repo();
  git(fine, "config", "core.worktree", fine);
  assert.equal((await findRepo(fine)).repo, true);
});

test("攻击：快照的引用更新不能触发仓库的钩子", async () => {
  const r = repo();
  const t = trap();
  git(r, "branch", "other");
  for (const name of ["reference-transaction", "post-index-change", "pre-auto-gc", "post-checkout", "post-commit", "pre-commit", "commit-msg", "prepare-commit-msg"]) {
    fs.symlinkSync(t.script, path.join(r, ".git", "hooks", name));
  }
  fs.writeFileSync(path.join(r, "a.txt"), "改\n");
  const tree = await snapshotTree(r);
  assert.ok(tree);
  await keepTrees(r, [tree]);
  await keepTrees(r, []);
  await statusOf(r);
  await gitStage(r, ["a.txt"]);
  await gitCommit(r, "没有钩子");
  await gitSwitch(r, "other");
  assert.equal(t.ran(), false, "钩子被执行了");
});

test("攻击：部分克隆的懒加载不能去执行远程地址里的命令", async () => {
  const r = repo();
  const t = trap("exit 1");
  fs.writeFileSync(path.join(r, "a.txt"), "第二版\n");
  git(r, "add", "-A");
  git(r, "commit", "-m", "second");
  // 删掉旧版本的对象，读它时 git 会去「懒加载」
  const old = git(r, "rev-parse", "HEAD~1:a.txt").trim();
  fs.rmSync(path.join(r, ".git", "objects", old.slice(0, 2), old.slice(2)), { force: true });
  git(r, "config", "core.repositoryformatversion", "1");
  git(r, "config", "extensions.partialClone", "origin");
  git(r, "config", "remote.origin.promisor", "true");
  git(r, "config", "remote.origin.url", `ext::sh ${t.script}`);
  git(r, "config", "protocol.ext.allow", "always");
  git(r, "config", "protocol.allow", "always");
  const log = await gitLog(r, 0, 10);
  await git_.commitFileDiff(r, log.commits[0]!.hash, "a.txt").catch(() => undefined);
  assert.equal(t.ran(), false, "远程命令被执行了");
});

test("攻击：勾选运行钩子时，钩子也拿不到本服务自己的环境变量", async () => {
  const r = repo();
  const dump = path.join(outside, `env-${++seq}`);
  fs.writeFileSync(path.join(r, ".git", "hooks", "pre-commit"), `#!/bin/sh\nenv > ${dump}\n`, { mode: 0o755 });
  process.env.FEISHU_APP_SECRET = "secret-value-for-test";
  try {
    fs.writeFileSync(path.join(r, "a.txt"), "改\n");
    await gitStage(r, ["a.txt"]);
    await gitCommit(r, "跑钩子", { hooks: true });
    const env = fs.readFileSync(dump, "utf8");
    assert.doesNotMatch(env, /secret-value-for-test/);
    assert.doesNotMatch(env, /AGENT_LOFT_HOME/);
    // 钩子是用户明确要跑的，可能要连网（pre-commit 框架要 git clone），禁网的设置不能带给它
    assert.doesNotMatch(env, /GIT_ALLOW_PROTOCOL|GIT_NO_LAZY_FETCH/);
  } finally {
    delete process.env.FEISHU_APP_SECRET;
  }
});

test("全局配置的签名照常用：签名失败时报出原因，不算提交成功", async () => {
  const r = repo();
  const fakeHome = path.join(outside, `home-${++seq}`);
  fs.mkdirSync(fakeHome);
  const gpg = path.join(outside, `gpg-${seq}.sh`);
  const marker = path.join(outside, `gpg-ran-${seq}`);
  fs.writeFileSync(gpg, `#!/bin/sh\necho ran >> ${marker}\nexit 1\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeHome, ".gitconfig"), `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${gpg}\n[user]\n\tname = t\n\temail = t@e\n`);
  fs.writeFileSync(path.join(r, "a.txt"), "改\n");
  await gitStage(r, ["a.txt"]);
  const saved = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    await assert.rejects(gitCommit(r, "要签名"), /gpg|sign/i);
  } finally {
    process.env.HOME = saved;
  }
  assert.equal(fs.existsSync(marker), true, "全局配置的签名程序跑了");
  assert.equal(git(r, "log", "-1", "--format=%s").trim(), "init", "签名失败就没有提交");
  assert.equal((await gitStatus(r)).files[0]!.staged, "modified", "暂存的还在");
});

test("攻击：大小写不同的 .GIT 在不分大小写的文件系统上就是 .git", () => {
  const r = path.join(workspace, `case${++seq}`);
  fs.mkdirSync(path.join(r, ".GIT"), { recursive: true });
  fs.writeFileSync(path.join(r, ".GIT", "config"), "url = https://token@example.test\n");
  fs.mkdirSync(path.join(r, ".SSH"));
  fs.writeFileSync(path.join(r, ".SSH", "config"), "x");
  fs.writeFileSync(path.join(r, "ok.txt"), "x");
  assert.equal(resolveWorkspaceFile(r, ".GIT/config"), undefined);
  assert.equal(resolveWorkspaceFile(r, ".SSH/config"), undefined);
  assert.deepEqual(listWorkspaceEntries(r, "")!.entries.map((e) => e.name), ["ok.txt"]);
  assert.throws(() => saveWorkspaceText(r, ".GIT/config", "x", { force: true }));
});

test("怪文件名：全流程都不会被当成选项、通配符或别的文件", async () => {
  const r = repo();
  const names = ["-rf.txt", "--all", "*.txt", ":(glob)x.txt", "带 空格.txt", "引号\"'.txt", "换\n行.txt", "制\t表.txt", "中文名.txt", "#注释.txt", "a b/c d.txt"];
  fs.mkdirSync(path.join(r, "a b"));
  fs.writeFileSync(path.join(r, "bystander.txt"), "别碰我\n");
  git(r, "add", "bystander.txt");
  git(r, "commit", "-m", "bystander");
  const before = await snapshotTree(r);
  for (const name of names) fs.writeFileSync(path.join(r, name), `内容 ${name}\n`);
  const status = await statusOf(r);
  assert.deepEqual(status.files.map((f) => f.path).sort(), [...names].sort());
  for (const name of names) {
    const diff = await gitDiff(r, name, false);
    assert.ok(diff?.diff.includes(`+内容 ${name.split("\n")[0]}`), `diff ${name}`);
  }
  const after = await snapshotTree(r);
  assert.deepEqual((await diffTrees(r, before!, after!))!.map((f) => f.path).sort(), [...names].sort());
  await gitStage(r, names);
  assert.equal((await statusOf(r)).files.filter((f) => f.staged === "added").length, names.length);
  await gitUnstage(r, names);
  assert.equal((await statusOf(r)).files.filter((f) => f.unstaged === "untracked").length, names.length);
  await gitDiscard(r, names);
  assert.deepEqual((await statusOf(r)).files, []);
  assert.equal(fs.readFileSync(path.join(r, "bystander.txt"), "utf8"), "别碰我\n");
  assert.equal(fs.readFileSync(path.join(r, "a.txt"), "utf8"), "一\n");
  assert.equal(fs.existsSync(path.join(r, "a b")), false, "空目录收拾了");
});

test("没跟踪的目录形式：嵌套的另一个仓库不能被丢弃（那是整个仓库）", async () => {
  const r = repo();
  const inner = path.join(r, "inner");
  fs.mkdirSync(inner);
  git(inner, "init");
  fs.writeFileSync(path.join(inner, "important.txt"), "另一个仓库的文件\n");
  git(inner, "add", "-A");
  git(inner, "commit", "-m", "x");
  const status = await statusOf(r);
  const entry = status.files.find((f) => f.path.startsWith("inner"));
  assert.ok(entry);
  const diff = await gitDiff(r, entry.path, false);
  assert.ok(diff?.note, "没有内容可比较");
  await assert.rejects(gitDiscard(r, [entry.path]), (err: Error & { status?: number }) => err.status === 409 && /目录/.test(err.message));
  assert.equal(fs.readFileSync(path.join(inner, "important.txt"), "utf8"), "另一个仓库的文件\n");
  assert.ok(await snapshotTree(r), "快照不受影响");
});

test("符号链接：丢弃只删链接，不碰它指向的文件", async () => {
  const r = repo();
  const target = path.join(outside, `target-${++seq}.txt`);
  fs.writeFileSync(target, "外面的\n");
  fs.symlinkSync(target, path.join(r, "link.txt"));
  const diff = await gitDiff(r, "link.txt", false);
  assert.doesNotMatch(JSON.stringify(diff), /外面的/, "diff 不跟着链接读");
  await gitDiscard(r, ["link.txt"]);
  assert.equal(fs.lstatSync(path.join(r, "link.txt"), { throwIfNoEntry: false }), undefined);
  assert.equal(fs.readFileSync(target, "utf8"), "外面的\n");
});

test("重命名：暂存后的 diff、取消暂存都带上旧路径", async () => {
  const r = repo();
  git(r, "mv", "a.txt", "b.txt");
  const status = await statusOf(r);
  assert.deepEqual(status.files.map((f) => [f.path, f.oldPath, f.staged]), [["b.txt", "a.txt", "renamed"]]);
  const diff = await gitDiff(r, "b.txt", true);
  assert.match(diff!.diff, /rename from a\.txt/);
  await gitUnstage(r, ["b.txt"]);
  const after = (await statusOf(r)).files.map((f) => [f.path, f.unstaged]).sort();
  assert.deepEqual(after, [["a.txt", "deleted"], ["b.txt", "untracked"]]);
});

test("合并冲突：能看到、不能丢弃，解决后暂存并提交，合并就完成了", async () => {
  const r = repo();
  git(r, "checkout", "-q", "-b", "other");
  fs.writeFileSync(path.join(r, "a.txt"), "other\n");
  git(r, "commit", "-qam", "other");
  git(r, "checkout", "-q", "main");
  fs.writeFileSync(path.join(r, "a.txt"), "main\n");
  git(r, "commit", "-qam", "main");
  assert.throws(() => git(r, "merge", "other"));
  const status = await statusOf(r);
  assert.deepEqual(status.files.map((f) => [f.path, f.unstaged]), [["a.txt", "conflicted"]]);
  const diff = await gitDiff(r, "a.txt", false);
  assert.match(diff!.diff, /<<<<<<<|\+\+<<<</);
  await assert.rejects(gitDiscard(r, ["a.txt"]), /冲突/);
  await assert.rejects(gitCommit(r, "还没解决"), /暂存/);
  fs.writeFileSync(path.join(r, "a.txt"), "解决了\n");
  await gitStage(r, ["a.txt"]);
  await gitCommit(r, "合并 other");
  assert.equal(git(r, "log", "-1", "--format=%s %P").split(" ").length, 4, "是个合并提交（两个父提交）");
  assert.deepEqual((await statusOf(r)).files, []);
  assert.equal(fs.existsSync(path.join(r, ".git", "MERGE_HEAD")), false);
});

test("分离头指针、git worktree、子模块都能用", async () => {
  const r = repo();
  fs.writeFileSync(path.join(r, "a.txt"), "二\n");
  git(r, "commit", "-qam", "second");
  // 分离头指针
  git(r, "checkout", "-q", "--detach", "HEAD~1");
  const detached = await statusOf(r);
  assert.equal(detached.branch, null);
  assert.ok(detached.head);
  assert.equal((await gitBranches(r)).branches.filter((b) => b.current).length, 0);
  await gitSwitch(r, "main");
  assert.equal((await statusOf(r)).branch, "main");
  // worktree：.git 是个文件
  const wt = path.join(workspace, `wt${++seq}`);
  git(r, "worktree", "add", "-q", "-b", "wt-branch", wt);
  const found = await findRepo(wt);
  assert.deepEqual(found, { repo: true, root: wt });
  fs.writeFileSync(path.join(wt, "in-worktree.txt"), "x\n");
  const a = await snapshotTree(wt);
  assert.ok(a);
  assert.equal(git(wt, "show", `${a}:in-worktree.txt`), "x\n");
  await gitStage(wt, ["in-worktree.txt"]);
  assert.equal((await statusOf(wt)).files[0]!.staged, "added");
  assert.deepEqual((await statusOf(r)).files, [], "主工作区不受影响");
  // 子模块
  const lib = repo();
  const parent = repo();
  git(parent, "submodule", "add", "-q", lib, "sub");
  git(parent, "commit", "-qm", "add sub");
  fs.writeFileSync(path.join(parent, "sub", "a.txt"), "子模块里改的\n");
  assert.deepEqual((await statusOf(parent)).files, [], "子模块内部的改动不往里看");
  assert.ok(await snapshotTree(parent));
});

test("大 diff 截断在完整的一行上；二进制和空文件", async () => {
  const r = repo();
  const line = "这一行用来撑大小 ".repeat(20);
  fs.writeFileSync(path.join(r, "big.txt"), `${Array.from({ length: 8000 }, (_, i) => `${i} ${line}`).join("\n")}\n`);
  const big = await gitDiff(r, "big.txt", false);
  // 没跟踪的超过 5 MB 不生成 diff；这个文件 4 MB 多，diff 超过上限要截断
  assert.equal(big?.truncated, true);
  assert.ok(Buffer.byteLength(big!.diff) <= git_.DIFF_MAX_BYTES);
  assert.ok(big!.diff.endsWith("\n"));
  fs.writeFileSync(path.join(r, "empty.txt"), "");
  const empty = await gitDiff(r, "empty.txt", false);
  assert.equal(empty?.truncated, false);
  assert.match(empty!.diff, /new file mode/);
  fs.writeFileSync(path.join(r, "huge.bin"), Buffer.alloc(6 * 1024 * 1024, 65));
  assert.ok((await gitDiff(r, "huge.bin", false))?.note);
});

test("目录消失、git 不可用：报得清楚，不崩", async () => {
  const r = repo();
  const gone = path.join(workspace, `gone${++seq}`);
  assert.equal((await findRepo(gone)).repo, false);
  assert.equal(await snapshotTree(gone), undefined);
  const saved = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const found = await findRepo(r);
    assert.equal(found.repo, false);
    assert.match((found as { reason?: string }).reason ?? "", /git/);
    assert.equal(await snapshotTree(r), undefined);
  } finally {
    process.env.PATH = saved;
  }
});

test("编辑：读不到的也写不到（再确认一次）", () => {
  const r = path.join(workspace, `edit${++seq}`);
  fs.mkdirSync(r);
  fs.writeFileSync(path.join(r, "x.txt"), "x");
  const read = readWorkspaceText(r, "x.txt");
  assert.equal(saveWorkspaceText(r, "x.txt", "y", { baseHash: read.hash }).size, 1);
  assert.throws(() => readWorkspaceText(r, "../x.txt"));
});
