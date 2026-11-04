// 工作区面板的 Git 部分：当前分支、改动的文件、diff、分支和提交历史，每轮对话前后的快照，
// 以及用户在面板上点的操作（暂存、丢弃、提交、切换分支、撤销一轮）。
// 除了用户明确点的操作，不动工作区、暂存区和分支；快照只往仓库里写对象和 refs/agent-loft/ 下的引用。
//
// 仓库里的配置不可信（.git/config 可能来自解压的压缩包、agent 或别人），而 git 会按配置执行程序，
// 所以只用 execFile 不经过 shell，并且：
//   - 关掉配置里能跑程序的项：core.fsmonitor、diff.external、textconv、仓库自己定义的 filter；
//   - 不让 git 向上找到工作区之外的仓库（GIT_CEILING_DIRECTORIES），家目录是个仓库时不会把整个家目录列出来；
//   - 去掉继承来的 GIT_* 环境变量，从 git 钩子里启动服务时也不会指到别的仓库；
//   - 本服务自己的凭据不传下去（和 agent 子进程一样，见 agent-env.ts）：用户勾选了运行钩子时，钩子也拿不到；
//   - 不连网（GIT_ALLOW_PROTOCOL、GIT_NO_LAZY_FETCH）：部分克隆缺对象时 git 会去远程地址拿，
//     而地址是配置里写的，ext:: 这种地址就是一条命令；
//   - 不抢索引锁（GIT_OPTIONAL_LOCKS=0）：面板在后台刷新，不能和正在干活的 agent 抢。
//
// 路径都相对仓库根目录。
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentEnvironment } from "./agent-env.js";
import { config } from "./config.js";
import { isSensitivePath } from "./reply-files.js";

const TIMEOUT_MS = 15_000;
/** status 的输出上限：大约几万个文件，多了也显示不过来 */
const STATUS_MAX_BYTES = 8 * 1024 * 1024;
/** 改动列表最多给这么多个文件 */
const STATUS_MAX_FILES = 2000;
/** 一个文件的 diff 最多给这么多 */
export const DIFF_MAX_BYTES = 2 * 1024 * 1024;
/** 没跟踪的文件超过这么大就不生成 diff 了 */
const UNTRACKED_MAX_BYTES = 5 * 1024 * 1024;
const BRANCHES_MAX = 500;

type RunResult = { code: number; stdout: string; stderr: string; truncated: boolean };

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(agentEnvironment())) if (!k.startsWith("GIT_")) env[k] = v;
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_NO_LAZY_FETCH = "1";
  // 这里用到的命令都不需要连网。没有哪个协议叫这个名字，所以都不允许
  env.GIT_ALLOW_PROTOCOL = "none";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.LC_ALL = "C";
  try {
    // 能找到工作区根目录上的仓库，但不会再往上找
    env.GIT_CEILING_DIRECTORIES = path.dirname(fs.realpathSync(config().workspaceRoot));
  } catch {
    // 工作区目录没了：后面 git 自己会报错
  }
  return env;
}

function run(cwd: string, args: string[], maxBytes: number, opts: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd, env: { ...gitEnv(), ...opts.env }, timeout: opts.timeoutMs ?? TIMEOUT_MS, maxBuffer: maxBytes, encoding: "utf8", windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr, truncated: false });
        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ code: 0, stdout, stderr, truncated: true });
        if (typeof e.code === "number") return resolve({ code: e.code, stdout, stderr, truncated: false });
        // 找不到 git，或者目录没了：spawn 报的都是这个
        if (e.code === "ENOENT") return reject(new GitUnavailable());
        reject(new Error(e.killed ? "git 执行超时" : e.message));
      },
    );
    // 不给输入的命令也要关掉：git 不该等着读什么
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.input);
  });
}

class GitUnavailable extends Error {
  constructor() {
    super("这台服务器上用不了 git（没有安装，或者目录已经不在了）");
  }
}

/** 每次调用 git 都带上的配置：覆盖掉仓库配置里能跑程序的项 */
const SAFE_CONFIG = [
  "core.fsmonitor=false",
  "core.hooksPath=/dev/null",
  "core.quotepath=false",
  "core.pager=cat",
  "diff.external=",
  "status.submoduleSummary=false",
];

/** git lfs install --local 写进 .git/config 的标准内容：程序是固定的 git-lfs，放行，关了 LFS 文件都会显示成改过 */
const LFS_FILTER: Record<string, string> = {
  "filter.lfs.clean": "git-lfs clean -- %f",
  "filter.lfs.smudge": "git-lfs smudge -- %f",
  "filter.lfs.process": "git-lfs filter-process",
  "filter.lfs.required": "true",
};

/**
 * 仓库自己的配置里（.git/config、worktree 配置，以及它们 include 进来的文件）符合 pattern 的项。
 * 全局和系统配置是这台机器的主人写的，不算。注意 git config --local 默认不跟 include，不能用它来判断
 */
