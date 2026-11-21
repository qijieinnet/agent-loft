// Run with node --import tsx --test, plus the browser paths used by the other Web tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";

const { chromium } = await import(process.env.AGENT_LOFT_PLAYWRIGHT || "playwright-core");

test("两个独立账号同时编辑同一行，自动合并、预览同步并保留 CRLF 和历史", {timeout: 60000}, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "loft-memo-browser-"));
  process.env.AGENT_LOFT_HOME = home;
  const { config, loadConfig, saveConfig } = await import("../src/core/config.ts");
  const { createUser } = await import("../src/core/users.ts");
  const { createExpert } = await import("../src/core/experts.ts");
  const { createSession } = await import("../src/channels/web/auth.ts");
  const { startWeb, stopWeb } = await import("../src/channels/web/server.ts");
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    fs.rmSync(home, {recursive:true, force:true});
  });
  loadConfig();
  let note = "共同编辑\r\n第二行";
  const etag = () => '"' + createHash("sha256").update(note).digest("hex") + '"';
  const dav = http.createServer(async (req,res) => {
    if (req.headers.authorization !== "Basic " + Buffer.from("shared:secret").toString("base64")) return res.writeHead(401).end();
    if (req.method === "PROPFIND") return res.writeHead(207).end('<D:multistatus xmlns:D="DAV:"><D:response><D:href>/notes/team.md</D:href></D:response></D:multistatus>');
    if (req.url !== "/notes/team.md") return res.writeHead(404).end();
    if (req.method === "PUT") {
      if (req.headers["if-match"] !== etag()) return res.writeHead(412).end();
      const body = [];
      for await (const chunk of req) body.push(chunk);
      note = Buffer.concat(body).toString();
      return res.writeHead(200, {etag:etag()}).end();
    }
    res.writeHead(200, {etag:etag()}).end(note);
  });
  async function listen(server) {
    await new Promise((resolve,reject) => server.once("error",reject).listen(0,"127.0.0.1",resolve));
    return server.address().port;
  }
  const davPort = await listen(dav);
  cleanup.push(() => new Promise(resolve => dav.close(resolve)));
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const base = "http://127.0.0.1:" + port;
  saveConfig({...config(), workspaceRoot:home, web:{...config().web, host:"127.0.0.1",port,quotaEnabled:false}});
  const users = ["alice","bob"].map(name => createUser({ name, password:"test-password", role:name === "alice" ? "admin" : "member" }));
  const { hub } = await import("../src/core/hub.ts");
  hub.registerDriver({ id: "claude", label: "Claude", capabilities: {}, defaults: async () => ({}), catalog: async () => [] });
  const expert = createExpert(users[0].id, { name: "笔记专家", engine: "claude", access: "web" });
  await startWeb();
  cleanup.push(stopWeb);
  const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args:["--no-sandbox"]});
  cleanup.push(() => browser.close());
  const errors = [], httpErrors = [];
  async function open(user) {
    const ctx = await browser.newContext({serviceWorkers:"block"});
    await ctx.addCookies([{name:"aim_session",value:createSession(user.id,"127.0.0.1","test"),url:base}]);
    if (user.id === users[0].id) {
      const response = await ctx.request.post(base+"/api/memos/sources", {data:{
        kind:"webdav",name:user.name,username:"shared",secret:"secret",endpoint:`http://127.0.0.1:${davPort}/notes/`,
      }});
      assert.equal(response.status(),201);
    }
    const page = await ctx.newPage();
    page.on("pageerror", e => errors.push(e.message));
    page.on("response", r => { if (r.status() >= 400) httpErrors.push(r.status() + " " + new URL(r.url()).pathname); });
    await page.goto(base+"/#memos", {waitUntil:"domcontentloaded"});
    try { await page.locator('.memo-tree [data-path="team.md"]').click({timeout: 10000}); }
    catch (err) { throw new Error([err.message, ...errors, ...httpErrors, await page.locator("body").innerText()].join("\n")); }
    return page;
  }
  const a = await open(users[0]);
  async function share(access) {
    await a.getByRole("button", {name:"共享给成员"}).click();
    try { await a.getByRole("combobox", {name:"bob",exact:true}).selectOption(access, {timeout:5000}); }
    catch (err) { throw new Error([err.message, ...errors, ...httpErrors, await a.locator("body").innerText()].join("\n")); }
    await a.getByRole("button", {name:"保存共享"}).click();
    await a.getByRole("button", {name:"保存共享"}).waitFor({state:"hidden"});
  }
  await share("read");
  const b = await open(users[1]);
  await b.locator(".memo-reading p").filter({hasText:"共同编辑"}).waitFor();
  for (const name of ["编辑","共享给成员","智能体访问","新建笔记"]) assert.equal(await b.getByRole("button",{name,exact:true}).count(),0);
  await share("write");
  await b.reload();
  await b.locator('.memo-tree [data-path="team.md"]').click();
  for (const page of [a,b]) await page.getByRole("button",{name:"编辑",exact:true}).click();
  // Hold both outgoing requests until both editors have made a local insertion at offset zero.
  let arrived = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  for (const page of [a,b]) await page.route("**/api/memos/changes?**", async route => {
    if (route.request().method() === "POST" && arrived < 2) {
      if (++arrived === 2) release();
      await gate;
    }
    return route.continue();
  });
  const insert = async (page, text) => {
    const doc = page.locator(".memo-editor .cm-content");
    await doc.click(); await doc.press("Control+Home"); await page.keyboard.insertText(text);
  };
  await Promise.all([insert(a,"甲"), insert(b,"乙")]);
  const merged = /^[甲乙]{2}共同编辑\n第二行$/;
  for (const page of [a,b]) await page.waitForFunction(() => {
    const text = document.querySelector(".memo-editor .cm-content")?.innerText;
    return text?.includes("甲") && text.includes("乙") && document.querySelector(".memo-status").textContent === "已保存";
  });
  const doc = page => page.locator(".memo-editor .cm-content").innerText();
  assert.match(await doc(a), merged);
  assert.equal(await doc(a), await doc(b));
  assert.equal(note, (await doc(a)).replaceAll("\n","\r\n"));
  await b.getByRole("button",{name:"预览",exact:true}).click();
  await insert(a,"同步");
  await b.locator(".memo-reading p").filter({hasText:"同步"}).waitFor();
  const settings = await a.context().newPage();
  await settings.goto(base + "/#settings");
  await settings.getByRole("button", {name:"专家", exact:true}).click();
  await settings.getByRole("button", {name:"笔记专家", exact:true}).click();
  await settings.getByRole("combobox", {name:"alice", exact:true}).selectOption("write");
  await settings.getByRole("button", {name:"保存", exact:true}).click();
  await settings.locator(".expert-form").waitFor({state:"detached"});
  await settings.close();
  await a.getByRole("button", {name:"智能体访问"}).click();
  assert.equal(await a.getByRole("combobox", {name:"笔记专家", exact:true}).count(), 0);
  await a.getByText(/最近成功：/).waitFor();
  await a.getByRole("button", {name:"关闭", exact:true}).last().click();

  const { startTasksBridge, stopTasksBridge } = await import("../src/core/tasks-bridge.ts");
  const { memosMcpSpawn } = await import("../src/core/tasks-mcp.ts");
  const { ensureConversation } = await import("../src/core/store.ts");
  const conv = ensureConversation({key:"web:memo-browser",channel:"web",channelId:"web",agent:"claude",expert:expert.id,owner:users[0].id});
  startTasksBridge();
  cleanup.push(stopTasksBridge);
  const spec = memosMcpSpawn(users[0].id, conv.key, "test");
  const child = spawn(spec.command, spec.args, {env:{...process.env,...spec.env},stdio:["pipe","pipe","inherit"]});
  cleanup.push(() => child.kill());
  const lines = createInterface({input:child.stdout})[Symbol.asyncIterator]();
  let id = 0;
  async function call(method, params) {
    child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:++id,method,params}) + "\n");
    const response = JSON.parse((await lines.next()).value);
    assert.equal(response.id, id);
    assert.ok(!response.error);
    return response.result;
  }
  const invoke = async (name, args) => {
    const result = await call("tools/call", {name, arguments:args});
    assert.ok(!result.isError, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  assert.equal((await call("tools/list", {})).tools.length, 7);
  const {hits} = await invoke("search_memos", {query:"第二行"});
  const target = {source:hits[0].source,path:hits[0].path};
  const latest = await invoke("read_memo", target);
  // Hold a real user's unsaved change while the agent appends to the remote note.
  let held, resume;
  const pending = new Promise(r => { held = r; }), proceed = new Promise(r => { resume = r; });
  await a.route("**/api/memos/changes?**", async route => {
    if (route.request().method() === "POST") { held(); await proceed; }
    return route.continue();
  });
  await insert(a, "待提交");
  await pending;
  try {
    await invoke("append_memo", {...target, version:latest.version, text:"\n智能体追加"});
    await b.locator(".memo-reading").getByText(/智能体追加/).waitFor();
  } finally { resume(); }
  await b.locator(".memo-reading").getByText(/待提交/).waitFor();
  assert.ok(note.includes("待提交") && note.endsWith("\r\n智能体追加"));
  await a.getByRole("button",{name:"版本历史"}).click();
  await a.locator(".memo-snapshot").waitFor();
  await a.getByRole("button",{name:"关闭",exact:true}).last().click();
  note = "由外部应用修改";
  await insert(a,"本地草稿");
  await a.getByText("远端已更改",{exact:true}).waitFor();
  assert.equal(note,"由外部应用修改");
  assert.ok((await doc(a)).includes("本地草稿"));
  assert.deepEqual(errors, []);
});
