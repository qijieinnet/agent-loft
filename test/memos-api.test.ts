import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AddressInfo } from "node:net";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "loft-memos-"));
process.env.AGENT_LOFT_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
const { handleApi } = await import("../src/channels/web/api.js");
const { HttpError, sendJson } = await import("../src/channels/web/http.js");
const { createUser } = await import("../src/core/users.js");
const { createSession } = await import("../src/channels/web/auth.js");

async function listen(server: http.Server) {
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}

test("备忘录按账号接入 WebDAV 和 S3，目录、条件保存及图片直接写回相应数据源", async t => {

  const objects = new Map<string, Buffer>();
  const remote = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://local");
    const p = decodeURIComponent(url.pathname);
    if (p.startsWith("/dav/")) assert.equal(req.headers.authorization, "Basic " + Buffer.from("key:secret").toString("base64"));
    else {
      assert.match(req.headers.authorization ?? "", /^AWS4-HMAC-SHA256 Credential=key\/\d{8}\/us-east-1\/s3\/aws4_request,/);
      assert.ok(p.startsWith("/notes/"));
    }
    if (req.method === "PROPFIND") {
      assert.equal(req.headers.depth, "1");
      const paths = [...objects.keys()].filter(k => k.startsWith(p) && !k.slice(p.length).replace(/\/$/, "").includes("/"));
      res.writeHead(207).end('<D:multistatus xmlns:D="DAV:">' + paths.map(k =>
        '<D:response><D:href>' + encodeURI(k) + '</D:href><D:propstat><D:prop><D:resourcetype>' +
        (k.endsWith("/") ? "<D:collection/>" : "") + "</D:resourcetype></D:prop></D:propstat></D:response>").join("") + "</D:multistatus>");
    } else if (url.searchParams.has("list-type")) {
      const prefix = url.searchParams.get("prefix")!;
      const keys = [...objects.keys()].map(k => k.slice("/notes/".length)).filter(k => k.startsWith(prefix) && k !== prefix);
      res.end('<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' + keys.map(k => {
        const slash = k.indexOf("/", prefix.length);
        return slash < 0 ? "<Contents><Key>" + k + "</Key></Contents>" : "<CommonPrefixes><Prefix>" + k.slice(0, slash + 1) + "</Prefix></CommonPrefixes>";
      }).join("") + "</ListBucketResult>");
    } else if (req.method === "MKCOL") {
      if (objects.has(p)) return void res.writeHead(405).end();
      objects.set(p, Buffer.alloc(0));
      res.writeHead(201).end();
    } else {
      const old = objects.get(p);
      const tag = (bytes: Buffer) => '"' + createHash("md5").update(bytes).digest("hex") + '"';
      if (req.method === "PUT") {
        if ((old && req.headers["if-none-match"] === "*") || (req.headers["if-match"] && (!old || tag(old) !== req.headers["if-match"]))) return void res.writeHead(412).end();
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        objects.set(p, bytes);
        if (!p.startsWith("/dav/")) assert.equal(req.headers["x-amz-content-sha256"], createHash("sha256").update(bytes).digest("hex"));
        res.writeHead(201, p.startsWith("/dav/") ? {} : { etag: tag(bytes) }).end();
      } else if (old) res.writeHead(200, p.startsWith("/dav/") ? {} : { etag: tag(old) }).end(old);
      else res.writeHead(404).end();
    }
  });
  const endpoint = await listen(remote);
  t.after(() => remote.close());
  const server = http.createServer((req, res) => {
    handleApi(req, res, new URL(req.url!, "http://local")).catch(e => sendJson(res, e instanceof HttpError ? e.status : 500, { error: e.message }));
  });
  const base = await listen(server);
  t.after(() => server.close());
  const cookie = (role: "admin" | "member", name: string = role) => {
    const user = createUser({ name, password: "test-password", role });
    return "aim_session=" + createSession(user.id, "127.0.0.1", "memos-test");
  };
  const alice = cookie("admin"), bob = cookie("member"), other = cookie("admin", "editor");
  const request = (op: string, method = "GET", body?: unknown, who = alice) =>
    fetch(base + "/api/memos/" + op, { method, headers: { Cookie: who }, body: body instanceof Buffer ? body : JSON.stringify(body) });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZBoAAAAASUVORK5CYII=", "base64");
  assert.equal((await request("sources", "GET", undefined, "")).status, 401);
  for (const kind of ["webdav", "s3"]) {
    const config = { name: kind, kind, endpoint: endpoint + (kind === "webdav" ? "/dav/" : ""), username: "key", secret: "secret", region: "us-east-1", bucket: "notes", prefix: "private" };
    assert.equal((await request("sources", "POST", config, bob)).status, 403);
    const source = await (await request("sources", "POST", config)).json() as { id: string };
    assert.deepEqual(Object.keys(source).sort(), ["id", "kind", "name"]);
    const route = (action: string, path = "") => action + "?" + new URLSearchParams({ source: source.id, path });
    assert.equal((await request(route("tree"), "GET", undefined, bob)).status, 404);
    assert.equal((await request(route("file", "../x.md"))).status, 400);
    assert.equal((await request(route("folder", "日 记"), "POST")).status, 201);
    const file = "日 记/笔记 #1.md", fileRoute = route("file", file);
    const initial = { text: "# 正文\r\n", version: null };
    assert.equal((await request(fileRoute, "PUT", initial)).status, 200);
    assert.equal((await request(fileRoute, "PUT", initial)).status, 409);
    const root = await (await request(route("tree"))).json() as { entries: { name: string; directory: boolean }[] };
    assert.ok(root.entries.some(x => x.name === "日 记" && x.directory));
    const original = await (await request(fileRoute)).json() as { text: string; version: string };
    const image = await (await request(route("attachment", file), "POST", png)).json() as { relative: string };
    assert.match(image.relative, /^assets\/image-[a-f0-9-]+\.png$/);
    assert.deepEqual(Buffer.from(await (await request(route("image", "日 记/" + image.relative))).arrayBuffer()), png);
    const text = original.text + "![图](" + image.relative + ")";
    assert.equal((await request(fileRoute, "PUT", { version: original.version, text })).status, 200);
    assert.equal((await request(fileRoute, "PUT", { version: original.version, text: "过期草稿" })).status, 409);
    assert.equal(((await (await request(fileRoute)).json()) as { text: string }).text, text);
    const history = route("history", file);
    const versions = await (await request(history)).json() as { id: number; at: number }[];
    assert.equal(versions.length, 1);
    const snapshot = history + "&id=" + versions[0]!.id;
    assert.deepEqual(await (await request(snapshot)).json(), { text: original.text });
    assert.equal((await request(snapshot, "GET", undefined, bob)).status, 404);
    assert.equal((await request(route("history", "另一个.md") + "&id=" + versions[0]!.id)).status, 404);
    const latest = await (await request(fileRoute)).json() as { version: string };
    assert.equal((await request(fileRoute, "PUT", { version: latest.version, text: original.text })).status, 200);
    const restored = await (await request(fileRoute)).json() as { text: string; version: string };
    assert.equal(restored.text, original.text);
    const after = await (await request(history)).json() as { id: number }[];
    assert.equal(after.length, 2);
    assert.deepEqual(await (await request(history + "&id=" + after[0]!.id)).json(), { text });
    assert.equal((await request(route("sources"), "DELETE")).status, 200);
    assert.equal((await request(fileRoute)).status, 404);
    assert.ok([...objects.values()].some(b => b.toString() === original.text));
    const again = await (await request("sources", "POST", { ...config, name: "重新连接" })).json() as { id: string };
    assert.notEqual(again.id, source.id);
    assert.deepEqual(await (await request(history.replace(source.id, again.id))).json(), after);

    const peer = await (await request("sources", "POST", config, other)).json() as { id: string };
    const open = (id: string, who: string) => request(fileRoute.replace(source.id, id) + "&collab=1", "GET", undefined, who)
      .then(r => r.json() as Promise<{ text: string; collab: { token: string; startVersion: number } }>);
    const [a, b] = await Promise.all([open(again.id, alice), open(peer.id, other)]);
    const changes = (id: string, who: string, token: string, since: number, updates: unknown) =>
      fetch(base + "/api/memos/" + route("changes", file).replace(source.id, id) + "&since=" + since, {
        method: "POST", headers: { Cookie: who, "X-Memo-Client": token }, body: JSON.stringify({ updates }),
      });
    const length = original.text.replaceAll("\r\n", "\n").length;
    const left = [[[0, "甲"], length]], right = [[[0, "乙"], length]];
    assert.equal((await changes(peer.id, other, a.collab.token, 0, left)).status, 409);
    assert.equal((await changes(again.id, alice, a.collab.token, 0, [[-1]])).status, 400);
    const writes = await Promise.all([changes(again.id, alice, a.collab.token, 0, left), changes(peer.id, other, b.collab.token, 0, right)]);
    assert.deepEqual(writes.map(r => r.status), [200,200]);
    // Dropped acknowledgment: resubmitting the original local change must not insert it twice.
    assert.equal((await changes(again.id, alice, a.collab.token, 0, left)).status, 200);
    const merged = await open(again.id, alice);
    assert.equal(merged.collab.startVersion, 2);
    assert.ok(merged.text === "甲乙" + original.text || merged.text === "乙甲" + original.text);
    assert.equal((await changes(again.id, alice, merged.collab.token, 0, left)).status, 409);

    // Concurrent deletion of the two added characters and insertion between them.
    const edits = await Promise.all([changes(again.id, alice, a.collab.token, 2, [[[2], length]]),
      changes(peer.id, other, b.collab.token, 2, [[1, [0, "中"], length + 1]])]);
    assert.deepEqual(edits.map(r => r.status), [200,200]);
    assert.equal((await open(peer.id, other)).text, "中" + original.text);
  }
});

test("单份笔记保留最近 50 个版本，重复快照不挤占历史", async () => {
  const { rememberMemoVersion, memoVersions, memoVersionText } = await import("../src/core/memo-versions.js");
  const { deleteMemoSources } = await import("../src/core/memo-sources.js");
  const key = ["history-owner", "test-vault", "note.md"] as const;
  for (let i = 0; i < 52; i++) rememberMemoVersion(...key, Buffer.from(String(i)));
  rememberMemoVersion(...key, Buffer.from("51"));
  const versions = memoVersions(...key);
  assert.equal(versions.length, 50);
  assert.equal(memoVersionText(...key, Number(versions[49]!.id)), "2");
  deleteMemoSources(key[0]);
  assert.deepEqual(memoVersions(...key), []);
});
