import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type { AgentDriver } from "../src/core/types.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-assets-"));
process.env.AGENT_LOFT_HOME = home;
const { config, loadConfig, saveConfig } = await import("../src/core/config.js");
const { hub } = await import("../src/core/hub.js");
const { createUser } = await import("../src/core/users.js");
const { createSession } = await import("../src/channels/web/auth.js");
const { startWeb, stopWeb } = await import("../src/channels/web/server.js");
const { assetToken, parseVersioned, stampIndex } = await import("../src/channels/web/assets.js");
loadConfig();

const webRoot = new URL("../web/", import.meta.url);
const IMMUTABLE = "max-age=31536000, immutable";

test("页面地址：样式和入口带指纹，地址要稳定的不动", () => {
  const html = `<link rel="manifest" href="/manifest.webmanifest" /><link rel="icon" href="/icon.svg" />
    <link rel="stylesheet" href="/vendor/hljs-light.css" /><link rel="stylesheet" href="/css/base.css" />
    <script type="module" src="/app.js"></script>`;
  const out = stampIndex(html, "abc123abc123");
  assert.ok(out.includes('href="/v/abc123abc123/vendor/hljs-light.css"'));
  assert.ok(out.includes('href="/v/abc123abc123/css/base.css"'));
  assert.ok(out.includes('src="/v/abc123abc123/app.js"'));
  assert.ok(out.includes('href="/manifest.webmanifest"'));
  assert.ok(out.includes('href="/icon.svg"'));
});

test("带指纹的地址：只认 12 位十六进制", () => {
  assert.deepEqual(parseVersioned("/v/abc123abc123/views/a.js"), { token: "abc123abc123", pathname: "/views/a.js" });
  assert.equal(parseVersioned("/v/short/views/a.js"), undefined);
  assert.equal(parseVersioned("/views/a.js"), undefined);
});

test("指纹跟着文件和版本变，没变就不变", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aim-token-"));
  fs.mkdirSync(path.join(dir, "views"));
  const file = path.join(dir, "views", "a.js");
  const extra = path.join(dir, "vendor.js");
  fs.writeFileSync(file, "1");
  fs.writeFileSync(extra, "1");
  const token = await assetToken("1.0.0", dir, [extra]);
  assert.match(token, /^[0-9a-f]{12}$/);
  assert.equal(await assetToken("1.0.0", dir, [extra]), token, "没变");
  assert.notEqual(await assetToken("1.0.1", dir, [extra]), token, "升级");
  fs.writeFileSync(file, "22");
  const edited = await assetToken("1.0.0", dir, [extra]);
  assert.notEqual(edited, token, "前端文件改了");
  fs.writeFileSync(extra, "22");
  assert.notEqual(await assetToken("1.0.0", dir, [extra]), edited, "vendor 改了");
  fs.rmSync(extra);
  await assetToken("1.0.0", dir, [extra]); // vendor 文件没了也不报错
});

