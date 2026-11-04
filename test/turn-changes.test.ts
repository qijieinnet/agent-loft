import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEvents, SessionOptions, UserInput } from "../src/core/types.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-turn-home-"));
process.env.AGENT_LOFT_HOME = home;
const { config, loadConfig, saveConfig } = await import("../src/core/config.js");
const { createUser, updateUser } = await import("../src/core/users.js");
const { hub } = await import("../src/core/hub.js");
const { diffTrees, keepTrees, parseTreeDiff, snapshotTree, treeFileDiff } = await import("../src/core/git.js");
const { revertTurn, turnFileDiff, turnState } = await import("../src/core/turn-changes.js");
loadConfig();

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aim-turn-")));
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace);
saveConfig({ ...structuredClone(config()), workspaceRoot: workspace });
process.on("exit", () => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
}

let repoSeq = 0;
function newRepo(): string {
  const repo = path.join(workspace, `repo${++repoSeq}`);
  fs.mkdirSync(repo);
  git(repo, "init");
  fs.writeFileSync(path.join(repo, "a.txt"), "一\n二\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  return repo;
}

test("parseTreeDiff：状态、行数、重命名、二进制", () => {
  const names = ["M", "a.txt", "A", "新 文件.txt", "D", "gone.txt", "R095", "old.txt", "new.txt", "M", "img.png", ""].join("\0");
  const stats = ["1\t2\ta.txt", "3\t0\t新 文件.txt", "0\t1\tgone.txt", "4\t4\t", "old.txt", "new.txt", "-\t-\timg.png", ""].join("\0");
  assert.deepEqual(parseTreeDiff(names, stats), [
    { path: "a.txt", status: "modified", added: 1, removed: 2 },
    { path: "新 文件.txt", status: "added", added: 3, removed: 0 },
    { path: "gone.txt", status: "deleted", added: 0, removed: 1 },
    { path: "new.txt", oldPath: "old.txt", status: "renamed", added: 4, removed: 4 },
    { path: "img.png", status: "modified", added: 0, removed: 0, binary: true },
  ]);
});

test("snapshotTree：不碰用户的暂存区、工作区和分支", async () => {
  const repo = newRepo();
  fs.writeFileSync(path.join(repo, "a.txt"), "一\n改\n");
  fs.writeFileSync(path.join(repo, "staged.txt"), "暂存\n");
  git(repo, "add", "staged.txt");
  fs.writeFileSync(path.join(repo, "new.txt"), "没跟踪\n");
  const status = git(repo, "status", "--porcelain=v1");
  const head = git(repo, "rev-parse", "HEAD");
  const index = fs.readFileSync(path.join(repo, ".git/index"));
  const branches = git(repo, "branch", "-a");
  const tree = await snapshotTree(repo);
  assert.ok(tree);
  assert.equal(git(repo, "status", "--porcelain=v1"), status);
  assert.equal(git(repo, "rev-parse", "HEAD"), head);
  assert.ok(fs.readFileSync(path.join(repo, ".git/index")).equals(index), "索引一个字节都没变");
  assert.equal(git(repo, "branch", "-a"), branches);
  // 内容都在快照里，工作区没变就是同一个 hash
  assert.equal(git(repo, "show", `${tree}:a.txt`), "一\n改\n");
  assert.equal(git(repo, "show", `${tree}:new.txt`), "没跟踪\n");
  assert.equal(await snapshotTree(repo), tree);
});

test("snapshotTree：比较出增删改和重命名，忽略的、敏感的、太大的不算", async () => {
  const repo = newRepo();
  const before = await snapshotTree(repo);
  assert.ok(before);
  fs.writeFileSync(path.join(repo, "a.txt"), "一\n三\n四\n");
  fs.writeFileSync(path.join(repo, "新 文件.md"), "内容\n");
  fs.mkdirSync(path.join(repo, "ignored"));
  fs.writeFileSync(path.join(repo, "ignored/x.txt"), "忽略\n");
  fs.writeFileSync(path.join(repo, ".env"), "TOKEN=secret-value\n");
  fs.writeFileSync(path.join(repo, "server.pem"), "PRIVATE\n");
  const big = path.join(repo, "big.bin");
  fs.closeSync(fs.openSync(big, "w"));
  fs.truncateSync(big, 21 * 1024 * 1024);
  const after = await snapshotTree(repo);
  assert.ok(after);
  const files = await diffTrees(repo, before, after);
  assert.deepEqual(files?.map((f) => f.path).sort(), ["a.txt", "新 文件.md"]);
  const a = files!.find((f) => f.path === "a.txt")!;
  assert.deepEqual([a.status, a.added, a.removed], ["modified", 2, 1]);
  // 敏感内容没有进 .git
  assert.throws(() => git(repo, "cat-file", "-e", `${after}:.env`));
  assert.doesNotMatch(execFileSync("sh", ["-c", "git cat-file --batch-all-objects --batch"], { cwd: repo, encoding: "latin1", maxBuffer: 64 * 1024 * 1024 }), /secret-value/);
  const diff = await treeFileDiff(repo, before, after, "a.txt");
  assert.match(diff!.diff, /^\+三$/m);
  assert.equal(await treeFileDiff(repo, before, after, "没改过.txt"), undefined);
  assert.equal(await treeFileDiff(repo, before, after, "."), undefined);
  assert.equal(await treeFileDiff(repo, "0".repeat(40), after, "a.txt"), undefined);
});

test("snapshotTree：还没有提交的仓库、合并冲突中都能拍；文件太多就放弃", async () => {
  const empty = path.join(workspace, "empty");
  fs.mkdirSync(empty);
  git(empty, "init");
  fs.writeFileSync(path.join(empty, "first.txt"), "第一个\n");
  const first = await snapshotTree(empty);
  assert.ok(first);
  assert.equal(git(empty, "show", `${first}:first.txt`), "第一个\n");

  const repo = newRepo();
  git(repo, "checkout", "-q", "-b", "other");
  fs.writeFileSync(path.join(repo, "a.txt"), "other\n");
  git(repo, "commit", "-qam", "other");
  git(repo, "checkout", "-q", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "main\n");
  git(repo, "commit", "-qam", "main");
  assert.throws(() => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "merge", "other"], { cwd: repo, stdio: "ignore" }));
  const status = git(repo, "status", "--porcelain=v1");
  assert.ok(await snapshotTree(repo));
  assert.equal(git(repo, "status", "--porcelain=v1"), status, "冲突状态还在");

  const many = newRepo();
  fs.mkdirSync(path.join(many, "deps"));
  for (let i = 0; i < 5001; i++) fs.writeFileSync(path.join(many, "deps", `${i}.txt`), "");
  assert.equal(await snapshotTree(many), undefined);
});

