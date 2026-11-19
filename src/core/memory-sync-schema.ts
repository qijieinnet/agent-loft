// Changes are captured by SQLite in the writer's transaction, including writes by stdio MCP children.
// Bodies are read when sending; an offline deletion therefore doesn't leave a body in the queue.
export const syncKinds = ["about", "item", "message", "summary"] as const;
export type SyncKind = (typeof syncKinds)[number];
export const tables = { about: "memory", item: "memory_items", message: "history", summary: "memory_summaries" } as const;
const watched = {
  about: ["data"],
  item: ["text", "source", "tier", "locked", "valid_until", "observed_at", "deleted_at"],
  message: ["text"],
  summary: ["text", "title", "project", "from_ts", "to_ts", "updated_at"],
};

function trigger(kind: SyncKind, action: "INSERT" | "UPDATE" | "DELETE") {
  const row = action === "DELETE" ? "OLD" : "NEW";
  const user = row + ".user_id";
  const key = kind === "about" ? "'about'" : row + ".id";
  const device = `(SELECT device FROM sync_account WHERE user_id=${user} AND applying=0)`;
  const match = `user_id=${user} AND kind='${kind}' AND local_key=CAST(${key} AS TEXT)`;
  const global = kind === "about" ? "'about'" : `${device} || ':' || lower(hex(randomblob(16)))`;
  // Ignore search touches. UPDATE also seeds pre-existing rows without changing their contents.
  const changed = kind === "about" ? "OLD.data IS NOT NEW.data" : watched[kind].map((c) => `OLD.${c} IS NOT NEW.${c}`).join(" OR ");
  return `CREATE TRIGGER IF NOT EXISTS sync_${kind}_${action} AFTER ${action} ON ${tables[kind]}
    WHEN ${device} IS NOT NULL ${action === "UPDATE" ? `AND ((${changed}) OR NOT EXISTS(SELECT 1 FROM sync_map WHERE ${match}))` : ""}
    BEGIN
      INSERT INTO sync_map(user_id,kind,local_key,gid) VALUES(${user},'${kind}',CAST(${key} AS TEXT),${global})
        ON CONFLICT(user_id,kind,local_key) DO NOTHING;
      INSERT INTO sync_dirty(user_id,gid,op) SELECT user_id,gid,lower(hex(randomblob(16))) FROM sync_map WHERE ${match}
        ON CONFLICT(user_id,gid) DO UPDATE SET op=excluded.op;
      ${
        action === "DELETE" && kind !== "about"
          ? `
        UPDATE sync_dirty SET resolution=NULL WHERE user_id=${user} AND gid=(SELECT gid FROM sync_map WHERE ${match});
        DELETE FROM sync_flight WHERE user_id=${user} AND gid=(SELECT gid FROM sync_map WHERE ${match});
        UPDATE sync_doc SET body=NULL, conflicts='[]' WHERE user_id=${user} AND gid=(SELECT gid FROM sync_map WHERE ${match});
        UPDATE sync_map SET local_key=NULL WHERE ${match};`
          : ""
      }
    END;`;
}

export const syncSchema =
  `
CREATE TABLE IF NOT EXISTS sync_account(user_id TEXT PRIMARY KEY, device TEXT NOT NULL, relay TEXT, url TEXT, token TEXT, cursor INTEGER NOT NULL DEFAULT 0,
  applying INTEGER NOT NULL DEFAULT 0,last_sync INTEGER,error TEXT);
CREATE TABLE IF NOT EXISTS sync_map(user_id TEXT NOT NULL,kind TEXT NOT NULL,local_key TEXT,gid TEXT NOT NULL,PRIMARY KEY(user_id,gid),UNIQUE(user_id,kind,local_key));
CREATE TABLE IF NOT EXISTS sync_dirty(seq INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,gid TEXT NOT NULL,op TEXT NOT NULL,resolution TEXT,UNIQUE(user_id,gid));
CREATE TABLE IF NOT EXISTS sync_flight(user_id TEXT NOT NULL,gid TEXT NOT NULL,change TEXT NOT NULL,PRIMARY KEY(user_id,gid));
CREATE TABLE IF NOT EXISTS sync_doc(seq INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,gid TEXT NOT NULL,kind TEXT NOT NULL,body TEXT,revision TEXT,conflicts TEXT NOT NULL,UNIQUE(user_id,gid));
CREATE INDEX IF NOT EXISTS sync_feed ON sync_doc(user_id,seq);
CREATE TABLE IF NOT EXISTS sync_peer(user_id TEXT NOT NULL,device TEXT NOT NULL,hash TEXT UNIQUE NOT NULL,last_sync INTEGER,PRIMARY KEY(user_id,device));
CREATE TABLE IF NOT EXISTS sync_invite(user_id TEXT PRIMARY KEY,hash TEXT NOT NULL UNIQUE,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sync_receipt(user_id TEXT NOT NULL,device TEXT NOT NULL,op TEXT NOT NULL,PRIMARY KEY(user_id,device,op));
` + syncKinds.flatMap((kind) => (["INSERT", "UPDATE", "DELETE"] as const).map((action) => trigger(kind, action))).join("\n");
