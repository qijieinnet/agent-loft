// Web Push：回复完成、需要授权时给手机 / 电脑推系统通知。
//
// 不依赖第三方库，按标准自己实现：
//   - VAPID（RFC 8292）：用一对 P-256 密钥给推送服务签 JWT，证明推送来自我们；
//   - 消息加密（RFC 8291，aes128gcm）：推送服务（Apple / Google / Mozilla）看不到内容。
// iPhone 上只有「添加到主屏幕」的 PWA 才能收到（iOS 16.4+），macOS Safari / Chrome 直接可用。
// 订阅接口要求页面是 HTTPS（localhost 除外）。
import crypto from "node:crypto";
import path from "node:path";
import { dataDir, readJson, writeJsonAtomic } from "../../home.js";
import { legacyOwnerId } from "../../core/users.js";
import { config, onConfigChange } from "../../core/config.js";
import { selfName, validServerId } from "../../core/servers.js";

export type PushSubscriptionRecord = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** 设备描述（User-Agent 摘要），设置页里认设备用 */
  label: string;
  createdAt: number;
  lastOkAt?: number;
  /** 哪个用户开的（core/users.ts）。升级前的没有：第一次读到时认给迁移出来的那个管理员并记下 */
  userId?: string;
  /** 多服务器的外壳转来的订阅，见下面的 addRelaySubscription */
  relay?: RelayInfo;
};

type VapidKey = { publicKey: string; privateJwk: crypto.JsonWebKey };

/**
 * 外壳转来的订阅：手机上只有添加到主屏幕的那个地址（外壳）能订阅推送，订阅是对着外壳那台的
 * VAPID 公钥开的，这台推的时候也得用那把密钥签名，推送服务才认。点开通知回到外壳的页面，
 * 地址里带上 srv=这台在外壳里的 id，由外壳切过来。
 */
export type RelayInfo = {
  vapid: VapidKey;
  /** 外壳的地址 */
  origin: string;
  /** 这台在外壳列表里的 id */
  server: string;
  /** 外壳列表里这台的图标和名字，加在通知标题前面 */
  label: string;
};

/** 按订阅的主人筛选：拿到的是订阅里记的 userId（可能没有） */
export type OwnerFilter = (userId: string | undefined) => boolean;

export type PushPayload = {
  title: string;
  body: string;
  /** 同一 tag 的通知会互相替换，不在通知中心堆一串 */
  tag?: string;
  /** 点开通知后打开的地址 */
  url?: string;
};

type Store = {
  vapid?: VapidKey;
  subscriptions: PushSubscriptionRecord[];
};

const FILE = () => path.join(dataDir, "push.json");
/** VAPID 的 sub 声明：Apple 要求是 mailto: 或 https: 地址 */
const VAPID_SUBJECT = "https://github.com/qijieinnet/agent-loft";

let store: Store | null = null;

/** 取消嵌入授权后，该外壳也不能再通过旧订阅收到通知。 */
function dropRevokedRelays(s: Store, embedders: string[]): boolean {
  const before = s.subscriptions.length;
  s.subscriptions = s.subscriptions.filter((x) => !x.relay || embedders.includes(x.relay.origin));
  return s.subscriptions.length !== before;
}

onConfigChange((next) => {
  if (store && dropRevokedRelays(store, next.servers.embedders)) persist();
});

function load(): Store {
  if (!store) {
    store = readJson<Store>(FILE(), { subscriptions: [] });
    if (!Array.isArray(store.subscriptions)) store.subscriptions = [];
    // 升级前的订阅：记到迁移出来的管理员名下。只做一次 —— 之后那个管理员被停用、删掉，
    // 订阅也不会转给别人（那样别人的通知会推到他的手机上）
    const owner = legacyOwnerId();
    const legacy = owner ? store.subscriptions.filter((x) => !x.userId) : [];
    for (const x of legacy) x.userId = owner;
    const revoked = dropRevokedRelays(store, config().servers.embedders);
    if (legacy.length > 0 || revoked) writeJsonAtomic(FILE(), store);
  }
  return store;
}

function persist(): void {
  writeJsonAtomic(FILE(), load());
}

/** 测试用：换了 AGENT_LOFT_HOME 之后重新读 */
export function resetPushStoreForTest(): void {
  store = null;
}

export const b64url = (buf: Buffer | Uint8Array): string => Buffer.from(buf).toString("base64url");
export const fromB64url = (s: string): Buffer => Buffer.from(s, "base64url");

/** 未压缩格式的 P-256 公钥（0x04 || x || y，65 字节） */
function rawPublicKey(jwk: crypto.JsonWebKey): Buffer {
  return Buffer.concat([Buffer.from([4]), fromB64url(jwk.x!), fromB64url(jwk.y!)]);
}

