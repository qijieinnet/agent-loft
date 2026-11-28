import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-worktree-home-"));
process.env.AGENT_LOFT_HOME = home;

const { config, listWorkspaceDirs, loadConfig, saveConfig } = await import("../src/core/config.js");
const { createUser } = await import("../src/core/users.js");
const { createSession } = await import("../src/channels/web/auth.js");
const { startWeb, stopWeb } = await import("../src/channels/web/server.js");
const { getConversation } = await import("../src/core/store.js");
const { hub } = await import("../src/core/hub.js");
const { gitStatus } = await import("../src/core/git.js");
const { beginTurnSnapshot, finishTurnSnapshot, turnState } = await import("../src/core/turn-changes.js");
const {
  createWorktree,
  listRepoWorktrees,
  mergeWorktree,
  probeWorktree,
  removeWorktree,
  worktreeStatus,
  worktreesBaseDir,
} = await import("../src/core/worktree.js");
const { dirsOf, inDir } = await import("../src/channels/web/conv-pages.js");

loadConfig();

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=tester", "-c", "user.email=tester@example.test", "-c", "init.defaultBranch=main", ...args],
    { cwd, encoding: "utf8" },
  );
}

function makeWorkspace(t: test.TestContext): { root: string; project: string; plain: string; emptyRepo: string } {
  const base0 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aim-wt-ws-")));
  t.after(() => fs.rmSync(base0, { recursive: true, force: true }));
  const root = path.join(base0, "workspace");
  const project = path.join(root, "demo-app");
  const plain = path.join(root, "plain");
  const emptyRepo = path.join(root, "empty-repo");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(plain, { recursive: true });
  fs.mkdirSync(emptyRepo, { recursive: true });
  git(emptyRepo, "init");
  git(project, "init");
  fs.writeFileSync(path.join(project, "README.md"), "# demo\n");
  fs.writeFileSync(path.join(project, "src/index.ts"), "export const v = 1;\n");
  git(project, "add", "-A");
  git(project, "commit", "-m", "init");
  saveConfig({ ...structuredClone(config()), workspaceRoot: root, web: { ...config().web, quotaEnabled: false } });
  return { root, project, plain, emptyRepo };
}

