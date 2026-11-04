// 工作区面板的文件部分：列出会话工作目录里的文件，解析出能给前端看的路径，以及编辑、新建、重命名、删除、上传。
//
// 和 core/reply-files.ts 的区别：回复里的文件只认 agent 写过的路径；这里是用户主动浏览，
// 范围换成「会话的工作目录之内」，接口只收相对路径。能不能用面板由 users.ts 的 canUseFiles 决定。
//
// 三道关：
//   1. 写法上不能跳出工作目录（../、绝对路径）；
//   2. 解析符号链接后不能跳出工作区根目录（链接到同一工作区的别的项目可以）；
//   3. 解析前后都不能是敏感文件（isSensitivePath）或 .git 目录里的东西 ——
//      .git/config 的远程地址里可能带着令牌。
// 写操作走同样的规矩，敏感文件和 .git 里的东西也写不了。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config, resolveWorkspacePath } from "./config.js";
import { isSensitivePath } from "./reply-files.js";

/** 一个目录最多列这么多项：node_modules 这种没人会一项项翻 */
const LIST_MAX = 2000;

export type WorkspaceEntry = {
  name: string;
  /** 相对工作目录 */
  path: string;
  type: "dir" | "file";
  /** 目录没有大小 */
  size?: number;
  mtime: number;
  /** 符号链接：显示时标一下，指向的类型算在 type 里 */
  link?: boolean;
};

export type WorkspaceListing = {
  /** 相对工作目录，根目录是 "" */
  path: string;
  entries: WorkspaceEntry[];
  /** 项太多，只列了前一部分 */
  truncated: boolean;
};

function inside(dir: string, target: string): boolean {
  return target === dir || target.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

/** 不分大小写的文件系统（macOS、Windows）上 .GIT 就是 .git */
function blocked(file: string): boolean {
  return file.split(path.sep).some((part) => part.toLowerCase() === ".git") || isSensitivePath(file);
}

/** 给页面的相对路径一律用斜杠，Windows 上也一样 */
const toPosix = (rel: string): string => (path.sep === "/" ? rel : rel.split(path.sep).join("/"));

/** 会话的工作目录。目录没了、配置改过后不在工作区之内：undefined */
export function workspaceDir(cwd: string): string | undefined {
  return resolveWorkspacePath(cwd) ?? undefined;
}

/** 相对路径 → 绝对路径和解析符号链接后的路径。不合规矩返回 undefined */
function resolveEntry(cwd: string, rel: string): { abs: string; real: string; stat: fs.Stats } | undefined {
  if (rel.includes("\0") || path.isAbsolute(rel)) return undefined;
  const abs = path.resolve(cwd, rel);
  if (!inside(cwd, abs) || blocked(abs)) return undefined;
  try {
    const real = fs.realpathSync(abs);
    if (!inside(fs.realpathSync(config().workspaceRoot), real) || blocked(real)) return undefined;
    return { abs, real, stat: fs.statSync(real) };
  } catch {
    return undefined;
  }
}

/** 解析成可以给前端看的真实文件路径。不存在、不是普通文件、不能看：undefined */
export function resolveWorkspaceFile(cwd: string, rel: string): string | undefined {
  const entry = rel ? resolveEntry(cwd, rel) : undefined;
  return entry?.stat.isFile() ? entry.real : undefined;
}

/** 列一层目录：目录在前，按名字自然排序。不能看的（敏感文件、跳出工作区的链接）直接不出现 */
export function listWorkspaceEntries(cwd: string, rel: string): WorkspaceListing | undefined {
  const dir = resolveEntry(cwd, rel);
  if (!dir?.stat.isDirectory()) return undefined;
  const base = toPosix(path.relative(cwd, dir.abs));
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(dir.real, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
  // 目录排前面再截断：项太多时不至于把目录截掉（指向目录的符号链接到后面才知道，最后再排一次）
  names.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || collator.compare(a.name, b.name));
  const entries: WorkspaceEntry[] = [];
  let truncated = false;
  for (const item of names) {
    if (entries.length >= LIST_MAX) {
      truncated = true;
      break;
    }
    const child = base ? `${base}/${item.name}` : item.name;
    const found = resolveEntry(cwd, child);
    if (!found) continue;
    const isDir = found.stat.isDirectory();
    // 管道、设备文件之类的打开了也看不了
    if (!isDir && !found.stat.isFile()) continue;
    entries.push({
      name: item.name,
      path: child,
      type: isDir ? "dir" : "file",
      ...(isDir ? {} : { size: found.stat.size }),
      mtime: found.stat.mtimeMs,
      ...(item.isSymbolicLink() ? { link: true } : {}),
    });
  }
  entries.sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir"));
  return { path: base, entries, truncated };
}

// ---------- 编辑 ----------

/** 能在网页里编辑的文件大小上限（和预览时读的上限一致：超过的只读得到开头，保存会把文件截断） */
export const EDIT_MAX_BYTES = 1024 * 1024;
/** 保存时收的内容上限：编辑时可能粘贴进更多内容 */
export const SAVE_MAX_BYTES = 8 * 1024 * 1024;
/** 上传到工作目录的文件上限（和对话附件一致） */
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

/** 带 HTTP 状态的错误：接口层照着回 */
export class WorkspaceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const hashOf = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest("hex");

export type WorkspaceText = { path: string; name: string; content: string; hash: string; size: number; mtime: number };

/** 读出来编辑。太大、不是文本、不是 UTF-8 的不给编辑 —— 改完存回去内容会坏 */
export function readWorkspaceText(cwd: string, rel: string): WorkspaceText {
  const file = resolveWorkspaceFile(cwd, rel);
  if (!file) throw new WorkspaceError(404, "文件不存在，或者不能查看");
  const st = fs.statSync(file);
  if (st.size > EDIT_MAX_BYTES) throw new WorkspaceError(413, "文件超过 1 MB，不能在网页里编辑");
  const data = fs.readFileSync(file);
  if (data.includes(0)) throw new WorkspaceError(415, "这个文件不是文本，不能编辑");
  const content = data.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(data)) throw new WorkspaceError(415, "这个文件不是 UTF-8 编码，保存会损坏内容，不能编辑");
  return { path: rel, name: path.basename(file), content, hash: hashOf(data), size: st.size, mtime: st.mtimeMs };
}