function vapid(): { publicKey: string; privateKey: crypto.KeyObject } {
  const s = load();
  if (!s.vapid) {
    const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const privateJwk = privateKey.export({ format: "jwk" });
    s.vapid = { publicKey: b64url(rawPublicKey(privateJwk)), privateJwk };
    persist();
  }
  return { publicKey: s.vapid.publicKey, privateKey: crypto.createPrivateKey({ key: s.vapid.privateJwk, format: "jwk" }) };
}

/** 浏览器订阅时要的 applicationServerKey */
export function vapidPublicKey(): string {
  return vapid().publicKey;
}

/**
 * 这台的 VAPID 密钥对，给多服务器的外壳转给嵌着的各台（GET /api/push/relay-key）。
 * 拿到它也只能推给已经知道订阅地址的设备：订阅地址和加密用的 p256dh / auth 只在开通知的那台浏览器
 * 和收到订阅的服务端手里，别人的设备推不到
 */
export function vapidKeyPair(): VapidKey {
  vapid();
  const { publicKey, privateJwk } = load().vapid!;
  return { publicKey, privateJwk };
}

/** key：用别的密钥签（外壳转来的订阅），不给就用这台自己的 */
export function vapidHeader(endpoint: string, key?: VapidKey): string {
  const { publicKey, privateKey } = key
    ? { publicKey: key.publicKey, privateKey: crypto.createPrivateKey({ key: key.privateJwk, format: "jwk" }) }
    : vapid();
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(
    Buffer.from(
      JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT }),
    ),
  );
  const signature = crypto.sign("sha256", Buffer.from(`${header}.${claims}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${publicKey}`;
}

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, len: number): Buffer =>
  Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, len));

/** RFC 8291 加密：单条记录，内容后加 0x02 分隔符，不填充 */
export function encryptPayload(plaintext: Buffer, p256dh: string, auth: string): Buffer {
  const uaPublic = fromB64url(p256dh);
  const authSecret = fromB64url(auth);
  const ecdh = crypto.createECDH("prime256v1");
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hkdf(shared, authSecret, keyInfo, 32);
  const salt = crypto.randomBytes(16);
  const cek = hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// ---------- 订阅管理 ----------

function validSubscription(sub: unknown): sub is { endpoint: string; keys: { p256dh: string; auth: string } } {
  const s = sub as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof s?.endpoint !== "string" || typeof s.keys?.p256dh !== "string" || typeof s.keys?.auth !== "string") return false;
  try {
    const url = new URL(s.endpoint);
    // 只往 https 推：不然这个接口能被拿来让服务器去请求内网任意地址
    if (url.protocol !== "https:") return false;
  } catch {
    return false;
  }
  return fromB64url(s.keys.p256dh).length === 65 && fromB64url(s.keys.auth).length >= 16;
}

function describeUa(ua: string): string {
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Mac OS X/.test(ua) ? "Mac" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : "设备";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return browser ? `${device} · ${browser}` : device;
}

/** 同一个浏览器换了个账号登录再开通知：订阅归新账号 */
export function addSubscription(sub: unknown, userAgent: string, userId?: string): PushSubscriptionRecord {
  if (!validSubscription(sub)) throw new Error("订阅信息不完整");
  const s = load();
  const record: PushSubscriptionRecord = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    label: describeUa(userAgent),
    createdAt: Date.now(),
    ...(userId ? { userId } : {}),
  };
  s.subscriptions = [...s.subscriptions.filter((x) => x.endpoint !== sub.endpoint), record];
  persist();
  return record;
}

function validVapid(v: unknown): v is VapidKey {
  const key = v as { publicKey?: unknown; privateJwk?: crypto.JsonWebKey };
  const jwk = key?.privateJwk;
  if (typeof key?.publicKey !== "string" || !jwk || typeof jwk !== "object") return false;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.d !== "string" || typeof jwk.x !== "string" || typeof jwk.y !== "string") return false;
  try {
    crypto.createPrivateKey({ key: { kty: "EC", crv: "P-256", d: jwk.d, x: jwk.x, y: jwk.y }, format: "jwk" });
  } catch {
    return false;
  }
  return b64url(rawPublicKey(jwk)) === key.publicKey;
}

const clip = (v: unknown, max: number) => [...String(v ?? "").trim()].slice(0, max).join("");

/**
 * 外壳转来的订阅（多服务器）。embedders：这台允许谁嵌，外壳得在里面 —— 订阅只能是嵌着这台的
 * 外壳转来的，别的地址的不收。同一个订阅地址再转一次就换掉旧的（换了账号登录也是这样归新账号）
 */
