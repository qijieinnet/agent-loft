// The relay orders committed versions. Each sender includes the values it edited from, so
// clock skew never decides whose text survives a concurrent edit.
import { randomBytes } from "node:crypto";
import { sql, transaction } from "./db.js";
import { ftsIndexText } from "./fts.js";
import { readMemory, setMemoryOptions } from "./memory.js";
import { syncKinds, tables, type SyncKind } from "./memory-sync-schema.js";

type Body = Record<string, string | number | null>;
export type Document = { gid: string; kind: SyncKind; body: Body | null; revision: string | null; conflicts: string[] };
export type Change = {
  gid: string;
  kind: SyncKind;
  op: string;
  baseRevision: string | null;
  base: Body | null;
  body: Body | null;
  resolve?: string[];
  actor?: string;
};
type Mapping = { kind: SyncKind; local_key: string | null; gid: string };
type DocRow = { seq: number; kind: SyncKind; gid: string; body: string | null; revision: string | null; conflicts: string };
export type Account = {
  user_id: string;
  device: string;
  relay: string | null;
  url: string | null;
  token: string | null;
  cursor: number;
  last_sync: number | null;
  error: string | null;
};
export const randomId = () => randomBytes(16).toString("hex");
export const idPattern = /^[0-9a-f]{32}$/;
export const account = (u: string) => sql("SELECT * FROM sync_account WHERE user_id=?").get(u) as Account | undefined;
const mapping = (u: string, gid: string) => sql("SELECT * FROM sync_map WHERE user_id=? AND gid=?").get(u, gid) as Mapping | undefined;
const stored = (u: string, gid: string) => sql("SELECT * FROM sync_doc WHERE user_id=? AND gid=?").get(u, gid) as DocRow | undefined;
const decode = (r: DocRow): Document => ({
  gid: r.gid,
  kind: r.kind,
  body: r.body ? JSON.parse(r.body) : null,
  revision: r.revision,
  conflicts: JSON.parse(r.conflicts),
});
const columns = {
  about: ["text"],
  item: ["text", "source", "tier", "locked", "created_at", "updated_at", "observed_at", "valid_until", "source_conv", "deleted_at"],
  message: ["conv_key", "agent", "role", "text", "ts", "msg_id", "source_order"],
  summary: ["kind", "scope", "title", "text", "project", "from_ts", "to_ts", "updated_at"],
};

export function activate(u: string, device = randomId(), url: string | null = null, token: string | null = null) {
  transaction(() => {
    if (account(u)) throw new Error("该账号已配置同步");
    readMemory(u); // finish any legacy item migration before taking the initial inventory
    sql("INSERT INTO sync_account(user_id,device,url,token) VALUES(?,?,?,?)").run(u, device, url, token);
    for (const kind of syncKinds) {
      const col = kind === "about" ? "data" : "id";
      sql(`UPDATE ${tables[kind]} SET ${col}=${col} WHERE user_id=?`).run(u);
    }
  });
}

const prefix = (device: string) => `sync/${device}/`;
function qualify(value: unknown, device: string) {
  return typeof value === "string" && !value.startsWith("sync/") ? prefix(device) + value : value;
}
function localize(value: unknown, device: string) {
  return typeof value === "string" && value.startsWith(prefix(device)) ? value.slice(prefix(device).length) : value;
}

function snapshot(u: string, m: Mapping, device: string): Body | null {
  if (m.kind === "about") return { text: readMemory(u).about };
  if (!m.local_key) return null;
  const body = sql(`SELECT ${columns[m.kind].join(",")} FROM ${tables[m.kind]} WHERE user_id=? AND id=?`).get(u, m.local_key) as
    | Body
    | undefined;
  if (!body) return null;
  if (m.kind === "message") body.source_order ??= Number(m.local_key);
  for (const k of ["conv_key", "source_conv", "scope"]) if (typeof body[k] === "string") body[k] = qualify(body[k], device) as string;
  return body;
}

function saveDoc(u: string, d: Document) {
  sql("INSERT OR REPLACE INTO sync_doc(user_id,gid,kind,body,revision,conflicts) VALUES(?,?,?,?,?,?)").run(
    u,
    d.gid,
    d.kind,
    d.body ? JSON.stringify(d.body) : null,
    d.revision,
    JSON.stringify(d.conflicts),
  );
}

