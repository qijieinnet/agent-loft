// 工作区面板的获取、拉取、推送。连的是真的 HTTP Git 服务（git http-backend），走的就是生产环境的协议白名单，
// 没有为测试放开 file:// 这样的口子。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-git-remote-home-"));
process.env.AGENT_LOFT_HOME = home;
const { config, loadConfig, saveConfig } = await import("../src/core/config.js");
const { canUseGitRemote, createUser, updateUser } = await import("../src/core/users.js");
const { createSession } = await import("../src/channels/web/auth.js");
const { startWeb, stopWeb } = await import("../src/channels/web/server.js");
const { ensureConversation } = await import("../src/core/store.js");
const { GitError, gitFetch, gitPull, gitPush, gitStatus } = await import("../src/core/git.js");
loadConfig();

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aim-git-remote-")));
const workspace = path.join(root, "workspace");
const served = path.join(root, "served");
const outside = path.join(root, "outside");
for (const dir of [workspace, served, outside]) fs.mkdirSync(dir);
saveConfig({ ...structuredClone(config()), workspaceRoot: workspace });
process.on("exit", () => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * 把 served 目录下的裸仓库用 git http-backend 提供出来。
 * 放在单独的进程里：下面准备仓库用的是同步的 execFileSync，同一个进程里的服务器会被它堵住
 */
const BACKEND = `
const http = require("node:http");
const { spawn } = require("node:child_process");
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const cgi = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: process.argv[1],
      GIT_HTTP_EXPORT_ALL: "1",
      REMOTE_USER: "t",
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers["content-type"] || "",
      ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] } : {}),
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  req.pipe(cgi.stdin);
  let head = Buffer.alloc(0);
  let body = false;
  cgi.stdout.on("data", (chunk) => {
    if (body) return void res.write(chunk);
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\\r\\n\\r\\n");
    if (end < 0) return;
    const lines = head.subarray(0, end).toString().split("\\r\\n");
    const status = lines.find((l) => /^status:/i.test(l));
    for (const line of lines) if (!/^status:/i.test(line)) res.setHeader(line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim());
    res.statusCode = status ? Number(status.split(/\\s+/)[1]) : 200;
    body = true;
    res.write(head.subarray(end + 4));
  });
  cgi.stdout.on("end", () => res.end());
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;
const backend = spawn(process.execPath, ["-e", BACKEND, served], { stdio: ["ignore", "pipe", "inherit"] });
process.on("exit", () => backend.kill());
const backendPort = await new Promise<number>((resolve) => backend.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim()))));
// 不能让它拖着测试进程不退出
backend.unref();
backend.stdout.destroy();
const backendUrl = `http://127.0.0.1:${backendPort}`;

let seq = 0;

/** 一个裸仓库，加上工作区里两个克隆：mine 是被测的，theirs 模拟别人往远程提交 */
function setup(): { bare: string; url: string; mine: string; theirs: string; commit: (dir: string, file: string, content: string) => void } {
  const name = `r${++seq}.git`;
  const bare = path.join(served, name);
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "ignore" });
  git(bare, "config", "http.receivepack", "true");
  const url = `${backendUrl}/${name}`;
  const commit = (dir: string, file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
    git(dir, "add", "-A", "-f");
    git(dir, "commit", "-m", `改 ${file}`);
  };
  const seedDir = path.join(root, `seed${seq}`);
  git(root, "clone", "-q", url, seedDir);
  git(seedDir, "checkout", "-q", "-B", "main");
  commit(seedDir, "a.txt", "一\n");
  git(seedDir, "push", "-q", "origin", "main");
  const mine = path.join(workspace, `mine${seq}`);
  const theirs = path.join(root, `theirs${seq}`);
  git(root, "clone", "-q", url, mine);
  git(root, "clone", "-q", url, theirs);
  for (const dir of [mine, theirs]) {
    git(dir, "config", "user.name", "t");
    git(dir, "config", "user.email", "t@example.test");
  }
  return { bare, url, mine, theirs, commit };
}

async function refused(op: () => Promise<unknown>, pattern: RegExp, status?: number): Promise<void> {
  await assert.rejects(op, (err: unknown) => {
    assert.ok(err instanceof GitError, String(err));
    assert.match(err.message, pattern);
    if (status) assert.equal(err.status, status);
    return true;
  });
}

test("获取：更新落后数，不动本地分支和工作区", async () => {
  const { mine, theirs, commit } = setup();
  commit(theirs, "b.txt", "二\n");
  git(theirs, "push", "-q");
  const head = git(mine, "rev-parse", "HEAD");
  const result = await gitFetch(mine);
  assert.deepEqual(result, { remote: "origin", ahead: 0, behind: 1 });
  assert.equal(git(mine, "rev-parse", "HEAD"), head);
  assert.equal(fs.existsSync(path.join(mine, "b.txt")), false);
});