export function addRelaySubscription(
  input: { subscription?: unknown; vapid?: unknown; via?: unknown },
  userAgent: string,
  userId: string,
  embedders: string[],
): PushSubscriptionRecord {
  const sub = input.subscription;
  if (!validSubscription(sub)) throw new Error("订阅信息不完整");
  if (!validVapid(input.vapid)) throw new Error("推送密钥不对");
  const via = (input.via ?? {}) as { origin?: unknown; server?: unknown; label?: unknown };
  const origin = String(via.origin ?? "");
  if (!embedders.includes(origin)) throw new Error(`这台没有允许 ${origin || "这个地址"} 嵌入，收不了它转来的通知订阅`);
  const server = String(via.server ?? "");
  if (!validServerId(server)) throw new Error("订阅信息不完整");
  const { publicKey, privateJwk } = input.vapid;
  const s = load();
  const record: PushSubscriptionRecord = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    label: `${describeUa(userAgent)} · 经 ${new URL(origin).host}`,
    createdAt: Date.now(),
    userId,
    relay: {
      vapid: { publicKey, privateJwk: { kty: "EC", crv: "P-256", d: privateJwk.d, x: privateJwk.x, y: privateJwk.y } },
      origin,
      server,
      label: clip(via.label, 60),
    },
  };
  s.subscriptions = [...s.subscriptions.filter((x) => x.endpoint !== sub.endpoint), record];
  persist();
  return record;
}

export function removeSubscription(endpoint: string, mine?: OwnerFilter): boolean {
  const s = load();
  const before = s.subscriptions.length;
  s.subscriptions = s.subscriptions.filter((x) => x.endpoint !== endpoint || (mine && !mine(x.userId)));
  if (s.subscriptions.length === before) return false;
  persist();
  return true;
}

/** 给设置页看的：不带密钥 */
export function listSubscriptions(mine?: OwnerFilter): { endpoint: string; label: string; createdAt: number; lastOkAt?: number }[] {
  return load().subscriptions.filter((x) => !mine || mine(x.userId)).map(({ endpoint, label, createdAt, lastOkAt }) => ({
    endpoint,
    label,
    createdAt,
    ...(lastOkAt ? { lastOkAt } : {}),
  }));
}

export function hasSubscriptions(): boolean {
  return load().subscriptions.length > 0;
}

// ---------- 发送 ----------

const prefixed = (label: string, title: string) => (label ? `${label} · ${title}` : title);

/**
 * 真正推出去的内容。加了别的服务器（这台是外壳）时标题前面带上这台的名字，好分清是哪台的；
 * 外壳转来的订阅带上外壳列表里这台的名字，tag 加上这台的 id（各台的会话 key 可能撞上），
 * 点开的地址带上 srv=这台的 id
 */
export function payloadFor(sub: PushSubscriptionRecord, payload: PushPayload): PushPayload {
  const relay = sub.relay;
  if (!relay) {
    const servers = config().servers;
    if (!servers.list.length) return payload;
    return { ...payload, title: prefixed(`${servers.selfIcon} ${selfName(servers)}`.trim(), payload.title) };
  }
  const url = new URL(payload.url ?? "/", "http://relay");
  url.searchParams.set("srv", relay.server);
  return {
    ...payload,
    title: prefixed(relay.label, payload.title),
    ...(payload.tag ? { tag: `srv:${relay.server}:${payload.tag}` } : {}),
    url: `${url.pathname}${url.search}${url.hash}`,
  };
}

async function sendOne(sub: PushSubscriptionRecord, payload: PushPayload): Promise<boolean> {
  const body = encryptPayload(Buffer.from(JSON.stringify(payloadFor(sub, payload))), sub.keys.p256dh, sub.keys.auth);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: vapidHeader(sub.endpoint, sub.relay?.vapid),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(24 * 3600),
      Urgency: "high",
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404 || res.status === 410) {
    // 订阅失效了（用户关了通知、删了 PWA）：清掉，别一直推
    removeSubscription(sub.endpoint);
    console.warn(`[push] 订阅已失效，已移除：${sub.label}`);
    return false;
  }
  if (!res.ok) {
    console.error(`[push] 推送失败（${sub.label}）：${res.status} ${await res.text().catch(() => "")}`);
    return false;
  }
  sub.lastOkAt = Date.now();
  return true;
}

/** 某个用户的订阅全部删掉（删用户时） */
export function removeSubscriptionsOf(mine: OwnerFilter): void {
  const s = load();
  const before = s.subscriptions.length;
  s.subscriptions = s.subscriptions.filter((x) => !mine(x.userId));
  if (s.subscriptions.length !== before) persist();
}

/** 按主人和设备筛选订阅，返回成功的数量。单个设备失败不影响别的。 */
export async function pushToAll(payload: PushPayload, to?: OwnerFilter, device?: (endpoint: string, userId: string | undefined) => boolean): Promise<number> {
  const subs = load().subscriptions.filter((x) => (!to || to(x.userId)) && (!device || device(x.endpoint, x.userId)));
  if (subs.length === 0) return 0;
  const results = await Promise.all(
    subs.map((sub) =>
      sendOne(sub, payload).catch((err) => {
        console.error(`[push] 推送出错（${sub.label}）：`, err instanceof Error ? err.message : err);
        return false;
      }),
    ),
  );
  if (results.some(Boolean)) persist();
  return results.filter(Boolean).length;
}
