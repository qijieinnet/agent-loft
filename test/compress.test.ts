import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

process.env.AGENT_LOFT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aim-compress-"));
const { config, loadConfig, saveConfig } = await import("../src/core/config.js");
const { createUser } = await import("../src/core/users.js");
const { startWeb, stopWeb } = await import("../src/channels/web/server.js");
const { pickEncoding } = await import("../src/channels/web/compress.js");
loadConfig();

test("Accept-Encoding：br 优先，其次 gzip，q=0 不要", () => {
  assert.equal(pickEncoding({ "accept-encoding": "gzip, deflate, br, zstd" }), "br");
  assert.equal(pickEncoding({ "accept-encoding": "gzip, deflate" }), "gzip");
  assert.equal(pickEncoding({ "accept-encoding": "br;q=0, gzip;q=0.5" }), "gzip");
  assert.equal(pickEncoding({ "accept-encoding": "*" }), "br");
  assert.equal(pickEncoding({ "accept-encoding": "*, br;q=0" }), "gzip");
  assert.equal(pickEncoding({ "accept-encoding": "identity" }), undefined);
  assert.equal(pickEncoding({}), undefined);
});

type Raw = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

function get(base: string, url: string, headers: Record<string, string> = {}): Promise<Raw> {
  // 不用 fetch：它会自己解压、藏掉 Content-Encoding
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

function decode(r: Raw): Buffer {
  const enc = r.headers["content-encoding"];
  if (enc === "br") return zlib.brotliDecompressSync(r.body);
  if (enc === "gzip") return zlib.gunzipSync(r.body);
  return r.body;
}

test("静态文件和接口 JSON 按需压缩", { timeout: 20000 }, async (t) => {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())));
  const base = `http://127.0.0.1:${port}`;
  saveConfig({ ...structuredClone(config()), web: { ...config().web, host: "127.0.0.1", port, quotaEnabled: false } });
  createUser({ name: "admin", password: "password-1", role: "admin" });
  for (let i = 0; i < 30; i++) createUser({ name: `member-${i}`, password: "password-1" });
  await startWeb();
  t.after(() => stopWeb());

  const source = fs.readFileSync(new URL("../web/views/messages.js", import.meta.url));

  await t.test("js：br / gzip / 不收压缩，内容都一样，都带 Vary", async () => {
    for (const [accept, enc] of [["gzip, deflate, br", "br"], ["gzip", "gzip"], ["identity", undefined]] as const) {
      const r = await get(base, "/views/messages.js", { "Accept-Encoding": accept });
      assert.equal(r.status, 200);
      assert.equal(r.headers["content-encoding"], enc, accept);
      assert.equal(r.headers.vary, "Accept-Encoding");
      assert.equal(Number(r.headers["content-length"]), r.body.length);
      assert.deepEqual(decode(r), source);
      if (enc) assert.ok(r.body.length < source.length / 2, "确实变小了");
    }
    // 第二次走内存里压好的，结果一样
    const again = await get(base, "/views/messages.js", { "Accept-Encoding": "br" });
    assert.deepEqual(decode(again), source);
  });

  await t.test("vendor 也压；304 照旧", async () => {
    const r = await get(base, "/vendor/marked.js", { "Accept-Encoding": "gzip" });
    assert.equal(r.headers["content-encoding"], "gzip");
    const lastModified = r.headers["last-modified"]!;
    const cached = await get(base, "/vendor/marked.js", { "Accept-Encoding": "gzip", "If-Modified-Since": lastModified });
    assert.equal(cached.status, 304);
    assert.equal(cached.body.length, 0);
  });

  await t.test("图片、太小的文件不压", async () => {
    const png = await get(base, "/apple-touch-icon.png", { "Accept-Encoding": "br, gzip" });
    assert.equal(png.status, 200);
    assert.equal(png.headers["content-encoding"], undefined);
    assert.equal(png.headers.vary, undefined);
    const small = await get(base, "/manifest.webmanifest", { "Accept-Encoding": "br, gzip" });
    assert.equal(small.headers["content-encoding"], undefined);
  });

  await t.test("接口 JSON：大的压，小的不压", async () => {
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ name: "admin", password: "password-1" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const big = await get(base, "/api/users", { Cookie: cookie, "Accept-Encoding": "gzip" });
    assert.equal(big.status, 200);
    assert.ok(decode(big).length >= 1024, "用户列表够大");
    assert.equal(big.headers["content-encoding"], "gzip");
    assert.ok(JSON.parse(decode(big).toString()));
    const plain = await get(base, "/api/users", { Cookie: cookie });
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.deepEqual(JSON.parse(plain.body.toString()), JSON.parse(decode(big).toString()));
    const small = await get(base, "/api/me", { "Accept-Encoding": "gzip" });
    assert.equal(small.headers["content-encoding"], undefined);
  });
});