test("probeWorktree & createWorktree：基础校验、子目录保留、并发隔离与防嵌套", async (t) => {
  const { root, project, plain, emptyRepo } = makeWorkspace(t);

  assert.equal((await probeWorktree(plain)).eligible, false);
  assert.equal((await probeWorktree(emptyRepo)).eligible, false);

  const probed = await probeWorktree(project);
  assert.equal(probed.eligible, true);
  assert.equal(probed.branch, "main");
  assert.ok(probed.branches?.includes("main"));

  // 从子目录创建隔离工作树：保留子目录路径且主仓库保持干净
  const sub = path.join(project, "src");
  const created1 = await createWorktree(sub);
  assert.equal(created1.worktree.repoRoot, project);
  assert.equal(created1.worktree.projectCwd, sub);
  assert.equal(created1.cwd, path.join(created1.worktree.root, "src"));
  assert.match(created1.worktree.branch, /^aloft\/wt-[0-9a-f]{6}$/);
  assert.equal(created1.worktree.baseBranch, "main");
  assert.ok(created1.worktree.root.startsWith(worktreesBaseDir()));

  // 主仓库没有被污染
  const mainSt = await gitStatus(project);
  assert.equal(mainSt.files.length, 0);

  // 工作区目录列表默认隐藏内部 .agent-loft-worktrees
  const listing = listWorkspaceDirs("");
  assert.ok(listing && !listing.dirs.some((d) => d.name === ".agent-loft-worktrees"));

  // 从已有 worktree 再建新 worktree：仍为同级工作树而非嵌套
  const created2 = await createWorktree(created1.cwd, { branch: "feat/parallel", baseBranch: "main" });
  assert.equal(created2.worktree.repoRoot, project);
  assert.equal(created2.worktree.projectCwd, sub);
  assert.equal(created2.worktree.branch, "feat/parallel");
  assert.ok(!created2.worktree.root.startsWith(created1.worktree.root + path.sep));

  // 重复分支名与非法分支名被拒绝
  await assert.rejects(() => createWorktree(project, { branch: "feat/parallel" }), /已经存在/);
  await assert.rejects(() => createWorktree(project, { branch: "bad..name" }), /不合法/);

  // 列出工作树包含主仓库 + 2 个隔离工作树
  const list = await listRepoWorktrees(project);
  assert.equal(list.length, 3);

  // 两个隔离工作树和主仓库各自的轮次快照互不干扰
  await beginTurnSnapshot("c:main", project, () => false);
  fs.writeFileSync(path.join(project, "main-only.txt"), "m\n");
  const mainTurn = await finishTurnSnapshot("c:main", project, () => false);
  assert.ok(mainTurn);

  await beginTurnSnapshot("c:wt1", created1.cwd, () => false);
  fs.writeFileSync(path.join(created1.worktree.root, "wt1.txt"), "1\n");
  const wt1Turn = await finishTurnSnapshot("c:wt1", created1.cwd, () => false);
  assert.ok(wt1Turn);

  await beginTurnSnapshot("c:wt2", created2.cwd, () => false);
  fs.writeFileSync(path.join(created2.worktree.root, "wt2.txt"), "2\n");
  const wt2Turn = await finishTurnSnapshot("c:wt2", created2.cwd, () => false);
  assert.ok(wt2Turn);

  // 三个仓库/工作树的快照引用都完好保留
  assert.equal((await turnState(project, mainTurn.id)).state, "applied");
  assert.equal((await turnState(created1.worktree.root, wt1Turn.id)).state, "applied");
  assert.equal((await turnState(created2.worktree.root, wt2Turn.id)).state, "applied");

  // 清理其中一个工作树不会破坏主仓库和另一个工作树的快照
  fs.rmSync(path.join(created1.worktree.root, "wt1.txt"));
  await removeWorktree(created1.worktree, { force: false, deleteBranch: true });
  assert.equal((await turnState(project, mainTurn.id)).state, "applied");
  assert.equal((await turnState(created2.worktree.root, wt2Turn.id)).state, "applied");

  // 清理安全边界：拒绝删除受管目录外的任意路径
  await assert.rejects(
    () => removeWorktree({ ...created2.worktree, root: project }, { force: true }),
    /不是 agent-loft 管理的隔离工作树/,
  );

  // 脏工作树非强制删除报错，强制删除成功
  await assert.rejects(() => removeWorktree(created2.worktree, { force: false }), /未提交的改动/);
  const rm2 = await removeWorktree(created2.worktree, { force: true, deleteBranch: true });
  assert.equal(rm2.removed, true);
  assert.equal(rm2.branchDeleted, true);
  assert.equal(fs.existsSync(created2.worktree.root), false);

  // 清理主仓库测试文件，确认 workspaceRoot 本身是 git 仓库时被拒绝
  fs.rmSync(path.join(project, "main-only.txt"));
  saveConfig({ ...structuredClone(config()), workspaceRoot: project });
  assert.equal((await probeWorktree(project)).eligible, false);
  await assert.rejects(() => createWorktree(project), /工作区根目录本身就是 Git 仓库/);
  saveConfig({ ...structuredClone(config()), workspaceRoot: root });
});

