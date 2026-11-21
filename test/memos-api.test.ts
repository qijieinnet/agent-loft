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
const { createExpert } = await import("../src/core/experts.js");
const { memoToolCall } = await import("../src/core/memos-bridge.js");
const { memoSources } = await import("../src/core/memo-sources.js");
const { memoIndexStatus, refreshMemoIndex } = await import("../src/core/memo-index.js");
const { ensureConversation, updateConversation } = await import("../src/core/store.js");
const { createSession } = await import("../src/channels/web/auth.js");

async function listen(server: http.Server) {
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}

test("备忘录按账号接入 WebDAV 和 S3，目录、条件保存及图片直接写回相应数据源", async t => {

  const objects = new Map<string, Buffer>();
  let offline = false;
  let gate: { path: string; started: () => void; wait: Promise<void> } | undefined;
  const remote = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://local");
    const p = decodeURIComponent(url.pathname);
    if (offline) return void res.writeHead(503).end();
    if (p === gate?.path && req.method === "GET") { gate.started(); await gate.wait; }
    if (p.startsWith("/dav/")) assert.equal(req.headers.authorization, "Basic " + Buffer.from("key:secret").toString("base64"));
    else {
      assert.match(req.headers.authorization ?? "", /^AWS4-HMAC-SHA256 Credential=key\/\d{8}\/us-east-1\/s3\/aws4_request,/);
      assert.ok(p.startsWith("/notes/"));
    }
    if (req.method === "PROPFIND") {
      assert.equal(req.headers.depth, "1");
      const paths = [...objects.keys()].filter(k => k.startsWith(p) && !k.slice(p.length).replace(/\/$/, "").includes("/"));
      res.writeHead(207).end('<D:multistatus xmlns:D="DAV:">' + paths.map(k =>
        '<D:response><D:href>' + k.split("/").map(encodeURIComponent).join("/") + '</D:href><D:propstat><D:prop><D:resourcetype>' +
        (k.endsWith("/") ? "<D:collection/>" : "") + "</D:resourcetype></D:prop></D:propstat></D:response>").join("") + "</D:multistatus>");
    } else if (url.searchParams.has("list-type")) {
      const prefix = url.searchParams.get("prefix")!;
      const keys = [...objects.keys()].filter(k => k.startsWith("/notes/")).map(k => k.slice("/notes/".length)).filter(k => k.startsWith(prefix) && k !== prefix);
      const token = url.searchParams.get("continuation-token");
      const offset = Number(token ?? 0);
      const page = keys.slice(offset, offset + 2);
      const next = offset + page.length < keys.length ? "<NextContinuationToken>" + (offset + page.length) + "</NextContinuationToken>" : "";
      res.end('<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' + next + page.map(k => {
        const slash = k.indexOf("/", prefix.length);
        const etag = '"' + createHash("md5").update(objects.get("/notes/" + k)!).digest("hex") + '"';
        return slash < 0 ? "<Contents><Key>" + k + "</Key><ETag>" + etag + "</ETag></Contents>" : "<CommonPrefixes><Prefix>" + k.slice(0, slash + 1) + "</Prefix></CommonPrefixes>";
      }).join("") + "</ListBucketResult>");
    } else if (req.method === "MKCOL") {
      if (objects.has(p)) return void res.writeHead(405).end();
      objects.set(p, Buffer.alloc(0));
      res.writeHead(201).end();
    } else {
      const old = objects.get(p);
      const tag = (bytes: Buffer) => '"' + createHash("md5").update(bytes).digest("hex") + '"';
      if (req.method === "MOVE") {
        assert.equal(req.headers.overwrite, "F");
        const destination = decodeURIComponent(new URL(req.headers.destination as string).pathname);
        if (!old || objects.has(destination)) return void res.writeHead(old ? 412 : 404).end();
        objects.set(destination, old); objects.delete(p); return void res.writeHead(201).end();
      }
      if (req.method === "DELETE") {
        if (!old || req.headers["if-match"] !== tag(old)) return void res.writeHead(412).end();
        objects.delete(p); return void res.writeHead(204).end();
      }
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
  const owners = new Map<string,string>();
  const cookie = (role: "admin" | "member", name: string = role) => {
    const user = createUser({ name, password: "test-password", role });
    owners.set(name, user.id);
    return "aim_session=" + createSession(user.id, "127.0.0.1", "memos-test");
  };
  const alice = cookie("admin"), bob = cookie("member"), other = cookie("admin", "editor");
  const owner = owners.get("admin")!;
  const expert = createExpert(owner, { name: "笔记专家", engine: "codex", access: "web" });
  const expertConv = ensureConversation({ key: "memo-expert", channel: "web", channelId: "web", agent: "codex", expert: expert.id, owner });
  const asExpert = (name: string, args: Record<string, unknown>) => memoToolCall(owner, expertConv.key, name, args);
  const conv = ensureConversation({ key: "memo-test", channel: "web", channelId: "web", agent: "codex", owner });
  const group = ensureConversation({ key: "memo-group", channel: "feishu", channelId: "group", agent: "codex" });
  const invoke = (name: string, args: Record<string, unknown>) => memoToolCall(owner, conv.key, name, args);
  const request = (op: string, method = "GET", body?: unknown, who = alice) =>
    fetch(base + "/api/memos/" + op, { method, headers: { Cookie: who }, body: body instanceof Buffer ? body : JSON.stringify(body) });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZBoAAAAASUVORK5CYII=", "base64");
  assert.equal((await request("sources", "GET", undefined, "")).status, 401);
  for (const kind of ["webdav", "s3"]) {
    const config = { name: kind, kind, endpoint: endpoint + (kind === "webdav" ? "/dav/" : ""), username: "key", secret: "secret", region: "us-east-1", bucket: "notes", prefix: "private" };
    assert.equal((await request("sources", "POST", config, bob)).status, 403);
    const source = await (await request("sources", "POST", config)).json() as { id: string };
    assert.deepEqual(Object.keys(source).sort(), ["access", "expertAccess", "id", "kind", "name"]);
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
    const member = owners.get("member")!;
    const share = (access: string) => request(route("sharing"), "PUT", { changes: { [member]: access } });
    const sharedRequest = (op: string, method = "GET", body?: unknown) => request(op + "&owner=" + owner, method, body, bob);
    assert.equal((await sharedRequest(fileRoute)).status, 404);
    assert.equal((await share("read")).status, 200);
    assert.deepEqual(await (await request("sources", "GET", undefined, bob)).json(), [
      { id: source.id, name: kind, kind, permission: "read", sharedBy: { id: owner, name: "admin" } },
    ]);
    assert.equal((await sharedRequest(route("tree"))).status, 200);
    assert.deepEqual(await (await sharedRequest(snapshot)).json(), { text: original.text });
    assert.equal((await sharedRequest(route("image", "日 记/" + image.relative))).status, 200);
    for (const [action, method] of [["file","PUT"], ["changes","POST"], ["folder","POST"], ["attachment","POST"]] as const) {
      assert.equal((await sharedRequest(route(action, file), method, {})).status, 403);
    }
    const scratch = "整理测试.md", moved = "日 记/新名字.md";
    assert.equal((await request(route("file",scratch),"PUT",{version:null,text:"保留正文"})).status,200);
    const change = (from:string, body:unknown) => request(route("organize",from),"POST",body);
    assert.equal((await sharedRequest(route("organize",scratch),"POST",{op:"trash"})).status,403);
    assert.equal((await change(scratch,{op:"move",to:file})).status,409);
    assert.equal((await change(scratch,{op:"move",to:moved})).status,200);
    assert.equal((await request(route("file",scratch))).status,404);
    const removed = await change(moved,{op:"trash"});
    assert.equal(removed.status,200);
    const binPath = (await removed.json() as {path:string}).path;
    assert.equal((await change(binPath,{op:"restore"})).status,200);
    assert.equal((await (await request(route("file",moved))).json() as {text:string}).text,"保留正文");
    assert.equal((await share("write")).status, 200);
    for (const [action, method] of [["sharing","PUT"], ["sharing","GET"], ["access","PUT"], ["index","GET"], ["sources","DELETE"]] as const) {
      assert.equal((await sharedRequest(route(action), method)).status, 403);
    }
    const memberConv = ensureConversation({ key: "member-notes", agent: "codex", owner: member, channel: "web", channelId: "web" });
    assert.deepEqual(await memoToolCall(member, memberConv.key, "list_memo_sources", {}), []);
    assert.equal((await sharedRequest(route("file", "共享笔记.md"), "PUT", initial)).status, 200);
    let reading!: () => void, finishRead!: () => void;
    const readingStarted = new Promise<void>(r => { reading = r; });
    gate = { path: (kind === "s3" ? "/notes/private/" : "/dav/") + file, started: reading, wait: new Promise<void>(r => { finishRead = r; }) };
    const inFlight = sharedRequest(fileRoute);
    await readingStarted;
    try { assert.equal((await share("off")).status, 200); }
    finally { finishRead(); gate = undefined; }
    assert.equal((await inFlight).status, 404);
    assert.deepEqual(await (await request("sources", "GET", undefined, bob)).json(), []);
    assert.equal((await sharedRequest(snapshot)).status, 404);
    assert.equal((await sharedRequest(fileRoute, "PUT", initial)).status, 404);
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
    const active = { source: again.id, path: file };
    const access = (value: string, expertAccess?: Record<string, string>) =>
      request(route("access").replace(source.id, again.id), "PUT", { access: value, expertAccess });
    const settings = (url: string, method: string, body: unknown, who = alice) =>
      fetch(base + "/api/" + url, { method, headers: { Cookie: who }, body: JSON.stringify(body) });
    assert.deepEqual(await invoke("list_memo_sources", {}), []);
    const createdExpert = await settings("experts", "POST", { name: "共享专家", engine: "codex", access: "web", shared: true, memoAccess: { [again.id]: "off" } });
    assert.equal(createdExpert.status, 200);
    const { id: sharedId } = await createdExpert.json() as { id: string };
    const toolsRoute = "experts/" + sharedId + "/tools";
    const sharedTools = { skills: [], mcp: [], memoAccess: { [peer.id]: "read" } };
    assert.equal((await settings(toolsRoute, "PUT", sharedTools, other)).status, 200);
    assert.equal((await settings(toolsRoute, "PUT", sharedTools)).status, 400);
    assert.equal(memoSources(owners.get("editor")!).find(s => s.id === peer.id)?.expertAccess?.[sharedId], "read");
    assert.equal((await settings("agents/defaults", "PUT", { agents: { codex: { memoAccess: { [again.id]: "off" } } } })).status, 200);
    assert.equal((await settings("experts/" + expert.id, "PATCH", { memoAccess: { [again.id]: "write" } })).status, 200);
    assert.equal((await request(route("access").replace(source.id, again.id), "PUT", { access: "off", defaultOnly: true })).status, 200);
    assert.deepEqual(memoSources(owner).find(s => s.id === again.id)?.expertAccess, { [sharedId]: "off", codex: "off", [expert.id]: "write" });
    assert.equal((await settings("agents/defaults", "PUT", { agents: { codex: { memoAccess: { [again.id]: null } } } })).status, 200);
    assert.equal(memoSources(owner).find(s => s.id === again.id)?.expertAccess?.codex, undefined);
    assert.equal((await settings("experts/" + sharedId, "DELETE", undefined)).status, 200);
    assert.equal(memoSources(owners.get("editor")!).find(s => s.id === peer.id)?.expertAccess?.[sharedId], undefined);
    await refreshMemoIndex(owner, memoSources(owner).find(s => s.id === again.id)!);
    assert.deepEqual(await invoke("search_memos", { query: "正文" }), { libraries: [], hits: [] });
    await assert.rejects(invoke("read_memo", active), /未找到/);
    assert.deepEqual(await asExpert("list_memo_sources", {}), [{ id: again.id, name: "重新连接", kind, access: "write" }]);
    assert.ok((await asExpert("search_memos", { query: "正文" }) as { hits: unknown[] }).hits.length);
    await asExpert("create_memo", { source: again.id, path: "仅专家.md", text: "专家记录" });
    assert.equal((await access("write", { [expert.id]: "read", codex: "off" })).status, 200);
    await assert.rejects(asExpert("create_memo", { ...active, text: "禁止" }), /仅允许读取/);
    await assert.rejects(invoke("read_memo", active), /未找到/);
    assert.equal((await access("read", { [expert.id]: "off" })).status, 200);
    assert.deepEqual(await asExpert("list_memo_sources", {}), []);
    await assert.rejects(asExpert("read_memo", active), /未找到/);
    assert.equal((await access("read", { [expert.id]: "invalid" })).status, 400);
    const lookup = () => invoke("search_memos", { query: "正文", source: again.id }) as Promise<{ hits: {path:string}[] }>;
    // Wait until the first crawl has actually reached the subfolder.
    const library = memoSources(owner).find(s => s.id === again.id)!;
    await refreshMemoIndex(owner, library);
    assert.ok(memoIndexStatus(owner, again.id).success);
    const webHits = await (await request("search?source="+again.id+"&q="+encodeURIComponent("正文"))).json() as {ready:boolean;hits:unknown[]};
    assert.ok(webHits.ready && webHits.hits.length);
    assert.equal((await request("search?source="+again.id+"&q=test","GET",undefined,bob)).status,404);
    assert.ok((await lookup()).hits.some(hit => hit.path === file));
    assert.ok((await invoke("search_memos", { query: "笔记", folder: "日 记" }) as { hits: unknown[] }).hits.length);
    await assert.rejects(invoke("create_memo", { ...active, text: "禁止" }), /仅允许读取/);
    await assert.rejects(invoke("read_memo", { ...active, source: peer.id }), /未找到/);
    await assert.rejects(memoToolCall(owner, group.key, "list_memo_sources", {}), /无权/);
    await assert.rejects(memoToolCall(owners.get("editor")!, conv.key, "list_memo_sources", {}), /无权/);
    assert.equal((await access("write")).status, 200);
    const read = () => invoke("read_memo", active) as Promise<{text:string; version:string}>;
    const current = await read();
    updateConversation(conv.key, { plan: true });
    await assert.rejects(invoke("append_memo", { ...active, version: current.version, text: "禁止" }), /仅允许读取/);
    assert.equal((await read()).text, current.text);
    updateConversation(conv.key, { plan: false });
    const result = await invoke("append_memo", { ...active, version: current.version, text: "鱼鱼" }) as { version:string };
    assert.equal((await read()).text, current.text + "鱼鱼");
    assert.equal((await open(peer.id, other)).collab.startVersion, 5);
    assert.ok((await invoke("search_memos", {query:"鱼鱼"}) as {hits:unknown[]}).hits.length);
    await assert.rejects(invoke("append_memo", { ...active, version: current.version, text: "过期" }), /版本已变更/);
    await assert.rejects(invoke("edit_memo", { ...active, version: result.version, original: "鱼", text: "羊" }), /唯一片段/);
    await invoke("edit_memo", { ...active, version: result.version, original: "鱼鱼", text: "羊" });
    assert.equal((await read()).text, current.text + "羊");
    const created = { source: again.id, path: "新建.md", text: "带索引" };
    await invoke("create_memo", created);
    await assert.rejects(invoke("create_memo", created), /已存在/);
    const remotePath = (kind === "s3" ? "/notes/private/" : "/dav/") + created.path;
    offline = true;
    await refreshMemoIndex(owner, library);
    assert.ok(memoIndexStatus(owner, again.id).error);
    assert.ok((await invoke("search_memos", {query:"带索引"}) as {hits:unknown[]}).hits.length);
    offline = false;
    objects.set(remotePath, Buffer.from("外部改动"));
    await refreshMemoIndex(owner, library);
    assert.ok((await invoke("search_memos", {query:"外部改动"}) as {hits:unknown[]}).hits.length);
    objects.delete(remotePath);
    await refreshMemoIndex(owner, library);
    assert.deepEqual((await invoke("search_memos", {query:"外部改动"}) as {hits:unknown[]}).hits, []);
    let signal!: () => void, resume!: () => void;
    const started = new Promise<void>(r => { signal = r; }), release = new Promise<void>(r => { resume = r; });
    gate = { path: (kind === "s3" ? "/notes/private/" : "/dav/") + file, started: signal, wait: release };
    objects.set(gate.path, Buffer.from("撤权期间的外部修改"));
    const scan = refreshMemoIndex(owner, library);
    await started;
    assert.equal((await access("off")).status, 200);
    resume();
    await scan;
    gate = undefined;
    await assert.rejects(read(), /未找到/);
    assert.equal(memoIndexStatus(owner, again.id).success, 0);
    const { sql } = await import("../src/core/db.js");
    assert.equal(sql("SELECT count(*) AS n FROM memo_documents WHERE source=?").get(again.id)?.n, 0);

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
