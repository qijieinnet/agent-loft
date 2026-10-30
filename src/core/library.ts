// 资料库：用户发过的附件、agent 生成的文件，按人汇总在一处，可以浏览、搜索、删掉，或者拿到别的对话里再用。
//
// 文件本身不搬家，还在上传目录里（data/uploads/<对话>/…，见 uploads.ts）：历史消息里写着的路径照样能预览，
// agent 读文件的范围也还是「这条对话的上传目录」。这里只在数据库的 files 表里记一份索引：谁的、哪条对话、
// 什么时候、从哪来（upload：用户发的；agent：agent 回复里给出的新文件，复制了一份进来）。
//
// 收录跟着 hub 的事件流走（见 startLibraryCapture）：
//   - 用户消息带的附件：发出去时收进来。上传了没发的不收，一天后清掉（见 tidyLibrary）；
//   - agent 的回复里提到的、这一轮新写出来的图片 / 文档 / 音视频：复制一份进这条对话的上传目录再收进来，
//     之后 agent 改了、删了原文件，资料库里的不受影响。
// 从资料库拿到别的对话里用：硬链接一份进那条对话的上传目录（见 attachToConversation），不占双份空间。
// 这份也记一行（source = copy，origin 指向原来那条），列表里不显示；删原件时连它一起删，空间才真的腾出来。
//
// 归属跟着对话的主人走：没有主人的对话（飞书群聊、没绑定账号的私聊）的文件归管理员，规则同 users.ts 的 ownedBy。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sql, transaction } from "./db.js";
import { hub } from "./hub.js";
import { replyFileType, resolveReplyFile } from "./reply-files.js";
import { getConversation } from "./store.js";
import { ensureUploadsDir, kindOf, safeName, sniff, uploadsRoot } from "./uploads.js";
import { listUsers, ownedBy, type User } from "./users.js";

type Viewer = Pick<User, "id" | "role">;
import type { AttachmentKind, SavedAttachment } from "./types.js";

/** upload：用户发的；agent：agent 生成的；copy：从资料库放进别的对话的那份（列表里不显示） */
export type LibrarySource = "upload" | "agent" | "copy";

export type LibraryFile = {
  id: string;
  /** 用户 id；空串 = 没有主人的对话里的，归管理员 */
  owner: string;
  convKey: string;
  path: string;
  name: string;
  kind: AttachmentKind;
  size: number;
  source: LibrarySource;
  createdAt: number;
};

/** 筛选：图片 / 文档（其余的文件）/ 音视频 */
export type LibraryKind = "image" | "file" | "media";

type Row = { id: string; owner: string; conv_key: string; path: string; name: string; kind: AttachmentKind; size: number; source: LibrarySource; origin: string | null; created_at: number };

const COLUMNS = "id, owner, conv_key, path, name, kind, size, source, origin, created_at";

function toFile(r: Row): LibraryFile {
  return { id: r.id, owner: r.owner, convKey: r.conv_key, path: r.path, name: r.name, kind: r.kind, size: r.size, source: r.source, createdAt: r.created_at };
}

/** agent 生成的文件最多收这么大的（复制一份要占地方） */
const AGENT_FILE_MAX = 50 * 1024 * 1024;
/** 一轮最多收这么多个 agent 生成的文件 */
const AGENT_FILES_PER_TURN = 10;
/** 上传了一直没发出去的，过这么久清掉 */
const UNSENT_TTL = 24 * 60 * 60 * 1000;

