// 每轮对话改了什么：一轮开始前和结束后各拍一张工作区快照（见 git.ts 的 snapshotTree），比较两张得出改动。
//
// 不靠 agent 上报：Codex 只说改了哪些路径，Claude 只报自己工具改的，用命令改的两边都不算。
//
// 时间线：
//   - 发消息时会话空闲：先拍「开始」这张再把消息交给 agent（等不了太久，见 BEGIN_BUDGET_MS）；
//   - 一轮结束：拍「结束」这张，比较，有改动就记下来；
//   - 排队的消息紧接着开始：不再拍，上一轮「结束」那张就是它的「开始」，每一轮都对得上。
//
// 工作区是共用的：这一轮期间你自己改的、同一仓库里别的会话改的都会算进来。别的会话在跑时会标出来（shared）。
//
// 快照是 git 对象，靠 refs/agent-loft/t/ 下的引用留着。每个仓库只留最近 KEEP_PER_REPO 轮，
// 更早的引用删掉，等 git gc 回收；那些轮次的摘要还在（存在脚注里），只是看不了具体内容了。
import crypto from "node:crypto";
import { sql, transaction } from "./db.js";
import { differingPaths, diffTrees, findRepo, GitError, keepTrees, restoreFromTree, snapshotTree, treeFileDiff, type GitDiff } from "./git.js";
import type { TurnChanges } from "./types.js";

/** 拍「开始」这张最多等这么久：消息不能因为仓库太大发不出去。超时这一轮就没有改动卡片 */
const BEGIN_BUDGET_MS = 5000;
const KEEP_PER_REPO = 200;
const KEEP_MAX_AGE_MS = 60 * 86400_000;
/** 摘要里最多列这么多个文件 */
const MAX_FILES_IN_SUMMARY = 200;

type Baseline = { cwd: string; root: string; tree: string; shared: boolean };

const baselines = new Map<string, Baseline>();
/** 同一条会话的快照按顺序来：结束那张没拍完，下一轮的开始不能抢在前面 */
const chains = new Map<string, Promise<unknown>>();
/** 每次开始加一：超时放弃的那次拍完了也不算数 */
const generations = new Map<string, number>();

function chain<T>(key: string, job: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).catch(() => {}).then(job);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

/** 一轮开始之前调用。不会抛错，也不会等太久 */
export async function beginTurnSnapshot(key: string, cwd: string, busyInRepo: (root: string) => boolean): Promise<void> {
  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  const job = chain(key, async () => {
    baselines.delete(key);
    const repo = await findRepo(cwd);
    if (!repo.repo) return;
    const tree = await snapshotTree(repo.root);
    if (tree && generations.get(key) === generation) baselines.set(key, { cwd, root: repo.root, tree, shared: busyInRepo(repo.root) });
  }).catch((err) => console.error("[快照] 拍开始的快照失败:", err));
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      // 这一轮要开始了，后面才拍完的不能当基准：里面可能已经有 agent 的改动
      generations.set(key, generation + 1);
      resolve();
    }, BEGIN_BUDGET_MS);
    timer.unref?.();
  });
  await Promise.race([job, timeout]);
  clearTimeout(timer);
}

/** 一轮结束时调用。有改动返回摘要，没有（或者不是仓库、快照失败）返回 null。不会抛错 */
export function finishTurnSnapshot(key: string, cwd: string, busyInRepo: (root: string) => boolean): Promise<TurnChanges | null> {
  return chain(key, async () => {
    const base = baselines.get(key);
    // 中途切了目录：基准是别的目录的
    if (!base || base.cwd !== cwd) return null;
    const shared = base.shared || busyInRepo(base.root);
    const after = await snapshotTree(base.root);
    if (!after) {
      baselines.delete(key);
      return null;
    }
    const before = base.tree;
    // 下一轮接着这张比。接下来一轮的 shared 看它自己期间的情况
    baselines.set(key, { ...base, tree: after, shared: busyInRepo(base.root) });
    if (after === before) return null;
    const files = await diffTrees(base.root, before, after);
    if (!files?.length) return null;
    const changes: TurnChanges = {
      id: crypto.randomBytes(8).toString("hex"),
      files: files.slice(0, MAX_FILES_IN_SUMMARY),
      fileCount: files.length,
      added: files.reduce((n, f) => n + f.added, 0),
      removed: files.reduce((n, f) => n + f.removed, 0),
      ...(shared ? { shared: true } : {}),
    };
    await remember(changes.id, base.root, before, after);
    return changes;
  }).catch((err) => {
    console.error("[快照] 比较这一轮的改动失败:", err);
    return null;
  });
}