export function staged(u: string, limit = 48, gid?: string): Change[] {
  const a = account(u)!;
  const rows = sql(`SELECT m.*,q.op,q.resolution FROM sync_dirty q JOIN sync_map m USING(user_id,gid)
    WHERE q.user_id=? ${gid ? "AND q.gid=?" : ""} ORDER BY q.seq LIMIT ?`).iterate(u, ...(gid ? [gid] : []), limit) as Iterable<
    Mapping & { op: string; resolution: string | null }
  >;
  const out: Change[] = [];
  let bytes = 0;
  for (const r of rows) {
    const base = stored(u, r.gid);
    const c: Change = {
      gid: r.gid,
      kind: r.kind,
      op: r.op,
      baseRevision: base?.revision ?? null,
      base: (r.kind === "about" || r.kind === "item") && base?.body ? JSON.parse(base.body) : null,
      body: snapshot(u, r, a.device),
    };
    if (r.kind === "item" && r.local_key) {
      const log = sql("SELECT actor FROM memory_log WHERE user_id=? AND item_id=? ORDER BY id DESC LIMIT 1").get(u, r.local_key);
      if (log?.actor) c.actor = String(log.actor);
    }
    if (r.resolution) c.resolve = JSON.parse(r.resolution);
    out.push(c);
    bytes += Buffer.byteLength(JSON.stringify(c));
    if (bytes >= 512 * 1024) break;
  }
  return out;
}

// Freeze the exact batch across process restarts and lost acknowledgements. Later edits stay
// dirty until the acknowledged snapshot becomes their base.
export function preparePush(u: string): Change[] {
  return transaction(() => {
    const flight = sql("SELECT change FROM sync_flight WHERE user_id=? ORDER BY rowid").all(u);
    if (flight.length) return flight.map((r) => JSON.parse(String(r.change)) as Change);
    const batch = staged(u);
    for (const c of batch) sql("INSERT INTO sync_flight VALUES(?,?,?)").run(u, c.gid, JSON.stringify(c));
    return batch;
  });
}

function merge(old: Document | undefined, change: Change): Document {
  const { gid, kind, body, base } = change;
  if (!body || old?.body === null) return { gid, kind, body: null, revision: null, conflicts: [] };
  const previous = old?.body;
  if ((!previous && kind !== "about") || kind === "message" || kind === "summary")
    return { gid, kind, body, revision: change.op, conflicts: [] };
  const current = previous ?? { text: "" };
  const original = base ?? (kind === "about" ? { text: "" } : {});
  // An automatic change made offline before another instance pinned the item must
  // pass the same protection check as an automatic change made on that instance.
  const protectedItem = (b: Body) => b.locked === 1 || b.source === "user" || b.source === "asked";
  if (kind === "item" && old && change.actor !== "user" && protectedItem(current) && !protectedItem(original)) return old;
  // Keep the version that was put into the trash. A restore must name a base that was already trashed.
  if (kind === "item" && old && current.deleted_at && !original.deleted_at && !body.deleted_at) return old;
  const result = { ...current };
  let revision = old?.revision ?? null;
  let choices = [...(old?.conflicts ?? [])];
  for (const field of columns[kind]) {
    const next = body[field]!;
    if (
      field === "text" &&
      change.resolve &&
      old?.revision === change.baseRevision &&
      JSON.stringify(choices) === JSON.stringify(change.resolve)
    ) {
      revision = change.op;
      result.text = next;
      choices = [];
    } else if (next !== original[field]) {
      if (field === "text") revision = change.op;
      if (
        field === "text" &&
        (choices.length || (current.text !== next && (current.text !== original.text || (old?.revision ?? null) !== change.baseRevision)))
      ) {
        choices = [...new Set([...(choices.length ? choices : [String(current.text)]), String(next)])].sort();
        result.text = old?.conflicts.length ? current.text! : (original.text ?? "");
      } else if (field === "source" && ["user", "asked"].includes(String(current.source)) && !["user", "asked"].includes(String(next))) {
        continue;
      } else if (field === "updated_at") result[field] = Math.max(Number(current[field]), Number(next));
      else result[field] = next;
    }
  }
  if (result.deleted_at) {
    choices = [];
    if (!original.deleted_at && body.deleted_at) {
      result.text = body.text!;
      revision = change.op;
    }
  }
  return { gid, kind, body: result, revision, conflicts: choices };
}

