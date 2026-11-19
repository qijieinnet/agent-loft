import { createHash, randomBytes } from "node:crypto";
import { sql, transaction } from "./db.js";
import { getUser } from "./users.js";
import {
  acceptPush,
  account,
  acknowledge,
  activate,
  feed,
  flushRelay,
  idPattern,
  randomId,
  receive,
  preparePush,
  syncConflicts,
  type Change,
  type Document,
} from "./memory-sync-store.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const active = (u: string) => {
  const user = getUser(u);
  return !!user && !user.disabled;
};
export function issueInvite(u: string) {
  return transaction(() => {
    if (account(u)?.url) throw new Error("此账号已连接中转实例");
    if (!account(u)) activate(u);
    const code = randomBytes(16).toString("hex");
    const expires = Date.now() + 10 * 60_000;
    sql("INSERT OR REPLACE INTO sync_invite VALUES(?,?,?)").run(u, hash(code), expires);
    return { code, expires };
  });
}

export function redeem(code: string, device: string) {
  return transaction(() => {
    if (!idPattern.test(code) || !idPattern.test(device)) throw new Error("无效配对码或实例");
    const invite = sql("DELETE FROM sync_invite WHERE hash=? AND expires>? RETURNING user_id").get(hash(code), Date.now()) as
      | { user_id: string }
      | undefined;
    if (!invite || !active(invite.user_id)) throw new Error("配对码无效或已过期");
    if (account(invite.user_id)?.device === device) throw new Error("不能与当前实例自身配对");
    const token = randomBytes(32).toString("hex");
    sql("INSERT INTO sync_peer(user_id,device,hash) VALUES(?,?,?) ON CONFLICT(user_id,device) DO UPDATE SET hash=excluded.hash").run(
      invite.user_id,
      device,
      hash(token),
    );
    return { token, relay: account(invite.user_id)!.device, version: 1 };
  });
}

export function authenticate(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) return;
  const peer = sql("SELECT user_id,device FROM sync_peer WHERE hash=?").get(hash(token)) as { user_id: string; device: string } | undefined;
  if (peer && active(peer.user_id)) return peer;
}

export function revoke(u: string, device: string) {
  sql("DELETE FROM sync_peer WHERE user_id=? AND device=?").run(u, device);
}

function endpoint(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("请输入中转实例的 HTTPS 地址");
  return url.origin + url.pathname.replace(/\/$/, "");
}

const maxBytes = 64 * 1024 * 1024;
async function post(url: string, path: string, body: unknown, token?: string) {
  const response = await fetch(url + "/api/memory-sync/v1/" + path, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`中转返回 HTTP ${response.status}`);
  }
  const data: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body!) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error("同步响应过大");
    data.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(data).toString()) as Record<string, unknown>;
}

const joining = new Set<string>();
export async function join(u: string, address: string, code: string) {
  const url = endpoint(address);
  const old = account(u);
  if ((old && old.url !== url) || joining.has(u)) throw new Error("此账号已经配置同步");
  const device = old?.device ?? randomId();
  joining.add(u);
  try {
    const result = await post(url, "pair", { code: code.trim(), device });
    if (result.version !== 1 || typeof result.token !== "string" || !/^[a-f0-9]{64}$/.test(result.token)) throw new Error("配对响应无效");
    if (!active(u)) throw new Error("账号不可用");
    if (typeof result.relay !== "string" || !idPattern.test(result.relay)) throw new Error("无效中转标识");
    if (old && old.relay !== result.relay) throw new Error("配对码属于其他账号或中转实例");
    transaction(() => {
      if (!old) activate(u, device, url, result.token as string);
      sql("UPDATE sync_account SET relay=?,token=?,error=NULL WHERE user_id=?").run(result.relay as string, result.token as string, u);
    });
  } finally {
    joining.delete(u);
  }
}

export function status(u: string) {
  const a = account(u);
  return {
    device: a?.device,
    mode: a ? (a.url ? "client" : "relay") : "off",
    url: a?.url,
    lastSync: a?.last_sync,
    error: a?.error,
    pending: Number(sql("SELECT count(*) AS n FROM sync_dirty WHERE user_id=?").get(u)?.n),
    peers: sql("SELECT device,last_sync FROM sync_peer WHERE user_id=? ORDER BY device").all(u),
    conflicts: syncConflicts(u),
  };
}

export function servePush(peer: { user_id: string; device: string }, changes: Change[]) {
  acceptPush(peer.user_id, peer.device, changes);
  touchPeer(peer);
}
export function servePull(peer: { user_id: string; device: string }, cursor: number) {
  const page = feed(peer.user_id, cursor);
  touchPeer(peer);
  return page;
}
function touchPeer(peer: { user_id: string; device: string }) {
  const now = Date.now();
  sql("UPDATE sync_peer SET last_sync=? WHERE user_id=? AND device=?").run(now, peer.user_id, peer.device);
  sql("UPDATE sync_account SET last_sync=? WHERE user_id=?").run(now, peer.user_id);
}

const running = new Map<string, Promise<void>>();
let changed: (u: string) => void = () => {};
async function exchange(u: string) {
  const a = account(u);
  if (!a || !active(u)) return;
  const current = () => active(u) && account(u)?.device === a.device;
  if (!a.url || !a.token) {
    while (current() && flushRelay(u)) await new Promise((r) => setImmediate(r));
    return;
  }
  let cursor = a.cursor;
  do {
    const batch = preparePush(u);
    if (batch.length) {
      const ack = await post(a.url, "push", { changes: batch }, a.token);
      if (!current()) return;
      if (ack.ok !== true) throw new Error("中转未确认写入");
      acknowledge(u, batch);
    }
    const page = await post(a.url, "pull", { cursor }, a.token);
    if (!current()) return;
    if (
      !Array.isArray(page.docs) ||
      page.docs.length > 48 ||
      typeof page.cursor !== "number" ||
      !Number.isSafeInteger(page.cursor) ||
      (page.docs.length ? page.cursor <= cursor : page.cursor !== cursor)
    )
      throw new Error("中转游标无效");
    if (receive(u, page.docs as Document[], page.cursor)) {
      cursor = page.cursor;
      if ((page.docs as Document[]).some((d) => d.kind === "about" || d.kind === "item")) changed(u);
    }
    if (!batch.length && !page.docs.length) break;
  } while (current());
  sql("UPDATE sync_account SET last_sync=?,error=NULL WHERE user_id=? AND device=?").run(Date.now(), u, a.device);
}
export function syncNow(u: string) {
  const ongoing = running.get(u);
  if (ongoing) return ongoing;
  const work = exchange(u)
    .catch((err) => {
      sql("UPDATE sync_account SET error=? WHERE user_id=?").run(err instanceof Error ? err.message : "同步失败", u);
      throw err;
    })
    .finally(() => running.delete(u));
  running.set(u, work);
  return work;
}
export function startMemorySync(onChanged: (u: string) => void) {
  changed = onChanged;
  const tick = () => {
    for (const row of sql("SELECT user_id FROM sync_account").all()) void syncNow(String(row.user_id)).catch(() => {});
  };
  tick();
  return setInterval(tick, 15_000).unref();
}
