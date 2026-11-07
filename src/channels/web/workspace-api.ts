// 工作区面板的接口：/api/conversations/<key>/<workspace-… | git-…>。都不经过授权卡：是用户自己点的操作。
//
// 一律按会话定位，不接受前端传的目录：调用方（api.ts）已经核对过能看这条会话，这里再看账号开没开通面板。
// 路径都是相对路径：workspace-* 相对会话的工作目录，git-* 相对仓库根目录。
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  commitFileDiff,
  commitFiles,
  findRepo,
  gitBranches,
  gitCommit,
  gitCreateBranch,
  gitDiff,
  gitDiscard,
  gitFetch,
  gitIgnoredPaths,
  gitPull,
  gitPush,
  GitError,
  gitLog,
  gitStage,
  gitStatus,
  gitSwitch,
  gitUnstage,
} from "../../core/git.js";
import { hub } from "../../core/hub.js";
import { revertTurn, turnFileDiff, turnState } from "../../core/turn-changes.js";
import { listConversations, type Conversation } from "../../core/store.js";
import { canUseFiles, canUseGitRemote, type User } from "../../core/users.js";
import {
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  listWorkspaceEntries,
  readWorkspaceText,
  renameWorkspaceEntry,
  resolveWorkspaceFile,
  SAVE_MAX_BYTES,
  saveWorkspaceText,
  UPLOAD_MAX_BYTES,
  uploadWorkspaceFile,
  workspaceDir,
  WorkspaceError,
} from "../../core/workspace-files.js";
import { serveHtmlFile, serveReplyFile } from "./file-serve.js";
import { HttpError, readBody, readJsonBody, sendJson } from "./http.js";

/** 路由 → 方法 */
const ROUTES: Record<string, string> = {
  "workspace-tree": "GET",
  "workspace-file": "GET",
  "workspace-html": "GET",
  "workspace-text": "GET",
  "git-status": "GET",
  "git-diff": "GET",
  "git-branches": "GET",
  "git-turn-diff": "GET",
  "git-turn-state": "GET",
  "git-log": "GET",
  "git-commit-files": "GET",
  "git-commit-diff": "GET",
  "git-stage": "POST",
  "git-unstage": "POST",
  "git-discard": "POST",
  "git-commit": "POST",
  "git-switch": "POST",
  "git-branch-new": "POST",
  "git-fetch": "POST",
  "git-pull": "POST",
  "git-push": "POST",
  "git-turn-revert": "POST",
  "workspace-save": "POST",
  "workspace-new": "POST",
  "workspace-rename": "POST",
  "workspace-delete": "POST",
  "workspace-upload": "POST",
};

/** 所有会话的工作目录（解析符号链接后）：改名、删除时不能把它们弄没了 */
function conversationDirs(): string[] {
  const dirs = new Set<string>();
  for (const c of listConversations()) {
    // 已删除的会话不用管
    if (c.hidden) continue;
    try {
      dirs.add(fs.realpathSync(c.cwd));
    } catch {
      // 目录已经没了
    }
  }
  return [...dirs];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 文件操作的错误带着状态码和冲突类型 */
function fileOp<T>(res: ServerResponse, status: number, op: () => T): void {
  try {
    sendJson(res, status, op());
  } catch (err) {
    if (!(err instanceof WorkspaceError)) throw err;
    sendJson(res, err.status, { error: err.message, ...err.extra });
  }
}

/** git 自己报的错（仓库坏了、超时）：照实告诉页面 */
async function gitOp<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof GitError) throw err;
    throw new HttpError(500, err instanceof Error ? err.message : String(err));
  }
}

/** 这些操作会大面积改工作区：agent 正在这个仓库里干活时不能做，否则它接下来的动作都建立在错的文件上 */
function assertIdle(root: string): void {
  if (hub.busyInRepo(null, root)) throw new GitError(409, "agent 正在这个仓库里干活，等这一轮结束再操作");
}

