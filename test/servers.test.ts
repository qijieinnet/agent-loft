import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_LOFT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aim-servers-"));
const servers = await import("../src/core/servers.js");
const { config, loadConfig, saveConfig } = await import("../src/core/config.js");
const push = await import("../src/channels/web/push.js");
loadConfig();

const empty = { selfName: "", selfIcon: "", list: [], embedders: [] };

test("地址规范成 origin：补 https，去掉末尾斜杠，带路径、账号、别的协议的不收", () => {
  assert.equal(servers.normalizeOrigin("nas.example.com"), "https://nas.example.com");
  assert.equal(servers.normalizeOrigin(" https://NAS.example.com/ "), "https://nas.example.com");
  assert.equal(servers.normalizeOrigin("http://localhost:8800"), "http://localhost:8800");
  assert.equal(servers.normalizeOrigin("https://a.example.com:443"), "https://a.example.com");
  assert.throws(() => servers.normalizeOrigin(""));
  assert.throws(() => servers.normalizeOrigin("https://a.example.com/loft"), /子路径/);
  assert.throws(() => servers.normalizeOrigin("https://u:p@a.example.com"), /账号密码/);
  assert.throws(() => servers.normalizeOrigin("ftp://a.example.com"), /http/);
  assert.throws(() => servers.normalizeOrigin("javascript:alert(1)"));
});

test("服务器列表：新加的生成 id，老的保留 id，自己和重复的不收", () => {
  const first = servers.cleanServers({ list: [{ name: "NAS", icon: "🗄️", url: "nas.example.com" }] }, empty);
  assert.equal(first.list.length, 1);
  const id = first.list[0]!.id;
  assert.match(id, /^[0-9a-f]{8}$/);
  assert.notEqual(id, servers.SELF_ID);
  assert.equal(first.list[0]!.url, "https://nas.example.com");

  const second = servers.cleanServers(
    { list: [{ name: "Mac", url: "https://mac.example.com" }, { id, name: "NAS 2", icon: "🗄️", url: "https://nas.example.com" }] },
    first,
  );
  assert.deepEqual(second.list.map((s) => s.url), ["https://mac.example.com", "https://nas.example.com"]);
  assert.equal(second.list[1]!.id, id, "老的 id 不变");
  assert.equal(second.list[1]!.name, "NAS 2");
  assert.equal(second.list[0]!.name, "Mac");

  // 不认识的 id（手改、伪造）当新的
  const forged = servers.cleanServers({ list: [{ id: "home", url: "https://x.example.com" }] }, empty);
  assert.notEqual(forged.list[0]!.id, "home");
  // 没填名字用主机名的第一段
  assert.equal(servers.cleanServers({ list: [{ url: "https://box.example.com" }] }, empty).list[0]!.name, "box");

  assert.throws(() => servers.cleanServers({ list: [{ url: "https://a.example.com" }, { url: "https://a.example.com/" }] }, empty), /两次/);
  assert.throws(() => servers.cleanServers({ list: [{ url: "https://me.example.com" }] }, empty, "https://me.example.com"), /自己/);
  assert.throws(() => servers.cleanServers({ list: "x" }, empty));
  assert.throws(() => servers.cleanServers({ list: Array.from({ length: 13 }, (_, i) => ({ url: `https://s${i}.example.com` })) }, empty), /最多/);
});

test("只改其中一项时别的照旧；允许嵌入的地址去重", () => {
  const base = servers.cleanServers({ selfName: "Mac", list: [{ url: "https://nas.example.com" }] }, empty);
  const next = servers.cleanServers({ embedders: ["https://loft.example.com", "loft.example.com/"] }, base);
  assert.deepEqual(next.embedders, ["https://loft.example.com"]);
  assert.equal(next.selfName, "Mac");
  assert.deepEqual(next.list, base.list);
  assert.throws(() => servers.cleanServers({ embedders: ["https://a.example.com/x"] }, base));
});