export function recordFile(params: {
  owner?: string;
  convKey: string;
  path: string;
  name: string;
  kind: AttachmentKind;
  size: number;
  source: LibrarySource;
  origin?: string;
  createdAt?: number;
}): boolean {
  const res = sql(`INSERT OR IGNORE INTO files (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    `f_${crypto.randomBytes(8).toString("hex")}`,
    params.owner ?? "",
    params.convKey,
    path.resolve(params.path),
    params.name,
    params.kind,
    params.size,
    params.source,
    params.origin ?? null,
    params.createdAt ?? Date.now(),
  );
  return Number(res.changes) > 0;
}

export function getLibraryFile(id: string): LibraryFile | undefined {
  const row = sql(`SELECT ${COLUMNS} FROM files WHERE id = ?`).get(id) as Row | undefined;
  return row ? toFile(row) : undefined;
}

export function canSeeFile(user: Viewer, file: LibraryFile): boolean {
  return ownedBy(user, file.owner || undefined);
}

/**
 * 这个用户看得到的那部分，拼成 SQL 条件：自己的；管理员还有没主人的、主人已经被删掉的
 * （和 ownedBy 一样：别的管理员的不算）
 */
function visibleWhere(user: Viewer): { where: string; args: string[] } {
  if (user.role !== "admin") return { where: "owner = ?", args: [user.id] };
  const others = listUsers()
    .map((u) => u.id)
    .filter((id) => id !== user.id);
  return { where: `(owner = ? OR owner NOT IN (${others.map(() => "?").join(", ") || "''"}))`, args: [user.id, ...others] };
}

const KIND_WHERE: Record<LibraryKind, string> = {
  image: "kind = 'image'",
  file: "kind = 'file'",
  media: "kind IN ('audio', 'video')",
};

/** 按时间从新到旧一页一页地列。before：上一页最后一个的 { createdAt, id } */
export function listLibrary(
  user: Viewer,
  opts: { kind?: LibraryKind; q?: string; before?: { at: number; id: string }; limit?: number } = {},
): { files: LibraryFile[]; more: boolean } {
  const { where, args } = visibleWhere(user);
  const conds = [where, "source != 'copy'"];
  const params: (string | number)[] = [...args];
  if (opts.kind) conds.push(KIND_WHERE[opts.kind]);
  const q = opts.q?.trim();
  if (q) {
    conds.push("instr(lower(name), ?) > 0");
    params.push(q.toLowerCase());
  }
  if (opts.before) {
    conds.push("(created_at < ? OR (created_at = ? AND id < ?))");
    params.push(opts.before.at, opts.before.at, opts.before.id);
  }
  const limit = Math.max(1, Math.min(200, opts.limit ?? 60));
  const rows = sql(`SELECT ${COLUMNS} FROM files WHERE ${conds.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`).all(
    ...params,
    limit + 1,
  ) as Row[];
  return { files: rows.slice(0, limit).map(toFile), more: rows.length > limit };
}

/** 一共多少个、多大 */
export function librarySummary(user: Viewer): { count: number; size: number } {
  const { where, args } = visibleWhere(user);
  const row = sql(`SELECT count(*) AS n, coalesce(sum(size), 0) AS s FROM files WHERE ${where} AND source != 'copy'`).get(...args) as { n: number; s: number };
  return { count: row.n, size: row.s };
}

/**
 * 从资料库删掉：文件和索引都删，放进别的对话的那几份也一起删（硬链接不全删掉空间腾不出来）。
 * 放它们的小目录（每次上传一个）空了也一并删掉
 */
export function deleteLibraryFile(file: LibraryFile): void {
  const all = sql("SELECT id, path FROM files WHERE id = ? OR origin = ?").all(file.id, file.id) as { id: string; path: string }[];
  for (const f of all) {
    fs.rmSync(f.path, { force: true });
    removeEmptyDirs(path.dirname(f.path));
  }
  sql("DELETE FROM files WHERE id = ? OR origin = ?").run(file.id, file.id);
}

/** 往上删空目录，到上传目录的根为止 */
function removeEmptyDirs(dir: string): void {
  const root = path.resolve(uploadsRoot);
  for (let d = path.resolve(dir); d.startsWith(root + path.sep); d = path.dirname(d)) {
    try {
      fs.rmdirSync(d);
    } catch {
      return; // 不空、或者已经没了
    }
  }
}

// ---------- 拿到对话里用 ----------

/**
 * 资料库里的文件放进这条对话：硬链接进它的上传目录（跨不了文件系统就复制），agent 照常能读。
 * 返回和刚上传的附件一样的东西，交给发消息时认领
 */
export function attachToConversation(file: LibraryFile, key: string): SavedAttachment {
  const dir = path.join(ensureUploadsDir(key), `lib-${crypto.randomBytes(6).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, safeName(file.name));
  try {
    fs.linkSync(file.path, target);
  } catch {
    fs.copyFileSync(file.path, target);
  }
  // 记下这一份：发出去时不会再当成新上传的收一遍，也不会被当成「上传了没发」清掉
  const conv = getConversation(key);
  recordFile({ owner: conv?.owner, convKey: key, path: target, name: path.basename(target), kind: file.kind, size: file.size, source: "copy", origin: file.id });
  const mediaType = sniffFile(target);
  return { kind: file.kind, path: target, name: path.basename(target), size: fs.statSync(target).size, ...(mediaType ? { mediaType } : {}) };
}

function sniffFile(file: string): string | undefined {
  const head = Buffer.alloc(12);
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    fs.readSync(fd, head, 0, head.length, 0);
    return sniff(head)?.mediaType;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** 按文件头，认不出再按后缀 */
function kindOfFile(file: string): AttachmentKind {
  return kindOf(sniffFile(file) ?? replyFileType(file));
}

// ---------- 收录 ----------

/** 回复里提到的这些后缀才当成「交给用户的东西」收进来：代码、配置之类的不算 */
const DELIVERABLE = "png|jpe?g|gif|webp|svg|pdf|docx?|xlsx?|pptx?|csv|zip|mp3|m4a|wav|mp4|mov|webm";
const CANDIDATE = new RegExp(`[^\\s<>"'\`()（）\\[\\]{}，。；：！？、“”‘’「」|*]+\\.(?:${DELIVERABLE})(?![\\p{L}\\p{N}_/-])`, "giu");

/** 回复里像是文件路径、后缀是图片 / 文档 / 音视频的 */
export function deliverablePaths(text: string): string[] {
  return [...new Set(text.match(CANDIDATE) ?? [])];
}

function within(file: string, dir: string): boolean {
  return file.startsWith(path.resolve(dir) + path.sep);
}

/**
 * 这一轮 agent 新写出来的文件（修改时间不早于这一轮开始）复制进对话的上传目录，收进资料库。
 * 用户自己传的（本来就在上传目录里）、太大的、敏感的（resolveReplyFile 挡掉）不收
 */
export async function captureAgentFiles(key: string, text: string, since: number): Promise<number> {
  const conv = getConversation(key);
  if (!conv) return 0;
  const seen = new Set<string>();
  let n = 0;
  for (const p of deliverablePaths(text)) {
    if (n >= AGENT_FILES_PER_TURN) break;
    const real = resolveReplyFile(p, conv.cwd);
    if (!real || seen.has(real) || within(real, uploadsRoot)) continue;
    seen.add(real);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(real);
    } catch {
      continue;
    }
    // 修改时间留两秒余量：有的文件系统只精确到秒
    if (stat.mtimeMs < since - 2000 || stat.size === 0 || stat.size > AGENT_FILE_MAX) continue;
    const dir = path.join(ensureUploadsDir(key), `agent-${crypto.randomBytes(6).toString("hex")}`);
    const target = path.join(dir, safeName(path.basename(real)));
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.copyFile(real, target);
    } catch (err) {
      console.warn(`[资料库] 收录 ${real} 失败:`, err instanceof Error ? err.message : err);
      continue;
    }
    recordFile({ owner: conv.owner, convKey: key, path: target, name: path.basename(target), kind: kindOfFile(target), size: stat.size, source: "agent" });
    n++;
  }
  return n;
}

let capturing = false;

export function startLibraryCapture(): void {
  if (capturing) return;
  capturing = true;
  /** 每条对话这一轮从什么时候开始（agent 生成的文件按修改时间认） */
  const turnStart = new Map<string, number>();
  hub.on("event", (env) => {
    const ev = env.ev;
    try {
      if (ev.type === "turn_start") {
        turnStart.set(env.key, env.ts);
        return;
      }
      if (ev.type === "user") {
        if (!ev.files?.length) return;
        const conv = getConversation(env.key);
        for (const f of ev.files) {
          const file = path.resolve(f.path);
          if (!within(file, uploadsRoot) || !fs.existsSync(file)) continue;
          recordFile({ owner: conv?.owner, convKey: env.key, path: file, name: f.name, kind: f.kind, size: f.size ?? fs.statSync(file).size, source: "upload", createdAt: env.ts });
        }
        return;
      }
      if (ev.type === "result" && ev.text) {
        const since = turnStart.get(env.key) ?? env.ts - 10 * 60_000;
        turnStart.delete(env.key);
        void captureAgentFiles(env.key, ev.text, since).catch((err) => console.warn("[资料库] 收录 agent 文件失败:", err));
      }
    } catch (err) {
      console.warn("[资料库] 收录失败:", err instanceof Error ? err.message : err);
    }
  });
}

// ---------- 启动时 ----------

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

/** 上传目录里的文件属于哪条对话（第一级目录名） */
function convKeyOf(file: string): string | undefined {
  const first = path.relative(uploadsRoot, file).split(path.sep)[0];
  if (!first) return undefined;
  try {
    return decodeURIComponent(first);
  } catch {
    return undefined;
  }
}

/**
 * 升级时把上传目录里已有的文件收进资料库，只做一次。以前切换会话时会清掉旧附件，留下来的都是还在用的那些
 */
export function backfillLibrary(): number {
  return transaction(() => {
    if (sql("SELECT 1 FROM migrations WHERE name = 'library-backfill'").get()) return 0;
    let n = 0;
    for (const file of walk(uploadsRoot)) {
      const key = convKeyOf(file);
      const conv = key ? getConversation(key) : undefined;
      if (!key || !conv) continue;
      const stat = fs.statSync(file);
      const agentMade = path.relative(uploadsRoot, file).split(path.sep).some((s) => s.startsWith("agent-"));
      const added = recordFile({
        owner: conv.owner,
        convKey: key,
        path: file,
        name: path.basename(file),
        kind: kindOfFile(file),
        size: stat.size,
        source: agentMade ? "agent" : "upload",
        createdAt: Math.round(stat.mtimeMs),
      });
      if (added) n++;
    }
    sql("INSERT INTO migrations (name, at) VALUES ('library-backfill', ?)").run(Date.now());
    return n;
  });
}

/**
 * 启动时收拾：对话已经不在了的，上传目录和索引一起删；文件已经没了的索引删掉；
 * 上传了一直没发出去（不在索引里）、超过一天的文件删掉
 */
export function tidyLibrary(now = Date.now()): { removed: number } {
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(uploadsRoot);
  } catch {
    // 还没有上传目录
  }
  for (const entry of entries) {
    let key: string;
    try {
      key = decodeURIComponent(entry);
    } catch {
      continue;
    }
    if (getConversation(key)) continue;
    fs.rmSync(path.join(uploadsRoot, entry), { recursive: true, force: true });
    removed += Number(sql("DELETE FROM files WHERE conv_key = ?").run(key).changes);
  }
  const indexed = new Set<string>();
  for (const row of sql("SELECT id, path FROM files").all() as { id: string; path: string }[]) {
    if (fs.existsSync(row.path)) indexed.add(row.path);
    else {
      sql("DELETE FROM files WHERE id = ?").run(row.id);
      removed++;
    }
  }
  for (const file of walk(uploadsRoot)) {
    if (indexed.has(file)) continue;
    try {
      if (now - fs.statSync(file).mtimeMs < UNSENT_TTL) continue;
      fs.rmSync(file, { force: true });
      removeEmptyDirs(path.dirname(file));
    } catch {
      // 刚好被删了
    }
  }
  return { removed };
}