async function repoConfig(root: string, pattern: string): Promise<{ key: string; value: string }[]> {
  const out = await run(root, ["config", "--show-scope", "--includes", "-z", "--get-regexp", pattern], 256 * 1024);
  const items: { key: string; value: string }[] = [];
  if (out.code === 0 || out.code === 1) {
    const fields = out.stdout.split("\0");
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const scope = fields[i]!;
      if (scope === "global" || scope === "system") continue;
      const entry = fields[i + 1]!;
      const newline = entry.indexOf("\n");
      items.push(newline < 0 ? { key: entry, value: "" } : { key: entry.slice(0, newline), value: entry.slice(newline + 1) });
    }
    return items;
  }
  // 太老的 git（2.26 以前）没有 --show-scope
  const local = await run(root, ["config", "--local", "--includes", "-z", "--get-regexp", pattern], 256 * 1024);
  for (const entry of local.stdout.split("\0")) {
    if (!entry) continue;
    const newline = entry.indexOf("\n");
    items.push(newline < 0 ? { key: entry, value: "" } : { key: entry.slice(0, newline), value: entry.slice(newline + 1) });
  }
  return items;
}

/** 仓库自己配置里定义的 filter 的名字（git-crypt 之类）。标准的 git-lfs 不算 */
async function customFilters(root: string): Promise<Set<string>> {
  const names = new Set<string>();
  for (const { key, value } of await repoConfig(root, "^filter\\.")) {
    const name = /^filter\.(.+)\.[^.]+$/.exec(key)?.[1];
    if (name && LFS_FILTER[key] !== value) names.add(name);
  }
  return names;
}

/**
 * 仓库自己定义的 filter 也能跑程序（status、diff 时会对改过的文件跑 clean）：把这个仓库 .git/config 里的清空。
 * 全局配置是这台机器的主人自己写的，不动（比如全局装的 git-lfs）。
 *
 * 这只适用于读：清空之后 git 看到的是没过滤的内容。写操作不能这样 ——
 * git-crypt 的仓库清空了 filter 再 git add，提交进去的就是明文。写操作见 assertWritable。
 */