test("页面的 CSP：只嵌列表里的，只让 embedders 嵌；没有就谁都不行", () => {
  const none = servers.pageCsp(empty);
  assert.match(none, /frame-src 'self';/);
  assert.match(none, /frame-ancestors 'none'/);
  const cfg = { ...empty, list: [{ id: "a", name: "", icon: "", url: "https://nas.example.com" }], embedders: ["https://loft.example.com"] };
  const csp = servers.pageCsp(cfg);
  assert.match(csp, /frame-src 'self' https:\/\/nas\.example\.com;/);
  assert.match(csp, /frame-ancestors https:\/\/loft\.example\.com;/);
  assert.equal(servers.ownFrameAncestors(cfg), "'self' https://loft.example.com");
  assert.equal(servers.shellInfo(empty), null);
  assert.deepEqual(servers.shellInfo(cfg)!.list, [{ id: "a", name: "", icon: "", url: "https://nas.example.com" }]);
  assert.equal(servers.shellInfo(cfg)!.self.id, "home");
});

test("配置里的坏地址（手改的）：规范成 origin，坏的、重复的丢掉", () => {
  saveConfig({
    ...structuredClone(config()),
    servers: {
      selfName: "",
      selfIcon: "",
      list: [
        { id: "x1", name: "A", icon: "", url: "https://a.example.com/" },
        { id: "x2", name: "A again", icon: "", url: "https://a.example.com" },
        { id: "x3", name: "bad", icon: "", url: "https://b.example.com/sub" },
        { id: "", name: "no id", icon: "", url: "https://c.example.com" },
      ],
      embedders: ["https://d.example.com/", "not a url ::"],
    },
  });
  assert.deepEqual(config().servers.list.map((s) => [s.id, s.url]), [["x1", "https://a.example.com"]]);
  assert.deepEqual(config().servers.embedders, ["https://d.example.com"]);
});

test("配置里的服务器 id 不能重复、冒充本机或超出通知允许的格式", () => {
  saveConfig({
    ...structuredClone(config()),
    servers: {
      ...empty,
      list: [
        { id: "x1", name: "A", icon: "", url: "https://a.example.com" },
        { id: "x1", name: "B", icon: "", url: "https://b.example.com" },
        { id: "home", name: "C", icon: "", url: "https://c.example.com" },
        { id: "bad/id", name: "D", icon: "", url: "https://d.example.com" },
      ],
    },
  });
  assert.deepEqual(config().servers.list.map((s) => s.id), ["x1"]);
});

function subscription() {
  const ua = crypto.createECDH("prime256v1");
  ua.generateKeys();
  return { endpoint: `https://web.push.apple.com/${crypto.randomBytes(4).toString("hex")}`, keys: { p256dh: push.b64url(ua.getPublicKey()), auth: push.b64url(crypto.randomBytes(16)) } };
}

