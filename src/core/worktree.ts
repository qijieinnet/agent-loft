// Git Worktree 并发会话隔离：
//
// 同一仓库下开多个会话时，每个隔离会话拥有自己独立的 worktree 目录和临时分支，
// 互不踩文件，也不会因为另一个会话在跑而锁住工作区的提交 / 切分支 / 撤销。
//
// 存放位置：<workspaceRoot>/.agent-loft-worktrees/<repoSlug>-<hash8>/<wtId>
//   - 落在 workspaceRoot 内：天然满足 resolveWorkspacePath、findRepo、工作区面板和 Agent 沙箱边界；
//   - 落在主仓库目录外：不污染主仓库的 git status，且 hub.busyInRepo 不会与主仓库互相干扰；
//   - 删除时强校验目录必须落在 .agent-loft-worktrees 之内，绝不误删外部目录。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config, resolveWorkspacePath } from "./config.js";
import { findRepo, gitBranches, GitError, gitInternal, gitStatus } from "./git.js";
import type { WorktreeInfo } from "./store.js";
import { clearTurnSnapshots } from "./turn-changes.js";

const { run, safeArgs, assertWritable, repoConfig, explain, BRANCH_NAME } = gitInternal;

export const WORKTREES_DIR_NAME = ".agent-loft-worktrees";

export function worktreesBaseDir(): string {
  return path.join(config().workspaceRoot, WORKTREES_DIR_NAME);
}