function apply(u: string, d: Document) {
  const a = account(u)!;
  const m = mapping(u, d.gid);
  let key = m?.local_key ?? null;
  const b = d.body && { ...d.body };
  sql("UPDATE sync_account SET applying=1 WHERE user_id=?").run(u);
  if (d.kind === "about") {
    const value = String(b?.text ?? "");
    if (readMemory(u).about !== value) setMemoryOptions(u, { about: value });
  } else if (b) {
    for (const k of ["conv_key", "source_conv", "scope"]) if (typeof b[k] === "string") b[k] = localize(b[k], a.device) as string;
    if (d.kind === "item") key ??= "m_" + randomId();
    if (d.kind === "summary" && !key) {
      // A newer incarnation can arrive before the old tombstone on a compacted feed.
      // Reuse its local row and detach the old identity so a late purge can't delete the new summary.
      const row = sql("SELECT id FROM memory_summaries WHERE user_id=? AND kind=? AND scope=?").get(u, b.kind!, b.scope!);
      if (row) {
        key = String(row.id);
        sql("UPDATE sync_map SET local_key=NULL WHERE user_id=? AND kind='summary' AND local_key=?").run(u, key);
      }
    }
    const fields = columns[d.kind];
    const vals = fields.map((k) => b[k]!);
    if (key && sql(`SELECT 1 FROM ${tables[d.kind]} WHERE user_id=? AND id=?`).get(u, key)) {
      sql(`UPDATE ${tables[d.kind]} SET ${fields.map((k) => k + "=?").join(",")} WHERE user_id=? AND id=?`).run(...vals, u, key);
    } else {
      const insert = sql(`INSERT INTO ${tables[d.kind]}(user_id,id,${fields.join(",")}) VALUES(?,?,${fields.map(() => "?").join(",")})`);
      const saved = insert.run(u, key, ...vals);
      key ??= String(saved.lastInsertRowid);
    }
    if (d.kind === "message" || d.kind === "summary") {
      const fts = d.kind === "message" ? "history_fts" : "memory_summaries_fts";
      sql(`DELETE FROM ${fts} WHERE rowid=?`).run(key);
      if (d.kind === "summary" || sql("SELECT 1 FROM index_state WHERE name='history_fts' AND upto>=?").get(Number(key))) {
        sql(`INSERT INTO ${fts}(rowid,text) VALUES(?,?)`).run(key, ftsIndexText((b.title ? b.title + "\n" : "") + b.text));
      }
    }
  } else if (key) {
    if (d.kind === "item") sql("DELETE FROM memory_log WHERE user_id=? AND item_id=?").run(u, key);
    if (d.kind === "message" || d.kind === "summary") {
      const fts = d.kind === "message" ? "history_fts" : "memory_summaries_fts";
      sql(`DELETE FROM ${fts} WHERE rowid=?`).run(key);
    }
    sql(`DELETE FROM ${tables[d.kind]} WHERE user_id=? AND id=?`).run(u, key);
    key = null;
  }
  sql(
    "INSERT INTO sync_map(user_id,kind,local_key,gid) VALUES(?,?,?,?) ON CONFLICT(user_id,gid) DO UPDATE SET local_key=excluded.local_key",
  ).run(u, d.kind, d.kind === "about" ? "about" : key, d.gid);
  sql("UPDATE sync_account SET applying=0 WHERE user_id=?").run(u);
}

function commit(u: string, c: Change, local: boolean) {
  const old = stored(u, c.gid);
  const d = merge(old && decode(old), c);
  if (!local || JSON.stringify(d.body) !== JSON.stringify(c.body)) apply(u, d);
  saveDoc(u, d);
}