test("外壳转来的订阅：要是允许嵌入的地址、密钥要对得上，同一个订阅再转一次就换掉", () => {
  const vapid = push.vapidKeyPair();
  const sub = subscription();
  const via = { origin: "https://loft.example.com", server: "a1b2c3d4", label: "🗄️ NAS" };
  const embedders = ["https://loft.example.com"];
  assert.throws(() => push.addRelaySubscription({ subscription: sub, vapid, via }, "", "u1", []), /没有允许/);
  assert.throws(() => push.addRelaySubscription({ subscription: sub, vapid: { ...vapid, publicKey: "AAAA" }, via }, "", "u1", embedders), /密钥/);
  assert.throws(() => push.addRelaySubscription({ subscription: sub, vapid, via: { ...via, server: "../x" } }, "", "u1", embedders));
  const other = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" });
  assert.throws(() => push.addRelaySubscription({ subscription: sub, vapid: { ...vapid, privateJwk: other } }, "", "u1", embedders), /密钥/);

  const record = push.addRelaySubscription({ subscription: sub, vapid, via }, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1", "u1", embedders);
  assert.equal(record.label, "iPhone · Safari · 经 loft.example.com");
  push.addRelaySubscription({ subscription: sub, vapid, via }, "", "u2", embedders);
  const mine = push.listSubscriptions((owner) => owner === "u2");
  assert.equal(mine.length, 1, "换了账号再转：归新账号");
  assert.equal(push.listSubscriptions((owner) => owner === "u1").length, 0);
  assert.equal(JSON.stringify(push.listSubscriptions()).includes(String(vapid.privateJwk.d)), false, "列表里不带密钥");
  push.removeSubscription(sub.endpoint);
});

test("推出去的内容：转来的订阅带上这台的名字、srv 和带前缀的 tag，用外壳的密钥签名", () => {
  const vapid = push.vapidKeyPair();
  const relay = { vapid, origin: "https://loft.example.com", server: "a1b2c3d4", label: "🗄️ NAS" };
  const record = { ...subscription(), label: "", createdAt: 0, relay };
  const out = push.payloadFor(record, { title: "对话 · 回复完成", body: "好了", tag: "reply:web:1", url: "/#web%3A1" });
  assert.equal(out.title, "🗄️ NAS · 对话 · 回复完成");
  assert.equal(out.tag, "srv:a1b2c3d4:reply:web:1");
  assert.equal(out.url, "/?srv=a1b2c3d4#web%3A1");
  assert.equal(push.payloadFor(record, { title: "t", body: "" }).url, "/?srv=a1b2c3d4");

  // 这台自己的订阅：加了别的服务器时标题带上这台的名字，没加时原样
  const own = { ...subscription(), label: "", createdAt: 0 };
  saveConfig({ ...structuredClone(config()), servers: { selfName: "Mac", selfIcon: "💻", list: [], embedders: [] } });
  assert.equal(push.payloadFor(own, { title: "t", body: "" }).title, "t");
  saveConfig({
    ...structuredClone(config()),
    servers: { selfName: "Mac", selfIcon: "💻", list: [{ id: "x1", name: "NAS", icon: "", url: "https://nas.example.com" }], embedders: [] },
  });
  assert.equal(push.payloadFor(own, { title: "t", body: "" }).title, "💻 Mac · t");

  // 签名：用传进来的那把密钥，k= 是它的公钥
  const other = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" });
  const key = { publicKey: push.b64url(Buffer.concat([Buffer.from([4]), Buffer.from(other.x!, "base64url"), Buffer.from(other.y!, "base64url")])), privateJwk: other };
  const header = push.vapidHeader("https://web.push.apple.com/x", key);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
  assert.equal(m[4], key.publicKey);
  const pub = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: other.x, y: other.y }, format: "jwk" });
  assert.ok(crypto.verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3]!, "base64url")));
});

test("撤销嵌入授权立即清掉该地址的转发订阅，保留本机和仍获授权的订阅", async () => {
  const vapid = push.vapidKeyPair();
  const a = "https://a.example.com";
  const b = "https://b.example.com";
  const own = subscription();
  const first = subscription();
  const second = subscription();
  saveConfig({ ...structuredClone(config()), servers: { ...empty, embedders: [a, b] } });
  push.addSubscription(own, "", "u1");
  push.addRelaySubscription({ subscription: first, vapid, via: { origin: a, server: "s1" } }, "", "u1", [a, b]);
  push.addRelaySubscription({ subscription: second, vapid, via: { origin: b, server: "s2" } }, "", "u1", [a, b]);
  saveConfig({ ...structuredClone(config()), servers: { ...empty, embedders: [b] } });
  assert.deepEqual(push.listSubscriptions().map((s) => s.endpoint).sort(), [own.endpoint, second.endpoint].sort());
  // 重启后读到旧文件中的订阅也不能绕过已经撤销的授权。
  const file = path.join(process.env.AGENT_LOFT_HOME!, "data", "push.json");
  const before = JSON.parse(fs.readFileSync(file, "utf8"));
  before.subscriptions.push({ ...first, label: "old", createdAt: 0, userId: "u1", relay: { vapid, origin: a, server: "s1", label: "A" } });
  fs.writeFileSync(file, JSON.stringify(before));
  push.resetPushStoreForTest();
  assert.equal(push.listSubscriptions().some((s) => s.endpoint === first.endpoint), false);
  push.removeSubscription(own.endpoint);
  push.removeSubscription(second.endpoint);
});
