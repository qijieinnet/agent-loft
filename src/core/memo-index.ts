import { MemoStorage, editable } from "../channels/web/memo-storage.js";
import { withMemoLock } from "../channels/web/memo-collab.js";
import { HttpError } from "../channels/web/http.js";
import { sql, transaction } from "./db.js";
import { ftsIndexText, ftsMatch, terms } from "./fts.js";
import { memoSources, canReadMemo, validMemoPath, type MemoSource } from "./memo-sources.js";
import { getUser, isAdmin, listUsers } from "./users.js";

const scope = "owner = ? AND source = ?";
type Job = { scanned: number; error?: string; pending?: Promise<void> };
const jobs = new Map<string, Job>(); // Source IDs are UUIDs.
let timer: NodeJS.Timeout | undefined;

export function indexMemo(owner: string, source: string, path: string, text: string, version: string) {
  const key = [owner, source, path];
  if (sql(`SELECT version FROM memo_documents WHERE ${scope} AND path = ?`).get(...key)?.version === version) return;
  transaction(() => {
    sql(`DELETE FROM memo_documents WHERE ${scope} AND path = ?`).run(...key);
    const { lastInsertRowid } = sql("INSERT INTO memo_documents(owner,source,path,version,body) VALUES(?,?,?,?,?)").run(...key, version, text);
    sql("INSERT INTO memo_fts(rowid,path,body) VALUES(?,?,?)").run(lastInsertRowid, ftsIndexText(path), ftsIndexText(text));
  });
}

export function clearMemoIndex(owner: string, source: string) {
  jobs.delete(source);
  transaction(() => {
    sql(`DELETE FROM memo_documents WHERE ${scope}`).run(owner, source);
    sql(`DELETE FROM memo_scans WHERE ${scope}`).run(owner, source);
  });
}

export function memoIndexStatus(owner: string, source: string) {
  const last = sql(`SELECT success FROM memo_scans WHERE ${scope}`).get(owner, source);
  const job = jobs.get(source);
  return { success: Number(last?.success ?? 0), scanned: job?.scanned ?? 0, running: !!job?.pending, error: job?.error };
}

// A failed local index update must not turn a successful remote PUT into a
// failed edit. The periodic scan retries it using the remote file as truth.
export function indexSavedMemo(owner: string, source: string, path: string, text: string, version: string) {
  try { indexMemo(owner, source, path, text, version); }
  catch {
    const job = jobs.get(source) ?? { scanned: 0 };
    job.error = "最近保存的笔记尚未完成索引，请刷新索引";
    jobs.set(source, job);
  }
}

async function* listTextFiles(storage: MemoStorage, current: () => boolean) {
  const folders = new Set([""]);
  for (const folder of folders) {
    let cursor = "";
    const cursors = new Set<string>();
    do {
      if (!current()) return;
      const page = await storage.list(folder, cursor);
      for (const entry of page.entries) {
        const path = folder ? folder + "/" + entry.name : entry.name;
        if (!validMemoPath(path)) continue;
        if (entry.directory) folders.add(path);
        else if (editable(path)) yield { path, etag: entry.etag };
      }
      cursor = page.next;
      if (cursor && cursors.has(cursor)) throw new HttpError(502, "存储服务返回了重复的分页标记");
      cursors.add(cursor);
    } while (cursor);
  }
}

export function refreshMemoIndex(owner: string, source: MemoSource) {
  const pending = jobs.get(source.id)?.pending;
  if (pending || !canReadMemo(source)) return pending;
  const user = getUser(owner);
  if (!user || user.disabled) return;
  const role = user.role;
  const job: Job = { scanned: 0 };
  jobs.set(source.id, job);
  const storage = new MemoStorage(source, isAdmin(user));
  const current = () => {
    const active = getUser(owner);
    return jobs.get(source.id) === job && !!active && !active.disabled && active.role === role &&
      memoSources(owner).some(s => s.id === source.id && canReadMemo(s));
  };
  job.pending = scanMemoSource(owner, source.id, storage, job, current).finally(() => { job.pending = undefined; });
  return job.pending;
}

async function scanMemoSource(owner: string, source: string, storage: MemoStorage, job: Job, current: () => boolean) {
  try {
    // Only prune rows present at the start. Concurrent saves get a new row ID.
    const old = sql(`SELECT id,path,version FROM memo_documents WHERE ${scope}`).all(owner, source);
    const missing = new Map(old.map(row => [String(row.path), row]));
    for await (const { path, etag } of listTextFiles(storage, current)) {
      if (!current()) return;
      const previous = missing.get(path);
      missing.delete(path);
      job.scanned++;
      if (etag && etag === previous?.version) continue;
      await withMemoLock(storage.objectURL(path).href, async () => {
        if (!current()) return;
        try {
          const file = await storage.readText(path);
          if (current()) indexMemo(owner, source, path, file.text, file.version);
        } catch (err) {
          if (!(err instanceof HttpError && [404, 413, 415].includes(err.status))) throw err;
          if (previous) missing.set(path, previous);
        }
      });
    }
    if (!current()) return;
    transaction(() => {
      for (const row of missing.values()) sql("DELETE FROM memo_documents WHERE id = ?").run(row.id!);
      sql("INSERT OR REPLACE INTO memo_scans VALUES(?,?,?)").run(owner, source, Date.now());
    });
  } catch (err) {
    job.error = err instanceof HttpError ? err.message : "索引更新失败，请重新刷新";
  }
}

export function startMemoIndexer() {
  if (timer) return;
  const refresh = () => {
    for (const user of listUsers()) {
      if (!user.disabled) for (const source of memoSources(user.id)) {
        if (canReadMemo(source)) void refreshMemoIndex(user.id, source);
      }
    }
  };
  refresh();
  timer = setInterval(refresh, 10 * 60_000);
  timer.unref();
}
export function stopMemoIndexer() { clearInterval(timer); timer = undefined; jobs.clear(); }

export function searchMemos(owner: string, sources: MemoSource[], query: string, folder: string) {
  if (query.length > 512) throw new HttpError(400, "搜索关键词限 512 字符");
  const match = ftsMatch(query);
  if (!match) throw new HttpError(400, "请输入搜索关键词");
  const libraries = sources.map(s => ({ id: s.id, name: s.name, ...memoIndexStatus(owner, s.id) }));
  if (!sources.length) return { libraries, hits: [] };
  const slots = sources.map(() => "?").join(",");
  const prefix = folder ? folder + "/" : "";
  const rows = sql(`SELECT d.source,d.path,d.body FROM memo_fts JOIN memo_documents d ON d.id = memo_fts.rowid
    WHERE memo_fts MATCH ? AND d.owner = ? AND d.source IN (${slots}) AND substr(d.path,1,length(?)) = ?
    ORDER BY bm25(memo_fts, 4, 1), d.path LIMIT 20`).all(match, owner, ...sources.map(s => s.id), prefix, prefix);
  const words = terms(query);
  const hits = rows.map(row => {
    const body = String(row.body), lower = body.toLowerCase();
    const at = words.map(w => lower.indexOf(w)).find(i => i >= 0) ?? 0;
    return { source: row.source, library: sources.find(s => s.id === row.source)?.name, path: row.path,
      snippet: body.slice(Math.max(0, at - 60), at + 140) };
  });
  return { libraries, hits };
}