test("拉取：快进；已是最新；工作区改动会被覆盖时拒绝且不丢；分叉时不合并", async () => {
  const { mine, theirs, commit } = setup();
  assert.equal((await gitPull(mine)).updated, false);

  commit(theirs, "b.txt", "二\n");
  git(theirs, "push", "-q");
  assert.equal((await gitPull(mine)).updated, true);
  assert.equal(fs.readFileSync(path.join(mine, "b.txt"), "utf8"), "二\n");

  // 没提交的改动和要拉下来的文件撞了
  commit(theirs, "b.txt", "三\n");
  git(theirs, "push", "-q");
  fs.writeFileSync(path.join(mine, "b.txt"), "我的\n");
  await refused(() => gitPull(mine), /没提交的改动/);
  assert.equal(fs.readFileSync(path.join(mine, "b.txt"), "utf8"), "我的\n");
  git(mine, "checkout", "--", "b.txt");

  // 分叉：本地也有新提交
  commit(mine, "c.txt", "本地\n");
  const head = git(mine, "rev-parse", "HEAD");
  await refused(() => gitPull(mine), /分叉/);
  assert.equal(git(mine, "rev-parse", "HEAD"), head);
  assert.equal(git(mine, "status", "--porcelain"), "");
});

test("拉取：配置了 pull.rebase 也还是只快进；分离头指针和没有上游时拒绝", async () => {
  const { mine, theirs, commit } = setup();
  git(mine, "config", "pull.rebase", "true");
  commit(theirs, "b.txt", "二\n");
  git(theirs, "push", "-q");
  assert.equal((await gitPull(mine)).updated, true);

  git(mine, "checkout", "-q", "-b", "no-upstream");
  await refused(() => gitPull(mine), /还没有上游/);
  git(mine, "checkout", "-q", "--detach");
  await refused(() => gitPull(mine), /分离头指针/);
  await refused(() => gitPush(mine), /分离头指针/);
});

test("推送：普通推送、发布新分支；从不强制", async () => {
  const { bare, mine, theirs, commit } = setup();
  commit(mine, "b.txt", "二\n");
  const pushed = await gitPush(mine);
  assert.deepEqual(pushed, { remote: "origin", branch: "main", published: false });
  assert.equal(git(bare, "rev-parse", "main"), git(mine, "rev-parse", "HEAD"));

  git(mine, "checkout", "-q", "-b", "feature/新");
  commit(mine, "c.txt", "三\n");
  assert.equal((await gitStatus(mine)).upstream, undefined);
  assert.equal((await gitPush(mine)).published, true);
  assert.equal((await gitStatus(mine)).upstream, "origin/feature/新");
  git(mine, "checkout", "-q", "main");

  // 远程有本地没有的提交：拒绝，远程不变
  git(theirs, "pull", "-q");
  commit(theirs, "d.txt", "四\n");
  git(theirs, "push", "-q");
  const remoteHead = git(bare, "rev-parse", "main");
  commit(mine, "e.txt", "五\n");
  await refused(() => gitPush(mine), /先拉取/);
  assert.equal(git(bare, "rev-parse", "main"), remoteHead);
});

test("推送：只动当前分支，不受 push.default 和 remote.*.push 影响；跟踪的分支名字不同时不猜", async () => {
  const { bare, mine, commit } = setup();
  git(mine, "branch", "other");
  git(mine, "config", "push.default", "matching");
  git(mine, "config", "remote.origin.push", "refs/heads/*:refs/heads/*");
  commit(mine, "b.txt", "二\n");
  await gitPush(mine);
  assert.throws(() => git(bare, "rev-parse", "--verify", "other"));

  git(mine, "checkout", "-q", "-b", "feature", "--track", "origin/main");
  commit(mine, "c.txt", "三\n");
  const before = git(bare, "rev-parse", "main");
  await refused(() => gitPush(mine), /名字不一样/);
  assert.equal(git(bare, "rev-parse", "main"), before);
});

test("推送：要推的提交里有敏感文件时拒绝，已经在远程上的不算", async () => {
  const { bare, mine, commit } = setup();
  commit(mine, ".env", "SECRET=1\n");
  const before = git(bare, "rev-parse", "main");
  await refused(() => gitPush(mine), /敏感文件/, 403);
  assert.equal(git(bare, "rev-parse", "main"), before);
  // 在终端里确认过、推出去之后，不再拦后面的提交
  git(mine, "push", "-q");
  commit(mine, "b.txt", "二\n");
  await gitPush(mine);
});

