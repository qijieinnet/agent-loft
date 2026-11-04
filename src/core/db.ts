// 本地数据库：data/agent-loft.db（SQLite，用 Node 自带的 node:sqlite）。
//
// 放在这里的是会越用越多、或者好几个进程都要写的：会话（conversations）、会话归属（session_owners）、
// 聊天记录索引（history / history_meta）、每轮回复的脚注（footers）、用量（usage_sessions / usage_daily）、
// 每个人的记忆（memory 存设置和「关于我」，memory_items 存条目，memory_log 存改动记录，
// memory_summaries 存摘要）、资料库里的文件索引（files，文件本身还在上传目录里，见 library.ts）。
// 设置、用户、专家这类小配置还是 JSON 文件，方便直接打开看、手改。
//
// 主进程和每个会话的记忆工具子进程（mcp/memory-server.ts）会同时打开它：WAL 模式下读不挡写，
// 写和写之间由 busy_timeout 排队。
//
// 升级前的 JSON 第一次打开时导入（见 importLegacy），导入的那个文件改名成 .imported 留作备份。
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { dataDir, readJson } from "../home.js";

export const dbPath = path.join(dataDir, "agent-loft.db");

/**
 * node:sqlite 在 Node 22 上还挂着「实验性」：加载时打一行 ExperimentalWarning。
 * 每个记忆工具子进程都会打一遍，看着像出错了，只把这一条吞掉。
 */