test("snapshotTree：仓库配置不能让 git 执行程序；自定义 filter 的仓库不做快照", async () => {
  const repo = newRepo();
  const marker = path.join(root, "pwned-snapshot");
  const script = path.join(root, "evil-snapshot.sh");
  fs.writeFileSync(script, `#!/bin/sh\necho pwned >> ${marker}\ncat\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(repo, ".gitattributes"), "*.txt diff=evil\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "attrs");
  const before = await snapshotTree(repo);
  for (const [k, v] of [["core.fsmonitor", script], ["diff.external", script], ["diff.evil.textconv", script], ["diff.evil.command", script]] as const) git(repo, "config", k, v);
  fs.writeFileSync(path.join(repo, "a.txt"), "改\n");
  const after = await snapshotTree(repo);
  assert.ok(before && after);
  assert.ok(await diffTrees(repo, before, after));
  assert.match((await treeFileDiff(repo, before, after, "a.txt"))!.diff, /^\+改$/m);
  assert.equal(fs.existsSync(marker), false);
  // 自定义 filter（git-crypt 这样的）：不跑它，也不把没过滤的内容写进 .git
  git(repo, "config", "filter.evil.clean", script);
  assert.equal(await snapshotTree(repo), undefined);
  assert.equal(fs.existsSync(marker), false);
  // 标准的 git-lfs 不算
  const lfs = newRepo();
  git(lfs, "config", "filter.lfs.clean", "git-lfs clean -- %f");
  git(lfs, "config", "filter.lfs.smudge", "git-lfs smudge -- %f");
  git(lfs, "config", "filter.lfs.process", "git-lfs filter-process");
  git(lfs, "config", "filter.lfs.required", "true");
  assert.ok(await snapshotTree(lfs));
  // 假冒 lfs 名字、换了程序的不放行
  git(lfs, "config", "filter.lfs.clean", script);
  assert.equal(await snapshotTree(lfs), undefined);
});

test("keepTrees：引用留住快照不被 gc，不要的删掉；不出现在分支和日志里", async () => {
  const repo = newRepo();
  fs.writeFileSync(path.join(repo, "a.txt"), "一版\n");
  const one = await snapshotTree(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "二版\n");
  const two = await snapshotTree(repo);
  assert.ok(one && two);
  await keepTrees(repo, [one]);
  git(repo, "gc", "-q", "--prune=now");
  assert.equal(git(repo, "show", `${one}:a.txt`), "一版\n", "有引用的留着");
  assert.throws(() => execFileSync("git", ["cat-file", "-e", two], { cwd: repo, stdio: "ignore" }), "没引用的被回收");
  assert.doesNotMatch(git(repo, "branch", "-a"), /agent-loft/);
  assert.equal(git(repo, "log", "--all", "--oneline").trim().split("\n").length, 1, "git log --all 不受影响");
  assert.equal(git(repo, "fsck", "--no-progress").includes("error"), false);
  await keepTrees(repo, []);
  assert.equal(git(repo, "for-each-ref", "refs/agent-loft").trim(), "");
});

// ---------- 和 hub 接起来 ----------

/** 假的 agent：收到消息时执行 script 里对应的动作（改文件），然后结束这一轮 */
const script = new Map<string, (cwd: string) => void>();
const history = new Map<string, { role: "user" | "assistant"; text: string }[]>();
let holdNext: (() => void) | null = null;
let sessionSeq = 0;
hub.registerDriver({
  id: "claude",
  label: "Fake",
  capabilities: { effort: false, fork: false, cost: false, streaming: false },
  start: async () => {},
  stop: async () => {},
  createSession: (opts: SessionOptions, events: AgentEvents) => {
    const id = `turn-session-${++sessionSeq}`;
    // 和真的 agent 一样一轮一轮来：排队的消息等上一轮结束才开始
    let queue = Promise.resolve();
    return {
      sessionId: id,
      send: (input: UserInput) => {
        events.onSessionId(id);
        const finish = () => {
          script.get(input.text)?.(opts.cwd);
          const reply = `完成：${input.text}`;
          history.set(id, [...(history.get(id) ?? []), { role: "user", text: input.text }, { role: "assistant", text: reply }]);
          if (input.text.startsWith("报错")) events.onError(new Error("坏了"));
          else events.onResult({ text: reply, durationMs: 1 });
        };
        const release = holdNext;
        holdNext = null;
        queue = queue.then(async () => {
          await new Promise((r) => setTimeout(r, release ? 150 : 5));
          finish();
          release?.();
          // 真的 agent 在拍完这一轮结束的快照之后还要过一会才开始下一轮
          await new Promise((r) => setTimeout(r, 100));
        });
      },
      interrupt: async () => {},
      setModel: async () => {},
      describeRuntime: async () => ({}),
      dispose: async () => {},
    };
  },
  listSessions: async () => [],
  sessionExists: async () => true,
  readHistory: async (id: string) => history.get(id) ?? [],
  listModels: async () => [],
  catalog: async () => [],
  defaults: async () => ({}),
  statusLines: async () => [],
  diagnose: () => ({ kind: "x", chatMessage: "x", consoleHint: "" }),
} as never);

const origin = { channel: "web", channelId: "web" };
let convSeq = 0;
function conversation(cwd: string, owner?: string): string {
  const key = `web:turn${++convSeq}`;
  hub.ensure({ key, channel: "web", channelId: "web", defaultAgent: "claude", cwd, ...(owner ? { owner } : {}) });
  return key;
}

type Changes = { id: string; fileCount: number; added: number; removed: number; shared?: boolean; files: { path: string; status: string }[] };

/** 收这条会话的事件 */
function watch(key: string) {
  const changes: Changes[] = [];
  const results: number[] = [];
  const listener = (env: { key: string; ev: { type: string; changes?: Changes; at?: number } }) => {
    if (env.key !== key) return;
    if (env.ev.type === "turn_changes") changes.push(env.ev.changes!);
    if (env.ev.type === "result") results.push(env.ev.at!);
  };
  hub.on("event", listener as never);
  return { changes, results, stop: () => hub.off("event", listener as never) };
}

async function waitFor(check: () => boolean, label: string, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) assert.fail(`等不到：${label}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

test("一轮改了文件：报出改动，能看 diff，刷新后还在", async () => {
  const repo = newRepo();
  const key = conversation(repo);
  const w = watch(key);
  script.set("改文件", (cwd) => {
    fs.writeFileSync(path.join(cwd, "a.txt"), "一\n改过\n");
    fs.writeFileSync(path.join(cwd, "agent.txt"), "agent 写的\n");
  });
  hub.send(key, { text: "改文件", attachments: [] }, origin);
  await waitFor(() => w.changes.length === 1, "改动事件");
  const [changes] = w.changes as [Changes];
  assert.equal(changes.fileCount, 2);
  assert.deepEqual(changes.files.map((f) => `${f.status}:${f.path}`).sort(), ["added:agent.txt", "modified:a.txt"]);
  assert.equal(changes.added, 2);
  assert.equal(changes.removed, 1);
  // 只认这个仓库、这轮的文件
  assert.match((await turnFileDiff(repo, changes.id, "agent.txt"))!.diff, /^\+agent 写的$/m);
  assert.equal(await turnFileDiff(repo, "不存在", "agent.txt"), undefined);
  assert.equal(await turnFileDiff(newRepo(), changes.id, "agent.txt"), undefined, "别的仓库用不了这个编号");
  assert.equal(await turnFileDiff(repo, changes.id, "没改过.txt"), undefined);
  // 没碰用户的暂存区
  assert.equal(git(repo, "diff", "--cached", "--name-only").trim(), "");
  // 读历史时对回到这条回复上
  const messages = await hub.history(key);
  const reply = messages.find((m) => m.role === "assistant");
  assert.equal(reply?.changes?.id, changes.id);
  // 引用留着，快照不会被 gc
  git(repo, "gc", "-q", "--prune=now");
  assert.ok(await turnFileDiff(repo, changes.id, "a.txt"));
  w.stop();
});

test("每个仓库只留最近的快照：更早的引用删掉，别的仓库不受影响", async () => {
  const { sql } = await import("../src/core/db.js");
  const repo = newRepo();
  const key = conversation(repo);
  const w = watch(key);
  // 用数据库里的假记录撑到上限
  const insert = sql("INSERT INTO turn_changes (id, root, before_tree, after_tree, at) VALUES (?, ?, ?, ?, ?)");
  const fake = "0".repeat(39);
  for (let i = 0; i < 200; i++) insert.run(`old-${i}`, repo, `${fake}1`, `${fake}2`, Date.now() - 1000 + i);
  insert.run("other-repo", "/别的仓库", `${fake}1`, `${fake}2`, Date.now() - 1000);
  insert.run("too-old", "/别的仓库2", `${fake}1`, `${fake}2`, Date.now() - 61 * 86400_000);
  script.set("再改一轮", (cwd) => fs.writeFileSync(path.join(cwd, "more.txt"), "x\n"));
  hub.send(key, { text: "再改一轮", attachments: [] }, origin);
  await waitFor(() => w.changes.length === 1, "改动");
  const count = sql("SELECT COUNT(*) AS n FROM turn_changes WHERE root = ?").get(repo) as { n: number };
  assert.equal(count.n, 200);
  const ids = (sql("SELECT id FROM turn_changes").all() as { id: string }[]).map((r) => r.id);
  assert.ok(!ids.includes("old-0"), "最早的那条清掉了");
  assert.ok(ids.includes("old-199"));
  assert.ok(ids.includes(w.changes[0]!.id));
  assert.ok(ids.includes("other-repo"));
  assert.ok(!ids.includes("too-old"), "太久以前的清掉了");
  w.stop();
});

test("没改文件、不是仓库：没有改动事件", async () => {
  const repo = newRepo();
  const plain = path.join(workspace, "plain");
  fs.mkdirSync(plain);
  for (const cwd of [repo, plain]) {
    const key = conversation(cwd);
    const w = watch(key);
    script.set("闲聊", () => {});
    hub.send(key, { text: "闲聊", attachments: [] }, origin);
    await waitFor(() => w.results.length === 1, "回复");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(w.changes.length, 0);
    w.stop();
  }
  assert.equal(fs.existsSync(path.join(plain, ".git")), false);
});

test("排队的消息：每一轮只算自己改的，发消息之前的改动不算", async () => {
  const repo = newRepo();
  // 发消息之前就有的改动
  fs.writeFileSync(path.join(repo, "before.txt"), "早就有了\n");
  const key = conversation(repo);
  const w = watch(key);
  script.set("第一轮", (cwd) => fs.writeFileSync(path.join(cwd, "one.txt"), "1\n"));
  script.set("第二轮", (cwd) => fs.writeFileSync(path.join(cwd, "two.txt"), "2\n"));
  const released = new Promise<void>((resolve) => (holdNext = resolve));
  hub.send(key, { text: "第一轮", attachments: [] }, origin);
  await waitFor(() => hub.isBusy(key), "开始");
  hub.send(key, { text: "第二轮", attachments: [] }, origin);
  await released;
  await waitFor(() => w.changes.length === 2, "两轮的改动");
  assert.deepEqual(w.changes.map((c) => c.files.map((f) => f.path)), [["one.txt"], ["two.txt"]]);
  w.stop();
});

test("出错结束的一轮也报改动；用户自己在两轮之间的改动不算下一轮", async () => {
  const repo = newRepo();
  const key = conversation(repo);
  const w = watch(key);
  script.set("报错前改了", (cwd) => fs.writeFileSync(path.join(cwd, "half.txt"), "一半\n"));
  hub.send(key, { text: "报错前改了", attachments: [] }, origin);
  await waitFor(() => w.changes.length === 1, "出错这轮的改动");
  assert.deepEqual(w.changes[0]!.files.map((f) => f.path), ["half.txt"]);
  fs.writeFileSync(path.join(repo, "mine.txt"), "我自己写的\n");
  script.set("接着改", (cwd) => fs.writeFileSync(path.join(cwd, "next.txt"), "下一轮\n"));
  hub.send(key, { text: "接着改", attachments: [] }, origin);
  await waitFor(() => w.changes.length === 2, "下一轮");
  assert.deepEqual(w.changes[1]!.files.map((f) => f.path), ["next.txt"]);
  w.stop();
});

test("同一仓库有别的会话在跑：标出来", async () => {
  const repo = newRepo();
  const a = conversation(repo);
  const b = conversation(repo);
  const w = watch(a);
  script.set("A 改", (cwd) => fs.writeFileSync(path.join(cwd, "from-a.txt"), "a\n"));
  script.set("B 慢", () => {});
  const released = new Promise<void>((resolve) => (holdNext = resolve));
  hub.send(b, { text: "B 慢", attachments: [] }, origin);
  await waitFor(() => hub.isBusy(b), "B 开始");
  hub.send(a, { text: "A 改", attachments: [] }, origin);
  await waitFor(() => w.changes.length === 1, "A 的改动");
  assert.equal(w.changes[0]!.shared, true);
  await released;
  w.stop();
});

test("撤销一轮：只恢复这一轮动过的文件，能重做，之后又改过要明说", async () => {
  const repo = newRepo();
  fs.writeFileSync(path.join(repo, "gone.txt"), "要被删\n");
  fs.writeFileSync(path.join(repo, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  fs.mkdirSync(path.join(repo, "dir"));
  fs.writeFileSync(path.join(repo, "dir", "keep.txt"), "留着\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "更多文件");
  // 这一轮之前用户就有的改动和暂存
  fs.writeFileSync(path.join(repo, "mine.txt"), "我的\n");
  fs.writeFileSync(path.join(repo, "staged.txt"), "暂存的\n");
  git(repo, "add", "staged.txt");
  const key = conversation(repo);
  const w = watch(key);
  script.set("一轮", (cwd) => {
    fs.writeFileSync(path.join(cwd, "a.txt"), "agent 改的\n");
    fs.rmSync(path.join(cwd, "gone.txt"));
    fs.writeFileSync(path.join(cwd, "added.txt"), "agent 加的\n");
    fs.mkdirSync(path.join(cwd, "newdir", "sub"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "newdir", "sub", "x.txt"), "x\n");
    fs.chmodSync(path.join(cwd, "run.sh"), 0o644);
    fs.symlinkSync("a.txt", path.join(cwd, "link"));
  });
  hub.send(key, { text: "一轮", attachments: [] }, origin);
  await waitFor(() => w.changes.length === 1, "改动");
  const { id } = w.changes[0]!;
  assert.deepEqual(await turnState(repo, id), { state: "applied" });
  const indexBefore = fs.readFileSync(path.join(repo, ".git/index"));
  const staged = git(repo, "diff", "--cached", "--name-only");

  // 撤销
  assert.deepEqual(await revertTurn(repo, id, "undo", false), { state: "undone" });
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "一\n二\n");
  assert.equal(fs.readFileSync(path.join(repo, "gone.txt"), "utf8"), "要被删\n");
  assert.equal(fs.existsSync(path.join(repo, "added.txt")), false);
  assert.equal(fs.existsSync(path.join(repo, "newdir")), false, "空出来的目录也收拾");
  assert.equal(fs.lstatSync(path.join(repo, "link"), { throwIfNoEntry: false }), undefined);
  assert.equal(fs.statSync(path.join(repo, "run.sh")).mode & 0o111, 0o111, "可执行权限回来了");
  // 别的东西一点没动
  assert.equal(fs.readFileSync(path.join(repo, "mine.txt"), "utf8"), "我的\n");
  assert.equal(fs.readFileSync(path.join(repo, "dir", "keep.txt"), "utf8"), "留着\n");
  assert.equal(git(repo, "diff", "--cached", "--name-only"), staged, "暂存区没变");
  assert.ok(fs.readFileSync(path.join(repo, ".git/index")).equals(indexBefore), "索引文件没被写过");
  // 再撤销一次没有副作用
  assert.deepEqual(await revertTurn(repo, id, "undo", false), { state: "undone" });

  // 重做
  assert.deepEqual(await revertTurn(repo, id, "redo", false), { state: "applied" });
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "agent 改的\n");
  assert.equal(fs.existsSync(path.join(repo, "gone.txt")), false);
  assert.equal(fs.readFileSync(path.join(repo, "newdir", "sub", "x.txt"), "utf8"), "x\n");
  assert.equal(fs.readlinkSync(path.join(repo, "link")), "a.txt");
  assert.equal(fs.statSync(path.join(repo, "run.sh")).mode & 0o111, 0);

  // 之后又改过：不动手，告诉是哪些文件；明说才覆盖
  fs.writeFileSync(path.join(repo, "added.txt"), "后来又改了\n");
  assert.deepEqual(await turnState(repo, id), { state: "diverged", diverged: ["added.txt"] });
  await assert.rejects(revertTurn(repo, id, "undo", false), (err: Error & { status?: number; extra?: { files?: string[] } }) => err.status === 409 && err.extra?.files?.[0] === "added.txt");
  assert.equal(fs.readFileSync(path.join(repo, "added.txt"), "utf8"), "后来又改了\n");
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "agent 改的\n", "一个文件都没动");
  assert.deepEqual(await revertTurn(repo, id, "undo", true), { state: "undone" });
  assert.equal(fs.existsSync(path.join(repo, "added.txt")), false);
  w.stop();
});

test("撤销一轮：别的文件后来的改动保留；编号只在这个仓库认；快照没了就不能撤销", async () => {
  const repo = newRepo();
  const key = conversation(repo);
  const w = watch(key);
  script.set("第一轮改 a", (cwd) => fs.writeFileSync(path.join(cwd, "a.txt"), "第一轮\n"));
  script.set("第二轮改 b", (cwd) => fs.writeFileSync(path.join(cwd, "b.txt"), "第二轮\n"));
  hub.send(key, { text: "第一轮改 a", attachments: [] }, origin);
  await waitFor(() => w.changes.length === 1, "第一轮");
  hub.send(key, { text: "第二轮改 b", attachments: [] }, origin);
  await waitFor(() => w.changes.length === 2, "第二轮");
  // 撤销第一轮：第二轮的改动不受影响
  assert.deepEqual(await revertTurn(repo, w.changes[0]!.id, "undo", false), { state: "undone" });
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "一\n二\n");
  assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "第二轮\n");
  assert.deepEqual(await turnState(repo, w.changes[1]!.id), { state: "applied" });
  // 别的仓库、不存在的编号
  const other = newRepo();
  assert.deepEqual(await turnState(other, w.changes[1]!.id), { state: "expired" });
  await assert.rejects(revertTurn(other, w.changes[1]!.id, "undo", true), (err: Error & { status?: number }) => err.status === 404);
  assert.deepEqual(await turnState(repo, "不存在"), { state: "expired" });
  // 快照被回收了
  for (const ref of git(repo, "for-each-ref", "--format=%(refname)", "refs/agent-loft").split("\n").filter(Boolean)) git(repo, "update-ref", "-d", ref);
  git(repo, "gc", "-q", "--prune=now");
  assert.deepEqual(await turnState(repo, w.changes[1]!.id), { state: "expired" });
  await assert.rejects(revertTurn(repo, w.changes[1]!.id, "undo", true), (err: Error & { status?: number }) => err.status === 404);
  assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "第二轮\n");
  w.stop();
});