test("mergeWorktree：普通合并、压缩合并与冲突自动回滚", async (t) => {
  const { project } = makeWorkspace(t);

  // 1) 普通合并 + 自动清理
  const wt1 = await createWorktree(project, { branch: "feat/merge-clean" });
  fs.writeFileSync(path.join(wt1.worktree.root, "a.txt"), "hello\n");
  // 未提交时拒绝合并
  await assert.rejects(() => mergeWorktree(wt1.worktree, { mode: "merge" }), /未提交的改动/);
  git(wt1.worktree.root, "add", "a.txt");
  git(wt1.worktree.root, "commit", "-m", "add a");

  const st1 = await worktreeStatus(wt1.worktree);
  assert.equal(st1.ahead, 1);
  assert.equal(st1.behind, 0);
  assert.equal(st1.dirty, false);
  assert.equal(st1.diffStats?.files, 1);
  assert.equal(st1.diffStats?.added, 1);

  // 主仓库有未提交改动时拒绝合并
  fs.writeFileSync(path.join(project, "dirty.tmp"), "x\n");
  await assert.rejects(() => mergeWorktree(wt1.worktree, { mode: "merge" }), /主仓库还有/);
  fs.rmSync(path.join(project, "dirty.tmp"));

  const merged1 = await mergeWorktree(wt1.worktree, { mode: "merge", cleanup: true, deleteBranch: true });
  assert.equal(merged1.merged, true);
  assert.equal(merged1.cleaned, true);
  assert.equal(merged1.branchDeleted, true);
  assert.equal(fs.readFileSync(path.join(project, "a.txt"), "utf8"), "hello\n");
  assert.equal(fs.existsSync(wt1.worktree.root), false);

  // 2) Squash 合并：多条提交压成一条 + 删除分支
  const wt2 = await createWorktree(project, { branch: "feat/squash" });
  fs.writeFileSync(path.join(wt2.worktree.root, "b.txt"), "line1\n");
  git(wt2.worktree.root, "add", "b.txt");
  git(wt2.worktree.root, "commit", "-m", "step 1");
  fs.appendFileSync(path.join(wt2.worktree.root, "b.txt"), "line2\n");
  git(wt2.worktree.root, "add", "b.txt");
  git(wt2.worktree.root, "commit", "-m", "step 2");

  const merged2 = await mergeWorktree(wt2.worktree, { mode: "squash", message: "feat: squash b", cleanup: true, deleteBranch: true });
  assert.equal(merged2.merged, true);
  assert.equal(merged2.cleaned, true);
  assert.equal(merged2.branchDeleted, true);
  assert.equal(git(project, "log", "-1", "--format=%s").trim(), "feat: squash b");
  assert.equal(fs.readFileSync(path.join(project, "b.txt"), "utf8"), "line1\nline2\n");

  // 3) 冲突时自动中止/回滚，主仓库保持干净
  const wt3 = await createWorktree(project, { branch: "feat/conflict" });
  fs.writeFileSync(path.join(wt3.worktree.root, "README.md"), "# from worktree\n");
  git(wt3.worktree.root, "add", "README.md");
  git(wt3.worktree.root, "commit", "-m", "wt edit");

  fs.writeFileSync(path.join(project, "README.md"), "# from main\n");
  git(project, "add", "README.md");
  git(project, "commit", "-m", "main edit");

  await assert.rejects(() => mergeWorktree(wt3.worktree, { mode: "merge" }), /合并产生冲突/);
  assert.equal((await gitStatus(project)).files.length, 0);
  assert.equal(fs.readFileSync(path.join(project, "README.md"), "utf8"), "# from main\n");

  await assert.rejects(() => mergeWorktree(wt3.worktree, { mode: "squash" }), /合并产生冲突/);
  assert.equal((await gitStatus(project)).files.length, 0);

  await removeWorktree(wt3.worktree, { force: true, deleteBranch: true });
});

