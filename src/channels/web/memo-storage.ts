// WebDAV collections and S3 prefixes both expose one directory level at a time.
import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import ipaddr from "ipaddr.js";
import { DOMParser } from "@xmldom/xmldom";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@smithy/core/checksum";
import { HttpRequest } from "@smithy/core/protocols";
import { validMemoPath, type MemoSource } from "../../core/memo-sources.js";
import { HttpError } from "./http.js";

export const TEXT_LIMIT = 2 * 1024 * 1024;
export const IMAGE_LIMIT = 12 * 1024 * 1024;
export const editable = (path: string) => /\.(?:md|markdown|txt|json|ya?ml|toml|ini|csv|tsv|log|css|js|ts|xml|html)$/i.test(path);
const encode = (path: string) => path.split("/").map(s => encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase())).join("/");
type Reply = { status: number; body: Buffer; etag?: string };
const conflict = () => new HttpError(409, "文件已存在或已被其他设备修改。请保留草稿并重新打开远端版本。");
function checked(r: Reply) {
  if (r.status === 412 || r.status === 409) throw conflict();
  if (r.status < 200 || r.status >= 300) throw new HttpError(r.status === 404 ? 404 : 502, `存储服务返回 HTTP ${r.status}，请检查地址、凭据和目录权限`);
  return r;
}
function revision(r: Reply) {
  return r.etag && /^"[^"\r\n]*"$/.test(r.etag) ? r.etag : "sha256:" + createHash("sha256").update(r.body).digest("hex");
}

function xml(r: Reply, root: string) {
  const value = checked(r).body.toString("utf8");
  if (/<!DOCTYPE/i.test(value)) throw new HttpError(502, "目录响应包含不支持的 XML 声明");
  try {
    const doc = new DOMParser().parseFromString(value, "application/xml");
    if (doc.documentElement?.localName === root) return doc.documentElement;
  } catch { /* generic error without remote response content */ }
  throw new HttpError(502, "存储服务没有返回有效的目录列表");
}

export class MemoStorage {
  constructor(readonly source: MemoSource, private readonly allowPrivate: boolean) {}

  objectURL(path: string, listing = false) {
    const { kind, bucket, prefix, endpoint } = this.source;
    const url = new URL(endpoint);
    if (kind === "s3") url.pathname += bucket + "/" + (listing ? "" : encode([prefix, path].filter(Boolean).join("/")));
    else url.pathname += encode(path);
    return url;
  }

  private async request(method: string, url: URL, headers: Record<string, string> = {}, body?: Buffer, limit = TEXT_LIMIT): Promise<Reply> {
    const { kind, username, secret, region } = this.source;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    try {
      // Pin the resolved public address for member connections (including literal IPs).
      let address: string | undefined;
      if (!this.allowPrivate) {
        address = isIP(host) ? host : (await dns.lookup(host)).address;
        if (ipaddr.process(address).range() !== "unicast") throw new HttpError(403, "内网存储地址需要使用管理员账号连接");
      }
      headers = { ...headers, host: url.host };
      if (body) headers["content-length"] = String(body.length);
      if (kind === "s3") {
        const signer = new SignatureV4({ service: "s3", region, sha256: Sha256, uriEscapePath: false, credentials: { accessKeyId: username, secretAccessKey: secret } });
        const request = new HttpRequest({ method, protocol: url.protocol, hostname: host, path: url.pathname, headers, query: Object.fromEntries(url.searchParams), body });
        headers = (await signer.sign(request)).headers;
      } else if (username || secret) headers.authorization = "Basic " + Buffer.from(username + ":" + secret).toString("base64");
      return await new Promise<Reply>((resolve, reject) => {
        const client = url.protocol === "https:" ? https : http;
        const req = client.request(url, {
          method, headers, agent: false, signal: AbortSignal.timeout(30_000),
          ...(address ? { hostname: address, servername: isIP(host) ? undefined : host } : {}),
        }, async res => {
          try {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of res) {
              size += chunk.length;
              if (size > limit) throw new HttpError(413, "文件或目录超出预览大小限制");
              chunks.push(chunk);
            }
            resolve({ body: Buffer.concat(chunks), status: res.statusCode ?? 502, etag: res.headers.etag });
          } catch (err) { res.destroy(); reject(err); }
        });
        req.on("error", reject);
        req.end(body);
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, "无法连接存储服务，请检查地址、网络和 TLS 证书");
    }
  }

