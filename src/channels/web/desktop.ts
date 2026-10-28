// 远程控制的接口：GET /api/remote 告诉页面终端、桌面各自能不能用；
// POST /api/desktop/session 准备好桌面（必要时起 x11vnc），把这次的 VNC 密码给页面；
// GET /api/desktop/screens 有哪几块屏（页面选只看哪块）；
// /ws/desktop 把页面（noVNC）的 WebSocket 原样转到 VNC 服务的 TCP 端口，和 websockify 一样。
import net from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket, WebSocketServer } from "ws";
import { canUseDesktop, desktopAvailability, desktopTarget, desktopViewer, type DesktopTarget } from "../../core/desktop.js";
import { desktopScreens, screenSource } from "../../core/desktop-screens.js";
import { canUseRemote, isAdmin, type User } from "../../core/users.js";
import { config } from "../../core/config.js";
import { ByteReader, serveNoAuth, vncLogin } from "../../core/vnc-auth.js";
import { isDesktopQuality, loadSharp, transcode, type DesktopQuality } from "../../core/vnc-transcode.js";
import { sessionUser } from "./auth.js";
import { HttpError, sendJson } from "./http.js";
import { terminalStatus } from "./terminal.js";

/** 页面要知道的：能不能用远程控制，终端、桌面各自开着没、能不能用 */
export function remoteStatus(user: User) {
  const desktop = desktopAvailability();
  return {
    allowed: canUseRemote(user),
    terminal: terminalStatus(user),
    desktop: {
      allowed: canUseDesktop(user),
      available: desktop.available,
      source: desktop.source,
      // 为什么用不了、怎么装：只给管理员看（成员只知道没有桌面）
      ...(desktop.reason && isAdmin(user) ? { reason: desktop.reason } : {}),
    },
  };
}

export async function handleDesktopApi(req: IncomingMessage, res: ServerResponse, p: string, user: User): Promise<boolean> {
  const method = req.method ?? "GET";
  if (p === "/api/remote" && method === "GET") {
    sendJson(res, 200, remoteStatus(user));
    return true;
  }
  if (p === "/api/desktop/session" && method === "POST") {
    if (!canUseDesktop(user)) throw new HttpError(403, "你没有使用远程桌面的权限，找管理员在 设置 → 用户 里开通");
    let target;
    try {
      target = await desktopTarget();
    } catch (err) {
      throw new HttpError(503, err instanceof Error ? err.message : String(err));
    }
    // 已有的 VNC 服务（比如 macOS 屏幕共享）没开：现在就说清楚，别让页面一直「正在重连」
    if (config().remote.desktopSource === "vnc" && !(await reachable(target.host, target.port))) {
      throw new HttpError(503, `连不上 VNC 服务 ${target.host}:${target.port}，先确认它开着（macOS：系统设置 → 通用 → 共享 → 屏幕共享）`);
    }
    // 苹果认证由服务端登录，Mac 的登录密码不给页面
    sendJson(res, 200, { password: target.username ? "" : target.password, source: config().remote.desktopSource });
    return true;
  }
  if (p === "/api/desktop/screens" && method === "GET") {
    if (!canUseDesktop(user)) throw new HttpError(403, "你没有使用远程桌面的权限");
    sendJson(res, 200, desktopScreens());
    return true;
  }
  return false;
}