async function safeArgs(root: string): Promise<string[]> {
  const args = SAFE_CONFIG.flatMap((c) => ["-c", c]);
  for (const name of await customFilters(root)) {
    args.push("-c", `filter.${name}.clean=`, "-c", `filter.${name}.smudge=`, "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`);
  }
  return args;
}

// ---------- 仓库 ----------

export type GitRepo = { repo: true; root: string } | { repo: false; reason?: string };

/** cwd 所在的仓库。不是仓库不算错误；git 没装、仓库归属不对这些给个原因 */
export async function findRepo(cwd: string): Promise<GitRepo> {
  let out: RunResult;
  try {
    out = await run(cwd, ["rev-parse", "--is-inside-work-tree", "--show-toplevel"], 64 * 1024);
  } catch (err) {
    return { repo: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (out.code !== 0) {
    if (out.stderr.includes("dubious ownership")) return { repo: false, reason: "这个仓库的所有者和运行 agent-loft 的用户不同，git 拒绝读取" };
    return { repo: false };
  }
  const [inTree, root] = out.stdout.split("\n");
  if (inTree !== "true" || !root) return { repo: false };
  // core.worktree 可以把工作树指到别处（比如 /）：工作树得在工作区之内，否则改动列表、丢弃都会碰到外面去
  try {
    const realRoot = fs.realpathSync(config().workspaceRoot);
    const realTree = fs.realpathSync(root);
    if (realTree !== realRoot && !realTree.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep)) {
      return { repo: false, reason: "这个仓库的工作树不在工作区之内，不能在这里操作" };
    }
  } catch {
    return { repo: false };
  }
  return { repo: true, root };
}

// ---------- status ----------

export type GitFileState = "modified" | "added" | "deleted" | "renamed" | "copied" | "typechange" | "untracked" | "conflicted";

export type GitFileChange = {
  path: string;
  /** 重命名、复制前的路径 */
  oldPath?: string;
  /** 暂存区相对 HEAD 的改动 */
  staged?: GitFileState;
  /** 工作区相对暂存区的改动（没跟踪的、有冲突的也在这） */
  unstaged?: GitFileState;
  /** 密钥之类的文件：只显示有改动，不给看内容 */
  sensitive?: boolean;
};

export type GitStatus = {
  root: string;
  /** 分支名。分离头指针时是 null，看 head */
  branch: string | null;
  /** 当前提交的短 hash；还没有提交时是 null */
  head: string | null;
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitFileChange[];
  truncated: boolean;
};

const STATE: Record<string, GitFileState> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", T: "typechange" };

/** 解析 git status --porcelain=v2 --branch -z 的输出。用 -z 路径不转义，始终相对仓库根目录 */
export function parseStatus(root: string, output: string): GitStatus {
  const status: GitStatus = { root, branch: null, head: null, ahead: 0, behind: 0, files: [], truncated: false };
  const fields = output.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const line = fields[i]!;
    if (line.startsWith("# ")) {
      const [, key, ...rest] = line.split(" ");
      if (key === "branch.oid" && rest[0] !== "(initial)") status.head = rest[0]!.slice(0, 7);
      else if (key === "branch.head" && rest[0] !== "(detached)") status.branch = rest.join(" ");
      else if (key === "branch.upstream") status.upstream = rest.join(" ");
      else if (key === "branch.ab") {
        status.ahead = Math.abs(Number(rest[0])) || 0;
        status.behind = Math.abs(Number(rest[1])) || 0;
      }
      continue;
    }
    if (status.files.length >= STATUS_MAX_FILES) {
      if (line) status.truncated = true;
      continue;
    }
    const type = line[0];
    if (type === "?") status.files.push({ path: line.slice(2), unstaged: "untracked" });
    else if (type === "u") status.files.push({ path: fieldsAfter(line, 10), unstaged: "conflicted" });
    else if (type === "1" || type === "2") {
      const xy = line.slice(2, 4);
      const change: GitFileChange = { path: fieldsAfter(line, type === "1" ? 8 : 9) };
      const staged = STATE[xy[0]!];
      const unstaged = STATE[xy[1]!];
      if (staged) change.staged = staged;
      if (unstaged) change.unstaged = unstaged;
      // 重命名的第二段（原来的路径）是下一个字段
      if (type === "2") change.oldPath = fields[++i];
      status.files.push(change);
    }
  }
  return status;
}

/** 去掉前 n 个空格分隔的字段，剩下的是路径（路径里可能有空格） */
function fieldsAfter(line: string, n: number): string {
  let at = 0;
  for (let i = 0; i < n; i++) at = line.indexOf(" ", at) + 1;
  return line.slice(at);
}

export async function gitStatus(root: string): Promise<GitStatus> {
  const out = await run(
    root,
    // 子模块里的改动不往里看：既慢，又会跑子模块自己的配置
    [...(await safeArgs(root)), "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--ignore-submodules=dirty"],
    STATUS_MAX_BYTES,
  );
  if (out.code !== 0) throw new Error(out.stderr.trim() || "读取仓库状态失败");
  // 输出被截断时最后一段不完整，丢掉
  const text = out.truncated ? out.stdout.slice(0, out.stdout.lastIndexOf("\0") + 1) : out.stdout;
  const status = parseStatus(root, text);
  if (out.truncated) status.truncated = true;
  for (const f of status.files) {
    if (isSensitivePath(path.join(root, f.path)) || (f.oldPath && isSensitivePath(path.join(root, f.oldPath)))) f.sensitive = true;
  }
  return status;
}

// ---------- diff ----------

export type GitDiff = {
  path: string;
  /** unified diff 原文。二进制、不给看时是空的 */
  diff: string;
  truncated: boolean;
  binary?: boolean;
  /** 没有 diff 可看的原因：太大、敏感文件、不是普通文件 */
  note?: string;
};

/**
 * 一个文件的 diff。path 必须出现在当前的改动列表里：不接受任意路径，
 * 免得传个目录（或已删除的目录）把里面的敏感文件一起带出来。文件不在列表里返回 undefined。
 */
export async function gitDiff(root: string, file: string, staged: boolean): Promise<GitDiff | undefined> {
  const status = await gitStatus(root);
  const change = status.files.find((f) => f.path === file);
  if (!change || !(staged ? change.staged : change.unstaged)) return undefined;
  if (change.sensitive) return { path: file, diff: "", truncated: false, note: "这是密钥一类的敏感文件，不显示内容" };

  const common = ["--no-color", "--no-ext-diff", "--no-textconv", "--ignore-submodules=dirty"];
  const safe = await safeArgs(root);
  let out: RunResult;
  if (change.unstaged === "untracked") {
    const abs = path.join(root, file);
    const st = fs.lstatSync(abs, { throwIfNoEntry: false });
    if (!st) return undefined;
    // 符号链接不跟过去：指向哪里不归这里管
    if (!st.isFile()) return { path: file, diff: "", truncated: false, note: "这不是普通文件，没有内容可比较" };
    if (st.size > UNTRACKED_MAX_BYTES) return { path: file, diff: "", truncated: false, note: "文件太大，不生成 diff" };
    out = await run(root, [...safe, "diff", ...common, "--no-index", "--", "/dev/null", file], DIFF_MAX_BYTES);
    // --no-index：有差异时退出码是 1
    if (out.code === 1) out.code = 0;
  } else {
    const paths = change.oldPath ? [file, change.oldPath] : [file];
    out = await run(root, [...safe, "--literal-pathspecs", "diff", ...common, ...(staged ? ["--cached", "-M"] : []), "--", ...paths], DIFF_MAX_BYTES);
  }
  if (out.code !== 0) throw new Error(out.stderr.trim() || "读取 diff 失败");
  return diffResult(file, out);
}

function diffResult(file: string, out: RunResult): GitDiff {
  let text = out.stdout;
  let truncated = out.truncated;
  // execFile 的上限数的是字符，中文一个字三个字节：这里再按字节卡一次
  if (Buffer.byteLength(text) > DIFF_MAX_BYTES) {
    text = Buffer.from(text).subarray(0, DIFF_MAX_BYTES).toString();
    truncated = true;
  }
  // 截断时停在完整的一行上
  if (truncated) text = text.slice(0, text.lastIndexOf("\n") + 1);
  if (/^(?:Binary files .* differ|GIT binary patch)$/m.test(text.split("\n@@")[0]!)) return { path: file, diff: "", truncated: false, binary: true };
  return { path: file, diff: text, truncated };
}

// ---------- 分支 ----------

export type GitBranch = {
  name: string;
  remote: boolean;
  current: boolean;
  upstream?: string;
  hash: string;
  subject: string;
  /** 毫秒时间戳 */
  date: number;
};

export async function gitBranches(root: string): Promise<{ branches: GitBranch[]; truncated: boolean }> {
  const sep = "\x1f";
  const format = ["%(refname)", "%(HEAD)", "%(upstream:short)", "%(objectname:short)", "%(committerdate:unix)", "%(subject)"].join(sep);
  const out = await run(
    root,
    [...(await safeArgs(root)), "for-each-ref", `--format=${format}`, "--sort=-committerdate", `--count=${BRANCHES_MAX + 1}`, "refs/heads", "refs/remotes"],
    4 * 1024 * 1024,
  );
  if (out.code !== 0) throw new Error(out.stderr.trim() || "读取分支失败");
  const lines = out.stdout.split("\n").filter(Boolean);
  const branches: GitBranch[] = [];
  for (const line of lines.slice(0, BRANCHES_MAX)) {
    const [ref, head, upstream, hash, date, subject] = line.split(sep);
    // origin/HEAD 只是个指针，不是分支
    if (!ref || ref.endsWith("/HEAD")) continue;
    const remote = ref.startsWith("refs/remotes/");
    branches.push({
      name: ref.replace(/^refs\/(?:heads|remotes)\//, ""),
      remote,
      current: head === "*",
      ...(upstream ? { upstream } : {}),
      hash: hash ?? "",
      subject: subject ?? "",
      date: Number(date) * 1000 || 0,
    });
  }
  return { branches, truncated: lines.length > BRANCHES_MAX };
}

// ---------- 每轮对话的快照 ----------
//
// 快照是一棵 tree：工作区当时的样子。用一份临时索引生成，用户的暂存区、工作区、分支都不碰。
// 比较两棵 tree 就知道这一轮改了什么，agent 用工具改的、用命令改的都算在内，两种 agent 一视同仁。
// 敏感文件和太大的文件不进快照：不给它们在 .git 里留副本，也就不会出现在 diff 里。

/** 比这大的文件不进快照（模型、数据集、编译产物）：每轮复制一份太占地方 */
const SNAPSHOT_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** 改动和没跟踪的文件比这多：多半是没写 .gitignore 的依赖目录，这一轮不做快照 */
const SNAPSHOT_MAX_FILES = 5000;

/** 工作区现在的样子写成一棵 tree，返回它的 hash。做不了（文件太多、索引坏了）返回 undefined，不影响对话 */
export async function snapshotTree(root: string): Promise<string | undefined> {
  // 自定义 filter 的仓库：清空 filter 做快照，会把 git-crypt 保护的内容以明文写进 .git。这种仓库不做快照
  if ((await customFilters(root).catch(() => new Set(["?"]))).size) return undefined;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aloft-index-"));
  try {
    const safe = [...(await safeArgs(root)), "-c", "core.splitIndex=false"];
    const indexPath = await run(root, ["rev-parse", "--git-path", "index"], 64 * 1024);
    if (indexPath.code !== 0) return undefined;
    const index = path.join(dir, "index");
    // 从真的索引复制一份开始：里面有文件的状态缓存，不用把所有文件都读一遍
    try {
      fs.copyFileSync(path.resolve(root, indexPath.stdout.trim()), index);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    const env = { GIT_INDEX_FILE: index };
    const listed = await run(root, [...safe, "ls-files", "-z", "--modified", "--deleted", "--others", "--exclude-standard"], STATUS_MAX_BYTES, { env });
    if (listed.code !== 0 || listed.truncated) return undefined;
    const paths = new Set<string>();
    for (const file of listed.stdout.split("\0")) {
      // 以斜杠结尾的是嵌在里面的另一个仓库，不进快照
      if (!file || file.endsWith("/")) continue;
      const abs = path.join(root, file);
      if (isSensitivePath(abs)) continue;
      const st = fs.lstatSync(abs, { throwIfNoEntry: false });
      if (st?.isFile() && st.size > SNAPSHOT_MAX_FILE_BYTES) continue;
      paths.add(file);
      if (paths.size > SNAPSHOT_MAX_FILES) return undefined;
    }
    if (paths.size) {
      const updated = await run(root, [...safe, "update-index", "--add", "--remove", "-z", "--stdin"], 1024 * 1024, { env, input: [...paths].map((p) => `${p}\0`).join("") });
      if (updated.code !== 0) return undefined;
    }
    const tree = await run(root, [...safe, "write-tree"], 1024, { env });
    return tree.code === 0 ? tree.stdout.trim() || undefined : undefined;
  } catch {
    return undefined;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export type TreeFileState = "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange";

export type TreeFileChange = {
  path: string;
  oldPath?: string;
  status: TreeFileState;
  added: number;
  removed: number;
  binary?: boolean;
};

const TREE_STATE: Record<string, TreeFileState> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "typechange" };

/** 解析 git diff-tree -z --name-status 和 --numstat 的输出，合成一份 */
export function parseTreeDiff(nameStatus: string, numstat: string): TreeFileChange[] {
  const files = new Map<string, TreeFileChange>();
  const names = nameStatus.split("\0");
  for (let i = 0; i < names.length; i++) {
    const code = names[i]!;
    if (!code) continue;
    const status = TREE_STATE[code[0]!];
    const two = code[0] === "R" || code[0] === "C";
    const first = names[++i];
    const second = two ? names[++i] : undefined;
    const target = second ?? first;
    if (!status || !target) continue;
    files.set(target, { path: target, ...(two ? { oldPath: first! } : {}), status, added: 0, removed: 0 });
  }
  const stats = numstat.split("\0");
  for (let i = 0; i < stats.length; i++) {
    const line = stats[i]!;
    if (!line) continue;
    const [added, removed, inline] = line.split("\t");
    // 重命名：路径字段是空的，后面两段是旧路径、新路径
    let target = inline;
    if (!target) {
      i++;
      target = stats[++i];
    }
    const file = target ? files.get(target) : undefined;
    if (!file) continue;
    if (added === "-" || removed === "-") file.binary = true;
    else {
      file.added = Number(added) || 0;
      file.removed = Number(removed) || 0;
    }
  }
  return [...files.values()];
}

async function treeChanges(root: string, before: string, after: string, safe: string[]): Promise<TreeFileChange[] | undefined> {
  const args = [...safe, "diff-tree", "-r", "-z", "-M", "--no-ext-diff", "--no-textconv"];
  const [names, stats] = await Promise.all([
    run(root, [...args, "--name-status", before, after], STATUS_MAX_BYTES),
    run(root, [...args, "--numstat", before, after], STATUS_MAX_BYTES),
  ]);
  if (names.code !== 0 || stats.code !== 0 || names.truncated || stats.truncated) return undefined;
  return parseTreeDiff(names.stdout, stats.stdout);
}

/** 两棵 tree 之间改了哪些文件。比不了（快照已经没了）返回 undefined */
export async function diffTrees(root: string, before: string, after: string): Promise<TreeFileChange[] | undefined> {
  return treeChanges(root, before, after, await safeArgs(root));
}

/** 两棵 tree 之间一个文件的 diff。和 gitDiff 一样，只认确实改了的文件；快照没了、文件不在里面都返回 undefined */
export async function treeFileDiff(root: string, before: string, after: string, file: string): Promise<GitDiff | undefined> {
  const safe = await safeArgs(root);
  const change = (await treeChanges(root, before, after, safe))?.find((f) => f.path === file);
  if (!change) return undefined;
  if (isSensitivePath(path.join(root, file)) || (change.oldPath && isSensitivePath(path.join(root, change.oldPath)))) {
    return { path: file, diff: "", truncated: false, note: "这是密钥一类的敏感文件，不显示内容" };
  }
  const paths = change.oldPath ? [file, change.oldPath] : [file];
  const out = await run(root, [...safe, "--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", before, after, "--", ...paths], DIFF_MAX_BYTES);
  if (out.code !== 0) return undefined;
  return diffResult(file, out);
}

const SNAPSHOT_REF = "refs/agent-loft/t/";

/** 只留这些 tree 的引用，其余的删掉，让 git gc 能回收。引用不是分支，不会出现在 git branch、git log 里 */
export async function keepTrees(root: string, trees: Iterable<string>): Promise<void> {
  const want = new Set(trees);
  const refs = await run(root, ["for-each-ref", "--format=%(objectname)", SNAPSHOT_REF], 4 * 1024 * 1024);
  if (refs.code !== 0) return;
  const have = new Set(refs.stdout.split("\n").filter(Boolean));
  const commands: string[] = [];
  for (const tree of have) if (!want.has(tree)) commands.push(`delete ${SNAPSHOT_REF}${tree}`);
  for (const tree of want) if (!have.has(tree)) commands.push(`create ${SNAPSHOT_REF}${tree} ${tree}`);
  // 更新引用会触发 reference-transaction 钩子，一定要带上关钩子的配置
  if (commands.length) await run(root, [...(await safeArgs(root)), "update-ref", "--stdin"], 64 * 1024, { input: `${commands.join("\n")}\n` });
}

// ---------- 提交历史 ----------

export type GitCommit = { hash: string; short: string; author: string; date: number; subject: string };

/** 提交历史，新的在前。还没有提交的仓库是空的 */
export async function gitLog(root: string, skip: number, limit: number): Promise<{ commits: GitCommit[]; more: boolean }> {
  const out = await run(
    root,
    [...(await safeArgs(root)), "-c", "log.showSignature=false", "log", "-z", "--no-color", "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s", `--skip=${skip}`, `-n${limit + 1}`],
    4 * 1024 * 1024,
  );
  if (out.code !== 0) return { commits: [], more: false };
  const lines = out.stdout.split("\0").filter(Boolean);
  const commits = lines.slice(0, limit).map((line) => {
    const [hash, short, author, date, subject] = line.split("\x1f");
    return { hash: hash ?? "", short: short ?? "", author: author ?? "", date: Number(date) * 1000 || 0, subject: subject ?? "" };
  });
  return { commits, more: lines.length > limit };
}

/** 页面传来的提交编号：只收 hash，不能是 --option 或 HEAD~1 这种，并且要确实是个提交 */
async function commitAndParent(root: string, hash: string): Promise<{ commit: string; parent: string } | undefined> {
  if (!/^[0-9a-f]{7,64}$/.test(hash)) return undefined;
  const commit = await run(root, ["rev-parse", "--verify", "-q", `${hash}^{commit}`], 1024);
  if (commit.code !== 0) return undefined;
  const parent = await run(root, ["rev-parse", "--verify", "-q", `${hash}^1`], 1024);
  if (parent.code === 0) return { commit: commit.stdout.trim(), parent: parent.stdout.trim() };
  // 第一个提交：和空目录比
  const empty = await run(root, ["hash-object", "-t", "tree", "--stdin"], 1024, { input: "" });
  return empty.code === 0 ? { commit: commit.stdout.trim(), parent: empty.stdout.trim() } : undefined;
}

export async function commitFiles(root: string, hash: string): Promise<TreeFileChange[] | undefined> {
  const pair = await commitAndParent(root, hash);
  return pair ? diffTrees(root, pair.parent, pair.commit) : undefined;
}

export async function commitFileDiff(root: string, hash: string, file: string): Promise<GitDiff | undefined> {
  const pair = await commitAndParent(root, hash);
  return pair ? treeFileDiff(root, pair.parent, pair.commit, file) : undefined;
}

// ---------- 用户点的操作 ----------
//
// 路径都要在当前的改动列表里，分支要在分支列表里：不把页面传来的字符串直接交给 git。
// 敏感文件不能暂存、不能丢弃、不能提交：不让人一不小心把密钥提交进去。

/** 带 HTTP 状态的错误：接口层照着回。extra 给页面判断下一步（比如冲突的文件列表） */
export class GitError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** git 的报错翻译成人话。认不出的原样给 */
function explain(stderr: string, fallback: string): string {
  const text = stderr.trim();
  if (/index\.lock|another git process/i.test(text)) return "另一个 git 进程正在操作这个仓库（可能是 agent），稍后再试";
  if (/would be overwritten|commit your changes or stash/i.test(text)) return "有没提交的改动会被覆盖，git 拒绝了。先提交或丢弃这些改动";
  if (/please tell me who you are|empty ident|unable to auto-detect email/i.test(text)) return "git 还没配置用户名和邮箱，先在终端里设置 user.name 和 user.email";
  if (/already exists/i.test(text)) return "这个分支已经存在了";
  if (/not a valid branch name|is not a valid/i.test(text)) return "分支名不合法";
  return text || fallback;
}

/**
 * 写操作前检查：自定义 filter 的仓库（git-crypt 之类）不能操作。
 * 不跑仓库配置里的程序是这里的底线，而这些 filter 不跑的话，暂存就是把明文写进去、切分支就是把密文写出来
 */
async function assertWritable(root: string): Promise<void> {
  const filters = await customFilters(root);
  if (filters.size) throw new GitError(409, `这个仓库配置了自定义的 Git 过滤器（${[...filters].join("、")}，比如 git-crypt），在面板里操作可能损坏内容或泄露明文，请在终端里操作`);
}

async function changesFor(root: string, paths: unknown): Promise<GitFileChange[]> {
  if (!Array.isArray(paths) || !paths.length || paths.some((p) => typeof p !== "string")) throw new GitError(400, "没有指定文件");
  const status = await gitStatus(root);
  return (paths as string[]).map((file) => {
    const change = status.files.find((f) => f.path === file);
    if (!change) throw new GitError(404, `「${file}」现在没有改动了，刷新一下再试`);
    return change;
  });
}

function rejectSensitive(changes: GitFileChange[], action: string): void {
  const secret = changes.find((f) => f.sensitive);
  if (secret) throw new GitError(403, `「${secret.path}」是密钥一类的敏感文件，不能在面板里${action}，需要的话请在终端里操作`);
}

/** git status 把嵌在里面的另一个仓库报成一个没跟踪的目录。丢弃会把整个仓库删掉，暂存会变成奇怪的 gitlink */
function rejectDirectories(root: string, changes: GitFileChange[], action: string): void {
  for (const f of changes) {
    if (f.unstaged === "untracked" && (f.path.endsWith("/") || fs.lstatSync(path.join(root, f.path), { throwIfNoEntry: false })?.isDirectory())) {
      throw new GitError(409, `「${f.path}」是一个目录（可能是嵌在里面的另一个仓库），不能在面板里${action}，请在终端里操作`);
    }
  }
}

async function write(root: string, args: string[], fallback: string, opts: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  const out = await run(root, [...(await safeArgs(root)), ...args], 1024 * 1024, opts);
  if (out.code !== 0) throw new GitError(409, explain(out.stderr, fallback));
  return out;
}

export async function gitStage(root: string, paths: unknown): Promise<void> {
  await assertWritable(root);
  const changes = await changesFor(root, paths);
  rejectSensitive(changes, "暂存");
  rejectDirectories(root, changes, "暂存");
  await write(root, ["--literal-pathspecs", "add", "-A", "--", ...changes.map((f) => f.path)], "暂存失败");
}

export async function gitUnstage(root: string, paths: unknown): Promise<void> {
  await assertWritable(root);
  const changes = await changesFor(root, paths);
  const targets = changes.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path]));
  // 只动暂存区，不碰工作区；还没有提交的仓库也能用
  await write(root, ["--literal-pathspecs", "reset", "-q", "--", ...targets], "取消暂存失败");
}

/** 丢弃工作区的改动：跟踪的文件恢复成暂存区的样子，没跟踪的文件删掉。暂存了的不动 */
export async function gitDiscard(root: string, paths: unknown): Promise<void> {
  await assertWritable(root);
  const changes = await changesFor(root, paths);
  rejectSensitive(changes, "丢弃");
  rejectDirectories(root, changes, "丢弃");
  const conflicted = changes.find((f) => f.unstaged === "conflicted");
  if (conflicted) throw new GitError(409, `「${conflicted.path}」有合并冲突，不能在这里丢弃`);
  const none = changes.find((f) => !f.unstaged);
  if (none) throw new GitError(409, `「${none.path}」只有已暂存的改动，先取消暂存再丢弃`);
  const tracked = changes.filter((f) => f.unstaged !== "untracked").map((f) => f.path);
  if (tracked.length) await write(root, ["--literal-pathspecs", "checkout", "--", ...tracked], "丢弃失败");
  for (const file of changes.filter((f) => f.unstaged === "untracked")) removeWorktreeFile(root, file.path);
}

/** 删工作区里的一个文件，顺手把空出来的目录也删了（和 git 一样）。路径上有符号链接的不动：不能跟着链接删到外面去 */
function removeWorktreeFile(root: string, file: string): void {
  const abs = path.join(root, file);
  const parent = path.dirname(abs);
  let realParent: string;
  try {
    realParent = fs.realpathSync(parent);
  } catch {
    return; // 目录已经没了，文件当然也没了
  }
  const realRoot = fs.realpathSync(root);
  if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) throw new GitError(403, `「${file}」的路径经过符号链接跳出了仓库，不能操作`);
  const target = path.join(realParent, path.basename(abs));
  if (fs.lstatSync(target, { throwIfNoEntry: false })?.isDirectory()) throw new GitError(409, `「${file}」现在是一个目录，不能当文件删除，请在终端里处理`);
  fs.rmSync(target, { force: true });
  for (let dir = parent; dir !== root && dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
    try {
      fs.rmdirSync(dir);
    } catch {
      break; // 不是空的
    }
  }
}

