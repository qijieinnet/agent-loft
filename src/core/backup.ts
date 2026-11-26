// 数据库的自动备份：记忆和聊天记录要存很多年，单靠这一个文件不够。
//
// 每天一份，放在 <家目录>/backups/db/（AGENT_LOFT_BACKUP_DIR 可以改到别的盘，比如外接硬盘或别的共享目录）。
// 用 VACUUM INTO 取一份一致的快照（WAL 模式下也安全，不挡别的读写），校验过再压缩，压缩完才算备份成功。
// 放在 worker 线程里做：库大了要好几秒，不能卡住服务。
//
// 保留：最近 7 天每天一份、最近 4 周每周一份、最近 12 个月每月一份，升级前留的那份不自动删。
//
// 恢复：停掉服务 → gunzip 备份文件 → 覆盖 data/agent-loft.db → 删掉 agent-loft.db-wal 和 -shm → 启动。
// 只备份数据库。配置和专家这些是 JSON 文件，不在这里面。
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { home } from "../home.js";
import { database, dbPath, LEGACY_MEMORY_ITEMS } from "./db.js";

const DAY = 86400_000;
const CHECK_MS = 3600_000;
const PREFIX = "agent-loft-";
const SUFFIX = ".db.gz";

export function backupDir(): string {
  return process.env.AGENT_LOFT_BACKUP_DIR?.trim() || path.join(home, "backups", "db");
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayName = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** 在 worker 里跑：快照 → 校验 → 压缩 → 改名。任何一步失败都不留半截文件 */
const WORKER = `
const { workerData, parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const zlib = require("node:zlib");
const { pipeline } = require("node:stream/promises");
const emit = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  if (/SQLite/i.test(typeof w === "string" ? w : (w && w.message) || "")) return;
  return emit.call(process, w, ...rest);
};
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
(async () => {
  const { source, target } = workerData;
  const raw = target + ".tmp-db";
  const gz = target + ".tmp";
  let result = { ok: true };
  try {
    // 上次备份到一半进程被杀留下的：VACUUM INTO 遇到已有的文件会报错，不清掉就再也备份不了
    fs.rmSync(raw, { force: true });
    fs.rmSync(gz, { force: true });
    const db = new DatabaseSync(source);
    db.exec("PRAGMA busy_timeout = 30000");
    db.prepare("VACUUM INTO ?").run(raw);
    db.close();
    const check = new DatabaseSync(raw, { readOnly: true });
    const ok = check.prepare("PRAGMA quick_check").get();
    check.close();
    if (Object.values(ok)[0] !== "ok") throw new Error("备份校验没通过：" + JSON.stringify(ok));
    await pipeline(fs.createReadStream(raw), zlib.createGzip({ level: 6 }), fs.createWriteStream(gz, { mode: 0o600 }));
    fs.renameSync(gz, target);
  } catch (err) {
    fs.rmSync(gz, { force: true });
    result = { ok: false, error: err && err.message ? err.message : String(err) };
  } finally {
    fs.rmSync(raw, { force: true });
  }
  // 临时文件都清完才算结束：主线程收到消息后可能马上又备份一次
  parentPort.postMessage(result);
})();
`;

function snapshot(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { eval: true, workerData: { source: dbPath, target }, execArgv: [] });
    let settled = false;
    worker.once("message", (m: { ok: boolean; error?: string }) => {
      settled = true;
      if (m.ok) resolve();
      else reject(new Error(m.error ?? "备份失败"));
    });
    worker.once("error", (err) => {
      settled = true;
      reject(err);
    });
    worker.once("exit", () => {
      if (!settled) reject(new Error("备份线程意外退出"));
    });
  });
}

export type BackupInfo = { name: string; at: number; size: number };

