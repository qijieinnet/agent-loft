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

export type PushSubscriptionRecord = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** 设备描述（User-Agent 摘要），设置页里认设备用 */
  label: string;
  createdAt: number;
  lastOkAt?: number;
};

export type PushPayload = {
  title: string;
  body: string;
  /** 同一 tag 的通知会互相替换，不在通知中心堆一串 */
  tag?: string;
  /** 点开通知后打开的地址 */
  url?: string;
};

type Store = {
  vapid?: { publicKey: string; privateJwk: crypto.JsonWebKey };
  subscriptions: PushSubscriptionRecord[];
};

const FILE = () => path.join(dataDir, "push.json");
/** VAPID 的 sub 声明：Apple 要求是 mailto: 或 https: 地址 */
const VAPID_SUBJECT = "https://github.com/qijieinnet/im-agent";

let store: Store | null = null;

function load(): Store {
  if (!store) {
    store = readJson<Store>(FILE(), { subscriptions: [] });
    if (!Array.isArray(store.subscriptions)) store.subscriptions = [];
  }
  return store;
}

function persist(): void {
  writeJsonAtomic(FILE(), load());
}

/** 测试用：换了 IM_AGENT_HOME 之后重新读 */
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

export function vapidHeader(endpoint: string): string {
  const { publicKey, privateKey } = vapid();
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

export function addSubscription(sub: unknown, userAgent: string): PushSubscriptionRecord {
  if (!validSubscription(sub)) throw new Error("订阅信息不完整");
  const s = load();
  const record: PushSubscriptionRecord = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    label: describeUa(userAgent),
    createdAt: Date.now(),
  };
  s.subscriptions = [...s.subscriptions.filter((x) => x.endpoint !== sub.endpoint), record];
  persist();
  return record;
}

export function removeSubscription(endpoint: string): boolean {
  const s = load();
  const before = s.subscriptions.length;
  s.subscriptions = s.subscriptions.filter((x) => x.endpoint !== endpoint);
  if (s.subscriptions.length === before) return false;
  persist();
  return true;
}

/** 给设置页看的：不带密钥 */
export function listSubscriptions(): { endpoint: string; label: string; createdAt: number; lastOkAt?: number }[] {
  return load().subscriptions.map(({ endpoint, label, createdAt, lastOkAt }) => ({
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

async function sendOne(sub: PushSubscriptionRecord, payload: PushPayload): Promise<boolean> {
  const body = encryptPayload(Buffer.from(JSON.stringify(payload)), sub.keys.p256dh, sub.keys.auth);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: vapidHeader(sub.endpoint),
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

/** 推给所有订阅的设备，返回成功的数量。单个设备失败不影响别的 */
export async function pushToAll(payload: PushPayload): Promise<number> {
  const subs = [...load().subscriptions];
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
