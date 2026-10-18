// Web 渠道：静态页面 + REST + WebSocket。
//
// WebSocket 上跑的是实时的东西：订阅某条会话的事件流（断线重连按 seq 补发）、
// 发消息、点授权 / 作答。手机切到后台再回来，连接会断，重连后用 since 把错过的补上。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { config } from "../../core/config.js";
import { hub, type EventEnvelope } from "../../core/hub.js";
import { interactions, type Interaction } from "../../core/interactions.js";
import { getConversation } from "../../core/store.js";
import type { Settlement } from "../../core/types.js";
import { authed, handleApi, takeUploads } from "./api.js";
import { authEvents, ensureSetupToken, validateSession } from "./auth.js";
import { cookies } from "./http.js";
import { COOKIE } from "./api.js";
import { HttpError, sameOrigin, SECURITY_HEADERS, sendJson } from "./http.js";

const require = createRequire(import.meta.url);
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web");

/** 包的根目录。有的包（dompurify）的 exports 没放出 package.json，只能从入口往上找。 */
function pkgDir(pkg: string): string {
  try {
    return path.dirname(require.resolve(`${pkg}/package.json`));
  } catch {
    let dir = path.dirname(require.resolve(pkg));
    while (!fs.existsSync(path.join(dir, "package.json")) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    return dir;
  }
}

function pkgFile(pkg: string, rel: string): string {
  return path.join(pkgDir(pkg), rel);
}

/** 前端依赖直接从 node_modules 里给，不走 CDN（国内访问 CDN 不稳定） */
const VENDOR: Record<string, () => string> = {
  "/vendor/marked.js": () => pkgFile("marked", "lib/marked.esm.js"),
  "/vendor/purify.js": () => pkgFile("dompurify", "dist/purify.es.mjs"),
  "/vendor/hljs.js": () => pkgFile("@highlightjs/cdn-assets", "es/highlight.min.js"),
  "/vendor/hljs-light.css": () => pkgFile("@highlightjs/cdn-assets", "styles/github.min.css"),
  "/vendor/hljs-dark.css": () => pkgFile("@highlightjs/cdn-assets", "styles/github-dark.min.css"),
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

function serveFile(res: http.ServerResponse, file: string, cache: string): void {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, SECURITY_HEADERS);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": cache,
    });
    fs.createReadStream(file).pipe(res);
  });
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  const vendor = VENDOR[url.pathname];
  if (vendor) {
    try {
      serveFile(res, vendor(), "public, max-age=86400");
    } catch {
      res.writeHead(404);
      res.end();
    }
    return;
  }
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, SECURITY_HEADERS);
    res.end("bad request");
    return;
  }
  if (rel.includes("\0")) {
    res.writeHead(400, SECURITY_HEADERS);
    res.end("bad request");
    return;
  }
  if (rel === "/" || !path.extname(rel)) rel = "/index.html"; // 单页应用
  const file = path.resolve(webRoot, `.${rel}`);
  if (!file.startsWith(webRoot + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  // 页面本身别缓存：升级后要立刻生效
  serveFile(res, file, rel === "/index.html" || rel === "/sw.js" ? "no-cache" : "public, max-age=300");
  void req;
}

// ---------- WebSocket ----------

type Client = { ws: WebSocket; subs: Set<string>; alive: boolean; token: string };

/** 每次进程启动换一个：客户端发现变了，就知道 seq 已经从头计数，得整页重拉 */
const EPOCH = Math.random().toString(36).slice(2, 10);

/** 登录态已失效的连接：断开。客户端收到 4401 会回到登录页 */
function checkClient(client: Client): boolean {
  if (validateSession(client.token)) return true;
  client.ws.close(4401, "登录已失效");
  clients.delete(client);
  return false;
}
const clients = new Set<Client>();

function send(client: Client, msg: unknown): void {
  if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(msg));
}

function broadcastEvent(env: EventEnvelope): void {
  // 侧边栏需要知道哪条会话有动静；正文只推给订阅了的
  const listChanged = ["user", "meta", "state", "result", "error"].includes(env.ev.type);
  const info = listChanged ? hub.info(env.key) : undefined;
  for (const client of [...clients]) {
    if (client.subs.has(env.key)) send(client, { t: "ev", ...env });
    if (info) send(client, { t: "conv", info });
  }
}

function broadcastInteraction(i: Interaction): void {
  for (const client of clients) send(client, { t: "ix", interaction: i });
}

const BY = "已在 Web 处理";