test("Web API：创建隔离会话、按原项目归组、合并、删除与删项目联动清理", { timeout: 60000 }, async (t) => {
  const { root, project, plain } = makeWorkspace(t);

  // 注册一个轻量假驱动以便创建 Web 会话
  if (!hub.driver("claude")) {
    hub.registerDriver({
      id: "claude",
      label: "Claude Code",
      capabilities: { effort: true, fork: true, cost: true, streaming: true },
      start: async () => {},
      stop: async () => {},
      createSession: () => {
        throw new Error("not used");
      },
      listSessions: async () => [],
      sessionExists: async () => false,
      readHistory: async () => [],
      listModels: async () => [],
      catalog: async () => [],
      defaults: async () => ({}),
      statusLines: async () => [],
      diagnose: (err) => ({ chatMessage: String(err), consoleHint: "", kind: "unknown" }),
    });
  }

  const probeSrv = net.createServer();
  await new Promise<void>((resolve, reject) => probeSrv.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = (probeSrv.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => probeSrv.close((err) => (err ? reject(err) : resolve())));
  const base = `http://127.0.0.1:${port}`;
  saveConfig({ ...structuredClone(config()), workspaceRoot: root, web: { ...config().web, host: "127.0.0.1", port, quotaEnabled: false } });

  const admin = createUser({ name: "wt-admin", password: "password-1", role: "admin" });
  const member = createUser({ name: "wt-member", password: "password-1" });
  const adminCookie = `aim_session=${createSession(admin.id, "127.0.0.1", "test")}`;
  const memberCookie = `aim_session=${createSession(member.id, "127.0.0.1", "test")}`;

  await startWeb();
  t.after(async () => {
    await stopWeb();
    fs.rmSync(home, { recursive: true, force: true });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req = async (cookie: string, p: string, opts: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: any }> => {
    const res = await fetch(`${base}${p}`, {
      method: opts.method ?? "GET",
      headers: {
        Cookie: cookie,
        Origin: base,
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  // 1) /api/dirs/git 权限与探测
  const mProbe = await req(memberCookie, `/api/dirs/git?path=${encodeURIComponent(project)}`);
  assert.equal(mProbe.status, 200);
  assert.equal(mProbe.data.eligible, false);

  const aProbe = await req(adminCookie, `/api/dirs/git?path=${encodeURIComponent(project)}`);
  assert.equal(aProbe.status, 200);
  assert.equal(aProbe.data.eligible, true);
  assert.equal(aProbe.data.branch, "main");

  const pProbe = await req(adminCookie, `/api/dirs/git?path=${encodeURIComponent(plain)}`);
  assert.equal(pProbe.data.eligible, false);

  // 2) 未开通工作区的成员不能创建隔离工作树会话
  const mCreate = await req(memberCookie, "/api/conversations", { method: "POST", body: { agent: "claude", cwd: project, worktree: true } });
  assert.equal(mCreate.status, 403);

  // 3) 管理员创建隔离工作树会话，侧栏按原项目目录归组
  const created = await req(adminCookie, "/api/conversations", {
    method: "POST",
    body: { agent: "claude", cwd: project, worktree: { branch: "feat/api-wt" } },
  });
  assert.equal(created.status, 200);
  const convInfo = created.data;
  assert.equal(convInfo.worktree.branch, "feat/api-wt");
  assert.equal(convInfo.worktree.projectCwd, project);
  assert.notEqual(convInfo.cwd, project);
  assert.equal(inDir(project)(convInfo), true);
  assert.deepEqual(dirsOf([convInfo]).map((d) => d.dir), [project]);

  const page = await req(adminCookie, `/api/conversations/page?scope=dir&dir=${encodeURIComponent(project)}`);
  assert.equal(page.status, 200);
  assert.ok(page.data.conversations.some((c: { key: string }) => c.key === convInfo.key));

  // 4) 在隔离工作树中提交改动并通过 API 合并回主分支并清理
  fs.writeFileSync(path.join(convInfo.cwd, "feature.ts"), "export const ok = true;\n");
  git(convInfo.cwd, "add", "feature.ts");
  git(convInfo.cwd, "commit", "-m", "feat: add feature");

  const wtGet = await req(adminCookie, `/api/conversations/${encodeURIComponent(convInfo.key)}/git-worktree`);
  assert.equal(wtGet.status, 200);
  assert.equal(wtGet.data.worktree.ahead, 1);
  assert.equal(wtGet.data.worktree.dirty, false);

  const merged = await req(adminCookie, `/api/conversations/${encodeURIComponent(convInfo.key)}/git-worktree-merge`, {
    method: "POST",
    body: { mode: "merge", cleanup: true, deleteBranch: true },
  });
  assert.equal(merged.status, 200);
  assert.equal(merged.data.merged, true);
  assert.equal(merged.data.cleaned, true);
  assert.equal(merged.data.info.cwd, project);
  assert.equal(merged.data.info.worktree, undefined);
  assert.equal(fs.readFileSync(path.join(project, "feature.ts"), "utf8"), "export const ok = true;\n");

  // 5) 删除会话时清理工作树：脏目录先 409 不删会话，force 后清理并隐藏
  const created2 = await req(adminCookie, "/api/conversations", {
    method: "POST",
    body: { agent: "claude", cwd: project, worktree: { branch: "feat/del-wt" } },
  });
  assert.equal(created2.status, 200);
  const k2 = created2.data.key as string;
  const wt2Root = created2.data.worktree.root as string;
  fs.writeFileSync(path.join(wt2Root, "unsaved.txt"), "wip\n");

  const delDirty = await req(adminCookie, `/api/conversations/${encodeURIComponent(k2)}?worktree=remove`, { method: "DELETE" });
  assert.equal(delDirty.status, 409);
  assert.equal(delDirty.data.conflict, "dirty");
  assert.equal(getConversation(k2)?.hidden, undefined);

  const delForce = await req(adminCookie, `/api/conversations/${encodeURIComponent(k2)}?worktree=force`, { method: "DELETE" });
  assert.equal(delForce.status, 200);
  assert.equal(getConversation(k2)?.hidden, true);
  assert.equal(fs.existsSync(wt2Root), false);

  // 6) 删除项目时联动清理关联的隔离工作树
  const created3 = await req(adminCookie, "/api/conversations", {
    method: "POST",
    body: { agent: "claude", cwd: project, worktree: { branch: "feat/proj-del" } },
  });
  assert.equal(created3.status, 200);
  const wt3Root = created3.data.worktree.root as string;
  assert.equal(fs.existsSync(wt3Root), true);

  const delProj = await req(adminCookie, "/api/dirs", { method: "DELETE", body: { path: project } });
  assert.equal(delProj.status, 200);
  assert.equal(fs.existsSync(project), false);
  assert.equal(fs.existsSync(wt3Root), false);
});
