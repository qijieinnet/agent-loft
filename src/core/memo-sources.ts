import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir, readJson, writeJsonAtomic } from "../home.js";
import { sql } from "./db.js";

export type MemoSource = {
  id: string; name: string; kind: "webdav" | "s3"; endpoint: string;
  username: string; secret: string; bucket: string; region: string; prefix: string;
};

const file = (user: string) => path.join(dataDir, "memo-sources", encodeURIComponent(user) + ".json");
export const memoSources = (user: string) => readJson<MemoSource[]>(file(user), []);
export const publicSource = ({ id, name, kind }: MemoSource) => ({ id, name, kind });
// A connection can be removed and re-added with a new password or display name.
export function memoHistoryKey(s: MemoSource): string {
  const library = [s.kind, s.endpoint, s.username];
  if (s.kind === "s3") library.push(s.bucket, s.prefix);
  return createHash("sha256").update(JSON.stringify(library)).digest("hex");
}

export function deleteMemoSources(user: string) {
  fs.rmSync(file(user), { force: true });
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
  return { id: randomUUID(), name, kind, endpoint: url.href, username, secret, region, bucket, prefix };
}

export function addMemoSource(user: string, source: MemoSource) {
  const sources = memoSources(user);
  writeJsonAtomic(file(user), [...sources, source]);
}

export function removeMemoSource(user: string, id: string) {
  writeJsonAtomic(file(user), memoSources(user).filter(s => s.id !== id));
}
