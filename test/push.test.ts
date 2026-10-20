import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.IM_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aim-push-"));
const push = await import("../src/channels/web/push.js");

/** 按 RFC 8291 以浏览器（UA）身份解密，验证我们的加密是对的 */
function decryptAsBrowser(body: Buffer, uaEcdh: crypto.ECDH, authSecret: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  assert.equal(rs, 4096);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const shared = uaEcdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaEcdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  assert.equal(padded[padded.length - 1], 2, "最后一条记录要以 0x02 结尾");
  return padded.subarray(0, padded.length - 1);
}

test("推送内容加密：浏览器能解开", () => {
  const ua = crypto.createECDH("prime256v1");
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const msg = Buffer.from(JSON.stringify({ title: "回复完成", body: "你好 👋" }));
  const body = push.encryptPayload(msg, push.b64url(ua.getPublicKey()), push.b64url(auth));
  assert.deepEqual(decryptAsBrowser(body, ua, auth), msg);
});

test("VAPID：JWT 用公布的公钥能验签，aud 是推送服务的 origin", () => {
  const header = push.vapidHeader("https://web.push.apple.com/abc/def");
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
  assert.ok(m);
  const [, h, c, sig, k] = m;
  assert.equal(k, push.vapidPublicKey());
  const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
  assert.equal(claims.aud, "https://web.push.apple.com");
  assert.ok(claims.exp > Date.now() / 1000);
  assert.match(claims.sub, /^(mailto:|https:)/);
  const raw = Buffer.from(k!, "base64url");
  const key = crypto.createPublicKey({
    key: { kty: "EC", crv: "P-256", x: push.b64url(raw.subarray(1, 33)), y: push.b64url(raw.subarray(33)) },
    format: "jwk",
  });
  assert.ok(crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig!, "base64url")));
});

test("订阅：校验格式，只收 https，重复订阅不重复记", () => {
  const ua = crypto.createECDH("prime256v1");
  ua.generateKeys();
  const keys = { p256dh: push.b64url(ua.getPublicKey()), auth: push.b64url(crypto.randomBytes(16)) };
  assert.throws(() => push.addSubscription({ endpoint: "http://10.0.0.1/x", keys }, ""));
  assert.throws(() => push.addSubscription({ endpoint: "https://x" }, ""));
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  assert.equal(push.addSubscription({ endpoint: "https://web.push.apple.com/a", keys }, iphone).label, "iPhone · Safari");
  push.addSubscription({ endpoint: "https://web.push.apple.com/a", keys }, iphone);
  assert.equal(push.listSubscriptions().length, 1);
  assert.equal("keys" in push.listSubscriptions()[0]!, false, "列表里不带密钥");
  assert.equal(push.removeSubscription("https://web.push.apple.com/a"), true);
  assert.equal(push.hasSubscriptions(), false);
});