function inside(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 转为 workspaceRoot 的规范写法（根目录本身是符号链接时保持一致）。 */
function workspaceNormalized(abs: string): string {
  const wsRoot = config().workspaceRoot;
  const realWs = fs.realpathSync(wsRoot);
  const realTarget = fs.realpathSync(abs);
  if (!inside(realWs, realTarget)) throw new GitError(403, "目录不在工作区之内");
  return path.join(wsRoot, path.relative(realWs, realTarget));
}

export type MainRepoInfo =
  | { repo: true; root: string; mainRoot: string; isWorktree: boolean }
  | { repo: false; reason?: string };

/**
 * 查找目录所属的仓库及其主仓库根目录（即使 cwd 本身已经在链接 worktree 里，
 * 也能通过 --git-common-dir 定位到主仓库）。
 */
export async function findMainRepo(cwd: string): Promise<MainRepoInfo> {
  const found = await findRepo(cwd);
  if (!found.repo) return found;
  const commonOut = await run(found.root, ["rev-parse", "--git-dir", "--git-common-dir"], 64 * 1024);
  if (commonOut.code !== 0) return { repo: false, reason: explain(commonOut.stderr, "读取仓库信息失败") };
  const [rawGitDir, rawCommonDir] = commonOut.stdout.trim().split("\n");
  if (!rawGitDir || !rawCommonDir) return { repo: false, reason: "读取仓库信息失败" };
  const gitDir = fs.realpathSync(path.resolve(found.root, rawGitDir));
  const commonDir = fs.realpathSync(path.resolve(found.root, rawCommonDir));
  const isWorktree = gitDir !== commonDir;
  // 普通仓库和链接工作树的 commonDir 都是 <mainRepo>/.git
  const mainAbs = isWorktree ? path.dirname(commonDir) : found.root;
  try {
    const mainRoot = workspaceNormalized(mainAbs);
    const root = workspaceNormalized(found.root);
    return { repo: true, root, mainRoot, isWorktree };
  } catch {
    return { repo: false, reason: "主仓库不在工作区之内，不能创建隔离工作树" };
  }
}

export type WorktreeProbe = {
  eligible: boolean;
  repoRoot?: string;
  branch?: string | null;
  head?: string | null;
  branches?: string[];
  reason?: string;
};

/** 供新对话页探测当前选中目录是否支持开启隔离工作树。 */
export async function probeWorktree(cwd: string): Promise<WorktreeProbe> {
  const resolved = resolveWorkspacePath(cwd);
  if (!resolved) return { eligible: false, reason: "目录不存在或不在工作区之内" };
  const repo = await findMainRepo(resolved);
  if (!repo.repo) return { eligible: false, ...(repo.reason ? { reason: repo.reason } : {}) };
  try {
    if (fs.realpathSync(repo.mainRoot) === fs.realpathSync(config().workspaceRoot)) {
      return { eligible: false, reason: "工作区根目录本身就是 Git 仓库，请把项目放到子目录里再使用隔离工作树" };
    }
  } catch {
    return { eligible: false, reason: "无法访问仓库目录" };
  }
  const head = await run(repo.mainRoot, ["rev-parse", "--verify", "-q", "HEAD"], 1024);
  if (head.code !== 0) return { eligible: false, repoRoot: repo.mainRoot, reason: "这个仓库还没有提交，先提交一次再创建隔离工作树" };
  const [status, listed] = await Promise.all([
    gitStatus(repo.root).catch(() => null),
    gitBranches(repo.mainRoot).catch(() => ({ branches: [], truncated: false })),
  ]);
  const localBranches = listed.branches.filter((b) => !b.remote).slice(0, 30).map((b) => b.name);
  return {
    eligible: true,
    repoRoot: repo.mainRoot,
    branch: status?.branch ?? null,
    head: status?.head ?? head.stdout.trim().slice(0, 7),
    branches: localBranches,
  };
}

export type CreateWorktreeOptions = {
  /** 可选自定义分支名，不给则自动生成 aloft/wt-<6位十六进制> */
  branch?: string;
  /** 可选基线分支名，不给则基于当前 HEAD */
  baseBranch?: string;
};

function sanitizeSlug(name: string): string {
  const clean = name
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return clean || "repo";
}

async function refExists(repoRoot: string, ref: string): Promise<boolean> {
  const out = await run(repoRoot, ["show-ref", "--verify", "--quiet", ref], 1024);
  return out.code === 0;
}

async function pickBranchName(repoRoot: string, requested?: string): Promise<string> {
  const custom = typeof requested === "string" ? requested.trim() : "";
  if (custom) {
    if (!BRANCH_NAME.test(custom)) throw new GitError(400, "分支名不合法");
    const valid = await run(repoRoot, ["check-ref-format", "--branch", custom], 1024);
    if (valid.code !== 0) throw new GitError(400, "分支名不合法");
    if (await refExists(repoRoot, `refs/heads/${custom}`)) throw new GitError(409, `分支「${custom}」已经存在，请换一个名称`);
    return custom;
  }
  for (let i = 0; i < 8; i++) {
    const candidate = `aloft/wt-${crypto.randomBytes(3).toString("hex")}`;
    if (!(await refExists(repoRoot, `refs/heads/${candidate}`))) return candidate;
  }
  throw new GitError(500, "无法生成可用的临时分支名，请重试");
}

/**
 * 为指定项目目录创建一个隔离的 Git Worktree。
 * 若 projectCwd 本身已经是仓库子目录或另一个工作树，会自动归一化主仓库并保留子目录相对位置。
 */
export async function createWorktree(
  projectCwd: string,
  opts: CreateWorktreeOptions = {},
): Promise<{ cwd: string; worktree: WorktreeInfo }> {
  const resolved = resolveWorkspacePath(projectCwd);
  if (!resolved) throw new GitError(400, `目录必须存在，且在 ${config().workspaceRoot} 之内`);
  const repo = await findMainRepo(resolved);
  if (!repo.repo) throw new GitError(400, repo.reason ?? "当前目录不是 Git 仓库，无法创建隔离工作树");
  const realMain = fs.realpathSync(repo.mainRoot);
  const realWs = fs.realpathSync(config().workspaceRoot);
  if (realMain === realWs) {
    throw new GitError(409, "工作区根目录本身就是 Git 仓库，请把项目放到子目录里再使用隔离工作树");
  }
  await assertWritable(repo.mainRoot);

  // 确认仓库已有提交（空仓库无法 git worktree add）
  const headOut = await run(repo.mainRoot, ["rev-parse", "--verify", "-q", "HEAD"], 1024);
  if (headOut.code !== 0) throw new GitError(409, "这个仓库还没有提交，先提交一次再创建隔离工作树");

  let startRef = "HEAD";
  let baseBranch: string | undefined;
  const reqBase = typeof opts.baseBranch === "string" ? opts.baseBranch.trim() : "";
  if (reqBase) {
    if (!BRANCH_NAME.test(reqBase)) throw new GitError(400, "基线分支名不合法");
    if (await refExists(repo.mainRoot, `refs/heads/${reqBase}`)) {
      startRef = `refs/heads/${reqBase}`;
      baseBranch = reqBase;
    } else if (await refExists(repo.mainRoot, `refs/remotes/${reqBase}`)) {
      startRef = `refs/remotes/${reqBase}`;
      baseBranch = reqBase;
    } else {
      throw new GitError(404, `找不到基线分支「${reqBase}」`);
    }
  } else {
    const status = await gitStatus(repo.root).catch(() => null);
    if (status?.branch) {
      startRef = `refs/heads/${status.branch}`;
      baseBranch = status.branch;
    } else {
      // 分离头指针：基于当前仓库的 HEAD 提交
      const curHead = await run(repo.root, ["rev-parse", "--verify", "-q", "HEAD"], 1024);
      if (curHead.code === 0 && curHead.stdout.trim()) startRef = curHead.stdout.trim();
    }
  }

  const baseCommitOut = await run(repo.mainRoot, ["rev-parse", "--verify", "-q", `${startRef}^{commit}`], 1024);
  if (baseCommitOut.code !== 0 || !baseCommitOut.stdout.trim()) throw new GitError(409, "无法解析基线提交");
  const baseCommit = baseCommitOut.stdout.trim();

  const branch = await pickBranchName(repo.mainRoot, opts.branch);

  // 计算 worktree 目录：<workspaceRoot>/.agent-loft-worktrees/<slug>-<hash8>/<wtId>
  const repoHash = crypto.createHash("sha256").update(realMain).digest("hex").slice(0, 8);
  const bucket = `${sanitizeSlug(path.basename(repo.mainRoot))}-${repoHash}`;
  const wtId = `wt-${crypto.randomBytes(4).toString("hex")}`;
  const parentDir = path.join(worktreesBaseDir(), bucket);
  fs.mkdirSync(parentDir, { recursive: true });
  const wtRoot = path.join(parentDir, wtId);

  const safe = await safeArgs(repo.mainRoot);
  const added = await run(repo.mainRoot, [...safe, "worktree", "add", "-b", branch, wtRoot, startRef], 1024 * 1024, { timeoutMs: 60_000 });
  if (added.code !== 0) {
    // 清理可能残留的空目录
    fs.rmSync(wtRoot, { recursive: true, force: true });
    throw new GitError(409, explain(added.stderr, "创建隔离工作树失败"));
  }

  // 如果是从仓库子目录发起的，保持同样的子目录路径
  const relSub = path.relative(fs.realpathSync(repo.root), fs.realpathSync(resolved));
  const canonicalWtRoot = workspaceNormalized(wtRoot);
  const canonicalProjectCwd = repo.isWorktree ? path.join(repo.mainRoot, relSub) : resolved;
  const subInWt = relSub && !relSub.startsWith("..") ? path.join(canonicalWtRoot, relSub) : canonicalWtRoot;
  const cwd = fs.existsSync(subInWt) && fs.statSync(subInWt).isDirectory() ? subInWt : canonicalWtRoot;

  const worktree: WorktreeInfo = {
    repoRoot: repo.mainRoot,
    projectCwd: fs.existsSync(canonicalProjectCwd) ? canonicalProjectCwd : repo.mainRoot,
    root: canonicalWtRoot,
    branch,
    ...(baseBranch ? { baseBranch } : {}),
    baseCommit,
  };
  return { cwd, worktree };
}

export type WorktreeEntry = {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
  prunable?: boolean;
};

/** 解析 git worktree list --porcelain，列出仓库下所有工作树。 */
export async function listRepoWorktrees(cwd: string): Promise<WorktreeEntry[]> {
  const repo = await findMainRepo(cwd);
  if (!repo.repo) return [];
  const out = await run(repo.mainRoot, ["worktree", "list", "--porcelain"], 1024 * 1024);
  if (out.code !== 0) return [];
  const entries: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of out.stdout.split("\n")) {
    if (!line.trim()) {
      if (cur) entries.push(cur);
      cur = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length) };
    } else if (cur && line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length).trim();
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (cur && line === "bare") {
      cur.bare = true;
    } else if (cur && line === "detached") {
      cur.detached = true;
    } else if (cur && line.startsWith("prunable")) {
      cur.prunable = true;
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

export type WorktreeStatus = {
  repoRoot: string;
  projectCwd: string;
  root: string;
  branch: string;
  currentBranch: string | null;
  baseBranch?: string;
  baseCommit: string;
  exists: boolean;
  dirty: boolean;
  changedFiles: number;
  mainBranch: string | null;
  mainDirty: boolean;
  ahead: number;
  behind: number;
  diffStats?: { files: number; added: number; removed: number };
};

/** 获取隔离工作树相对于主仓库目标分支的实时状态（领先/落后提交、改动统计、主仓库是否干净）。 */
export async function worktreeStatus(wt: WorktreeInfo): Promise<WorktreeStatus> {
  const exists = fs.existsSync(wt.root);
  const [wtSt, mainSt] = await Promise.all([
    exists ? gitStatus(wt.root).catch(() => null) : Promise.resolve(null),
    fs.existsSync(wt.repoRoot) ? gitStatus(wt.repoRoot).catch(() => null) : Promise.resolve(null),
  ]);
  const currentBranch = wtSt?.branch ?? null;
  const mainBranch = mainSt?.branch ?? null;
  // 对比目标：优先主仓库当前检出的分支（合并时也是合并到主仓库当前分支），其次基线分支，最后基线提交
  const targetRef = mainBranch ? `refs/heads/${mainBranch}` : wt.baseBranch ? `refs/heads/${wt.baseBranch}` : wt.baseCommit;
  const sourceRef = currentBranch ? `refs/heads/${currentBranch}` : exists ? "HEAD" : `refs/heads/${wt.branch}`;

  let ahead = 0;
  let behind = 0;
  let diffStats: { files: number; added: number; removed: number } | undefined;

  if (fs.existsSync(wt.repoRoot)) {
    const cwdForDiff = exists ? wt.root : wt.repoRoot;
    const lr = await run(cwdForDiff, ["rev-list", "--left-right", "--count", `${targetRef}...${sourceRef}`], 1024);
    if (lr.code === 0) {
      const [b, a] = lr.stdout.trim().split(/\s+/).map(Number);
      behind = Number.isFinite(b) ? b! : 0;
      ahead = Number.isFinite(a) ? a! : 0;
    }
    if (ahead > 0) {
      const safe = await safeArgs(cwdForDiff);
      const ns = await run(cwdForDiff, [...safe, "diff", "--numstat", "--no-ext-diff", "--no-textconv", `${targetRef}...${sourceRef}`], 1024 * 1024);
      if (ns.code === 0 && !ns.truncated) {
        let files = 0;
        let added = 0;
        let removed = 0;
        for (const line of ns.stdout.split("\n")) {
          if (!line) continue;
          const [a, r] = line.split("\t");
          files++;
          if (a !== "-") added += Number(a) || 0;
          if (r !== "-") removed += Number(r) || 0;
        }
        diffStats = { files, added, removed };
      }
    }
  }

  return {
    repoRoot: wt.repoRoot,
    projectCwd: wt.projectCwd,
    root: wt.root,
    branch: wt.branch,
    currentBranch,
    ...(wt.baseBranch ? { baseBranch: wt.baseBranch } : {}),
    baseCommit: wt.baseCommit,
    exists,
    dirty: (wtSt?.files.length ?? 0) > 0,
    changedFiles: wtSt?.files.length ?? 0,
    mainBranch,
    mainDirty: (mainSt?.files.length ?? 0) > 0,
    ahead,
    behind,
    ...(diffStats ? { diffStats } : {}),
  };
}

/** 校验工作树路径必须严格位于 <workspaceRoot>/.agent-loft-worktrees 之内，防止误删任意目录。 */
function assertManagedWorktreePath(wtRoot: string): void {
  const base = path.resolve(worktreesBaseDir());
  const resolved = path.resolve(wtRoot);
  if (resolved === base || !inside(base, resolved)) {
    throw new GitError(403, "这个目录不是 agent-loft 管理的隔离工作树，拒绝删除");
  }
  if (fs.existsSync(base) && fs.existsSync(resolved)) {
    const realBase = fs.realpathSync(base);
    const realTarget = fs.realpathSync(resolved);
    if (realTarget === realBase || !inside(realBase, realTarget)) {
      throw new GitError(403, "工作树路径经符号链接跳出了受管目录，拒绝删除");
    }
  }
}

export type RemoveWorktreeOptions = {
  force?: boolean;
  deleteBranch?: boolean;
};

/** 清理隔离工作树目录、快照引用，以及可选删除临时分支。 */
export async function removeWorktree(
  wt: WorktreeInfo,
  opts: RemoveWorktreeOptions = {},
): Promise<{ removed: boolean; branchDeleted: boolean }> {
  assertManagedWorktreePath(wt.root);
  const exists = fs.existsSync(wt.root);
  if (exists && !opts.force) {
    const status = await gitStatus(wt.root).catch(() => null);
    if (status && status.files.length > 0) {
      throw new GitError(409, `隔离工作树里还有 ${status.files.length} 个未提交的改动，请先提交/丢弃，或选择强制清理`, {
        conflict: "dirty",
        files: status.files.map((f) => f.path),
      });
    }
  }

  // 在删除目录前先清理轮次快照引用（需要 realpath）
  await clearTurnSnapshots(wt.repoRoot, wt.root);

  const repoExists = fs.existsSync(wt.repoRoot);
  if (repoExists) {
    const safe = await safeArgs(wt.repoRoot);
    if (exists) {
      const args = [...safe, "worktree", "remove", ...(opts.force ? ["--force"] : []), wt.root];
      const out = await run(wt.repoRoot, args, 1024 * 1024, { timeoutMs: 30_000 });
      if (out.code !== 0) {
        if (!opts.force) throw new GitError(409, explain(out.stderr, "清理隔离工作树失败"));
        // 强制清理时如果 git worktree remove 仍失败，直接删受管目录再 prune
        fs.rmSync(wt.root, { recursive: true, force: true });
        await run(wt.repoRoot, [...safe, "worktree", "prune"], 64 * 1024);
      }
    } else {
      await run(wt.repoRoot, [...safe, "worktree", "prune"], 64 * 1024);
    }
  } else if (exists) {
    fs.rmSync(wt.root, { recursive: true, force: true });
  }

  // 顺手清理空的分组父目录（只清理 .agent-loft-worktrees/<bucket>）
  try {
    const parent = path.dirname(path.resolve(wt.root));
    const base = path.resolve(worktreesBaseDir());
    if (parent !== base && inside(base, parent)) fs.rmdirSync(parent);
  } catch {
    // 非空或已删
  }

  let branchDeleted = false;
  if (opts.deleteBranch && repoExists) {
    const mainStatus = await gitStatus(wt.repoRoot).catch(() => null);
    if (mainStatus?.branch !== wt.branch && (await refExists(wt.repoRoot, `refs/heads/${wt.branch}`))) {
      const safe = await safeArgs(wt.repoRoot);
      const del = await run(wt.repoRoot, [...safe, "branch", opts.force ? "-D" : "-d", wt.branch], 64 * 1024);
      branchDeleted = del.code === 0;
    }
  }

  return { removed: true, branchDeleted };
}

export type MergeWorktreeOptions = {
  mode: "merge" | "squash";
  message?: string;
  cleanup?: boolean;
  deleteBranch?: boolean;
};

export type MergeWorktreeResult = {
  merged: boolean;
  short?: string;
  note?: string;
  cleaned: boolean;
  branchDeleted: boolean;
};

/**
 * 把隔离工作树的分支合并回主仓库当前分支。
 * 发生冲突时自动中止合并，保证主仓库始终处于干净状态。
 */
export async function mergeWorktree(wt: WorktreeInfo, opts: MergeWorktreeOptions): Promise<MergeWorktreeResult> {
  if (!fs.existsSync(wt.repoRoot)) throw new GitError(404, "主仓库目录已经不存在了");
  if (!fs.existsSync(wt.root)) throw new GitError(404, "隔离工作树目录已经不存在了");
  await assertWritable(wt.repoRoot);
  await assertWritable(wt.root);

  const [wtSt, mainSt] = await Promise.all([gitStatus(wt.root), gitStatus(wt.repoRoot)]);
  if (wtSt.files.length > 0) {
    throw new GitError(409, `隔离工作树还有 ${wtSt.files.length} 个未提交的改动，请先提交或丢弃后再合并`, {
      conflict: "worktree-dirty",
      files: wtSt.files.map((f) => f.path),
    });
  }
  if (mainSt.files.length > 0) {
    throw new GitError(409, `主仓库还有 ${mainSt.files.length} 个未提交的改动，请先提交或暂存后再合并`, {
      conflict: "main-dirty",
      files: mainSt.files.map((f) => f.path),
    });
  }
  if (!mainSt.branch) {
    throw new GitError(409, "主仓库当前处于分离头指针状态，请先在主仓库切换到目标分支");
  }
  const sourceBranch = wtSt.branch ?? wt.branch;
  if (sourceBranch === mainSt.branch) {
    throw new GitError(409, "工作树和主仓库在同一分支上，无需合并");
  }
  const lr = await run(wt.repoRoot, ["rev-list", "--left-right", "--count", `refs/heads/${mainSt.branch}...refs/heads/${sourceBranch}`], 1024);
  const ahead = lr.code === 0 ? Number(lr.stdout.trim().split(/\s+/)[1]) || 0 : 0;
  if (ahead === 0) {
    let cleaned = false;
    let branchDeleted = false;
    if (opts.cleanup) {
      const rm = await removeWorktree(wt, { force: false, deleteBranch: opts.deleteBranch ?? true });
      cleaned = rm.removed;
      branchDeleted = rm.branchDeleted;
    }
    return { merged: false, note: `分支 ${sourceBranch} 相对 ${mainSt.branch} 没有新提交`, cleaned, branchDeleted };
  }

  const safe = await safeArgs(wt.repoRoot);
  const noLocalSigner = (await repoConfig(wt.repoRoot, "^(gpg\\.|commit\\.gpgsign)")).length ? ["-c", "commit.gpgsign=false"] : [];

  if (opts.mode === "squash") {
    const msg = (opts.message ?? "").trim() || `Merge ${sourceBranch} into ${mainSt.branch}`;
    const sq = await run(wt.repoRoot, [...safe, "merge", "--squash", "--no-stat", `refs/heads/${sourceBranch}`], 1024 * 1024, { timeoutMs: 60_000 });
    if (sq.code !== 0) {
      const conflicts = (await gitStatus(wt.repoRoot).catch(() => null))?.files.filter((f) => f.unstaged === "conflicted").map((f) => f.path) ?? [];
      await run(wt.repoRoot, [...safe, "reset", "--merge"], 64 * 1024);
      throw new GitError(
        409,
        conflicts.length
          ? `合并产生冲突（${conflicts.slice(0, 5).join("、")}${conflicts.length > 5 ? " 等" : ""}），已自动回滚。可先在隔离工作树里合并 ${mainSt.branch} 解决冲突后再试`
          : explain(sq.stderr, "压缩合并失败，已自动回滚"),
        { conflict: "merge", files: conflicts },
      );
    }
    const cm = await run(wt.repoRoot, [...safe, ...noLocalSigner, "commit", "-q", "-F", "-"], 1024 * 1024, { input: msg, timeoutMs: 60_000 });
    if (cm.code !== 0) {
      await run(wt.repoRoot, [...safe, "reset", "--merge"], 64 * 1024);
      throw new GitError(409, explain(cm.stderr, "压缩合并提交失败，已自动回滚"));
    }
  } else {
    const customMsg = (opts.message ?? "").trim();
    const args = [...safe, ...noLocalSigner, "merge", "--no-stat", ...(customMsg ? ["-m", customMsg] : ["--no-edit"]), `refs/heads/${sourceBranch}`];
    const mg = await run(wt.repoRoot, args, 1024 * 1024, { timeoutMs: 60_000 });
    if (mg.code !== 0) {
      const conflicts = (await gitStatus(wt.repoRoot).catch(() => null))?.files.filter((f) => f.unstaged === "conflicted").map((f) => f.path) ?? [];
      await run(wt.repoRoot, [...safe, "merge", "--abort"], 64 * 1024);
      throw new GitError(
        409,
        conflicts.length
          ? `合并产生冲突（${conflicts.slice(0, 5).join("、")}${conflicts.length > 5 ? " 等" : ""}），已自动中止。可先在隔离工作树里合并 ${mainSt.branch} 解决冲突后再试`
          : explain(mg.stderr, "合并失败，已自动中止"),
        { conflict: "merge", files: conflicts },
      );
    }
  }

  const head = await run(wt.repoRoot, ["rev-parse", "--short", "HEAD"], 1024);
  const short = head.stdout.trim() || undefined;

  let cleaned = false;
  let branchDeleted = false;
  if (opts.cleanup) {
    // squash 合并后分支历史未直连，需要 -D 才能删掉临时分支
    const rm = await removeWorktree(wt, { force: opts.mode === "squash", deleteBranch: opts.deleteBranch ?? true });
    cleaned = rm.removed;
    branchDeleted = rm.branchDeleted;
  }

  return { merged: true, ...(short ? { short } : {}), cleaned, branchDeleted };
}
