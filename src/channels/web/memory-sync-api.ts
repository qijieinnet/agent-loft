import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticate, issueInvite, join, redeem, revoke, servePull, servePush, status, syncNow } from "../../core/memory-sync.js";
import { resolveConflict, type Change } from "../../core/memory-sync-store.js";
import { hub } from "../../core/hub.js";
import { readJsonBody, sendJson, HttpError } from "./http.js";

export async function syncApi(req: IncomingMessage, res: ServerResponse, path: string, user?: string) {
  try {
    if (user && path === "/api/account/memory/sync" && req.method === "GET") return sendJson(res, 200, status(user));
    if (req.method !== "POST") throw new HttpError(405, "需要 POST");
    const action = path.split("/").pop();
    if (!user) {
      if (action === "pair") {
        const { code, device } = await readJsonBody(req, 2048);
        return sendJson(res, 200, redeem(String(code), String(device)));
      }
      const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? "";
      if (!authenticate(token)) throw new HttpError(401, "实例配对已失效");
      const body = await readJsonBody(req, 64 * 1024 * 1024);
      // A revocation while a request was uploading must take effect before committing it.
      const peer = authenticate(token);
      if (!peer) throw new HttpError(401, "实例配对已失效");
      if (action === "push" && Array.isArray(body.changes) && body.changes.length <= 48) {
        servePush(peer, body.changes as Change[]);
        if (body.changes.some((c) => c.kind === "item" || c.kind === "about")) hub.memoryChanged(peer.user_id);
      } else if (action === "pull" && Number.isSafeInteger(body.cursor) && Number(body.cursor) >= 0) {
        return sendJson(res, 200, servePull(peer, Number(body.cursor)));
      } else throw new HttpError(400, "无效的同步请求");
    } else {
      const b = await readJsonBody(req);
      if (action === "invite") return sendJson(res, 200, issueInvite(user));
      if (action === "join") await join(user, String(b.url), String(b.code));
      else if (action === "revoke") revoke(user, String(b.device));
      else if (action === "resolve") resolveConflict(user, String(b.gid), b.choices as string[], String(b.text));
      else if (action !== "now") throw new HttpError(404, "同步操作不存在");
      if (action === "now") await syncNow(user);
      else void syncNow(user).catch(() => {});
    }
    sendJson(res, 200, { ok: true });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, err instanceof Error ? err.message : "同步失败");
  }
}
