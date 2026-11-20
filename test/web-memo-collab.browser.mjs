// Run with node --import tsx --test, plus the browser paths used by the other Web tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";

const { chromium } = await import(process.env.AGENT_LOFT_PLAYWRIGHT || "playwright-core");

test("两个独立账号同时编辑同一行，自动合并、预览同步并保留 CRLF 和历史", {timeout: 60000}, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "loft-memo-browser-"));
  process.env.AGENT_LOFT_HOME = home;
  const { config, loadConfig, saveConfig } = await import("../src/core/config.ts");
  const { createUser } = await import("../src/core/users.ts");
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
  const users = ["alice","bob"].map(name => createUser({ name, password:"test-password", role:"admin" }));
  await startWeb();
  cleanup.push(stopWeb);
  const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args:["--no-sandbox"]});
  cleanup.push(() => browser.close());
  const errors = [];
  async function open(user) {
    const ctx = await browser.newContext({serviceWorkers:"block"});
    await ctx.addCookies([{name:"aim_session",value:createSession(user.id,"127.0.0.1","test"),url:base}]);
    const response = await ctx.request.post(base+"/api/memos/sources", {data:{
      kind:"webdav",name:user.name,username:"shared",secret:"secret",endpoint:`http://127.0.0.1:${davPort}/notes/`,
    }});
    assert.equal(response.status(),201);
    const page = await ctx.newPage();
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(base+"/#memos", {waitUntil:"domcontentloaded"});
    await page.locator('.memo-tree [data-path="team.md"]').click();
    await page.getByRole("button",{name:"编辑",exact:true}).click();
    return page;
  }
  const [a,b] = await Promise.all(users.map(open));
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
