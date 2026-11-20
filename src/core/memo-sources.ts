import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";
import { dataDir, readJson, writeJsonAtomic } from "../home.js";
import { sql } from "./db.js";

export type MemoAccess = "off" | "read" | "write";
export function parseMemoAccess(value: unknown): MemoAccess {
  if (value === "off" || value === "read" || value === "write") return value;
  throw new Error("智能体访问权限无效");
}
export const canReadMemo = (source: MemoSource) => source.access === "read" || source.access === "write";

export type MemoSource = {
  access?: MemoAccess; id: string; name: string; kind: "webdav" | "s3"; endpoint: string;
  username: string; secret: string; bucket: string; region: string; prefix: string;
};

const file = (user: string) => path.join(dataDir, "memo-sources", encodeURIComponent(user) + ".json");
export const memoSources = (user: string) => readJson<MemoSource[]>(file(user), []);
export const publicSource = ({ id, name, kind, access }: MemoSource) => ({ id, name, kind, access: access ?? "off" });
// A connection can be removed and re-added with a new password or display name.
export function memoHistoryKey(s: MemoSource): string {
  const library = [s.kind, s.endpoint, s.username];
  if (s.kind === "s3") library.push(s.bucket, s.prefix);
  return createHash("sha256").update(JSON.stringify(library)).digest("hex");
}

export function deleteMemoSources(user: string) {
  fs.rmSync(file(user), { force: true });
  sql("DELETE FROM memo_documents WHERE owner = ?").run(user);
  sql("DELETE FROM memo_scans WHERE owner = ?").run(user);
  sql("DELETE FROM memo_versions WHERE owner = ?").run(user);
}

export function validMemoPath(value: string): boolean {
  return value.length <= 3000 && value.split("/").every(part =>
    part && part !== "." && part !== ".." && !/[\\\x00-\x1f\x7f]/.test(part) && !/%(?:2e|2f|5c)/i.test(part));
}

export function parseMemoSource(input: Record<string, unknown>): MemoSource {
  const str = (key: string) => typeof input[key] === "string" ? input[key] as string : "";
  const name = str("name").trim(), kind = input.kind;
  const bucket = str("bucket").trim(), region = str("region").trim() || "us-east-1";
  const prefix = str("prefix").replace(/^\/+|\/+$/g, "");
  const username = str("username"), secret = str("secret");
  if (!name || name.length > 100 || (kind !== "webdav" && kind !== "s3")) throw new Error("请填写笔记库名称并选择数据源");
  if (kind === "s3" && (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || !/^[a-z0-9-]+$/.test(region) ||
      (prefix && !validMemoPath(prefix)) || !username || !secret)) throw new Error("请检查存储桶、区域、前缀和访问密钥");
  const url = new URL(str("endpoint").trim() || (kind === "s3" ? `https://s3.${region}.amazonaws.com` : ""));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("请输入 HTTP(S) 服务地址，凭据请单独填写");
  url.pathname = url.pathname.replace(/\/*$/, "/");
  return { access: parseMemoAccess(input.access ?? "off"), id: randomUUID(), name, kind, endpoint: url.href, username, secret, region, bucket, prefix };
}

export const memoAccessEvents = new EventEmitter<{ changed: [string] }>();
export const hasWritableMemo = (sources: MemoSource[]) => sources.some(s => s.access === "write");

function saveSources(user: string, previous: MemoSource[], next: MemoSource[]) {
  writeJsonAtomic(file(user), next);
  if (hasWritableMemo(previous) !== hasWritableMemo(next)) memoAccessEvents.emit("changed", user);
}

export function addMemoSource(user: string, source: MemoSource) {
  const sources = memoSources(user);
  saveSources(user, sources, [...sources, source]);
}

export function removeMemoSource(user: string, id: string) {
  const sources = memoSources(user);
  saveSources(user, sources, sources.filter(s => s.id !== id));
}

export function setMemoAccess(user: string, id: string, access: MemoAccess) {
  const sources = memoSources(user);
  const source = sources.find(s => s.id === id);
  if (!source) throw new Error("笔记库已断开");
  const updated = { ...source, access };
  saveSources(user, sources, sources.map(s => s.id === id ? updated : s));
  return updated;
}
