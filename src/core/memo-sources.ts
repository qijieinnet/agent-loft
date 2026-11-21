import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";
import { dataDir, readJson, writeJsonAtomic } from "../home.js";
import { sql } from "./db.js";
import { getUser, listUsers, type User } from "./users.js";

export type MemoAccess = "off" | "read" | "write";
export function parseMemoAccess(value: unknown): MemoAccess {
  if (value === "off" || value === "read" || value === "write") return value;
  throw new Error("智能体访问权限无效");
}
export function memoAccessFor(source: MemoSource, expert: string): MemoAccess {
  return source.expertAccess && Object.hasOwn(source.expertAccess, expert)
    ? source.expertAccess[expert]! : source.access ?? "off";
}

/** Keep one index for the owner while any conversation may read this library. */
export const canReadMemo = (source: MemoSource) => source.access === "read" || source.access === "write" ||
  Object.values(source.expertAccess ?? {}).some(access => access !== "off");

export type MemoSource = {
  sharedWith?: Record<string, "read" | "write">;
  expertAccess?: Record<string, MemoAccess>;
  access?: MemoAccess; id: string; name: string; kind: "webdav" | "s3"; endpoint: string;
  username: string; secret: string; bucket: string; region: string; prefix: string;
};

const file = (user: string) => path.join(dataDir, "memo-sources", encodeURIComponent(user) + ".json");
export const memoSources = (user: string) => readJson<MemoSource[]>(file(user), []);
export const publicSource = ({ id, name, kind, access }: MemoSource) => ({ id, name, kind, access: access ?? "off" });
export const sourceSettings = (source: MemoSource) => ({ ...publicSource(source), expertAccess: source.expertAccess ?? {} });

export function memberAccess(source: MemoSource, member: string) {
  return source.sharedWith && Object.hasOwn(source.sharedWith, member) ? source.sharedWith[member] : undefined;
}

/** Sharing a Web library never changes the recipient's personal expert grants. */
export function visibleMemoSources(user: User) {
  const shared = listUsers().filter(other => other.id !== user.id && !other.disabled).flatMap(other =>
    memoSources(other.id).flatMap(source => {
      const permission = memberAccess(source, user.id);
      return permission ? [{ id: source.id, name: source.name, kind: source.kind, permission,
        sharedBy: { id: other.id, name: other.name } }] : [];
    }));
  return [...memoSources(user.id).map(sourceSettings), ...shared];
}

export function setMemoSharing(owner: string, id: string, changes: unknown) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new Error("共享设置无效");
  const sources = memoSources(owner);
  const source = sources.find(s => s.id === id);
  if (!source) throw new Error("笔记库已断开");
  const sharedWith = { ...source.sharedWith };
  for (const [member, access] of Object.entries(changes)) {
    const user = getUser(member);
    if (member === owner || !user || (user.disabled && access !== "off")) throw new Error("共享账号不可用");
    if (access === "off") delete sharedWith[member];
    else if (access === "read" || access === "write") sharedWith[member] = access;
    else throw new Error("共享权限无效");
  }
  source.sharedWith = sharedWith;
  writeJsonAtomic(file(owner), sources);
}
// A connection can be removed and re-added with a new password or display name.
export function memoHistoryKey(s: MemoSource): string {
  const library = [s.kind, s.endpoint, s.username];
  if (s.kind === "s3") library.push(s.bucket, s.prefix);
  return createHash("sha256").update(JSON.stringify(library)).digest("hex");
}

export function deleteMemoSources(user: string) {
  fs.rmSync(file(user), { force: true });
  for (const other of listUsers()) {
    const sources = memoSources(other.id);
    if (!sources.some(s => memberAccess(s, user))) continue;
    for (const source of sources) delete source.sharedWith?.[user];
    writeJsonAtomic(file(other.id), sources);
  }
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

export const memoAccessEvents = new EventEmitter<{ changed: [string, MemoSource[], MemoSource[]] }>();
export const hasWritableMemo = (sources: MemoSource[], expert: string) => sources.some(s => memoAccessFor(s, expert) === "write");

function saveSources(user: string, previous: MemoSource[], next: MemoSource[]) {
  writeJsonAtomic(file(user), next);
  memoAccessEvents.emit("changed", user, previous, next);
}

export function addMemoSource(user: string, source: MemoSource) {
  const sources = memoSources(user);
  saveSources(user, sources, [...sources, source]);
}

export function removeMemoSource(user: string, id: string) {
  const sources = memoSources(user);
  saveSources(user, sources, sources.filter(s => s.id !== id));
}

export function setMemoAccess(user: string, id: string, access: MemoAccess, expertAccess: Record<string, MemoAccess>) {
  const sources = memoSources(user);
  const source = sources.find(s => s.id === id);
  if (!source) throw new Error("笔记库已断开");
  const updated = { ...source, access, expertAccess };
  saveSources(user, sources, sources.map(s => s.id === id ? updated : s));
  return updated;
}

/** Validate before saving the expert form. Only the edited library/expert pairs are patched. */
export function parseExpertMemoChanges(owner: string, raw: unknown) {
  const changes = new Map<string, MemoAccess | null>();
  if (raw === undefined) return changes;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("备忘录权限格式无效");
  const own = new Set(memoSources(owner).map(s => s.id));
  for (const [id, value] of Object.entries(raw)) {
    if (!own.has(id)) throw new Error("笔记库已断开或无权授权，请刷新后重试");
    changes.set(id, value === null ? null : parseMemoAccess(value));
  }
  return changes;
}

export function setExpertMemoAccess(owner: string, expert: string, changes: Map<string, MemoAccess | null>) {
  const updated: { before: MemoSource; after: MemoSource }[] = [];
  if (!changes.size) return updated;
  const sources = memoSources(owner);
  const next = sources.map(before => {
    const access = changes.get(before.id);
    if (access === undefined || access === (before.expertAccess?.[expert] ?? null)) return before;
    const expertAccess = { ...before.expertAccess };
    if (access === null) delete expertAccess[expert];
    else expertAccess[expert] = access;
    const after = { ...before, expertAccess };
    updated.push({ before, after });
    return after;
  });
  if (updated.length) saveSources(owner, sources, next);
  return updated;
}
