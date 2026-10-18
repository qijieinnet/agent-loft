// HTTP 小工具：不引框架，几十行就够用。
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../../core/config.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function normalizeIp(ip: string): string {
  return ip.trim().replace(/^::ffff:/, "");
}

function isTrustedProxy(ip: string | undefined): boolean {
  if (!ip) return false;
  const list = config().web.trustedProxies.map(normalizeIp);
  return list.includes(normalizeIp(ip));
}

/** 这条连接是不是经由可信反代来的。只有这时 X-Forwarded-* 才可信。 */
export function viaTrustedProxy(req: IncomingMessage): boolean {
  return isTrustedProxy(req.socket.remoteAddress);
}

/**
 * 客户端 IP：从 X-Forwarded-For 的最右边往左剥掉可信代理，第一个不可信的就是客户端。
 * 不取最左边那个 —— 那一项是客户端自己能随便填的。
 */
export function clientIp(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? "unknown";
  if (!viaTrustedProxy(req)) return normalizeIp(remote);
  const fwd = req.headers["x-forwarded-for"];
  const chain = (Array.isArray(fwd) ? fwd.join(",") : (fwd ?? ""))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!isTrustedProxy(chain[i])) return normalizeIp(chain[i]!);
  }
  const real = req.headers["x-real-ip"];
  return typeof real === "string" && real ? normalizeIp(real) : normalizeIp(remote);
}

export function isHttps(req: IncomingMessage): boolean {
  if (viaTrustedProxy(req) && req.headers["x-forwarded-proto"] === "https") return true;
  return (req.socket as { encrypted?: boolean }).encrypted === true;
}

export function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
  }
  return out;
}

/**
 * 跨站请求防护：浏览器发的写请求和 WebSocket 握手一定带 Origin，它的 host 必须和
 * 请求的 host 一致。没有 Origin 的（curl 之类）放行 —— 它们本来就带不了别人的 cookie。
 */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const fwdHost = viaTrustedProxy(req) ? req.headers["x-forwarded-host"] : undefined;
  const hosts = [req.headers.host, ...(Array.isArray(fwdHost) ? fwdHost : fwdHost ? [fwdHost] : [])];
  return hosts.some((h) => h?.split(",")[0]?.trim() === originHost);
}

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, `内容太大（上限 ${Math.round(limit / 1024 / 1024)}MB）`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJsonBody<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req, 1024 * 1024);
  if (raw.length === 0) return {} as T;
  try {
    return JSON.parse(raw.toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "请求体不是合法的 JSON");
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};