test("撤销和重做都不会跟着符号链接碰到仓库外面的文件", async () => {
  const repo = newRepo();
  const outside = path.join(root, "outside-undo");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "victim.txt"), "外面的文件\n");
  const key = conversation(repo);
  const w = watch(key);
  // 这一轮新增了 d/victim.txt；之后 d 被换成指向外面的链接
  script.set("建目录", (cwd) => {
    fs.mkdirSync(path.join(cwd, "d"));
    fs.writeFileSync(path.join(cwd, "d", "victim.txt"), "x\n");
  });
  hub.send(key, { text: "建目录", attachments: [] }, origin);
  await waitFor(() => w.changes.length === 1, "改动");
  fs.rmSync(path.join(repo, "d"), { recursive: true });
  fs.symlinkSync(outside, path.join(repo, "d"));
  // git 不穿过符号链接：d/victim.txt 算是已经没了，和这一轮开始前一样，什么都不用做
  assert.deepEqual(await revertTurn(repo, w.changes[0]!.id, "undo", true), { state: "undone" });
  assert.equal(fs.readFileSync(path.join(outside, "victim.txt"), "utf8"), "外面的文件\n");
  // 重做要写 d/victim.txt：写在仓库里，不写到链接指向的地方去
  await revertTurn(repo, w.changes[0]!.id, "redo", true);
  assert.equal(fs.readFileSync(path.join(outside, "victim.txt"), "utf8"), "外面的文件\n");
  assert.equal(fs.readFileSync(path.join(repo, "d", "victim.txt"), "utf8"), "x\n");
  assert.equal(fs.lstatSync(path.join(repo, "d")).isSymbolicLink(), false);
  w.stop();
});