/** 3 秒内能不能连上这个 TCP 端口 */
function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(3000, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

// ---------- WebSocket ↔ VNC ----------

type DesktopClient = { ws: WebSocket; tcp: net.Socket; token: string; alive: boolean };
const clients = new Set<DesktopClient>();

/** 同时连着桌面的页面最多这么多（每个都是一整路画面） */
const MAX_CLIENTS = 6;
/** 页面收得慢：攒到这么多就先不读 VNC 那头，等它消化掉 */
const HIGH_WATER = 4 * 1024 * 1024;

function drop(client: DesktopClient): void {
  if (!clients.delete(client)) return;
  client.tcp.destroy();
  desktopViewer(-1);
}

function stillAllowed(client: DesktopClient): boolean {
  const user = sessionUser(client.token);
  if (user && canUseDesktop(user)) return true;
  client.ws.close(user ? 4403 : 4401, user ? "远程桌面权限已被收回" : "登录已失效");
  drop(client);
  return false;
}

function reject(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
  socket.destroy();
}

/**
 * /ws/desktop 的握手：user 已经由调用方核对过登录和 Origin。
 * ?q= 是画质：smooth / standard / high 由服务端缩小、压成 JPEG 再发（vnc-transcode.ts）；original 或不带是原样转发。
 * ?screen= 只看第几块屏（从 1 数，按 /api/desktop/screens 的顺序），只在转码时管用
 */
export function upgradeDesktop(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer, user: User, token: string, url: URL): void {
  if (!canUseDesktop(user)) return reject(socket, "403 Forbidden");
  if (clients.size >= MAX_CLIENTS) return reject(socket, "429 Too Many Requests");
  // 下面要等 x11vnc 起来（最多 10 秒）：这期间浏览器断开的话，socket 上没人接 error 会把进程带崩
  const onError = () => socket.destroy();
  socket.on("error", onError);
  void desktopTarget().then(
    (target) => {
      if (socket.destroyed) return;
      const tcp = net.connect(target.port, target.host);
      tcp.once("error", () => {
        if (!socket.destroyed) reject(socket, "502 Bad Gateway");
      });
      tcp.once("connect", () => {
        if (socket.destroyed) return void tcp.destroy();
        socket.off("error", onError);
        const q = url.searchParams.get("q");
        const screen = Math.max(0, Math.floor(Number(url.searchParams.get("screen")) || 0));
        wss.handleUpgrade(req, socket, head, (ws) => {
          if (isDesktopQuality(q)) return void transcodeSession(ws, tcp, token, target, q, screen);
          if (!target.username) return bridge(ws, tcp, token);
          void loginThenBridge(ws, tcp, token, target.username, target.password);
        });
      });
    },
    (err) => {
      console.error("[桌面] 准备桌面失败:", err instanceof Error ? err.message : err);
      reject(socket, "503 Service Unavailable");
    },
  );
}

/** 握手最多等这么久（对方不回话） */
const LOGIN_TIMEOUT = 15_000;

/** 苹果认证：先由这里和 VNC 服务登录，对页面装成不用认证的，谈完了再原样转发 */
async function loginThenBridge(ws: WebSocket, tcp: net.Socket, token: string, username: string, password: string): Promise<void> {
  // 握手前那个「回 502」的已经用不上了（socket 交给 WebSocket 了）
  tcp.removeAllListeners("error");
  const fromVnc = new ByteReader();
  const fromPage = new ByteReader();
  const onTcp = (d: Buffer) => fromVnc.push(d);
  const onWs = (d: Buffer) => fromPage.push(d);
  const onTcpEnd = () => fromVnc.fail(new Error("VNC 服务断开了连接"));
  const onWsEnd = () => fromPage.fail(new Error("页面断开了"));
  tcp.on("data", onTcp).on("close", onTcpEnd).on("error", onTcpEnd);
  ws.on("message", onWs).on("close", onWsEnd);
  const timer = setTimeout(() => {
    const err = new Error("VNC 服务没有回应");
    fromVnc.fail(err);
    fromPage.fail(err);
  }, LOGIN_TIMEOUT);
  try {
    const login = vncLogin(fromVnc, (b) => tcp.write(b), { username, password });
    await serveNoAuth(fromPage, (b) => ws.readyState === ws.OPEN && ws.send(b, { binary: true }), login);
  } catch (err) {
    console.error("[桌面] 苹果认证失败:", err instanceof Error ? err.message : err);
    tcp.destroy();
    // 原因已经按认证失败告诉页面了：等它收到再关
    if (ws.readyState === ws.OPEN) setTimeout(() => ws.close(4000, "认证失败"), 200);
    return;
  } finally {
    clearTimeout(timer);
    tcp.off("data", onTcp).off("close", onTcpEnd).off("error", onTcpEnd);
    ws.off("message", onWs).off("close", onWsEnd);
  }
  if (ws.readyState !== ws.OPEN || tcp.destroyed) return void tcp.destroy();
  bridge(ws, tcp, token, fromVnc.rest(), fromPage.rest());
}

function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\./.test(h);
}