export function flushRelay(u: string, gid?: string) {
  return transaction(() => {
    const batch = staged(u, 48, gid);
    for (const c of batch) {
      commit(u, c, true);
      sql("DELETE FROM sync_dirty WHERE user_id=? AND op=?").run(u, c.op);
    }
    return batch.length;
  });
}

export function acceptPush(u: string, device: string, changes: Change[]) {
  transaction(() => {
    for (const c of changes) {
      validateChange(c);
      if (sql("SELECT 1 FROM sync_receipt WHERE user_id=? AND device=? AND op=?").get(u, device, c.op)) continue;
      flushRelay(u, c.gid);
      const old = stored(u, c.gid);
      if ((old && old.kind !== c.kind) || (!old && c.kind !== "about" && !c.gid.startsWith(device + ":"))) throw new Error("对象来源无效");
      if ((c.kind === "message" || c.kind === "summary") && c.body && !c.gid.startsWith(device + ":"))
        throw new Error("只能修改来源实例的聊天");
      commit(u, c, false);
      sql("INSERT INTO sync_receipt VALUES(?,?,?)").run(u, device, c.op);
    }
  });
}

export function acknowledge(u: string, batch: Change[]) {
  transaction(() => {
    for (const c of batch) {
      const m = mapping(u, c.gid);
      sql("DELETE FROM sync_flight WHERE user_id=? AND gid=?").run(u, c.gid);
      // If purged while this request was in flight, never write the old content back to disk.
      if (m?.local_key || c.kind === "about")
        saveDoc(u, {
          ...c,
          revision:
            (c.base?.text ?? (c.kind === "about" ? "" : undefined)) !== c.body?.text ||
            c.resolve ||
            (!c.base?.deleted_at && c.body?.deleted_at)
              ? c.op
              : c.baseRevision,
          conflicts: c.resolve ? [] : JSON.parse(stored(u, c.gid)?.conflicts ?? "[]"),
        });
      sql("DELETE FROM sync_dirty WHERE user_id=? AND op=?").run(u, c.op);
    }
  });
}

export function feed(u: string, cursor: number) {
  return transaction(() => {
    flushRelay(u);
    const docs: Document[] = [];
    let bytes = 0;
    for (const r of sql("SELECT * FROM sync_doc WHERE user_id=? AND seq>? ORDER BY seq LIMIT 48").iterate(u, cursor) as Iterable<DocRow>) {
      docs.push(decode(r));
      cursor = r.seq;
      bytes += (r.body?.length ?? 0) * 3;
      if (bytes >= 512 * 1024) break;
    }
    return { docs, cursor };
  });
}

export function receive(u: string, docs: Document[], cursor: number) {
  return transaction(() => {
    if (docs.some((d) => sql("SELECT 1 FROM sync_dirty WHERE user_id=? AND gid=?").get(u, d.gid))) return false;
    for (const d of docs) {
      validateDocument(d);
      apply(u, d);
      saveDoc(u, d);
    }
    sql("UPDATE sync_account SET cursor=? WHERE user_id=?").run(cursor, u);
    return true;
  });
}

export function resolveConflict(u: string, gid: string, choices: string[], text: string) {
  transaction(() => {
    const old = stored(u, gid);
    if (!old?.body || !choices?.length || old.conflicts !== JSON.stringify(choices)) throw new Error("冲突版本已变化，请刷新");
    const d = decode(old);
    if (
      (d.kind !== "item" && d.kind !== "about") ||
      typeof text !== "string" ||
      (d.kind === "item" && !text.trim()) ||
      text.length > (d.kind === "item" ? 500 : 2000)
    )
      throw new Error("解决内容无效");
    const m = mapping(u, gid);
    d.body = m ? snapshot(u, m, account(u)!.device) : null;
    if (!d.body || d.body.deleted_at) throw new Error("这条记忆已删除");
    d.body.text = text.trim();
    apply(u, d);
    sql(
      "INSERT INTO sync_dirty(user_id,gid,op,resolution) VALUES(?,?,?,?) ON CONFLICT(user_id,gid) DO UPDATE SET op=excluded.op,resolution=excluded.resolution",
    ).run(u, gid, randomId(), JSON.stringify(choices));
  });
}