test("前端模块不用绝对路径 import vendor：会跳出带指纹的地址，同一个模块还会被加载两份", () => {
  const offenders: string[] = [];
  for (const entry of fs.readdirSync(webRoot, { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".js")) continue;
    const source = fs.readFileSync(new URL(entry, webRoot), "utf8");
    if (/(?:\bfrom\s+|\bimport\s*\(?\s*)["']\/|["']\/vendor\//.test(source)) offenders.push(entry);
  }
  assert.deepEqual(offenders, []);
});

type Raw = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

function get(base: string, url: string, headers: Record<string, string> = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    http
      .get(`${base}${url}`, { headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      })
      .on("error", reject);
  });
}

test("静态文件的缓存策略和接口耗时", { timeout: 20000 }, async (t) => {
  const driver: AgentDriver = {
    id: "claude", label: "Fake", capabilities: { effort: false, fork: false, cost: false, streaming: false },
    start: async () => {}, stop: async () => {},
    createSession: () => { throw new Error("不应该启动会话"); },
    readHistory: async () => [],
    listSessions: async () => [], sessionExists: async () => true, listModels: async () => [], catalog: async () => [], defaults: async () => ({}), statusLines: async () => [],
    diagnose: () => ({ kind: "test", chatMessage: "test", consoleHint: "" }),
  };
  hub.registerDriver(driver);
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())));
  const base = `http://127.0.0.1:${port}`;
  saveConfig({ ...structuredClone(config()), web: { ...config().web, host: "127.0.0.1", port, quotaEnabled: false } });
  const admin = createUser({ name: "admin", password: "password-1", role: "admin" });
  await startWeb();
  t.after(() => stopWeb());

  const page = await get(base, "/");
  const html = page.body.toString();
  const token = /src="\/v\/([0-9a-f]{12})\/app\.js"/.exec(html)?.[1];
  assert.ok(token, "入口带指纹");
  const source = fs.readFileSync(new URL("views/messages.js", webRoot));

  await t.test("页面：地址都带指纹，每次都重新拿，不回 304", async () => {
    assert.equal(page.status, 200);
    assert.equal(page.headers["cache-control"], "no-cache");
    assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
    assert.ok(page.headers["content-security-policy"], "页面带 CSP");
    assert.ok(!/href="\/(css|vendor)\//.test(html), "没有漏掉的样式");
    const again = await get(base, "/", { "If-Modified-Since": new Date(Date.now() + 86400_000).toUTCString() });
    assert.equal(again.status, 200);
    const br = await get(base, "/some/spa/path", { "Accept-Encoding": "br" });
    assert.equal(br.headers["content-encoding"], "br");
    assert.equal(zlib.brotliDecompressSync(br.body).toString(), html, "单页应用路径和压缩都是同一份");
  });

  await t.test("带最新指纹的资源长缓存，内容和老地址一样", async () => {
    for (const asset of ["/views/messages.js", "/css/base.css", "/vendor/marked.js", "/vendor/hljs-light.css", "/vendor/novnc/core/rfb.js"]) {
      const r = await get(base, `/v/${token}${asset}`);
      assert.equal(r.status, 200, asset);
      assert.equal(r.headers["cache-control"], IMMUTABLE, asset);
      assert.deepEqual(r.body, (await get(base, asset)).body, asset);
    }
    const compressed = await get(base, `/v/${token}/views/messages.js`, { "Accept-Encoding": "gzip" });
    assert.equal(compressed.headers["content-encoding"], "gzip");
    assert.deepEqual(zlib.gunzipSync(compressed.body), source);
  });

  await t.test("不带指纹的老地址、过期的指纹：给内容但不让长缓存", async () => {
    assert.equal((await get(base, "/views/messages.js")).headers["cache-control"], "no-cache");
    const stale = await get(base, "/v/000000000000/views/messages.js");
    assert.equal(stale.status, 200);
    assert.equal(stale.headers["cache-control"], "no-cache");
    assert.deepEqual(stale.body, source);
  });

  await t.test("带指纹的地址不回退到页面，也出不了前端目录", async () => {
    assert.equal((await get(base, `/v/${token}/settings`)).status, 404);
    assert.equal((await get(base, `/v/${token}/index.html`)).status, 404);
    assert.equal((await get(base, `/v/${token}/not-there.js`)).status, 404);
    assert.equal((await get(base, `/v/${token}/..%2f..%2fpackage.json`)).status, 403);
    assert.equal((await get(base, `/v/${token}/vendor/novnc/package.json`)).status, 404);
  });

  await t.test("首屏接口带上 Server-Timing", async () => {
    const cookie = `aim_session=${createSession(admin.id, "127.0.0.1", "test")}`;
    const bootstrap = await get(base, "/api/bootstrap", { Cookie: cookie });
    assert.equal(bootstrap.status, 200);
    assert.match(String(bootstrap.headers["server-timing"]), /^titles;dur=[\d.]+, total;dur=[\d.]+$/);
    const key = "web:timing";
    hub.ensure({ key, channel: "web", channelId: admin.id, defaultAgent: "claude", owner: admin.id });
    const history = await get(base, `/api/conversations/${encodeURIComponent(key)}/history`, { Cookie: cookie });
    assert.equal(history.status, 200);
    assert.match(String(history.headers["server-timing"]), /^read;dur=[\d.]+, total;dur=[\d.]+$/);
  });
});