async function remember(id: string, root: string, before: string, after: string): Promise<void> {
  const now = Date.now();
  const kept = transaction(() => {
    sql("INSERT INTO turn_changes (id, root, before_tree, after_tree, at) VALUES (?, ?, ?, ?, ?)").run(id, root, before, after, now);
    sql("DELETE FROM turn_changes WHERE at < ?").run(now - KEEP_MAX_AGE_MS);
    sql(
      `DELETE FROM turn_changes WHERE root = ? AND id NOT IN (
         SELECT id FROM turn_changes WHERE root = ? ORDER BY at DESC, rowid DESC LIMIT ?)`,
    ).run(root, root, KEEP_PER_REPO);
    return sql("SELECT before_tree AS b, after_tree AS a FROM turn_changes WHERE root = ?").all(root) as { b: string; a: string }[];
  });
  await keepTrees(root, kept.flatMap((r) => [r.b, r.a]));
}

/**
 * 某一轮里一个文件的 diff。id 只在同一个仓库里认：不接受页面传来的 tree hash，
 * 免得拼个 hash 读到仓库里任意的历史内容。记录没了、不是这个仓库的返回 undefined
 */
export async function turnFileDiff(root: string, id: string, file: string): Promise<GitDiff | undefined> {
  const row = turnRow(root, id);
  return row ? treeFileDiff(root, row.b, row.a, file) : undefined;
}

// ---------- 撤销和重做 ----------
//
// 不需要记「撤销过没有」：看工作区现在的样子就知道。这一轮动过的文件和「结束」那张一样就是还在，
// 和「开始」那张一样就是撤销过了，都不一样就是之后又改过了。
// 只恢复这一轮动过的文件，别的文件不碰。重做就是反过来恢复成「结束」那张。

export type TurnState = {
  /** applied：改动还在；undone：已经撤销了；diverged：这些文件之后又被改过；expired：快照没了；unavailable：现在判断不了（工作区文件太多之类） */
  state: "applied" | "undone" | "diverged" | "expired" | "unavailable";
  /** diverged 时：哪些文件和这一轮结束时不一样了 */
  diverged?: string[];
};

type TurnRow = { root: string; b: string; a: string };

function turnRow(root: string, id: string): TurnRow | undefined {
  const row = sql("SELECT root, before_tree AS b, after_tree AS a FROM turn_changes WHERE id = ?").get(id) as TurnRow | undefined;
  return row && row.root === root ? row : undefined;
}

async function inspect(row: TurnRow): Promise<{ state: TurnState; files: string[] }> {
  const files = await differingPaths(row.root, row.b, row.a);
  if (!files) return { state: { state: "expired" }, files: [] };
  const now = await snapshotTree(row.root);
  if (!now) return { state: { state: "unavailable" }, files };
  const [fromAfter, fromBefore] = await Promise.all([differingPaths(row.root, row.a, now), differingPaths(row.root, row.b, now)]);
  if (!fromAfter || !fromBefore) return { state: { state: "expired" }, files };
  const mine = new Set(files);
  const changed = fromAfter.filter((f) => mine.has(f));
  if (!changed.length) return { state: { state: "applied" }, files };
  if (!fromBefore.some((f) => mine.has(f))) return { state: { state: "undone" }, files };
  return { state: { state: "diverged", diverged: changed }, files };
}

export async function turnState(root: string, id: string): Promise<TurnState> {
  const row = turnRow(root, id);
  return row ? (await inspect(row)).state : { state: "expired" };
}

/**
 * 撤销（undo）或重做（redo）一轮。文件之后又被改过时不动手，报 409 并列出文件；force 明确要覆盖。
 * 只改工作区里这些文件，暂存区、对话记录都不变
 */
export async function revertTurn(root: string, id: string, direction: "undo" | "redo", force: boolean): Promise<TurnState> {
  const row = turnRow(root, id);
  if (!row) throw new GitError(404, "这一轮的快照已经清理了，不能撤销");
  const { state, files } = await inspect(row);
  if (state.state === "expired") throw new GitError(404, "这一轮的快照已经清理了，不能撤销");
  if (state.state === "unavailable") throw new GitError(409, "现在判断不了这些文件的状态（工作区的改动太多，或者这个仓库配置了自定义过滤器），没有动手");
  const done = direction === "undo" ? "undone" : "applied";
  if (state.state === done) return state;
  if (state.state === "diverged" && !force) throw new GitError(409, "这些文件之后又被改过了", { conflict: "diverged", files: state.diverged });
  await restoreFromTree(root, direction === "undo" ? row.b : row.a, files);
  return (await inspect(row)).state;
}