/** 现有的每日备份，新的在前 */
export function listBackups(): BackupInfo[] {
  const dir = backupDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const name of names) {
    if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      out.push({ name, at: st.mtimeMs, size: st.size });
    } catch {
      // 刚被删掉
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * 该留哪些：最近 7 天每天一份，最近 4 周每周最新的一份，最近 12 个月每月最新的一份。
 * 文件名里的日期说了算，不看文件时间（拷过来的文件时间不准）。
 */
export function backupsToKeep(names: string[], now = Date.now()): Set<string> {
  const dated = names
    .map((name) => ({ name, m: /(\d{4})-(\d{2})-(\d{2})/.exec(name) }))
    .filter((x): x is { name: string; m: RegExpExecArray } => !!x.m)
    .map((x) => ({ name: x.name, at: new Date(Number(x.m[1]), Number(x.m[2]) - 1, Number(x.m[3])).getTime() }))
    .sort((a, b) => b.at - a.at);
  const keep = new Set<string>();
  const weeks = new Set<number>();
  const months = new Set<string>();
  for (const { name, at } of dated) {
    const age = (now - at) / DAY;
    if (age < 7) keep.add(name);
    const week = Math.floor(at / (7 * DAY));
    if (age < 28 && !weeks.has(week)) {
      weeks.add(week);
      keep.add(name);
    }
    const d = new Date(at);
    const month = `${d.getFullYear()}-${d.getMonth()}`;
    if (age < 366 && !months.has(month)) {
      months.add(month);
      keep.add(name);
    }
  }
  return keep;
}

function prune(now: number): void {
  const dir = backupDir();
  const names = listBackups().map((b) => b.name);
  const keep = backupsToKeep(names, now);
  for (const name of names) if (!keep.has(name)) fs.rmSync(path.join(dir, name), { force: true });
}

/** 同一时间只做一份 */
let running: Promise<BackupInfo> | undefined;
let lastError: { at: number; message: string } | undefined;

/** 现在备份一份。同一天再备份就覆盖那天的 */
export function backupNow(now = Date.now()): Promise<BackupInfo> {
  if (running) return running;
  running = (async () => {
    const dir = backupDir();
    const name = `${PREFIX}${dayName(now)}${SUFFIX}`;
    const target = path.join(dir, name);
    try {
      // 目录建不了（外接盘没挂上、没权限）也算备份失败，要记下来让设置页显示
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      database();
      await snapshot(target);
      prune(now);
      lastError = undefined;
      const size = fs.statSync(target).size;
      console.log(`[备份] 数据库已备份到 ${target}（${(size / 1048576).toFixed(1)} MB）`);
      return { name, at: Date.now(), size };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = { at: Date.now(), message };
      console.error("[备份] 备份失败:", message);
      throw err;
    }
  })().finally(() => {
    running = undefined;
  });
  return running;
}

export function backupStatus(): { dir: string; last?: BackupInfo; count: number; error?: { at: number; message: string } } {
  const all = listBackups();
  return { dir: backupDir(), ...(all[0] ? { last: all[0] } : {}), count: all.length, ...(lastError ? { error: lastError } : {}) };
}

/** 最新的备份距今超过一天就备份 */
async function backupIfDue(now = Date.now()): Promise<void> {
  const last = listBackups()[0];
  if (last && now - last.at < DAY) return;
  await backupNow(now).catch(() => {});
}

let timer: NodeJS.Timeout | undefined;

export function startBackups(): void {
  if (timer) return;
  // 启动时的事多，缓一缓
  setTimeout(() => void backupIfDue(), 120_000).unref();
  timer = setInterval(() => void backupIfDue(), CHECK_MS);
  timer.unref();
}

/**
 * 还有条目存在老格式里要搬表、或者要补删已删除对话的记录：同步留一份升级前的备份（不压缩，这时候也不能等）。
 * 这份不参与自动清理，要手动删。
 */
export function backupBeforeMigration(): string | undefined {
  const d = database();
  const pending =
    d.prepare(`SELECT 1 FROM memory WHERE ${LEGACY_MEMORY_ITEMS} LIMIT 1`).get() ||
    // 从老版本升上来、还没清过已删除对话的：这一步也会删数据（memory-items 搬完后才可能只剩这一步）
    (d.prepare("SELECT 1 FROM history LIMIT 1").get() && !d.prepare("SELECT 1 FROM migrations WHERE name = 'memory-hidden-conversations-purged'").get());
  if (!pending) return undefined;
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, `before-memory-upgrade-${Date.now()}.db`);
  d.prepare("VACUUM INTO ?").run(target);
  fs.chmodSync(target, 0o600);
  console.log(`[备份] 升级记忆前留了一份备份：${target}`);
  return target;
}
