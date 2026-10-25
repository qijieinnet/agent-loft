// 网页终端的接口：REST（/api/terminals）开、列、关终端；WebSocket（/ws/term?id=…&since=…）收发。
// 一个终端一条 WebSocket，和会话的 /ws 分开：终端的输出量大，别挤占会话事件。shell 的管理见 core/terminals.ts。
//
// 页面 → 服务端：{ t: "i", d } 输入，{ t: "r", c, r } 改大小，{ t: "ping" }
// 服务端 → 页面：{ t: "a", reset, d, total } 连上时补发，{ t: "o", d } 输出，{ t: "x", code, reason } 结束了
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket, WebSocketServer } from "ws";
import { config } from "../../core/config.js";
import {
  attachTerminal,
  canUseTerminal,
  createTerminal,
  detachTerminal,
  getTerminal,
  killTerminal,
  listTerminals,
  resizeTerminal,
  terminalAvailability,
  writeTerminal,
  type TermPeer,
} from "../../core/terminals.js";
import type { User } from "../../core/users.js";
import { sessionUser } from "./auth.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";

/** 页面要知道的：能不能用、为什么不能用、空闲多久结束 */
export function terminalStatus(user: User) {
  const { available, reason } = terminalAvailability();
  return {
    enabled: config().remote.terminal,
    allowed: canUseTerminal(user),
    available,
    ...(reason && canUseTerminal(user) ? { reason } : {}),
    keepAliveMin: config().remote.keepAliveMin,
  };
}

export async function handleTerminalApi(req: IncomingMessage, res: ServerResponse, p: string, user: User): Promise<boolean> {
  const method = req.method ?? "GET";
  if (p === "/api/terminals" && method === "GET") {
    sendJson(res, 200, { ...terminalStatus(user), terminals: canUseTerminal(user) ? listTerminals(user.id) : [] });
    return true;
  }
  if (!canUseTerminal(user)) throw new HttpError(403, "你没有使用终端的权限，找管理员在 设置 → 用户 里开通");
  if (p === "/api/terminals" && method === "POST") {
    const body = await readJsonBody<{ cwd?: unknown; cols?: unknown; rows?: unknown }>(req);
    try {
      sendJson(res, 200, createTerminal(user, body));
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    return true;
  }
  const m = /^\/api\/terminals\/([A-Za-z0-9_]+)$/.exec(p);
  if (m && method === "DELETE") {
    if (!getTerminal(m[1]!, user.id)) throw new HttpError(404, "终端不存在（可能已经结束了）");
    killTerminal(m[1]!);
    sendJson(res, 200, { ok: true });
    return true;
  }
  return false;
}

// ---------- WebSocket ----------

type TermClient = { ws: WebSocket; peer: TermPeer; id: string; token: string; alive: boolean };
const clients = new Set<TermClient>();

/** 页面收得太慢（网太差）：攒着的超过这么多就断开它，重连时从输出记录里补 */
const MAX_BUFFERED = 8 * 1024 * 1024;

function drop(client: TermClient): void {
  if (!clients.delete(client)) return;
  detachTerminal(client.id, client.peer);
}

/** 登录态还有效、并且还能用终端；否则断开（4401 让页面回登录页） */
function stillAllowed(client: TermClient): boolean {
  const user = sessionUser(client.token);
  if (user && canUseTerminal(user)) return true;
  client.ws.close(user ? 4403 : 4401, user ? "终端权限已被收回" : "登录已失效");
  drop(client);
  return false;
}

/** /ws/term 的握手：user 已经由调用方核对过登录和 Origin */
export function upgradeTerminal(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer, user: User, token: string, url: URL): void {
  const id = url.searchParams.get("id") ?? "";
  if (!canUseTerminal(user) || !getTerminal(id, user.id)) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  const since = Number(url.searchParams.get("since") ?? "-1");
  wss.handleUpgrade(req, socket, head, (ws) => {
    const peer: TermPeer = {
      send: (msg) => {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED) return ws.terminate();
        ws.send(JSON.stringify(msg));
      },
      close: (code, reason) => ws.close(code, reason),
    };
    const client: TermClient = { ws, peer, id, token, alive: true };
    // 握手到这里的一小会儿里终端可能刚好结束了
    if (!attachTerminal(id, user.id, peer, since)) {
      ws.close(4000, "终端已结束");
      return;
    }
    clients.add(client);
    ws.on("pong", () => (client.alive = true));
    ws.on("message", (data) => {
      let msg: { t?: unknown; d?: unknown; c?: unknown; r?: unknown };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (typeof msg !== "object" || msg === null || !stillAllowed(client)) return;
      if (msg.t === "i" && typeof msg.d === "string") writeTerminal(id, msg.d);
      else if (msg.t === "r") resizeTerminal(id, msg.c, msg.r);
      else if (msg.t === "ping") peer.send({ t: "pong" });
    });
    ws.on("close", () => drop(client));
    ws.on("error", () => drop(client));
  });
}

/** 退出登录、被踢、权限收回：把还连着的断开 */
export function recheckTerminalClients(): void {
  for (const client of [...clients]) stillAllowed(client);
}

/** 心跳：清掉死连接（服务端 30 秒一次，和 /ws 一起） */
export function pingTerminalClients(): void {
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

export function closeTerminalClients(): void {
  for (const client of [...clients]) {
    client.ws.close(1001, "服务重启");
    drop(client);
  }
}