/**
 * 提交已暂存的内容。默认不跑 Git 钩子：钩子是仓库里的程序，要用户明确勾选（hooks）才跑，而且跑的时间可能很长。
 * 暂存区里有敏感文件不让提交。仓库配置（.git/config）里指定的签名程序不跑，全局配置的照常签名
 */
export async function gitCommit(root: string, message: unknown, opts: { hooks?: boolean } = {}): Promise<{ short: string }> {
  await assertWritable(root);
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) throw new GitError(400, "请写提交说明");
  const status = await gitStatus(root);
  const staged = status.files.filter((f) => f.staged);
  if (!staged.length) throw new GitError(409, "没有已暂存的文件");
  rejectSensitive(staged, "提交");
  const noLocalSigner = (await repoConfig(root, "^(gpg\\.|commit\\.gpgsign)")).length ? ["-c", "commit.gpgsign=false"] : [];
  // 不勾选时带 SAFE_CONFIG 里的 hooksPath=/dev/null（所有钩子都不跑）；勾选了要在它后面覆盖回来
  const hookArgs = opts.hooks ? ["-c", `core.hooksPath=${(await hooksDir(root))}`] : [];
  // 钩子是用户明确要跑的，可能要连网（pre-commit 框架第一次要 git clone）：禁止连网的设置不传给它们
  const env = opts.hooks ? { GIT_ALLOW_PROTOCOL: undefined, GIT_NO_LAZY_FETCH: undefined } : {};
  await write(root, [...noLocalSigner, ...hookArgs, "commit", "-q", "-F", "-"], "提交失败", { input: text, env, timeoutMs: opts.hooks ? 5 * 60_000 : 60_000 });
  const head = await run(root, ["rev-parse", "--short", "HEAD"], 1024);
  return { short: head.stdout.trim() };
}

