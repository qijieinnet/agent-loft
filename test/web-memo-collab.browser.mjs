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
  const paragraphs = "用于检验章节定位的段落。\n\n".repeat(32);
  const guides = new Map([
    ["/notes/guide.md", "## 导览\n\n[看第二段](#%E6%91%98%E5%BD%95-1)\n\n[打开附录](appendix.md#Final%20Notes)\n\n" +
      paragraphs + "## 摘录\n\n" + paragraphs + "### **摘录**\n\n" + paragraphs],
    ["/notes/appendix.md", paragraphs + "## Final Notes\n\n" + paragraphs],
    ["/notes/journal/reading.md", paragraphs + "## 阅读进度\n\n" + paragraphs],
  ]);
  const etag = () => '"' + createHash("sha256").update(note).digest("hex") + '"';
  const dav = http.createServer(async (req,res) => {
    if (req.headers.authorization !== "Basic " + Buffer.from("shared:secret").toString("base64")) return res.writeHead(401).end();
    if (req.method === "MKCOL") return res.writeHead(201).end();
    if (req.method === "MOVE") {
      const target = decodeURI(new URL(req.headers.destination).pathname);
      const from = decodeURI(req.url);
      if (!guides.has(from) || guides.has(target)) return res.writeHead(412).end();
      guides.set(target,guides.get(from)); guides.delete(from); return res.writeHead(201).end();
    }
    if (req.method === "PROPFIND") {
      const children = new Map();
      for (const file of ["/notes/team.md", ...guides.keys()]) {
        if (!file.startsWith(req.url)) continue;
        const parts = file.slice(req.url.length).split("/");
        children.set(req.url+parts[0],parts.length > 1);
      }
      return res.writeHead(207).end('<D:multistatus xmlns:D="DAV:">' + [...children].map(([url,folder]) =>
        "<D:response><D:href>"+url+(folder ? "/" : "")+"</D:href>"+(folder ? "<D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>" : "")+"</D:response>").join("") + "</D:multistatus>");
    }
    if (req.method === "GET" && guides.has(req.url)) return res.writeHead(200,{etag:'"guide"'}).end(guides.get(req.url));
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
  await t.test("快速打开、收藏、全文搜索、阅读勾选和双链", async () => {
    const edit = a.getByRole("button",{name:"编辑",exact:true});
    const read = a.getByRole("button",{name:"阅读",exact:true});
    const content = a.locator(".memo-editor .cm-content");
    await edit.click();
    await content.press("Control+End");
    await a.keyboard.insertText("\n\n- [ ] 重复待办\n- [ ] 重复待办\n\n[[guide#导览|查阅指南]]");
    await read.click();
    const boxes = a.locator(".memo-reading input[type=checkbox]");
    await boxes.nth(1).check();
    await a.waitForFunction(() => document.querySelector(".memo-status")?.textContent === "已保存");
    assert.match(note,/- \[ \] 重复待办\r\n- \[x\] 重复待办/);
    await a.getByRole("link",{name:"查阅指南"}).click();
    await a.locator(".memo-reading h2:focus").filter({hasText:"导览"}).waitFor();
    const originalRow = a.locator('.memo-tree [data-path="guide.md"]');
    await originalRow.click({button:"right"});
    await a.locator(".memo-refs li").filter({hasText:"team.md"}).waitFor();
    await a.getByRole("textbox",{name:"目标路径"}).fill("guide-moved.md");
    await a.getByRole("button",{name:"移动或重命名"}).click();
    const moved = a.locator('.memo-tree [data-path="guide-moved.md"]');
    await moved.click({button:"right"});
    await a.getByRole("button",{name:"移入回收站",exact:true}).click();
    await moved.waitFor({state:"detached"});
    await a.getByRole("button",{name:"笔记库设置"}).click();
    await a.getByRole("button",{name:"回收站",exact:true}).click();
    await a.locator(".memo-found").filter({hasText:"guide-moved.md"}).click();
    await moved.click({button:"right"});
    await a.getByRole("textbox",{name:"目标路径"}).fill("guide.md");
    await a.getByRole("button",{name:"移动或重命名"}).click();
    await originalRow.click();
    await a.keyboard.press("Control+o");
    await a.getByRole("button",{name:"收藏 guide.md",exact:true}).click();
    const query = a.getByRole("searchbox");
    await query.fill("共同编辑");
    await a.getByRole("button",{name:"搜正文"}).click();
    await a.locator(".memo-found").filter({hasText:"team.md"}).click();
    await a.waitForFunction(() => CSS.highlights.has("memo-search"));
    await edit.click();
    await content.press("Control+a"); await a.keyboard.insertText("共同编辑\n第二行"); await read.click();
    await a.waitForFunction(() => document.querySelector(".memo-status")?.textContent === "已保存");
  });
  const settingsButton = page => page.getByRole("button", {name:"笔记库设置"});
  const divider = a.getByRole("separator", {name:"文件树宽度"});
  const treeWidth = async () => (await a.locator(".memo-side").boundingBox()).width;
  const initialWidth = await treeWidth();
  const grip = await divider.boundingBox();
  await a.mouse.move(grip.x + grip.width / 2, grip.y + 80);
  await a.mouse.down();
  await a.mouse.move(grip.x + grip.width / 2 + 90, grip.y + 80);
  await a.mouse.up();
  assert.equal(await treeWidth(), initialWidth + 90);
  await divider.press("ArrowRight");
  const fold = a.getByRole("button", {name:"收起文件树"});
  const unfold = a.getByRole("button", {name:"展开文件树"});
  await fold.click();
  assert.equal(await divider.isVisible(), false);
  await unfold.click();
  assert.equal(await treeWidth(), initialWidth + 106);
  await a.reload();
  await divider.waitFor();
  assert.equal(await treeWidth(), initialWidth + 106);
  await divider.dblclick();
  assert.equal(await treeWidth(), initialWidth);
  await a.setViewportSize({width:390,height:844});
  assert.equal(await divider.isVisible(), false);
  await a.locator(".memo-reading p").filter({hasText:"共同编辑"}).waitFor();
  await a.getByRole("button", {name:"文件目录"}).click();
  const scrim = a.getByRole("button", {name:"关闭文件目录"});
  const canvas = a.locator(".memo-pane");
  assert.ok(await canvas.evaluate(el => el.inert && el.clientWidth > 0));
  const edge = await scrim.boundingBox();
  assert.ok((await a.locator(".memo-side").boundingBox()).width < edge.width);
  await scrim.click({position:{x:edge.width - 5,y:80}});
  assert.equal(await canvas.evaluate(el => el.inert), false);
  const files = a.getByRole("button", {name:"文件目录"});
  await files.click();
  await a.keyboard.press("Escape");
  assert.equal(await files.evaluate(el => el === document.activeElement), true);
  await files.click();
  await a.getByRole("button", {name:"返回文件"}).click();
  await a.locator(".memo-reading").waitFor();
  await a.getByRole("button", {name:"编辑",exact:true}).click();
  await a.getByRole("button", {name:"文件目录"}).click();
  await a.locator('.memo-tree [data-path="team.md"]').click();
  await a.locator(".memo-editor").waitFor();
  assert.equal(await a.getByRole("button", {name:"编辑",exact:true}).getAttribute("aria-pressed"), "true");
  await a.getByRole("button", {name:"阅读",exact:true}).click();
  await a.setViewportSize({width:1280,height:720});
  await fold.click();
  const paper = await a.locator(".memo-paper").boundingBox();
  await a.getByRole("button", {name:"编辑",exact:true}).click();
  const line = await a.locator(".memo-editor .cm-line").first().boundingBox();
  assert.ok(Math.abs(line.x - paper.x) <= 1 && Math.abs(line.width - paper.width) <= 1,
    "Markdown 编辑与阅读应使用相同的正文宽度和左边距");
  await a.getByRole("button", {name:"阅读",exact:true}).click();
  await unfold.click();
  await t.test("章节大纲与 Markdown 链接可定位同名章节和其他笔记", async () => {
    const outline = a.getByRole("button", {name:"章节大纲"});
    assert.equal(await outline.isVisible(), false);
    const guide = a.locator('.memo-tree [data-path="guide.md"]');
    const routePattern = "**/api/memos/file?*path=guide.md*";
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await a.route(routePattern, async route => { await gate; await route.continue(); });
    try {
      await guide.click();
      assert.equal(await guide.getAttribute("aria-busy"), "true");
      assert.equal(await a.locator('.memo-row[aria-current="page"]').getAttribute("data-path"), "team.md");
    } finally { release(); }
    await a.locator('.memo-row[aria-current="page"][data-path="guide.md"]').waitFor();
    await a.unroute(routePattern);
    assert.equal(await a.getByRole("button", {name:"阅读",exact:true}).getAttribute("aria-pressed"), "true");
    await outline.click();
    const nav = a.getByRole("navigation", {name:"章节大纲"});
    await nav.getByRole("button",{name:"导览"}).press("ArrowDown");
    await a.keyboard.press("Enter");
    assert.equal(await a.locator(".memo-reading h2:focus").textContent(), "摘录");
    await a.getByRole("link", {name:"看第二段"}).click();
    assert.equal(await a.locator(".memo-reading h3:focus").textContent(), "摘录");
    const top = await a.locator(".memo-reading").evaluate(el => el.getBoundingClientRect().top);
    assert.ok(Math.abs((await a.locator(".memo-reading h3").boundingBox()).y - top - 16) <= 1);
    await a.setViewportSize({width:390,height:844});
    await outline.click();
    assert.equal(await nav.locator("[aria-current]").textContent(), "摘录");
    await a.keyboard.press("Escape");
    await a.getByRole("link", {name:"打开附录"}).click();
    await a.locator(".memo-reading h2:focus").filter({hasText:"Final Notes"}).waitFor();
    assert.equal(await outline.isVisible(), false);
    assert.equal(new URL(a.url()).hash, "#memos");
    await a.setViewportSize({width:1280,height:720});
    await a.locator('.memo-tree [data-path="team.md"]').click();
  });
  await t.test("刷新与切库恢复目录、章节位置，草稿优先，移走文件后返回目录", async () => {
    const tree = a.locator(".memo-tree");
    const chooser = a.getByRole("combobox", {name:"切换笔记库"});
    const first = await chooser.inputValue();
    const path = "journal/reading.md";
    await tree.locator('[data-path="journal"]').click();
    await tree.locator('[data-path="journal/reading.md"]').click();
    const marker = a.getByRole("heading", {name:"阅读进度"});
    await a.setViewportSize({width:390,height:844});
    await marker.evaluate(el => {
      const pane = el.closest(".memo-reading");
      pane.scrollTop += el.getBoundingClientRect().top - pane.getBoundingClientRect().top + 34;
    });
    const offset = () => marker.evaluate(el => el.getBoundingClientRect().top - el.closest(".memo-reading").getBoundingClientRect().top);
    const initial = await offset();
    const res = await a.request.post(base + "/api/memos/sources", {data:{
      kind:"webdav",name:"第二个库",username:"shared",secret:"secret",endpoint:`http://127.0.0.1:${davPort}/notes/`,
    }});
    assert.equal(res.status(), 201);
    const second = (await res.json()).id;
    // Content inserted above the recorded heading must not shift the restored section.
    const remote = "/notes/" + path;
    guides.set(remote, "刷新后新增的段落。\n\n".repeat(12) + guides.get(remote));
    await a.reload();
    await marker.waitFor();
    assert.ok(Math.abs(await offset() - initial) <= 1);
    assert.equal(await tree.isVisible(), false);
    await a.setViewportSize({width:1280,height:720});
    const desktopOffset = await offset();
    await tree.locator('[data-path="journal/reading.md"].selected').waitFor();
    await chooser.selectOption(second);
    await a.getByRole("heading", {name:"打开一篇笔记"}).waitFor();
    await tree.locator('[data-path="team.md"]').click();
    await a.locator(".memo-reading p").filter({hasText:"共同编辑"}).waitFor();
    await chooser.selectOption(first);
    await marker.waitFor();
    assert.ok(Math.abs(await offset() - desktopOffset) <= 1);
    const recoveryContext = await browser.newContext({storageState: await a.context().storageState()});
    const recovery = await recoveryContext.newPage();
    await recovery.addInitScript(({source,owner}) => sessionStorage.setItem("aim.memoDraft." + owner,
      JSON.stringify({source, path:"team.md", version:"old-version", text:"待恢复的本地草稿"})), {source:first,owner:users[0].id});
    await recovery.goto(base + "/#memos");
    await recovery.locator(".memo-editor .cm-content").filter({hasText:"待恢复的本地草稿"}).waitFor();
    await recovery.getByText("远端已更改",{exact:true}).waitFor();
    await recoveryContext.close();
    assert.equal(note, "共同编辑\r\n第二行");
    await chooser.selectOption(second);
    await a.locator(".memo-reading p").filter({hasText:"共同编辑"}).waitFor();
    await chooser.selectOption(first);
    await marker.waitFor();
    guides.delete(remote);
    await a.reload();
    await a.getByRole("heading", {name:"打开一篇笔记"}).waitFor();
    await a.getByText("找不到上次阅读的「journal/reading.md」，请从文件目录重新选择。").waitFor();
    await tree.locator('[data-path="team.md"]').click();
    await a.locator(".memo-reading p").filter({hasText:"共同编辑"}).waitFor();
    assert.ok((await a.request.delete(base + "/api/memos/sources?source=" + second)).ok());
  });
  const disconnectAction = a.getByRole("button", {name:"断开笔记库",exact:true});
  assert.equal(await disconnectAction.count(), 0);
  await settingsButton(a).click();
  await disconnectAction.click();
  const confirm = a.getByRole("button", {name:"断开连接",exact:true});
  const libraryName = a.getByLabel("输入库名", {exact:false});
  assert.equal(await confirm.isDisabled(), true);
  await libraryName.fill("wrong");
  await libraryName.press("Enter");
  assert.equal(await confirm.isDisabled(), true);
  await libraryName.fill("alice");
  assert.equal(await confirm.isEnabled(), true);
  await a.getByRole("button", {name:"取消",exact:true}).click();
  assert.equal((await (await a.request.get(base+"/api/memos/sources")).json()).length, 1);
  async function share(access) {
    await settingsButton(a).click();
    await a.getByRole("button", {name:"共享给成员"}).click();
    try { await a.getByRole("combobox", {name:"bob",exact:true}).selectOption(access, {timeout:5000}); }
    catch (err) { throw new Error([err.message, ...errors, ...httpErrors, await a.locator("body").innerText()].join("\n")); }
    await a.getByRole("button", {name:"保存共享"}).click();
    await a.getByRole("button", {name:"保存共享"}).waitFor({state:"hidden"});
  }
  await share("read");
  const b = await open(users[1]);
  await b.locator(".memo-reading p").filter({hasText:"共同编辑"}).waitFor();
  await b.reload();
  await b.locator(".memo-reading p").filter({hasText:"共同编辑"}).waitFor();
  for (const name of ["编辑","共享给成员","智能体访问","新建笔记"]) assert.equal(await b.getByRole("button",{name,exact:true}).count(),0);
  await settingsButton(b).click();
  for (const name of ["断开笔记库","共享给成员","智能体访问"]) assert.equal(await b.getByRole("button",{name,exact:true}).count(),0);
  await b.keyboard.press("Escape");
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
  await b.getByRole("button",{name:"阅读",exact:true}).click();
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
  await settingsButton(a).click();
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
  await t.test("协作续写保留已渲染的标题和打开的大纲", async () => {
    await insert(a, "## 开场\n\n## 进展\n\n");
    await b.getByRole("button", {name:"章节大纲"}).click();
    const heading = await b.getByRole("heading", {name:"开场",exact:true}).elementHandle();
    const current = await invoke("read_memo", target);
    await invoke("append_memo", {...target, version:current.version, text:"\n\n追加进展"});
    await b.locator(".memo-reading p").filter({hasText:"追加进展"}).waitFor();
    assert.equal(await heading.evaluate(el => el.isConnected), true);
    await b.getByRole("navigation", {name:"章节大纲"}).getByRole("button", {name:"进展"}).click();
    assert.equal(await b.locator(".memo-reading h2:focus").textContent(), "进展");
  });
  await a.getByRole("button",{name:"版本历史"}).click();
  await a.locator(".memo-snapshot").waitFor();
  await a.getByRole("button",{name:"关闭",exact:true}).last().click();
  note = "由外部应用修改";
  await insert(a,"本地草稿");
  await a.getByText("远端已更改",{exact:true}).waitFor();
  assert.equal(await a.locator(".memo-status").getAttribute("data-state"), "error");
  assert.equal(note,"由外部应用修改");
  assert.ok((await doc(a)).includes("本地草稿"));
  const clean = await a.context().newPage();
  await clean.goto(base + "/#memos");
  await settingsButton(clean).click();
  await clean.getByRole("button", {name:"断开笔记库",exact:true}).click();
  await clean.getByLabel("输入库名", {exact:false}).fill("alice");
  await clean.getByRole("button", {name:"断开连接",exact:true}).click();
  await clean.getByRole("button", {name:"连接笔记库",exact:true}).waitFor();
  assert.deepEqual(await (await clean.request.get(base+"/api/memos/sources")).json(), []);
  assert.equal(note,"由外部应用修改");
  assert.deepEqual(errors, []);
});