/** 转码：服务端连 VNC、缩小画面压成 JPEG 发给页面 */
async function transcodeSession(ws: WebSocket, tcp: net.Socket, token: string, target: DesktopTarget, quality: DesktopQuality, screen: number): Promise<void> {
  // 握手前那个「回 502」的已经用不上了（socket 交给 WebSocket 了）
  tcp.removeAllListeners("error");
  tcp.on("error", () => tcp.destroy());
  // 压 JPEG 的 sharp 在这台机器上装不上：退回原样转发（原画），别让页面一直重连
  try {
    await loadSharp();
  } catch (err) {
    console.error("[桌面] 加载 sharp 失败，画质设置不起作用，按原画转发:", err instanceof Error ? err.message : err);
    if (!target.username) return bridge(ws, tcp, token);
    return loginThenBridge(ws, tcp, token, target.username, target.password);
  }
  tcp.removeAllListeners("error");
  tcp.setNoDelay(true);
  const client: DesktopClient = { ws, tcp, token, alive: true };
  clients.add(client);
  desktopViewer(1);
  const local = isLoopback(target.host);
  // 读系统里的屏幕要一会儿（osascript）：先接住两头的数据，别丢
  const screens = screenSource(`${target.host}:${target.port}`, { local, display: config().remote.desktopSource === "auto" ? desktopAvailability().display : undefined });
  const fromVnc = new ByteReader();
  const fromPage = new ByteReader();
  tcp.on("data", (d: Buffer) => fromVnc.push(d));
  tcp.on("close", () => fromVnc.fail(new Error("VNC 服务断开了连接")));
  tcp.on("error", () => fromVnc.fail(new Error("VNC 服务断开了连接")));
  ws.on("message", (d: Buffer) => fromPage.push(d));
  ws.on("close", () => fromPage.fail(new Error("页面断开了")));
  ws.on("error", () => fromPage.fail(new Error("页面断开了")));
  ws.on("pong", () => (client.alive = true));
  const timer = setTimeout(() => {
    const err = new Error("VNC 服务没有回应");
    fromVnc.fail(err);
    fromPage.fail(err);
  }, LOGIN_TIMEOUT);
  try {
    await transcode({
      vnc: { reader: fromVnc, write: (b) => void (tcp.destroyed || tcp.write(b)) },
      page: { reader: fromPage, write: (b) => void (ws.readyState === ws.OPEN && ws.send(b, { binary: true })), backlog: () => ws.bufferedAmount },
      creds: { username: target.username, password: target.password },
      quality,
      local,
      screen,
      screens: await screens,
      onReady: () => clearTimeout(timer),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/页面断开了/.test(msg)) console.error("[桌面] 转码会话结束:", msg);
    // 认证失败的原因已经告诉页面了：等它收到再关
    if (ws.readyState === ws.OPEN) setTimeout(() => ws.close(4000, "桌面连接已断开"), 200);
  } finally {
    clearTimeout(timer);
    drop(client);
  }
}

/** pending：握手时多读进来、还没转发的字节 */
function bridge(ws: WebSocket, tcp: net.Socket, token: string, pendingVnc?: Buffer, pendingPage?: Buffer): void {
  const client: DesktopClient = { ws, tcp, token, alive: true };
  clients.add(client);
  desktopViewer(1);
  tcp.removeAllListeners("error");
  tcp.setNoDelay(true);
  let paused = false;
  const resumeWhenDrained = () => {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount < HIGH_WATER / 2) {
      paused = false;
      tcp.resume();
    } else setTimeout(resumeWhenDrained, 30);
  };
  tcp.on("data", (chunk) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(chunk, { binary: true });
    if (!paused && ws.bufferedAmount > HIGH_WATER) {
      paused = true;
      tcp.pause();
      setTimeout(resumeWhenDrained, 30);
    }
  });
  tcp.on("close", () => {
    if (ws.readyState === ws.OPEN) ws.close(4000, "桌面连接已断开");
    drop(client);
  });
  tcp.on("error", () => drop(client));
  ws.on("pong", () => (client.alive = true));
  // 页面 → VNC：按键、鼠标都在这里，逐条复查登录态太密了；登录态 / 权限变了由 recheckDesktopClients 统一断开
  ws.on("message", (data: Buffer) => tcp.write(data));
  if (pendingVnc?.length) ws.send(pendingVnc, { binary: true });
  if (pendingPage?.length) tcp.write(pendingPage);
  ws.on("close", () => drop(client));
  ws.on("error", () => drop(client));
}

/** 退出登录、被踢、权限收回、设置里关了桌面：把还连着的断开 */
export function recheckDesktopClients(): void {
  for (const client of [...clients]) stillAllowed(client);
}

export function pingDesktopClients(): void {
  for (const client of [...clients]) {
    if (!stillAllowed(client)) continue;
    if (!client.alive) {
      client.ws.terminate();
      drop(client);
      continue;
    }
    client.alive = false;
    client.ws.ping();
  }
}

export function closeDesktopClients(): void {
  for (const client of [...clients]) {
    client.ws.close(1001, "服务重启");
    drop(client);
  }
}