/** 用户点的 Git 操作：返回结果，错误带着状态码和页面要用的信息（比如冲突的文件） */
async function gitAction(res: ServerResponse, op: () => Promise<unknown>): Promise<void> {
  try {
    sendJson(res, 200, (await op()) ?? { ok: true });
  } catch (err) {
    if (err instanceof GitError) sendJson(res, err.status, { error: err.message, ...err.extra });
    else throw err;
  }
}

export async function handleWorkspaceApi(req: IncomingMessage, res: ServerResponse, url: URL, sub: string, conv: Conversation, user: User): Promise<boolean> {
  if (ROUTES[sub] !== req.method) return false;
  if (!canUseFiles(user)) throw new HttpError(403, "你没有使用工作区面板的权限，找管理员在 设置 → 用户 里开通");
  const cwd = workspaceDir(conv.cwd);
  if (!cwd) throw new HttpError(404, "工作目录不存在，或不在工作区之内");
  const requested = url.searchParams.get("path") ?? "";

  if (sub === "workspace-text") {
    fileOp(res, 200, () => readWorkspaceText(cwd, requested));
    return true;
  }
  if (sub === "workspace-save") {
    // JSON 转义后可能比原文大不少，留点余量；真正的大小在下面按内容算
    const body = await readJsonBody<{ path?: unknown; content?: unknown; baseHash?: unknown; force?: unknown }>(req, SAVE_MAX_BYTES * 2);
    if (typeof body.content !== "string") throw new HttpError(400, "缺少文件内容");
    if (Buffer.byteLength(body.content) > SAVE_MAX_BYTES) throw new HttpError(413, "内容太大，不能保存");
    fileOp(res, 200, () =>
      saveWorkspaceText(cwd, asString(body.path), body.content as string, { baseHash: asString(body.baseHash), force: body.force === true }),
    );
    return true;
  }
  if (sub === "workspace-new") {
    const body = await readJsonBody<{ dir?: unknown; name?: unknown; type?: unknown }>(req);
    fileOp(res, 201, () => createWorkspaceEntry(cwd, asString(body.dir), body.name, body.type));
    return true;
  }
  if (sub === "workspace-rename") {
    const body = await readJsonBody<{ path?: unknown; name?: unknown }>(req);
    fileOp(res, 200, () => renameWorkspaceEntry(cwd, asString(body.path), body.name, conversationDirs()));
    return true;
  }
  if (sub === "workspace-delete") {
    const body = await readJsonBody<{ path?: unknown }>(req);
    fileOp(res, 200, () => {
      deleteWorkspaceEntry(cwd, asString(body.path), conversationDirs());
      return { ok: true };
    });
    return true;
  }
  if (sub === "workspace-upload") {
    const data = await readBody(req, UPLOAD_MAX_BYTES);
    fileOp(res, 201, () =>
      uploadWorkspaceFile(cwd, url.searchParams.get("dir") ?? "", url.searchParams.get("name"), data, url.searchParams.get("overwrite") === "1"),
    );
    return true;
  }
  if (sub === "workspace-tree") {
    const listing = listWorkspaceEntries(cwd, requested);
    if (!listing) throw new HttpError(404, "目录不存在，或者不能查看");
    const ignored = await gitIgnoredPaths(path.resolve(cwd, listing.path), listing.entries.map((entry) => entry.name));
    for (const entry of listing.entries) if (ignored.has(entry.name)) entry.ignored = true;
    sendJson(res, 200, listing);
    return true;
  }
  if (sub === "workspace-file" || sub === "workspace-html") {
    const file = resolveWorkspaceFile(cwd, requested);
    if (!file || (sub === "workspace-html" && !/\.html?$/i.test(file))) throw new HttpError(404, "文件不存在，或者不能查看");
    if (sub === "workspace-html") serveHtmlFile(res, file);
    else serveReplyFile(req, res, file, { stat: url.searchParams.get("stat") === "1", download: url.searchParams.get("download") === "1" });
    return true;
  }

  const repo = await findRepo(cwd);
  if (!repo.repo) {
    if (sub !== "git-status") throw new HttpError(404, "当前目录不是 git 仓库");
    sendJson(res, 200, repo);
    return true;
  }
  if (sub === "git-status") {
    const status = await gitOp(() => gitStatus(repo.root, { stats: true }));
    // 工作目录在仓库里的位置：页面拿仓库路径（相对根目录）去开文件（相对工作目录）时要换算
    sendJson(res, 200, { repo: true, ...status, prefix: path.relative(repo.root, fs.realpathSync(cwd)).split(path.sep).join("/") });
    return true;
  }
  if (sub === "git-diff") {
    const diff = await gitOp(() => gitDiff(repo.root, requested, url.searchParams.get("staged") === "1"));
    if (!diff) throw new HttpError(404, "这个文件现在没有这种改动");
    sendJson(res, 200, diff);
    return true;
  }
  if (req.method === "POST") {
    if ((sub === "git-fetch" || sub === "git-pull" || sub === "git-push") && !canUseGitRemote(user)) {
      throw new HttpError(403, "你没有连接 Git 远程的权限，找管理员在 设置 → 用户 里开通");
    }
    const body = await readJsonBody<{ paths?: unknown; message?: unknown; hooks?: unknown; branch?: unknown; name?: unknown; id?: unknown; direction?: unknown; force?: unknown }>(req);
    const root = repo.root;
    await gitAction(res, async () => {
      if (sub === "git-stage") return gitStage(root, body.paths);
      if (sub === "git-unstage") return gitUnstage(root, body.paths);
      if (sub === "git-commit") return gitCommit(root, body.message, { hooks: body.hooks === true });
      // 获取和推送不动工作区，agent 干活时也能做
      if (sub === "git-fetch") return gitFetch(root);
      if (sub === "git-push") return gitPush(root, { hooks: body.hooks === true });
      assertIdle(root);
      if (sub === "git-pull") return gitPull(root);
      if (sub === "git-discard") return gitDiscard(root, body.paths);
      if (sub === "git-switch") return gitSwitch(root, body.branch);
      if (sub === "git-branch-new") return gitCreateBranch(root, body.name);
      return revertTurn(root, asString(body.id), body.direction === "redo" ? "redo" : "undo", body.force === true);
    });
    return true;
  }
  if (sub === "git-log") {
    const skip = Math.max(0, Math.floor(Number(url.searchParams.get("skip")) || 0));
    sendJson(res, 200, await gitOp(() => gitLog(repo.root, skip, 50)));
    return true;
  }
  if (sub === "git-commit-files") {
    const files = await gitOp(() => commitFiles(repo.root, url.searchParams.get("hash") ?? ""));
    if (!files) throw new HttpError(404, "找不到这个提交");
    sendJson(res, 200, { files });
    return true;
  }
  if (sub === "git-commit-diff") {
    const diff = await gitOp(() => commitFileDiff(repo.root, url.searchParams.get("hash") ?? "", requested));
    if (!diff) throw new HttpError(404, "这个提交里没有这个文件的改动");
    sendJson(res, 200, diff);
    return true;
  }
  if (sub === "git-turn-state") {
    sendJson(res, 200, await gitOp(() => turnState(repo.root, url.searchParams.get("id") ?? "")));
    return true;
  }
  if (sub === "git-turn-diff") {
    const diff = await gitOp(() => turnFileDiff(repo.root, url.searchParams.get("id") ?? "", requested));
    if (!diff) throw new HttpError(404, "这一轮的快照已经清理了，看不到具体内容");
    sendJson(res, 200, diff);
    return true;
  }
  sendJson(res, 200, await gitOp(() => gitBranches(repo.root)));
  return true;
}