test("推送：用了 LFS 又不跑钩子时拒绝；钩子默认不跑，勾选才跑", async () => {
  const { mine, commit } = setup();
  const marker = path.join(outside, "pre-push-ran");
  fs.writeFileSync(path.join(mine, ".git/hooks/pre-push"), `#!/bin/sh\necho ran >> ${marker}\n`, { mode: 0o755 });
  commit(mine, "b.txt", "二\n");
  await gitPush(mine);
  assert.equal(fs.existsSync(marker), false, "默认不跑");
  commit(mine, "c.txt", "三\n");
  await gitPush(mine, { hooks: true });
  assert.equal(fs.existsSync(marker), true, "勾选了才跑");

  commit(mine, ".gitattributes", "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  await refused(() => gitPush(mine), /LFS/);
});

test("不可信的仓库配置：能跑程序、能改去向的一律拒绝，程序没有跑", async () => {
  const marker = path.join(outside, "evil-ran");
  const evil = path.join(outside, "evil.sh");
  fs.writeFileSync(evil, `#!/bin/sh\necho ran >> ${marker}\nexit 1\n`, { mode: 0o755 });
  const unsafe: [string, string][] = [
    ["credential.helper", `!${evil}`],
    ["credential.https://example.test.helper", `!${evil}`],
    ["core.sshCommand", evil],
    ["core.gitProxy", evil],
    ["core.askPass", evil],
    ["core.alternateRefsCommand", evil],
    ["protocol.ext.allow", "always"],
    ["remote.origin.uploadpack", evil],
    ["remote.origin.receivepack", evil],
    ["remote.origin.proxy", "http://evil.test"],
    ["remote.origin.vcs", "evil"],
    ["url.http://evil.test/.insteadOf", "http://127.0.0.1"],
    ["http.proxy", "http://evil.test"],
    ["http.extraHeader", "X: y"],
    ["http.http://example.test/.sslVerify", "false"],
    ["merge.x.driver", evil],
    ["gpg.program", evil],
    ["gpg.ssh.program", evil],
    ["lfs.url", "http://evil.test"],
    ["lfs.customtransfer.x.path", evil],
  ];
  const { mine } = setup();
  for (const [key, value] of unsafe) {
    git(mine, "config", key, value);
    for (const op of [gitFetch, gitPull, gitPush]) await refused(() => op(mine), /终端/);
    git(mine, "config", "--unset", key);
  }
  // include 进来的也算
  const included = path.join(outside, "included.cfg");
  fs.writeFileSync(included, `[credential]\n\thelper = !${evil}\n`);
  git(mine, "config", "include.path", included);
  await refused(() => gitFetch(mine), /终端/);
  git(mine, "config", "--unset", "include.path");

  // 只调传输参数的不拦
  git(mine, "config", "http.postBuffer", "1048576");
  await gitFetch(mine);
  assert.equal(fs.existsSync(marker), false);

  // 自定义 filter 的仓库不能拉取
  git(mine, "config", "filter.crypt.smudge", evil);
  await refused(() => gitPull(mine), /过滤器/);
  git(mine, "config", "--unset", "filter.crypt.smudge");
});

test("地址：能跑命令的和本地路径都不连；账号密码不外露", async () => {
  const marker = path.join(outside, "ext-ran");
  const { mine, bare } = setup();
  git(mine, "config", "remote.origin.url", `ext::sh -c "echo ran >> ${marker}"`);
  await refused(() => gitFetch(mine), /https、http、ssh/);
  assert.equal(fs.existsSync(marker), false);

  git(mine, "config", "remote.origin.url", bare);
  await refused(() => gitFetch(mine), /https、http、ssh/);
  git(mine, "config", "remote.origin.url", `file://${bare}`);
  await refused(() => gitFetch(mine), /https、http、ssh/);

  // 连不上时 git 的报错里带着地址
  const token = "s3cret-token";
  git(mine, "config", "remote.origin.url", `http://user:${token}@127.0.0.1:${backendPort}/没有这个仓库.git`);
  await assert.rejects(() => gitFetch(mine), (err: Error) => {
    assert.ok(!err.message.includes(token), err.message);
    return true;
  });
  const status = await gitStatus(mine, { stats: true });
  assert.equal(status.pushUrl, `http://127.0.0.1:${backendPort}/没有这个仓库.git`);
  assert.equal((await gitStatus(mine)).pushUrl, undefined, "不要 stats 时不多跑");

  git(mine, "remote", "remove", "origin");
  await refused(() => gitFetch(mine), /还没有配置远程/);
  await refused(() => gitPush(mine), /还没有配置远程/);
  assert.equal((await gitStatus(mine, { stats: true })).pushUrl, undefined);
});

test("多个远程：优先当前分支跟踪的，pushRemote 决定推到哪；选不出来时拒绝", async () => {
  const a = setup();
  // 空的备份仓库：两次 setup 的历史不相关，推过去会被当成非快进
  const backup = path.join(served, `backup${++seq}.git`);
  execFileSync("git", ["init", "--bare", "-b", "main", backup], { stdio: "ignore" });
  git(backup, "config", "http.receivepack", "true");
  const backupUrl = `${backendUrl}/${path.basename(backup)}`;
  git(a.mine, "remote", "add", "backup", backupUrl);
  a.commit(a.mine, "x.txt", "x\n");
  git(a.mine, "config", "branch.main.pushRemote", "backup");
  const pushed = await gitPush(a.mine);
  assert.equal(pushed.remote, "backup");
  assert.equal(git(backup, "rev-parse", "main"), git(a.mine, "rev-parse", "HEAD"));
  assert.equal((await gitStatus(a.mine, { stats: true })).pushUrl, backupUrl);

  const c = setup();
  git(c.mine, "remote", "rename", "origin", "one");
  git(c.mine, "remote", "add", "two", backupUrl);
  git(c.mine, "checkout", "-q", "-b", "free");
  await refused(() => gitFetch(c.mine), /多个远程/);
});

test("权限：成员默认没有，要开工作区面板和 Git 远程两个开关；关掉后立刻失效", async (t) => {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  saveConfig({ ...structuredClone(config()), web: { ...config().web, host: "127.0.0.1", port, quotaEnabled: false } });

  const admin = createUser({ name: "boss", password: "password-1", role: "admin" });
  const member = createUser({ name: "member", password: "password-1" });
  assert.equal(member.gitRemote, undefined);
  assert.equal(canUseGitRemote(admin), true);
  assert.equal(canUseGitRemote(member), false);
  assert.equal(canUseGitRemote({ ...member, gitRemote: true }), false, "只开远程、没开面板不够");
  assert.equal(canUseGitRemote({ ...member, files: true }), false, "只开面板不够");
  assert.equal(canUseGitRemote({ ...member, files: true, gitRemote: true, disabled: true }), false);
  assert.equal(canUseGitRemote({ ...admin, disabled: true }), false);

  const adminCookie = `aim_session=${createSession(admin.id, "127.0.0.1", "test")}`;
  const memberCookie = `aim_session=${createSession(member.id, "127.0.0.1", "test")}`;
  await startWeb();
  t.after(() => stopWeb());

  const { mine, bare, commit } = setup();
  ensureConversation({ key: "web:a", cwd: mine, owner: admin.id, channel: "web", channelId: "web", agent: "claude" });
  ensureConversation({ key: "web:m", cwd: mine, owner: member.id, channel: "web", channelId: "web", agent: "claude" });
  const post = (key: string, sub: string, cookie: string, body: unknown = {}) =>
    fetch(`${base}/api/conversations/${encodeURIComponent(key)}/${sub}`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const me = async (cookie: string) => ((await (await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).json()) as { user: { gitRemote?: boolean } }).user;

  const subs = ["git-fetch", "git-pull", "git-push"];
  commit(mine, "b.txt", "二\n");
  const before = git(bare, "rev-parse", "main");

  for (const sub of subs) assert.equal((await post("web:m", sub, memberCookie)).status, 403, `${sub} 没开通`);
  updateUser(member.id, { files: true });
  for (const sub of subs) assert.equal((await post("web:m", sub, memberCookie)).status, 403, `${sub} 只开了面板`);
  assert.equal((await me(memberCookie)).gitRemote, undefined);
  for (const sub of subs) assert.equal((await post("web:a", sub, adminCookie)).status, 200, `${sub} 管理员`);
  assert.notEqual(git(bare, "rev-parse", "main"), before);

  commit(mine, "c.txt", "三\n");
  updateUser(member.id, { gitRemote: true });
  assert.equal((await me(memberCookie)).gitRemote, true);
  assert.equal((await me(adminCookie)).gitRemote, true);
  const res = await post("web:m", "git-push", memberCookie);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(git(bare, "rev-parse", "main"), git(mine, "rev-parse", "HEAD"));

  updateUser(member.id, { gitRemote: false });
  assert.equal((await post("web:m", "git-push", memberCookie)).status, 403);
  // 跨站请求不行
  assert.equal((await fetch(`${base}/api/conversations/web%3Aa/git-push`, { method: "POST", headers: { Cookie: adminCookie, Origin: "https://other.example", "Content-Type": "application/json" }, body: "{}" })).status, 403);
});