function loadSqlite(): typeof import("node:sqlite") {
  const emit = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const message = typeof warning === "string" ? warning : warning?.message;
    if (/SQLite/i.test(message ?? "")) return;
    return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    // 22.13 之前要加 --experimental-sqlite 才有，22.3 之前连 getBuiltinModule 都没有
    const mod = process.getBuiltinModule?.("node:sqlite") as typeof import("node:sqlite") | undefined;
    if (!mod) throw new Error(`agent-loft 需要 Node.js 22.13 以上（现在是 ${process.version}），请升级 Node.js`);
    return mod;
  } finally {
    process.emitWarning = emit;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS conversations (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_owners (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  conv_key TEXT NOT NULL,
  agent TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL,
  msg_id TEXT
);
CREATE INDEX IF NOT EXISTS history_user ON history (user_id, id);
CREATE INDEX IF NOT EXISTS history_user_conv ON history (user_id, conv_key);
-- 查「每段对话最后一句是什么时候」只走这个索引，不用读正文（见 chat-history.ts 的 pendingConversations）
CREATE INDEX IF NOT EXISTS history_user_conv_ts ON history (user_id, conv_key, ts);

-- 聊天记录的全文索引：只存索引不存原文（原文在 history 里），rowid 就是 history.id。
-- 写入时不碰它，搜索和启动时按 index_state 里的进度补上（见 chat-history.ts 的 syncHistoryIndex）
CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(text, content='', contentless_delete=1, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS index_state (name TEXT PRIMARY KEY, upto INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS search_stats (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  searches INTEGER NOT NULL,
  empty INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS history_meta (
  user_id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS footers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  tail TEXT NOT NULL,
  footer TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS footers_session ON footers (session_id, id);

CREATE TABLE IF NOT EXISTS turn_changes (
  id TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  before_tree TEXT NOT NULL,
  after_tree TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS turn_changes_root ON turn_changes (root, at);

CREATE TABLE IF NOT EXISTS usage_sessions (
  session_id TEXT PRIMARY KEY,
  input INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
  output INTEGER NOT NULL, reasoning INTEGER NOT NULL, cost_usd REAL,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL, owner TEXT NOT NULL, agent TEXT NOT NULL, model TEXT NOT NULL,
  input INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
  output INTEGER NOT NULL, reasoning INTEGER NOT NULL, cost_usd REAL,
  PRIMARY KEY (day, owner, agent, model)
);

CREATE TABLE IF NOT EXISTS memory (
  user_id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_items (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  tier TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  observed_at INTEGER,
  valid_until INTEGER,
  source_conv TEXT,
  deleted_at INTEGER,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS memory_items_live ON memory_items (user_id, deleted_at, tier);

CREATE TABLE IF NOT EXISTS memory_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  old_text TEXT,
  new_text TEXT,
  old_tier TEXT,
  new_tier TEXT,
  conv_key TEXT,
  note TEXT,
  at INTEGER NOT NULL,
  undone_at INTEGER
);
CREATE INDEX IF NOT EXISTS memory_log_user ON memory_log (user_id, id);
CREATE INDEX IF NOT EXISTS memory_log_item ON memory_log (user_id, item_id);

CREATE TABLE IF NOT EXISTS memory_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  project TEXT,
  from_ts INTEGER NOT NULL,
  to_ts INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, kind, scope)
);
CREATE INDEX IF NOT EXISTS memory_summaries_time ON memory_summaries (user_id, kind, to_ts);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_summaries_fts USING fts5(text, content='', contentless_delete=1, tokenize='unicode61');

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  conv_key TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  source TEXT NOT NULL,
  origin TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS files_owner ON files (owner, created_at);
CREATE INDEX IF NOT EXISTS files_conv ON files (conv_key);
CREATE INDEX IF NOT EXISTS files_origin ON files (origin);
`;

let db: DatabaseSync | null = null;

export function database(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const fresh = !fs.existsSync(dbPath);
  const { DatabaseSync } = loadSqlite();
  const opened = new DatabaseSync(dbPath);
  if (fresh) fs.chmodSync(dbPath, 0o600);
  opened.exec("PRAGMA busy_timeout = 5000");
  opened.exec("PRAGMA journal_mode = WAL");
  opened.exec("PRAGMA synchronous = NORMAL");
  opened.exec(SCHEMA);
  // 旧库的 footers 表还没有这一列（列表里每轮改动的摘要，JSON）。老版本读写时不看它，降级也没事
  const footerColumns = opened.prepare("PRAGMA table_info(footers)").all() as { name: string }[];
  if (!footerColumns.some((c) => c.name === "changes")) {
    try {
      opened.exec("ALTER TABLE footers ADD COLUMN changes TEXT");
    } catch (err) {
      // 另一个进程（服务和命令行同时打开）刚加好了
      if (!/duplicate column/i.test(String(err))) throw err;
    }
  }
  db = opened;
  importLegacy(opened);
  return opened;
}

/** memory 表里哪些行还带着老格式的条目。坏掉的 JSON 不能让 json_type 抛错：一行坏数据不该让服务起不来 */
export const LEGACY_MEMORY_ITEMS = "CASE WHEN json_valid(data) THEN json_type(data, '$.items') END = 'array'";

/** 「记忆改成默认关」的升级迁移跑过了（见 memory.ts 的 migrateMemoryDefault） */
export const MEMORY_DEFAULT_OFF = "memory-default-off";

/** 预编译的语句按 SQL 缓存：同一句反复执行不用每次重新解析 */
const statements = new Map<string, StatementSync>();

export function sql(text: string): StatementSync {
  let stmt = statements.get(text);
  if (!stmt) statements.set(text, (stmt = database().prepare(text)));
  return stmt;
}

let depth = 0;

/**
 * 事务。BEGIN IMMEDIATE：一开始就拿写锁，别的进程在 busy_timeout 里排队，不会读到一半被改。
 * 事务里再开事务就并进外面那个。
 */
export function transaction<T>(fn: () => T): T {
  if (depth > 0) return fn();
  const d = database();
  d.exec("BEGIN IMMEDIATE");
  depth++;
  try {
    const out = fn();
    d.exec("COMMIT");
    return out;
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  } finally {
    depth--;
  }
}

/** 测试用：关掉连接，下次 database() 重新打开 */
export function closeDatabaseForTest(): void {
  statements.clear();
  db?.close();
  db = null;
}

// ---------- 导入升级前的 JSON ----------
//
// 每个文件导入一次：导入和「导入过了」的标记在同一个事务里，中途崩了下次重来不会重复。
// 两个进程同时打开时，后拿到写锁的那个看到标记就跳过。导入完把文件改名留作备份。

type LegacyImport = { name: string; files: () => string[]; run: (d: DatabaseSync, file: string) => number };

const historyDir = path.join(dataDir, "history");
const memoryDir = path.join(dataDir, "memory");

const n0 = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
type LegacyTotals = { input?: number; cacheRead?: number; cacheWrite?: number; output?: number; reasoning?: number; costUsd?: number };
const legacyTotals = (t: LegacyTotals) => [n0(t.input), n0(t.cacheRead), n0(t.cacheWrite), n0(t.output), n0(t.reasoning), n0(t.costUsd) || null] as const;

const LEGACY: LegacyImport[] = [
  {
    name: "conversations.json",
    files: () => [path.join(dataDir, "conversations.json")],
    run(d, file) {
      const all = readJson<Record<string, { key?: string }>>(file, {});
      const insert = d.prepare("INSERT OR REPLACE INTO conversations (key, data) VALUES (?, ?)");
      let n = 0;
      for (const [key, conv] of Object.entries(all)) {
        if (!conv || typeof conv !== "object") continue;
        insert.run(key, JSON.stringify({ ...conv, key }));
        n++;
      }
      return n;
    },
  },
  {
    name: "session-owners.json",
    files: () => [path.join(dataDir, "session-owners.json")],
    run(d, file) {
      const all = readJson<Record<string, string>>(file, {});
      const insert = d.prepare("INSERT OR IGNORE INTO session_owners (session_id, user_id) VALUES (?, ?)");
      let n = 0;
      for (const [sessionId, userId] of Object.entries(all)) {
        if (typeof userId !== "string") continue;
        insert.run(sessionId, userId);
        n++;
      }
      return n;
    },
  },
  {
    name: "footers.json",
    files: () => [path.join(dataDir, "footers.json")],
    run(d, file) {
      const all = readJson<Record<string, { at?: number; entries?: { t?: string; f?: string }[] }>>(file, {});
      const insert = d.prepare("INSERT INTO footers (session_id, tail, footer, at) VALUES (?, ?, ?, ?)");
      let n = 0;
      for (const [sessionId, slot] of Object.entries(all)) {
        for (const e of slot?.entries ?? []) {
          if (typeof e?.t !== "string" || typeof e.f !== "string") continue;
          insert.run(sessionId, e.t, e.f, Number(slot.at) || 0);
          n++;
        }
      }
      return n;
    },
  },
  {
    name: "usage.json",
    files: () => [path.join(dataDir, "usage.json")],
    run(d, file) {
      const all = readJson<Record<string, LegacyTotals & { at?: number }>>(file, {});
      const insert = d.prepare(
        "INSERT OR REPLACE INTO usage_sessions (session_id, input, cache_read, cache_write, output, reasoning, cost_usd, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      let n = 0;
      for (const [sessionId, t] of Object.entries(all)) {
        if (!t || typeof t !== "object") continue;
        insert.run(sessionId, ...legacyTotals(t), Number(t.at) || 0);
        n++;
      }
      return n;
    },
  },
  {
    // 日期 →「owner\tagent\tmodel」→ 合计
    name: "usage-daily.json",
    files: () => [path.join(dataDir, "usage-daily.json")],
    run(d, file) {
      const all = readJson<Record<string, Record<string, LegacyTotals>>>(file, {});
      const insert = d.prepare(
        "INSERT OR REPLACE INTO usage_daily (day, owner, agent, model, input, cache_read, cache_write, output, reasoning, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      let n = 0;
      for (const [day, buckets] of Object.entries(all)) {
        for (const [k, t] of Object.entries(buckets ?? {})) {
          if (!t || typeof t !== "object") continue;
          const [owner = "", agent = "", model = ""] = k.split("\t");
          insert.run(day, owner, agent, model, ...legacyTotals(t));
          n++;
        }
      }
      return n;
    },
  },
  {
    // 每个用户一份 <用户 id>.json；.default-off-migrated 是「记忆改成默认关」那次迁移跑过的标记（见 memory.ts）
    name: "memory",
    files: () => {
      try {
        return fs
          .readdirSync(memoryDir)
          .filter((f) => /^[A-Za-z0-9_]{1,64}\.json$/.test(f) || f === ".default-off-migrated")
          .map((f) => path.join(memoryDir, f));
      } catch {
        return [];
      }
    },
    run(d, file) {
      const base = path.basename(file);
      if (base === ".default-off-migrated") {
        d.prepare("INSERT OR IGNORE INTO migrations (name, at) VALUES (?, ?)").run(MEMORY_DEFAULT_OFF, Date.now());
        return 1;
      }
      const raw = readJson<unknown>(file, null);
      if (!raw || typeof raw !== "object") return 0;
      d.prepare("INSERT OR REPLACE INTO memory (user_id, data) VALUES (?, ?)").run(base.slice(0, -".json".length), JSON.stringify(raw));
      return 1;
    },
  },
  {
    // 每个用户一份 <用户 id>.jsonl 和 <用户 id>.meta.json
    name: "history",
    files: () => {
      try {
        return fs
          .readdirSync(historyDir)
          .filter((f) => /^[A-Za-z0-9_]{1,64}\.(jsonl|meta\.json)$/.test(f))
          .map((f) => path.join(historyDir, f));
      } catch {
        return [];
      }
    },
    run(d, file) {
      const base = path.basename(file);
      if (base.endsWith(".meta.json")) {
        const userId = base.slice(0, -".meta.json".length);
        d.prepare("INSERT OR REPLACE INTO history_meta (user_id, data) VALUES (?, ?)").run(userId, JSON.stringify(readJson(file, {})));
        return 1;
      }
      const userId = base.slice(0, -".jsonl".length);
      const insert = d.prepare("INSERT INTO history (user_id, conv_key, agent, role, text, ts, msg_id) VALUES (?, ?, ?, ?, ?, ?, ?)");
      let n = 0;
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        let r: { id?: unknown; k?: unknown; a?: unknown; r?: unknown; t?: unknown; ts?: unknown };
        try {
          r = JSON.parse(line);
        } catch {
          continue; // 写到一半被打断的行
        }
        if (typeof r.k !== "string" || typeof r.t !== "string" || (r.r !== "u" && r.r !== "a")) continue;
        insert.run(userId, r.k, typeof r.a === "string" ? r.a : "", r.r, r.t, Number(r.ts) || 0, typeof r.id === "string" ? r.id : null);
        n++;
      }
      return n;
    },
  },
];

function importLegacy(d: DatabaseSync): void {
  for (const item of LEGACY) {
    for (const file of item.files()) {
      if (!fs.existsSync(file)) continue;
      const mark = `${item.name}:${path.basename(file)}`;
      let count = -1;
      d.exec("BEGIN IMMEDIATE");
      try {
        if (!d.prepare("SELECT 1 FROM migrations WHERE name = ?").get(mark) && fs.existsSync(file)) {
          count = item.run(d, file);
          d.prepare("INSERT INTO migrations (name, at) VALUES (?, ?)").run(mark, Date.now());
        }
        d.exec("COMMIT");
      } catch (err) {
        d.exec("ROLLBACK");
        console.warn(`[数据库] 导入 ${file} 失败，先不动它:`, err);
        continue;
      }
      try {
        fs.renameSync(file, `${file}.imported`);
      } catch {
        // 别的进程刚改过名
      }
      if (count >= 0) console.log(`[数据库] 已导入 ${path.relative(dataDir, file)}（${count} 条），原文件改名为 .imported 留作备份`);
    }
  }
}