/** 仓库本来的钩子目录：core.hooksPath 配了就是它，否则是 .git/hooks */
async function hooksDir(root: string): Promise<string> {
  const out = await run(root, ["rev-parse", "--git-path", "hooks"], 4096);
  return path.resolve(root, out.stdout.trim());
}

const BRANCH_NAME = /^[^\s~^:?*[\\-][^\s~^:?*[\\]*$/;

/** 切换分支。git 发现有没提交的改动会被覆盖时会拒绝，不会丢东西。remote：切到远程分支，建一个跟踪它的本地分支 */
export async function gitSwitch(root: string, branch: unknown): Promise<void> {
  await assertWritable(root);
  if (typeof branch !== "string" || !branch) throw new GitError(400, "没有指定分支");
  const { branches } = await gitBranches(root);
  const target = branches.find((b) => b.name === branch);
  if (!target) throw new GitError(404, `分支「${branch}」不存在`);
  if (target.current) return;
  if (!target.remote) {
    await write(root, ["checkout", "-q", target.name, "--"], "切换分支失败");
    return;
  }
  const local = target.name.slice(target.name.indexOf("/") + 1);
  if (branches.some((b) => !b.remote && b.name === local)) await write(root, ["checkout", "-q", local, "--"], "切换分支失败");
  else await write(root, ["checkout", "-q", "--track", `refs/remotes/${target.name}`], "切换分支失败");
}

/** 从当前位置新建分支并切过去 */
export async function gitCreateBranch(root: string, name: unknown): Promise<void> {
  await assertWritable(root);
  const branch = typeof name === "string" ? name.trim() : "";
  if (!BRANCH_NAME.test(branch)) throw new GitError(400, "分支名不合法");
  const valid = await run(root, ["check-ref-format", "--branch", branch], 1024);
  if (valid.code !== 0) throw new GitError(400, "分支名不合法");
  await write(root, ["checkout", "-q", "-b", branch], "新建分支失败");
}

// ---------- 撤销一轮 ----------

/** 两棵 tree 里内容不一样的文件。不做重命名检测：撤销时重命名就是一删一增 */
export async function differingPaths(root: string, a: string, b: string): Promise<string[] | undefined> {
  const out = await run(root, [...(await safeArgs(root)), "diff-tree", "-r", "-z", "--no-renames", "--name-only", a, b], STATUS_MAX_BYTES);
  if (out.code !== 0 || out.truncated) return undefined;
  return out.stdout.split("\0").filter(Boolean);
}

/**
 * 把这些文件恢复成 tree 里的样子：tree 里有的写回工作区（权限、符号链接都按 tree 的），没有的删掉。
 * 用临时索引，用户的暂存区不动
 */
export async function restoreFromTree(root: string, tree: string, files: string[]): Promise<void> {
  await assertWritable(root);
  if (!files.length) return;
  const safe = await safeArgs(root);
  const present = await run(root, [...safe, "--literal-pathspecs", "ls-tree", "-r", "-z", "--name-only", tree, "--", ...files], STATUS_MAX_BYTES);
  if (present.code !== 0) throw new GitError(409, explain(present.stderr, "读取快照失败"));
  const inTree = new Set(present.stdout.split("\0").filter(Boolean));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aloft-index-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(dir, "index") };
    const read = await run(root, [...safe, "read-tree", tree], 64 * 1024, { env });
    if (read.code !== 0) throw new GitError(409, explain(read.stderr, "读取快照失败"));
    // 先删再写：一个文件变成同名目录、或者反过来时，要先把挡路的删掉
    for (const file of files) if (!inTree.has(file)) removeWorktreeFile(root, file);
    if (inTree.size) {
      const out = await run(root, [...safe, "checkout-index", "-f", "-z", "--stdin"], 1024 * 1024, { env, input: [...inTree].map((p) => `${p}\0`).join("") });
      if (out.code !== 0) throw new GitError(409, explain(out.stderr, "恢复文件失败"));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
