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
import { config, onConfigChange } from "../../core/config.js";
import { parseCommand } from "../../core/commands.js";
import { GLOBAL_ALWAYS_DENIED, hub, type EventEnvelope } from "../../core/hub.js";
import { interactions, type Interaction } from "../../core/interactions.js";
import { getConversation } from "../../core/store.js";
import { taskEvents } from "../../core/tasks.js";
import { skillEvents } from "../../core/skills.js";
import { enforceTerminalAccess, killAllTerminals, terminalEvents, watchTerminalAccess } from "../../core/terminals.js";
import { RUNNING_VERSION } from "../../core/upgrade.js";
import type { Settlement } from "../../core/types.js";
import { getUser, isAdmin, legacyOwnerId, userEvents, type User } from "../../core/users.js";
import { currentUser, handleApi, takeUploads } from "./api.js";
import { authEvents, ensureSetupToken, sessionUser } from "./auth.js";
import { canSeeKey, sessionVisibleTo } from "./access.js";
import { cookies } from "./http.js";
import { COOKIE } from "./api.js";
import { HttpError, pageHeaders, sameOrigin, SECURITY_HEADERS, sendJson } from "./http.js";
import { hasSubscriptions, pushToAll } from "./push.js";
import { closeListener, listen, listening, rebind } from "./listen.js";
import { closeTerminalClients, pingTerminalClients, recheckTerminalClients, upgradeTerminal } from "./terminal.js";
import { closeDesktopClients, pingDesktopClients, recheckDesktopClients, upgradeDesktop } from "./desktop.js";
import { stopDesktop } from "../../core/desktop.js";

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
  "/vendor/xterm.js": () => pkgFile("@xterm/xterm", "lib/xterm.mjs"),
  "/vendor/xterm.css": () => pkgFile("@xterm/xterm", "css/xterm.css"),
  "/vendor/xterm-fit.js": () => pkgFile("@xterm/addon-fit", "lib/addon-fit.mjs"),
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

/**
 * 静态文件一律 no-cache + Last-Modified：每次都向服务端确认一下，没变就回 304。
 * 升级后前端的 js、css 和 vendor 都会变，但地址不变，带 max-age 的话刷新页面还会拿到旧的。
 */
function serveFile(req: http.IncomingMessage, res: http.ServerResponse, file: string): void {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, SECURITY_HEADERS);
      res.end("not found");
      return;
    }
    const lastModified = new Date(Math.floor(stat.mtimeMs / 1000) * 1000);
    const since = Date.parse(req.headers["if-modified-since"] ?? "");
    const headers = {
      ...pageHeaders(),
      "Cache-Control": "no-cache",
      "Last-Modified": lastModified.toUTCString(),
    };
    // 页面本身不回 304：它的 CSP（允许谁嵌、能嵌谁）跟着设置变，304 带回的新头浏览器不一定换上
    if (!Number.isNaN(since) && lastModified.getTime() <= since && path.extname(file) !== ".html") {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, {
      ...headers,
      "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
      "Content-Length": stat.size,
    });
    fs.createReadStream(file).pipe(res);
  });
}

