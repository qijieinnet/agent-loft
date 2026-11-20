import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { sql, transaction } from "./db.js";

const scope = "owner = ? AND source = ? AND path = ?";
export function rememberMemoVersion(owner: string, source: string, path: string, bytes: Buffer) {
  const key = [owner, source, path];
  const digest = createHash("sha256").update(bytes).digest("hex");
  transaction(() => {
    const last = sql(`SELECT digest FROM memo_versions WHERE ${scope} ORDER BY id DESC LIMIT 1`).get(...key);
    if (last?.digest === digest) return;
    sql("INSERT INTO memo_versions (owner,source,path,at,digest,content) VALUES (?,?,?,?,?,?)")
      .run(...key, Date.now(), digest, gzipSync(bytes, { level: 1 }));
    sql(`DELETE FROM memo_versions WHERE ${scope} AND id < (
      SELECT id FROM memo_versions WHERE ${scope} ORDER BY id DESC LIMIT 1 OFFSET 49)`).run(...key, ...key);
  });
}

export function memoVersions(owner: string, source: string, path: string) {
  return sql(`SELECT id, at FROM memo_versions WHERE ${scope} ORDER BY id DESC`).all(owner, source, path);
}

export function memoVersionText(owner: string, source: string, path: string, id: number) {
  const row = sql(`SELECT content FROM memo_versions WHERE ${scope} AND id = ?`).get(owner, source, path, id);
  return row ? gunzipSync(row.content as Uint8Array).toString("utf8") : null;
}