function isErrno(err: unknown, ...codes: string[]): boolean {
  return codes.includes((err as NodeJS.ErrnoException).code ?? "");
}

function writeError(err: unknown, action: string): WorkspaceError {
  if (err instanceof WorkspaceError) return err;
  if (isErrno(err, "EACCES", "EPERM", "EROFS")) return new WorkspaceError(403, `没有权限${action}`);
  if (isErrno(err, "ENOSPC", "EDQUOT")) return new WorkspaceError(507, "磁盘空间不足");
  return new WorkspaceError(500, `${action}失败：${err instanceof Error ? err.message : String(err)}`);
}

/** 先写到同目录的临时文件再改名：写到一半出错、断电，原文件都还是完整的。保留原来的权限 */
function writeAtomic(file: string, data: Buffer, mode?: number): void {
  const temp = path.join(path.dirname(file), `.${path.basename(file).slice(0, 100)}.${crypto.randomBytes(4).toString("hex")}.aloft-tmp`);
  try {
    fs.writeFileSync(temp, data, { flag: "wx", ...(mode !== undefined ? { mode } : {}) });
    // writeFile 的 mode 会被 umask 削掉
    if (mode !== undefined) fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

/**
 * 保存。baseHash 是读出来时的内容 hash：文件这期间被 agent 或别人改过就返回 409，不覆盖；
 * force 明确要覆盖时不看 hash。文件已经被删掉：一样算冲突，force 时重新创建。
 */
export function saveWorkspaceText(cwd: string, rel: string, content: string, opts: { baseHash?: string; force?: boolean }): { hash: string; size: number; mtime: number } {
  const data = Buffer.from(content, "utf8");
  const existing = rel ? resolveEntry(cwd, rel) : undefined;
  let target: string;
  let mode: number | undefined;
  if (existing) {
    if (!existing.stat.isFile()) throw new WorkspaceError(400, "这不是文件，不能保存");
    target = existing.real;
    mode = existing.stat.mode & 0o7777;
    if (!opts.force && hashOf(fs.readFileSync(target)) !== opts.baseHash) {
      throw new WorkspaceError(409, "文件已经被改过了", { conflict: "changed" });
    }
    // 改名替换不看文件本身的权限，只读文件得在这里挡住
    try {
      fs.accessSync(target, fs.constants.W_OK);
    } catch {
      throw new WorkspaceError(403, "这个文件是只读的");
    }
  } else {
    target = resolveNewEntry(cwd, path.dirname(rel) === "." ? "" : path.dirname(rel), path.basename(rel));
    // 路径上有东西但看不了（比如跳出工作区的链接）：不能把它换成一个文件
    if (fs.lstatSync(target, { throwIfNoEntry: false })) throw new WorkspaceError(404, "文件不存在，或者不能查看");
    if (!opts.force) throw new WorkspaceError(409, "文件已经被删掉了", { conflict: "deleted" });
  }
  try {
    writeAtomic(target, data, mode);
  } catch (err) {
    throw writeError(err, "保存");
  }
  const st = fs.statSync(target);
  return { hash: hashOf(data), size: st.size, mtime: st.mtimeMs };
}

// ---------- 新建、重命名、删除、上传 ----------

function checkName(name: unknown): string {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n || n === "." || n === ".." || /[\\/\x00-\x1f\x7f]/.test(n) || Buffer.byteLength(n) > 255) {
    throw new WorkspaceError(400, "请输入有效的名称，不能包含斜杠或控制字符");
  }
  return n;
}

/** 要在 dir（相对工作目录）里新建的东西的绝对路径：目录要存在且能看，新名字不能是敏感文件 */
function resolveNewEntry(cwd: string, dir: string, name: unknown): string {
  const n = checkName(name);
  const parent = resolveEntry(cwd, dir);
  if (!parent?.stat.isDirectory()) throw new WorkspaceError(404, "目录不存在，或者不能查看");
  const target = path.join(parent.real, n);
  if (blocked(target) || blocked(path.join(parent.abs, n))) throw new WorkspaceError(403, "敏感文件和 .git 里的东西不能在这里操作");
  return target;
}

function assertFree(target: string): void {
  if (fs.lstatSync(target, { throwIfNoEntry: false })) throw new WorkspaceError(409, "同名文件或文件夹已存在");
}

export function createWorkspaceEntry(cwd: string, dir: string, name: unknown, type: unknown): { path: string; type: "file" | "dir" } {
  const target = resolveNewEntry(cwd, dir, name);
  assertFree(target);
  const kind = type === "dir" ? "dir" : "file";
  try {
    if (kind === "dir") fs.mkdirSync(target);
    else fs.writeFileSync(target, "", { flag: "wx" });
  } catch (err) {
    if (isErrno(err, "EEXIST")) throw new WorkspaceError(409, "同名文件或文件夹已存在");
    throw writeError(err, "新建");
  }
  return { path: toPosix(path.join(dir, path.basename(target))), type: kind };
}

/**
 * 要改名、删除的东西本身（不跟符号链接：删链接不能变成删它指向的内容）。
 * 工作目录本身不行；目录里有别的会话的工作目录也不行，那些会话要从项目菜单里处理。
 */
function resolveExisting(cwd: string, rel: string, conversationDirs: string[]): { target: string; isDir: boolean } {
  if (!rel || rel.includes("\0") || path.isAbsolute(rel)) throw new WorkspaceError(404, "文件不存在，或者不能操作");
  const abs = path.resolve(cwd, rel);
  if (abs === cwd || !inside(cwd, abs)) throw new WorkspaceError(403, "不能操作工作目录本身");
  const parent = resolveEntry(cwd, path.relative(cwd, path.dirname(abs)));
  if (!parent?.stat.isDirectory()) throw new WorkspaceError(404, "文件不存在，或者不能操作");
  const target = path.join(parent.real, path.basename(abs));
  if (blocked(target) || blocked(abs)) throw new WorkspaceError(404, "文件不存在，或者不能操作");
  const st = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!st) throw new WorkspaceError(404, "文件不存在，或者不能操作");
  if (st.isDirectory() && conversationDirs.some((dir) => inside(target, dir))) {
    throw new WorkspaceError(409, "这个目录是其他会话的工作目录，或者包含其他会话的工作目录，不能在这里操作");
  }
  return { target, isDir: st.isDirectory() };
}