/** noVNC 是一堆互相 import 的 ES module：整个 core/、vendor/ 目录按原样给，只给 .js */
function novncFile(pathname: string): string | undefined {
  const rel = pathname.slice("/vendor/novnc/".length);
  if (!/^(core|vendor)\/[\w./-]+\.js$/.test(rel) || rel.split("/").includes("..")) return undefined;
  return path.join(pkgDir("@novnc/novnc"), rel);
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  if (url.pathname.startsWith("/vendor/novnc/")) {
    const file = novncFile(url.pathname);
    if (file) return serveFile(req, res, file);
    res.writeHead(404, SECURITY_HEADERS);
    res.end();
    return;
  }
  const vendor = VENDOR[url.pathname];
  if (vendor) {
    try {
      serveFile(req, res, vendor());
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
  serveFile(req, res, file);
}

// ---------- WebSocket ----------

type Client = {
  ws: WebSocket;
  subs: Set<string>;
  alive: boolean;
  token: string;
  /** 登录的用户。每次复查登录态时刷新（角色可能被改了） */
  user: User;
  /** 页面在前台，且正看着哪条会话（前端在切会话、切前后台时上报） */
  visible: boolean;
  viewing: string | null;
  /** 最后一次收到这个页面的消息（含 ping） */
  seen: number;
};

/** 每次进程启动换一个：客户端发现变了，就知道 seq 已经从头计数，得整页重拉 */
const EPOCH = Math.random().toString(36).slice(2, 10);

/** 登录态已失效（退出、被踢、用户被停用 / 删除）的连接：断开。客户端收到 4401 会回到登录页 */
function checkClient(client: Client): User | undefined {
  const user = sessionUser(client.token);
  if (user) {
    client.user = user;
    // 角色被改了（管理员降成成员）：已经订阅着的、现在看不到的会话，事件不能再推给他
    for (const key of client.subs) if (!canSeeKey(user, key)) client.subs.delete(key);
    return user;
  }
  client.ws.close(4401, "登录已失效");
  clients.delete(client);
  return undefined;
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
    // 订阅时已经核对过是不是他的会话
    if (client.subs.has(env.key)) send(client, { t: "ev", ...env });
    if (info && canSeeKey(client.user, env.key)) send(client, { t: "conv", info });
  }
}

function broadcastInteraction(i: Interaction): void {
  for (const client of clients) if (canSeeKey(client.user, i.convKey)) send(client, { t: "ix", interaction: i });
}

/** 某人的定时任务变了（增删改、跑完一次）：只告诉他自己开着的页面，页面自己去重新拉 */
function broadcastTasks(owner: string): void {
  for (const client of clients) if (client.user.id === owner) send(client, { t: "tasks" });
}

/** 某人的终端开了 / 结束了：他开着的页面重新拉终端列表（别的设备上开的也能接上） */
function broadcastTerminals(owner: string): void {
  for (const client of clients) if (client.user.id === owner) send(client, { t: "remote" });
}

/** 用户改了（比如远程控制权限被开通 / 收回）、远程控制的设置改了：页面重新问一下能用什么 */
function broadcastUsersChanged(): void {
  for (const client of clients) send(client, { t: "remote" });
}

/** 技能变了：以前装过别人技能的人也受影响，通知所有人重新拉（列表很小） */
function broadcastSkills(): void {
  for (const client of clients) send(client, { t: "skills" });
}

// ---------- 系统通知（Web Push） ----------

/**
 * 有页面正在前台看着这条会话：人就在眼前，不用推。
 * 页面每 25 秒发一次 ping；40 秒没收到它的任何消息就不算（手机切走后网络断了，连接还没被心跳清掉，
 * 最后报的还是「在看」）
 */
const SEEN_MS = 40_000;
function watching(key: string): boolean {
  const now = Date.now();
  for (const client of clients) if (client.visible && client.viewing === key && now - client.seen < SEEN_MS) return true;
  return false;
}

/** 通知正文用：去掉 markdown 记号，压成一行。40 字在 iPhone 通知收起时能完整显示 */
export function plainPreview(text: string, max = 40): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " [代码] ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " [图片] ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

function convName(key: string): string {
  const conv = getConversation(key);
  if (!conv) return "Agent Loft";
  return conv.title?.trim() || hub.label(conv.agent);
}

/** 只提醒 Web 自己的会话：飞书会话的动静飞书已经会提醒 */
function isWebConv(key: string): boolean {
  return getConversation(key)?.channel === "web";
}

type Notice = { title: string; body: string; tag: string };

/**
 * 一条要提醒的动静，走两条路：
 *   - 广播给所有连着的页面（t: "notice"）：桌面端据此弹系统通知，要不要弹由它自己判断
 *     （它知道自己是不是正看着这条会话）。普通网页忽略。
 *   - Web Push：只在没有页面正看着这条会话时推。
 */
function notify(key: string, notice: Notice): void {
  if (!isWebConv(key)) return;
  for (const client of clients) if (canSeeKey(client.user, key)) send(client, { t: "notice", key, ...notice });
  if (!hasSubscriptions() || watching(key)) return;
  // 只推给这条会话的主人（没记主人的订阅算迁移出来的那个管理员的）
  const legacy = legacyOwnerId();
  void pushToAll({ ...notice, url: `/#${encodeURIComponent(key)}` }, (owner) => {
    const u = getUser(owner ?? legacy);
    return !!u && !u.disabled && canSeeKey(u, key);
  });
}

function pushEvent(env: EventEnvelope): void {
  const ev = env.ev;
  if (ev.type !== "result" && ev.type !== "error") return;
  if (!isWebConv(env.key)) return;
  // 定时任务这次判断不用提醒
  if (ev.type === "result" && ev.silent) return;
  const name = convName(env.key);
  const payload =
    ev.type === "result"
      ? ev.task
        ? { title: `⏰ ${ev.task.title}`, body: plainPreview(ev.text) || "（没有文字回复）" }
        : { title: `${name} · 回复完成`, body: plainPreview(ev.text) || "（没有文字回复）" }
      : { title: `${name} · 出错了`, body: plainPreview(ev.message) };
  notify(env.key, { ...payload, tag: `reply:${env.key}` });
}

function pushInteraction(i: Interaction): void {
  if (!isWebConv(i.convKey)) return;
  const name = convName(i.convKey);
  const payload =
    i.spec.kind === "approval"
      ? { title: `${name} · 需要授权`, body: plainPreview(i.spec.title) }
      : { title: `${name} · 有问题要你回答`, body: plainPreview(i.spec.questions[0]?.question ?? i.spec.title) };
  notify(i.convKey, { ...payload, tag: `ix:${i.id}` });
}

const BY = "已在 Web 处理";

function handleClientMessage(client: Client, raw: string): void {
  // 每条消息都复查登录态：握手时有效不代表现在还有效（改了密码、被踢了）
  const user = checkClient(client);
  if (!user) return;
  client.seen = Date.now();
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
        if (!getConversation(key) || !canSeeKey(user, key)) return ack(false, { error: "会话不存在" });
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

      case "presence":
        client.visible = msg.visible === true;
        client.viewing = typeof msg.key === "string" && msg.key ? msg.key : null;
        return;

      case "unsub":
        client.subs.delete(key);
        return ack(true);

      case "send": {
        if (!getConversation(key) || !canSeeKey(user, key)) return ack(false, { error: "会话不存在" });
        const text = typeof msg.text === "string" ? msg.text : "";
        const attachments = takeUploads(key, msg.uploads);
        if (!text.trim() && attachments.length === 0) return ack(false, { error: "空消息" });
        // 和飞书一致：整条消息是 agent-loft 命令就由 hub 执行，结果随 ack 回给发命令的这个页面，
        // 不进会话记录。带附件的一律当聊天。
        const command = attachments.length > 0 ? null : parseCommand(text);
        if (command && command.kind !== "chat") {
          const allowedAgents = hub.enabledAgents().map((d) => d.id);
          void hub
            .command(key, command, {
              allowedAgents,
              by: "Web 命令",
              ...(() => {
                const sessionVisible = sessionVisibleTo(user);
                return sessionVisible ? { sessionVisible } : {};
              })(),
              convVisible: (k) => canSeeKey(user, k),
              allowGlobalAlways: isAdmin(user),
            })
            .then((reply) => ack(true, { reply, info: hub.info(key) }))
            .catch((err) => ack(false, { error: err instanceof Error ? err.message : String(err) }));
          return;
        }
        hub.send(key, { text, attachments }, { channel: "web", channelId: "web", name: "Web" });
        return ack(true);
      }

      case "ix": {
        const id = String(msg.id ?? "");
        const target = interactions.get(id);
        if (!target || !canSeeKey(user, target.convKey)) return ack(false, { error: "请求已失效" });
        let ok = false;
        let error: string | undefined;
        switch (msg.op) {
          case "decide":
            if (msg.decision === "allow-always" && target.spec.kind === "approval" && target.spec.alwaysGlobal && !isAdmin(user)) {
              return ack(false, { error: GLOBAL_ALWAYS_DENIED });
            }
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
let stopWatchingListen: (() => void) | null = null;
let stopWatchingRemote: (() => void) | null = null;

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
      const user = ["/ws", "/ws/term", "/ws/desktop"].includes(url.pathname) && sameOrigin(req) ? currentUser(req) : undefined;
      if (!user) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const token = cookies(req)[COOKIE] ?? "";
      if (url.pathname === "/ws/term") return upgradeTerminal(wss!, req, socket, head, user, token, url);
      if (url.pathname === "/ws/desktop") return upgradeDesktop(wss!, req, socket, head, user, token, url);
      wss!.handleUpgrade(req, socket, head, (ws) => {
        const client: Client = { ws, subs: new Set(), alive: true, token, user, visible: false, viewing: null, seen: Date.now() };
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
        send(client, { t: "hello", seq: hub.currentSeq(), epoch: EPOCH, version: RUNNING_VERSION });
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
    enforceTerminalAccess();
    pingTerminalClients();
    pingDesktopClients();
  }, 30_000);
  heartbeat.unref();

  hub.on("event", broadcastEvent);
  hub.on("event", pushEvent);
  interactions.on("created", broadcastInteraction);
  interactions.on("created", pushInteraction);
  interactions.on("updated", broadcastInteraction);
  interactions.on("settled", broadcastInteraction);
  taskEvents.on("changed", broadcastTasks);
  skillEvents.on("changed", broadcastSkills);
  terminalEvents.on("changed", broadcastTerminals);
  userEvents.on("changed", broadcastUsersChanged);
  watchTerminalAccess();
  // 设置里关了远程桌面 / 换了桌面来源：连着的断开，自己起的 x11vnc 停掉（下次连时按新设置起）
  stopWatchingRemote = onConfigChange((next, prev) => {
    if (JSON.stringify(next.remote) === JSON.stringify(prev.remote)) return;
    const r = next.remote;
    const p = prev.remote;
    if (!r.desktop || r.desktopSource !== p.desktopSource || r.display !== p.display) {
      closeDesktopClients();
      stopDesktop();
    }
    recheckDesktopClients();
    broadcastUsersChanged();
  });

  await listen(server, host, port);
  console.log(`[web] 已监听 http://${host}:${port}`);
  // 配置文件被手改了地址 / 端口：跟着换（设置页保存时已经先换好了，这里会直接跳过）
  stopWatchingListen = onConfigChange((next) => {
    const now = listening();
    if (!now || (now.host === next.web.host && now.port === next.web.port)) return;
    rebind(next.web.host, next.web.port).catch((err) => console.error("[web] 换监听地址失败:", err instanceof Error ? err.message : err));
  });
  const token = ensureSetupToken();
  if (token) {
    console.log("=".repeat(56));
    console.log(`[web] 还没有设置登录密码。打开页面后输入设置码：${token}`);
    console.log("=".repeat(56));
  }
}

function onRevoked(): void {
  for (const client of [...clients]) checkClient(client);
  recheckTerminalClients();
  recheckDesktopClients();
}

export async function stopWeb(): Promise<void> {
  authEvents.off("revoked", onRevoked);
  hub.off("event", broadcastEvent);
  hub.off("event", pushEvent);
  interactions.off("created", broadcastInteraction);
  interactions.off("created", pushInteraction);
  interactions.off("updated", broadcastInteraction);
  interactions.off("settled", broadcastInteraction);
  taskEvents.off("changed", broadcastTasks);
  skillEvents.off("changed", broadcastSkills);
  terminalEvents.off("changed", broadcastTerminals);
  userEvents.off("changed", broadcastUsersChanged);
  stopWatchingRemote?.();
  stopWatchingRemote = null;
  closeTerminalClients();
  killAllTerminals();
  closeDesktopClients();
  stopDesktop();
  if (heartbeat) clearInterval(heartbeat);
  for (const client of clients) client.ws.close(1001, "服务重启");
  clients.clear();
  wss?.close();
  stopWatchingListen?.();
  stopWatchingListen = null;
  closeListener();
  // http.Server 自己没有 listen（连接是 listen.ts 交过来的），close 只为断开还连着的
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server?.closeAllConnections();
  server = null;
}