function handleClientMessage(client: Client, raw: string): void {
  // 每条消息都复查登录态：握手时有效不代表现在还有效（改了密码、被踢了）
  if (!checkClient(client)) return;
  let msg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    msg = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  const rid = msg.rid;
  const ack = (ok: boolean, extra: Record<string, unknown> = {}) => send(client, { t: "ack", rid, ok, ...extra });
  const key = typeof msg.key === "string" ? msg.key : "";

  try {
    switch (msg.t) {
      case "ping":
        send(client, { t: "pong" });
        return;

      case "sub": {
        if (!getConversation(key)) return ack(false, { error: "会话不存在" });
        client.subs.add(key);
        const since = typeof msg.since === "number" ? msg.since : 0;
        // 客户端的 seq 来自上一个进程（比现在的还大），或者换了实例：补不了，整页重拉
        const staleEpoch = typeof msg.epoch === "string" && msg.epoch !== EPOCH;
        // since=0：刚打开，历史由 REST 拉，这里只补正在进行的那一轮
        const events =
          staleEpoch || since > hub.currentSeq() ? null : since > 0 ? hub.eventsSince(key, since) : hub.liveTurn(key);
        send(client, {
          t: "replay",
          epoch: EPOCH,
          key,
          reset: events === null,
          events: events ?? [],
          seq: hub.currentSeq(),
          busy: hub.isBusy(key),
          pending: interactions.listPending(key),
        });
        return ack(true);
      }

      case "unsub":
        client.subs.delete(key);
        return ack(true);

      case "send": {
        if (!getConversation(key)) return ack(false, { error: "会话不存在" });
        const text = typeof msg.text === "string" ? msg.text : "";
        const attachments = takeUploads(key, msg.uploads);
        if (!text.trim() && attachments.length === 0) return ack(false, { error: "空消息" });
        hub.send(key, { text, attachments }, { channel: "web", channelId: "web", name: "Web" });
        return ack(true);
      }

      case "ix": {
        const id = String(msg.id ?? "");
        let ok = false;
        let error: string | undefined;
        switch (msg.op) {
          case "decide":
            ok = !!interactions.decide(id, String(msg.decision) as Settlement, BY);
            break;
          case "select":
            ok = !!interactions.select(id, Number(msg.q), Number(msg.o), msg.v !== false, BY);
            break;
          case "submit": {
            const r = interactions.submit(id, BY);
            ok = !!r && !("missing" in r);
            if (r && "missing" in r) error = "还有问题没选";
            break;
          }
          case "skip":
            ok = !!interactions.skip(id, "已在 Web 跳过，agent 会按合理的默认继续");
            break;
          case "text":
            ok = interactions.answerWithText(id, String(msg.text ?? ""), BY);
            break;
        }
        if (!ok && !error) {
          const settled = interactions.get(id)?.settled;
          error = settled ? `已经处理过了（${settled.by}）` : "请求已失效";
        }
        return ack(ok, error ? { error } : {});
      }
    }
  } catch (err) {
    ack(false, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ---------- 启动 ----------

let server: http.Server | null = null;
let wss: WebSocketServer | null = null;
let heartbeat: NodeJS.Timeout | null = null;

export async function startWeb(): Promise<void> {
  const { host, port } = config().web;

  server = http.createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://local");
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      try {
        serveStatic(req, res, url);
      } catch (err) {
        console.error("[web] 静态文件出错:", err);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
      return;
    }
    if (req.method !== "GET" && !sameOrigin(req)) {
      sendJson(res, 403, { error: "跨站请求被拒绝" });
      return;
    }
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    handleApi(req, res, url).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error("[web] 接口出错:", err);
      if (!res.headersSent) sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    });
  });

  wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url ?? "/", "http://local");
      if (url.pathname !== "/ws" || !sameOrigin(req) || !authed(req)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const token = cookies(req)[COOKIE] ?? "";
      wss!.handleUpgrade(req, socket, head, (ws) => {
        const client: Client = { ws, subs: new Set(), alive: true, token };
        clients.add(client);
        ws.on("pong", () => (client.alive = true));
        ws.on("message", (data) => {
          try {
            handleClientMessage(client, data.toString());
          } catch (err) {
            console.error("[web] 处理 WebSocket 消息出错:", err);
          }
        });
        ws.on("close", () => clients.delete(client));
        ws.on("error", () => clients.delete(client));
        send(client, { t: "hello", seq: hub.currentSeq(), epoch: EPOCH });
      });
    } catch (err) {
      console.error("[web] WebSocket 握手出错:", err);
      socket.destroy();
    }
  });
  authEvents.on("revoked", onRevoked);

  // 反代 / 手机网络会悄悄掐掉空闲连接，定期 ping 一下把死连接清掉
  heartbeat = setInterval(() => {
    for (const client of [...clients]) {
      if (!checkClient(client)) continue;
      if (!client.alive) {
        client.ws.terminate();
        clients.delete(client);
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  hub.on("event", broadcastEvent);
  interactions.on("created", broadcastInteraction);
  interactions.on("updated", broadcastInteraction);
  interactions.on("settled", broadcastInteraction);

  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(port, host, () => resolve());
  });
  console.log(`[web] 已监听 http://${host}:${port}`);
  const token = ensureSetupToken();
  if (token) {
    console.log("=".repeat(56));
    console.log(`[web] 还没有设置登录密码。打开页面后输入设置码：${token}`);
    console.log("=".repeat(56));
  }
}

function onRevoked(): void {
  for (const client of [...clients]) checkClient(client);
}

export async function stopWeb(): Promise<void> {
  authEvents.off("revoked", onRevoked);
  hub.off("event", broadcastEvent);
  interactions.off("created", broadcastInteraction);
  interactions.off("updated", broadcastInteraction);
  interactions.off("settled", broadcastInteraction);
  if (heartbeat) clearInterval(heartbeat);
  for (const client of clients) client.ws.close(1001, "服务重启");
  clients.clear();
  wss?.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
}