test("一轮改了很多文件：摘要只列一部分，统计和撤销都是全部的；敏感文件不进卡片也撤销不了", async () => {
  const repo = newRepo();
  const key = conversation(repo);
  const w = watch(key);
  script.set("改很多", (cwd) => {
    fs.mkdirSync(path.join(cwd, "many"));
    for (let i = 0; i < 205; i++) fs.writeFileSync(path.join(cwd, "many", `${i}.txt`), "x\n");
    fs.writeFileSync(path.join(cwd, ".env"), "TOKEN=agent-wrote-this\n");
  });
  hub.send(key, { text: "改很多", attachments: [] }, origin);
  await waitFor(() => w.changes.length === 1, "改动");
  const [changes] = w.changes as [Changes];
  assert.equal(changes.fileCount, 205);
  assert.equal(changes.files.length, 200);
  assert.equal(changes.added, 205);
  assert.ok(!changes.files.some((f) => f.path === ".env"));
  assert.deepEqual(await revertTurn(repo, changes.id, "undo", false), { state: "undone" });
  assert.equal(fs.existsSync(path.join(repo, "many")), false);
  assert.equal(fs.readFileSync(path.join(repo, ".env"), "utf8"), "TOKEN=agent-wrote-this\n", "敏感文件撤销不了，留在原地");
  w.stop();
});