export function syncConflicts(u: string) {
  return (sql("SELECT * FROM sync_doc WHERE user_id=? AND conflicts!='[]'").all(u) as DocRow[]).map((r) => {
    const d = decode(r);
    return { gid: d.gid, kind: d.kind, text: d.body?.text, choices: d.conflicts };
  });
}

function validateBody(kind: SyncKind, b: Body | null, origin: string) {
  if (b === null) return;
  if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).length !== columns[kind].length) throw new Error("同步字段不完整");
  const string = (k: string, max: number) => typeof b[k] === "string" && (b[k] as string).length <= max;
  const number = (k: string) => typeof b[k] === "number" && Number.isSafeInteger(b[k]) && Number(b[k]) >= 0;
  const qualified = (k: string) => string(k, 2048) && /^sync\/[0-9a-f]{32}\/.+$/s.test(String(b[k]));
  const fromOrigin = (k: string) => qualified(k) && String(b[k]).startsWith(prefix(origin));
  let valid = columns[kind].every((k) => Object.hasOwn(b, k));
  switch (kind) {
    case "about":
      valid &&= string("text", 2000);
      break;
    case "item":
      valid &&=
        string("text", 500) &&
        !!b.text &&
        ["asked", "agent", "user", "auto"].includes(String(b.source)) &&
        ["active", "core", "archive"].includes(String(b.tier)) &&
        (b.locked === 0 || b.locked === 1) &&
        ["created_at", "updated_at"].every(number) &&
        ["observed_at", "valid_until", "deleted_at"].every((k) => b[k] === null || number(k)) &&
        (b.source_conv === null || qualified("source_conv"));
      break;
    case "message":
      valid &&=
        string("text", Number.MAX_SAFE_INTEGER) &&
        fromOrigin("conv_key") &&
        string("agent", 256) &&
        (b.role === "u" || b.role === "a") &&
        number("ts") &&
        number("source_order") &&
        (b.msg_id === null || string("msg_id", 2048));
      break;
    case "summary":
      valid &&=
        fromOrigin("scope") &&
        (b.kind === "month" || b.kind === "conv") &&
        string("text", 1500) &&
        string("title", 80) &&
        (b.project === null || string("project", 8192)) &&
        ["from_ts", "to_ts", "updated_at"].every(number);
      break;
  }
  if (!valid) throw new Error("同步数据格式无效");
}

function validateKey(d: { kind: SyncKind; gid: string }) {
  if (
    !d ||
    !syncKinds.includes(d.kind) ||
    typeof d.gid !== "string" ||
    !(d.kind === "about" ? d.gid === "about" : /^[0-9a-f]{32}:[0-9a-f]{32}$/.test(d.gid))
  )
    throw new Error("同步对象标识无效");
}

function validChoices(v: unknown, kind: SyncKind) {
  return Array.isArray(v) && v.every((s) => typeof s === "string" && s.length <= (kind === "about" ? 2000 : 500));
}
function validateChange(c: Change) {
  validateKey(c);
  if (c.baseRevision !== null && !idPattern.test(c.baseRevision)) throw new Error("基础版本无效");
  if (typeof c.op !== "string" || !idPattern.test(c.op) || (c.resolve && !validChoices(c.resolve, c.kind))) throw new Error("同步变更无效");
  validateBody(c.kind, c.base, c.gid.split(":")[0]!);
  validateBody(c.kind, c.body, c.gid.split(":")[0]!);
  if (c.kind === "about" && !c.body) throw new Error("个人档案格式无效");
}
function validateDocument(d: Document) {
  validateKey(d);
  if (d.revision !== null && !idPattern.test(d.revision)) throw new Error("同步版本无效");
  if (!validChoices(d.conflicts, d.kind)) throw new Error("同步版本无效");
  validateBody(d.kind, d.body, d.gid.split(":")[0]!);
}

export function removeSyncAccount(u: string) {
  transaction(() => {
    for (const t of ["sync_account", "sync_invite", "sync_peer", "sync_dirty", "sync_flight", "sync_map", "sync_doc", "sync_receipt"])
      sql(`DELETE FROM ${t} WHERE user_id=?`).run(u);
  });
}