  async list(dir: string, cursor = "") {
    const entries: { name: string; directory: boolean; etag?: string }[] = [];
    const add = (name: string, directory: boolean, etag?: string | null) => {
      if (!name.includes("/") && validMemoPath(name)) entries.push({ name, directory, ...(etag && /^"[^"\r\n]*"$/.test(etag) ? { etag } : {}) });
    };
    let next = "";
    if (this.source.kind === "s3") {
      const url = this.objectURL("", true);
      const prefix = [this.source.prefix, dir].filter(Boolean).map(s => s + "/").join("");
      url.search = new URLSearchParams({ "list-type": "2", delimiter: "/", prefix, ...(cursor ? { "continuation-token": cursor } : {}) }).toString().replace(/\+/g, "%20");
      const root = xml(await this.request("GET", url), "ListBucketResult");
      for (const [tag, key, directory] of [["Contents", "Key", false], ["CommonPrefixes", "Prefix", true]] as const) {
        for (const el of Array.from(root.getElementsByTagNameNS("*", tag))) {
          const val = el.getElementsByTagNameNS("*", key)[0]?.textContent;
          if (val?.startsWith(prefix)) add(val.slice(prefix.length).replace(/\/$/, ""), directory, el.getElementsByTagNameNS("*", "ETag")[0]?.textContent);
        }
      }
      next = root.getElementsByTagNameNS("*", "NextContinuationToken")[0]?.textContent ?? "";
    } else {
      const url = this.objectURL(dir ? dir + "/" : "");
      const r = await this.request("PROPFIND", url, { depth: "1", "content-type": "application/xml" }, Buffer.from('<propfind xmlns="DAV:"><prop><resourcetype/><getetag/></prop></propfind>'));
      const root = xml(r, "multistatus");
      const base = decodeURIComponent(url.pathname);
      for (const item of Array.from(root.getElementsByTagNameNS("DAV:", "response"))) {
        const href = item.getElementsByTagNameNS("DAV:", "href")[0]?.textContent;
        if (!href) continue;
        const child = new URL(href, url);
        const path = decodeURIComponent(child.pathname);
        if (child.origin === url.origin && path.startsWith(base)) add(path.slice(base.length).replace(/\/$/, ""), item.getElementsByTagNameNS("DAV:", "collection").length > 0, item.getElementsByTagNameNS("DAV:", "getetag")[0]?.textContent);
      }
    }
    return { entries: entries.sort((a,b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, "zh-CN", { numeric: true })), next };
  }

  async read(path: string, limit = TEXT_LIMIT) {
    const r = checked(await this.request("GET", this.objectURL(path), {}, undefined, limit));
    return { bytes: r.body, version: revision(r) };
  }

  async readText(path: string) {
    const { bytes, version } = await this.read(path);
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new HttpError(415, "仅支持 UTF-8 文本"); }
    if (text.includes("\0")) throw new HttpError(415, "此文件包含二进制数据");
    return { text, version };
  }

  async put(path: string, bytes: Buffer, type: string, version: string | null, beforeReplace?: (bytes: Buffer) => void) {
    const headers: Record<string, string> = { "content-type": type };
    if (version === null) headers["if-none-match"] = "*";
    else {
      const hashed = /^sha256:[a-f0-9]{64}$/.test(version);
      if (!hashed && !/^"[^"\r\n]*"$/.test(version)) throw new HttpError(400, "文件版本无效");
      const current = await this.request("GET", this.objectURL(path));
      if (current.status === 404) throw conflict();
      checked(current);
      const currentVersion = revision(current);
      // A retry after a lost PUT response can acknowledge an already committed edit.
      if (current.body.equals(bytes)) return currentVersion;
      if ((hashed ? revision({ ...current, etag: undefined }) : currentVersion) !== version) throw conflict();
      if (currentVersion === current.etag) headers["if-match"] = currentVersion;
      beforeReplace?.(current.body);
    }
    const result = checked(await this.request("PUT", this.objectURL(path), headers, bytes));
    return revision({ ...result, body: bytes });
  }

  async mkdir(path: string, existingOK = false) {
    if (this.source.kind === "s3") {
      try { await this.put(path + "/", Buffer.alloc(0), "application/x-directory", null); }
      catch (err) { if (!(existingOK && err instanceof HttpError && err.status === 409)) throw err; }
    } else {
      const r = await this.request("MKCOL", this.objectURL(path + "/"));
      if (r.status === 405 && existingOK) return; // PUT of the child verifies the collection.
      checked(r);
    }
  }
}
