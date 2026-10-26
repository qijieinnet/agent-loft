import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

process.env.AGENT_LOFT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aim-servers-api-"));
const { config, loadConfig, saveConfig } = await import("../src/core/config.js");
const { createUser } = await import("../src/core/users.js");
const { startWeb, stopWeb } = await import("../src/channels/web/server.js");
loadConfig();

test("多服务器的真实 HTTP 接口、登录隔离和页面安全头", { timeout: 20000 }, async (t) => {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((err) => err ? reject(err) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  saveConfig({ ...structuredClone(config()), web: { ...config().web, host: "127.0.0.1", port, quotaEnabled: false } });
  createUser({ name: "admin", password: "password-1", role: "admin" });
  createUser({ name: "alice", password: "password-2" });
  createUser({ name: "bob", password: "password-3" });
  await startWeb();
  t.after(() => stopWeb());
  async function login(name: string, password: string): Promise<string> {
    const res = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ name, password }) });
    assert.equal(res.status, 200);
    return res.headers.get("set-cookie")!.split(";")[0]!;
  }
  const admin = await login("admin", "password-1");
  const alice = await login("alice", "password-2");
  const bob = await login("bob", "password-3");
  const call = (url: string, cookie = "", body?: unknown, origin = base) => fetch(`${base}${url}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const put = (cookie: string, body: unknown, origin = base) => fetch(`${base}/api/config`, {
    method: "PUT", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const json = async <T>(response: Promise<Response>): Promise<T> => (await (await response).json()) as T;
  const subscriptions = (cookie: string) => json<{ subscriptions: unknown[] }>(call("/api/push", cookie));

  await t.test("未登录不能获取密钥，成员不能修改服务器列表，跨站写请求被拒绝", async () => {
    assert.equal((await call("/api/push/relay-key")).status, 401);
    assert.equal((await call("/api/push/relay-key", admin)).status, 404);
    assert.equal((await put(alice, { servers: { list: [] } })).status, 403);
    assert.equal((await put(admin, { servers: { list: [] } }, "https://untrusted.example")).status, 403);
    assert.equal((await put(admin, { servers: { list: [{ url: base }] } })).status, 400);
  });

  await t.test("HTML 随嵌入授权更新 CSP，禁嵌时带 DENY，HTML 不使用旧的 304", async () => {
    const before = await fetch(base);
    assert.equal(before.headers.get("x-frame-options"), "DENY");
    assert.match(before.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    const modified = before.headers.get("last-modified")!;
    await before.arrayBuffer();
    const update = await put(admin, { servers: { list: [{ name: "NAS", url: "https://nas.example.com" }], embedders: ["https://host.example.com"] } });
    assert.equal(update.status, 200);
    const page = await fetch(base, { headers: { "If-Modified-Since": modified } });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("x-frame-options"), null);
    assert.match(page.headers.get("content-security-policy")!, /frame-src 'self' https:\/\/nas.example.com;/);
    assert.match(page.headers.get("content-security-policy")!, /frame-ancestors https:\/\/host.example.com;/);
    await page.arrayBuffer();
    const bootstrap = await json<{ servers: { self: { id: string }; list: { name: string }[] } }>(call("/api/bootstrap", alice));
    assert.equal(bootstrap.servers.list[0]!.name, "NAS");
    assert.equal(bootstrap.servers.self.id, "home");
  });

  await t.test("通知订阅按账号隔离；撤销嵌入授权立即撤销订阅并拒绝重新注册", async () => {
    const vapid = await (await call("/api/push/relay-key", alice)).json();
    const ua = crypto.createECDH("prime256v1");
    ua.generateKeys();
    const subscription = { endpoint: "https://web.push.apple.com/test", keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") } };
    const body = { subscription, vapid, via: { origin: "https://host.example.com", server: "s1", label: "NAS" } };
    assert.equal((await call("/api/push/relay", alice, { ...body, via: { ...body.via, origin: "https://untrusted.example" } })).status, 400);
    assert.equal((await call("/api/push/relay", alice, body)).status, 200);
    assert.equal((await subscriptions(alice)).subscriptions.length, 1);
    assert.equal((await subscriptions(bob)).subscriptions.length, 0);
    assert.equal((await json<{ ok: boolean }>(call("/api/push/unsubscribe", bob, { endpoint: subscription.endpoint }))).ok, false);
    assert.equal((await subscriptions(alice)).subscriptions.length, 1);
    assert.equal((await put(admin, { servers: { embedders: [] } })).status, 200);
    assert.equal((await subscriptions(alice)).subscriptions.length, 0);
    assert.equal((await call("/api/push/relay", alice, body)).status, 400);
    assert.equal((await fetch(base)).headers.get("x-frame-options"), "DENY");
  });
});
