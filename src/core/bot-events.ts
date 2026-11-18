// 备份作业只上报终态。原始凭据仅创建时返回，事件先提交到 SQLite，再交给投递进程。
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { sql, transaction } from "./db.js";

export type Watch = {
  id: string; owner: string; conv: string; name: string; source: "backup" | "webhook";
  destination: string; analyze: number; last_seen: number | null; last_status: string | null;
};
export type Incident = {
  id: number; watch: string; run: string; reason: Reason; at: number; delivery: string;
  attempts: number; next_try: number; error: string | null; analysis: string; analysis_key: string | null;
};
export const reasons = { unknown: "原因未提供", disk_full: "存储空间不足", offline: "备份目标离线", permission: "访问被拒绝", io: "读写失败" };
export type Reason = keyof typeof reasons;
export type BackupResult = { runId: string; status: "ok" | "failed"; reason: Reason };
export const botEvents = new EventEmitter<{ ready: []; changed: [owner: string] }>();
const fields = "id,owner,conv,name,source,destination,analyze,last_seen,last_status";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function parseBackupResult(input: unknown): BackupResult {
  if (!input || typeof input !== "object") throw new Error("需要 JSON 对象");
  const { runId, status, reason = "unknown" } = input as Record<string, unknown>;
  if (typeof runId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(runId)) throw new Error("runId 需要 1–128 位字母、数字、点、冒号、下划线或短横线");
  if (status !== "ok" && status !== "failed") throw new Error("status 只能是 ok 或 failed");
  if (typeof reason !== "string" || !Object.hasOwn(reasons, reason)) throw new Error("reason 必须是已知的备份状态码");
  return { runId, status, reason: reason as Reason };
}

export function getWatch(id: string): Watch | undefined {
  return sql(`SELECT ${fields} FROM bot_watches WHERE id=?`).get(id) as Watch | undefined;
}

export function watchesFor(owner: string, key: string): Watch[] {
  return sql(`SELECT ${fields} FROM bot_watches WHERE owner=? AND conv=? ORDER BY rowid`).all(owner, key) as Watch[];
}

export function createWatch(owner: string, conv: string, name: string, source: Watch["source"], destination: string, analyze: boolean) {
  if (!name.trim() || name.length > 60) throw new Error("监听名称需要 1–60 个字符");
  const id = randomUUID();
  const token = source === "webhook" ? randomBytes(32).toString("hex") : undefined;
  transaction(() => {
    if (Number(sql("SELECT count(*) AS n FROM bot_watches WHERE owner=?").get(owner)?.n) >= 30) throw new RangeError("每个账号最多 30 条监听");
    sql("INSERT INTO bot_watches(id,owner,conv,name,source,destination,analyze,token_hash) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, owner, conv, name.trim(), source, destination, Number(analyze), token ? hash(token) : null);
  });
  return { id, token };
}

export function hookWatch(token: string): Watch | undefined {
  if (!/^[0-9a-f]{64}$/.test(token)) return undefined;
  return sql(`SELECT ${fields} FROM bot_watches WHERE token_hash=? AND source='webhook'`).get(hash(token)) as Watch | undefined;
}

export function incidentsFor(watch: string): Incident[] {
  return sql("SELECT * FROM bot_incidents WHERE watch=? ORDER BY id DESC LIMIT 12").all(watch) as Incident[];
}

/** 成功只记最近收到的状态。失败由唯一约束去重，写入和推进接收位置同一事务。 */
export function acceptResult(w: Watch, result: BackupResult, now = Date.now()): "quiet" | "duplicate" | "accepted" {
  const outcome = transaction(() => {
    if (!getWatch(w.id)) throw new Error("监听已关闭");
    if (result.status === "failed") {
      if (sql("SELECT 1 FROM bot_incidents WHERE watch=? AND run=?").get(w.id, result.runId)) return "duplicate";
      // 避免上报端配置错误时短时间大量唤起模型或发送通知。限流的事件可稍后重投。
      if (Number(sql("SELECT count(*) AS n FROM bot_incidents WHERE watch=? AND at>=?").get(w.id, now - 3600_000)?.n) >= 60) throw new RangeError("该监听本小时失败事件已达上限");
      sql("INSERT INTO bot_incidents(watch,run,reason,at,delivery,analysis) VALUES(?,?,?,?,?,?)")
        .run(w.id, result.runId, result.reason, now, w.destination === "inbox" ? "inbox" : "pending", w.analyze ? "pending" : "off");
    }
    sql("UPDATE bot_watches SET last_seen=?,last_status=? WHERE id=?").run(now, result.status, w.id);
    return result.status === "ok" ? "quiet" : "accepted";
  });
  if (outcome === "accepted" || (outcome === "quiet" && w.last_status !== "ok")) botEvents.emit("changed", w.owner);
  if (outcome === "accepted") botEvents.emit("ready");
  return outcome;
}

export function deleteWatch(id: string): void {
  transaction(() => {
    sql("DELETE FROM bot_incidents WHERE watch=?").run(id);
    sql("DELETE FROM bot_watches WHERE id=?").run(id);
  });
}

export function clearWatches(owner: string, key?: string): void {
  const watches = key ? watchesFor(owner, key) : sql("SELECT id FROM bot_watches WHERE owner=?").all(owner) as { id: string }[];
  transaction(() => { for (const w of watches) deleteWatch(w.id); });
}