test("飞书发起的对话也有改动记录（在 Web 上打开看得到）", async () => {
  const repo = newRepo();
  const key = `feishu:bot:turn${++convSeq}`;
  hub.ensure({ key, channel: "feishu", channelId: "bot", defaultAgent: "claude", cwd: repo });
  const w = watch(key);
  script.set("飞书改", (cwd) => fs.writeFileSync(path.join(cwd, "from-feishu.txt"), "x\n"));
  hub.send(key, { text: "飞书改", attachments: [] }, { channel: "feishu", channelId: "bot" });
  await waitFor(() => w.changes.length === 1, "改动");
  const reply = (await hub.history(key)).find((m) => m.role === "assistant");
  assert.equal(reply?.changes?.id, w.changes[0]!.id);
  w.stop();
});

test("没开通工作区面板的成员：不往他的仓库里写东西，开通后才有", async () => {
  const repo = newRepo();
  createUser({ name: "boss", password: "password-1", role: "admin" });
  const member = createUser({ name: `member${convSeq}`, password: "password-1" });
  const key = conversation(repo, member.id);
  const w = watch(key);
  const objects = () => git(repo, "count-objects", "-v");
  const before = objects();
  script.set("成员改", (cwd) => fs.writeFileSync(path.join(cwd, "m.txt"), "m\n"));
  hub.send(key, { text: "成员改", attachments: [] }, origin);
  await waitFor(() => w.results.length === 1, "回复");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(w.changes.length, 0);
  assert.equal(objects(), before);
  assert.equal(git(repo, "for-each-ref", "refs/agent-loft").trim(), "");
  updateUser(member.id, { files: true });
  script.set("成员再改", (cwd) => fs.writeFileSync(path.join(cwd, "m2.txt"), "m2\n"));
  hub.send(key, { text: "成员再改", attachments: [] }, origin);
  await waitFor(() => w.changes.length === 1, "开通后的改动");
  assert.deepEqual(w.changes[0]!.files.map((f) => f.path), ["m2.txt"]);
  w.stop();
});