export function renameWorkspaceEntry(cwd: string, rel: string, name: unknown, conversationDirs: string[]): { path: string } {
  const { target } = resolveExisting(cwd, rel, conversationDirs);
  const relDir = path.dirname(rel) === "." ? "" : path.dirname(rel);
  const next = resolveNewEntry(cwd, relDir, name);
  if (next === target) return { path: rel };
  // 不分大小写的文件系统上，只改大小写时新旧名字是同一个文件，不算重名
  const from = fs.lstatSync(target);
  const to = fs.lstatSync(next, { throwIfNoEntry: false });
  if (to && (to.ino !== from.ino || to.dev !== from.dev)) throw new WorkspaceError(409, "同名文件或文件夹已存在");
  try {
    fs.renameSync(target, next);
  } catch (err) {
    if (isErrno(err, "EEXIST", "ENOTEMPTY")) throw new WorkspaceError(409, "同名文件或文件夹已存在");
    throw writeError(err, "重命名");
  }
  return { path: toPosix(path.join(relDir, path.basename(next))) };
}

export function deleteWorkspaceEntry(cwd: string, rel: string, conversationDirs: string[]): void {
  const { target, isDir } = resolveExisting(cwd, rel, conversationDirs);
  try {
    if (isDir) fs.rmSync(target, { recursive: true });
    else fs.unlinkSync(target);
  } catch (err) {
    throw writeError(err, "删除");
  }
}

export function uploadWorkspaceFile(cwd: string, dir: string, name: unknown, data: Buffer, overwrite: boolean): { path: string } {
  const target = resolveNewEntry(cwd, dir, name);
  const st = fs.lstatSync(target, { throwIfNoEntry: false });
  if (st && !overwrite) throw new WorkspaceError(409, "同名文件已存在", { conflict: "exists" });
  // 不替换目录，也不替换符号链接：把链接换成文件多半不是想要的结果
  if (st && !st.isFile()) throw new WorkspaceError(409, "同名的文件夹或链接已存在，不能覆盖");
  try {
    writeAtomic(target, data, st ? st.mode & 0o7777 : undefined);
  } catch (err) {
    throw writeError(err, "上传");
  }
  return { path: toPosix(path.join(dir, path.basename(target))) };
}
