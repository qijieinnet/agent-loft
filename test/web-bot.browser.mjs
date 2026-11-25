// node --import tsx --test test/web-bot.browser.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { createServer } from "node:http";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import "tsx/esm";

const { chromium } = await import(process.env.AGENT_LOFT_PLAYWRIGHT || "playwright-core");
// Release checks can serve the extracted npm package through its own server and bundled Web assets.
const packageRoot = process.env.BOT_TEST_PACKAGE_ROOT
  ? pathToFileURL(path.resolve(process.env.BOT_TEST_PACKAGE_ROOT) + path.sep)
  : new URL("../", import.meta.url);
const fromPackage = (file) => import(new URL(file, packageRoot).href);

test("手机 Bot 首次设置、照片和提醒、链接邀请、私聊和共享范围、成员撤权", { timeout: 120000 }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "loft-bot-browser-"));
  process.env.AGENT_LOFT_HOME = home;
  process.env.AGENT_LOFT_WEB_MODE = "bot";
  process.env.AGENT_LOFT_BOT_MODEL = "fixture/chat";
  let browser, stopService;
  t.after(async () => {
    try {
      await browser?.close();
      await stopService?.();
      const { appServer } = await fromPackage("src/agents/codex/app-server.ts");
      await appServer.stop();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  const { config, saveConfig } = await fromPackage("src/core/config.ts");
  const { ensureSetupToken } = await fromPackage("src/channels/web/auth.ts");
  const { setModelRuntime } = await fromPackage("src/agents/pi/sdk.ts");
  const { startWeb, stopWeb } = await fromPackage("src/channels/web/server.ts");
  const seen = [], delegated = [];
  const retryText = "再看一眼测试照片";
  const unavailableTask = "尝试生成一份测试清单";
  const fixture = { provider: "fixture", id: "chat", name: "测试模型", input: ["text", "image"], maxTokens: 3600 };
  setModelRuntime({
    getModel() {
      return fixture;
    },
    async getAvailable() { return [fixture]; },
    async completeSimple(_model, context) {
      if (typeof context.messages[0].content === "string") {
        delegated.push(context.messages[0].content);
        return { content: [{ type: "text", text: "建议先确定人数，再准备清单。" }],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: context.messages[0].content === unavailableTask ? "error" : "stop" };
      }
      const blocks = context.messages[0].content,
        data = JSON.parse(blocks[0].text);
      seen.push({ data, hasPhoto: blocks.some((block) => block.type === "image") });
      let reply = { text: "收到：" + data.latest.text };
      if (data.latest.text === "确认测试" && !blocks.some(b => b.text?.includes('"toolResult"'))) {
        const catalog = JSON.parse(blocks.find(b => b.text?.startsWith("本轮可用工具")).text.split("\n")[1]);
        reply = { tool: { id: catalog[0].id, name: "read_status", args: { phrase: "测试参数" } } };
      }
      if (data.latest.text === "想安排一次周末野餐")
        reply.text = "可以从这份两人清单开始。\n\n**随身带好**\n- 饮用水和简单的食物\n- 野餐垫、纸巾和垃圾袋\n\n**出发前**\n1. 查看当天的天气\n2. 约好集合时间";
      if (data.latest.text.includes("提醒"))
        reply.reminder = { kind: "create", text: "带水壶", dueAt: new Date(Date.now() + 3600000).toISOString() };
      return {
        content: [{ type: "text", text: JSON.stringify(reply) }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        stopReason: data.latest.text === retryText && seen.filter(x => x.data.latest.text === retryText).length === 1 ? "error" : "stop",
      };
    },
  });
  const reservation = net.createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  const cfg = config();
  cfg.web.host = "127.0.0.1";
  cfg.web.port = port;
  saveConfig(cfg);
  const setupToken = ensureSetupToken();
  stopService = stopWeb;
  await startWeb();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  const base = "http://127.0.0.1:" + port;
  const display = { locale: "zh-CN", timezoneId: "Asia/Hong_Kong", colorScheme: "light", reducedMotion: "reduce" };
  const context = await browser.newContext({ ...display, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const owner = await context.newPage();
  const errors = [];
  owner.on("pageerror", (error) => errors.push(error.message));
  const open = (page, name) => page.getByRole("button", { name, exact: true }).click();
  const write = async (page, text, response = "收到：" + text) => {
    await page.getByRole("textbox", { name: "消息", exact: true }).fill(text);
    assert.equal(await page.getByRole("button", { name: "发送消息" }).isEnabled(), true);
    await open(page, "发送消息");
    await page.locator("#messages")
      .getByText(response, { exact: false })
      .first()
      .waitFor();
  };
  await owner.goto(base + "/bot/");
  await owner.getByLabel("启动日志中的设置码").waitFor();
  await shot(owner, "bot-mobile-setup");
  await owner.getByLabel("启动日志中的设置码").fill(setupToken);
  await owner.getByLabel("用户名", { exact: true }).fill("alice");
  await owner.getByLabel("密码（至少 8 位）").fill("fixture-password");
  await open(owner, "创建管理员账号");
  await owner.locator("#rail-list .bot-choice").filter({ hasText: "我的助手" }).click();
  await owner.getByRole("heading", { name: "有什么想交给我？" }).waitFor();
  const privateURL = owner.url();
  // Real browser registrations must isolate native notifications under the same origin.
  await context.grantPermissions(["notifications"], { origin: base });
  const scope = await owner.evaluate(async () => new URL((await navigator.serviceWorker.ready).scope).pathname);
  assert.equal(scope, "/bot/");
  await owner.evaluate(async () => {
    const bot = await navigator.serviceWorker.ready;
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    const desk = await navigator.serviceWorker.getRegistration("/");
    if (!desk.active) {
      const pending = desk.installing || desk.waiting;
      await new Promise((resolve, reject) => {
        function changed() {
          if (pending.state === "activated") resolve();
          if (pending.state === "redundant") reject(Error("workbench worker unavailable"));
        }
        pending.addEventListener("statechange", changed);
        changed();
      });
    }
    await bot.showNotification("合成的 Bot 通知", {tag:"bot-fixture",data:{url:"/bot/?thread=fixture&message=1"}});
    await desk.showNotification("合成的工作台通知", {tag:"workbench-fixture",data:{url:"/#fixture"}});
    const { clearBotNotifications } = await import("/bot/client.js");
    clearBotNotifications({threadId:"fixture",through:1});
  });
  await owner.waitForFunction(async () => {
    const bot = await navigator.serviceWorker.getRegistration("/bot/");
    return (await bot.getNotifications({tag:"bot-fixture"})).length === 0;
  });
  assert.equal(await owner.evaluate(async () => {
    const desk = await navigator.serviceWorker.getRegistration("/");
    const notifications = await desk.getNotifications({tag:"workbench-fixture"});
    notifications.forEach(n => n.close());
    return notifications.length;
  }), 1);
  await open(owner, "返回对话列表");
  const search = owner.getByRole("searchbox", { name: "搜索对话" });
  await search.fill("不存在的名字");
  assert.equal(await owner.locator("#rail-list .bot-choice:visible").count(), 0);
  await search.fill("我的助手");
  await owner.locator("#rail-list .bot-choice").filter({ hasText: "我的助手" }).waitFor();
  await search.fill("");
  await shot(owner, "bot-mobile-conversations");
  await open(owner, "新建私人 Bot");
  await owner.getByLabel("Bot 名称").fill("清单搭档");
  await open(owner, "保存");
  await owner.locator("#bot-name", { hasText: "清单搭档" }).waitFor();
  const secondURL = owner.url();
  await owner.goto(privateURL);
  await owner.getByRole("heading", { name: "有什么想交给我？" }).waitFor();
  const deskContext = await browser.newContext({ ...display, viewport: { width: 1280, height: 840 }, storageState: await context.storageState() });
  const desk = await deskContext.newPage();
  desk.on("pageerror", (error) => errors.push(error.message));
  await desk.goto(privateURL);
  await desk.getByRole("heading", { name: "有什么想交给我？" }).waitFor();
  async function shot(page, filename) {
    const overflows = await page.evaluate(() =>
      [...document.querySelectorAll("html, #gate, #rail, #scroll, #compose, #compose-actions, dialog[open], dialog[open] #panel-body")]
        .filter(el => el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1)
        .map(el => ({ area: el.id || el.tagName, width: el.clientWidth, content: el.scrollWidth })));
    assert.deepEqual(overflows, [], filename + " 出现横向溢出");
    if (process.env.BOT_SCREENSHOT_DIR)
      await page.screenshot({ path: path.join(process.env.BOT_SCREENSHOT_DIR, filename + ".png"), animations: "disabled" });
  }
  async function checkComposer(page) {
    const input = page.getByRole("textbox", { name: "消息", exact: true });
    const send = page.getByRole("button", { name: "发送消息", exact: true });
    assert.equal(await input.count(), 1);
    assert.equal(await page.locator("#send").isDisabled(), true);
    assert.equal(await send.isVisible(), false);
    await input.fill("周末想去公园");
    for (const control of [input, send]) {
      const inView = await control.evaluate(el => {
        const { left, right, top, bottom, width, height } = el.getBoundingClientRect();
        return width > 0 && height > 0 && left >= 0 && right <= innerWidth + 1 && top >= 0 && bottom <= innerHeight + 1;
      });
      assert.ok(inView, "可见区域内应能操作消息框及发送键");
    }
    assert.equal(await send.isEnabled(), true);
    await input.fill("");
    assert.equal(await page.locator("#send").isDisabled(), true);
    assert.equal(await send.isVisible(), false);
  }
  assert.equal(await desk.locator("#rail").isVisible(), true);
  assert.equal(await owner.locator("#rail").isVisible(), false);
  const rail = await desk.locator("#rail").boundingBox(), bar = await desk.locator(".bar").boundingBox();
  assert.ok(rail.x + rail.width <= bar.x + 1 && rail.y <= bar.y + 1, "桌面对话列表应占据聊天栏左侧的独立一列");
  const mobileHeader = await owner.locator(".bar").evaluate(el => {
    const bar = el.getBoundingClientRect(), title = el.querySelector("#bot-name").getBoundingClientRect();
    const avatar = el.querySelector("#active-avatar").getBoundingClientRect(), back = el.querySelector("#choose").getBoundingClientRect();
    return { height: bar.height, centerError: Math.abs(title.left + title.width / 2 - (bar.left + bar.width / 2)), ordered: back.right <= title.left && avatar.left >= title.right };
  });
  assert.ok(mobileHeader.height <= 64 && mobileHeader.centerError < 2 && mobileHeader.ordered,
    "手机聊天标题应位于紧凑顶栏中线，左右分别为返回和头像 " + JSON.stringify(mobileHeader));
  await shot(owner, "bot-mobile-welcome");
  await shot(desk, "bot-desktop-welcome");
  const surfaceColors = page => page.evaluate(() =>
    [document.documentElement, document.body, document.getElementById("chat"), document.getElementById("scroll")]
      .map(el => getComputedStyle(el).backgroundColor));
  const lightColors = await surfaceColors(owner);
  await checkComposer(desk);
  const settingsButton = desk.getByRole("button", { name: "对话设置", exact: true });
  await settingsButton.focus();
  await desk.keyboard.press("Enter");
  await desk.getByRole("dialog").waitFor();
  assert.equal(await desk.evaluate(() => !!document.activeElement?.closest("dialog[open]")), true);
  await desk.keyboard.press("Escape");
  assert.equal(await settingsButton.evaluate(el => document.activeElement === el), true);
  await owner.setViewportSize({ width: 320, height: 640 });
  await owner.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  assert.notDeepEqual(await surfaceColors(owner), lightColors, "深浅模式需要切换实际界面底色");
  await shot(owner, "bot-mobile-dark-welcome");
  await checkComposer(owner);
  await open(owner, "跟进一件事");
  await owner.getByRole("textbox", { name: "事情名称" }).waitFor();
  await shot(owner, "bot-mobile-dark-followup");
  await owner.keyboard.press("Escape");
  assert.equal(await owner.locator("dialog").isVisible(), false);
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await open(owner, "对话设置");
  await open(owner, "技能与工具");
  await open(owner, "添加技能");
  await owner.getByLabel("技能名称（必填）").fill("阅读通知");
  await owner.getByLabel("技能说明（必填）").fill("先列出时间和地点。");
  await open(owner, "保存");
  await owner.getByRole("dialog").getByText("阅读通知", { exact: true }).waitFor();
  await open(owner, "编辑技能");
  await owner.getByLabel("在这个 Bot 的聊天中启用").uncheck();
  await open(owner, "保存");
  await owner.getByRole("dialog").getByText("已停用").waitFor();
  await open(owner, "导入技能包");
  const { writeZip } = await fromPackage("src/core/zip.ts");
  const bundle = writeZip([{ path: "guide/SKILL.md", data: Buffer.from("---\nname: browser-guide\n---\n使用模板") },
    { path: "guide/templates/note.txt", data: Buffer.from("测试") }]);
  await owner.getByLabel("选择 ZIP 或 .skill 文件").setInputFiles({ name: "guide.skill", mimeType: "application/zip", buffer: bundle });
  await open(owner, "保存");
  await owner.getByText("1 个附带文件").click();
  await owner.getByText("templates/note.txt", { exact: true }).waitFor();
  let toolCount = 0;
  const mcp = createServer(async (req, res) => {
    if (req.method !== "POST") return res.writeHead(405).end();
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const msg = JSON.parse(Buffer.concat(chunks));
    if (msg.id == null) return res.writeHead(202).end();
    let result;
    if (msg.method === "initialize") result = { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "browser", version: "1" } };
    if (msg.method === "tools/list") result = { tools: [{ name: "read_status", inputSchema: { type: "object" } }] };
    if (msg.method === "tools/call") { toolCount++; result = { content: [{ type: "text", text: "服务确认收到" }] }; }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  }).listen(0, "127.0.0.1");
  await once(mcp, "listening");
  t.after(() => { mcp.closeAllConnections(); mcp.close(); });
  await open(owner, "添加 HTTP 连接");
  await owner.getByLabel("连接名称（必填）").fill("测试连接");
  await owner.getByLabel("Streamable HTTP 地址（必填）").fill("http://127.0.0.1:" + mcp.address().port + "/mcp");
  await owner.getByLabel("Bearer 令牌（可选）").fill("browser-fixture");
  await open(owner, "保存");
  const listing = owner.waitForResponse(r => r.url().endsWith("/discover") && r.request().method() === "POST");
  await open(owner, "读取工具列表");
  const listed = await listing;
  assert.ok(listed.ok(), JSON.stringify(await listed.json()));
  await owner.getByRole("combobox", { name: /read_status/ }).selectOption("ask-private");
  await open(owner, "保存");
  await open(owner, "管理工具");
  await open(owner, "编辑连接");
  assert.equal(await owner.getByLabel("Bearer 令牌（可选）").inputValue(), "");
  await open(owner, "取消");
  await open(owner, "返回设置");
  await open(owner, "关闭");
  for (const [page, size] of [[owner, "mobile"], [desk, "desktop"]]) {
    await open(page, "对话设置");
    await open(page, "Bot 资料");
    await page.getByLabel("主要职责").waitFor();
    await open(page, "生活助手");
    assert.match(await page.getByLabel("主要职责").inputValue(), /日常/);
    await shot(page, "bot-" + size + "-profile");
    if (size === "mobile") {
      await page.getByText("引擎、模型与能力", { exact: true }).click();
      await page.getByLabel("使用的引擎").selectOption("codex");
      await open(page, "保存资料");
      await page.getByRole("heading", { name: "对话设置" }).waitFor();
      await open(page, "技能与工具");
      await open(page, "Codex 自带工具");
      await page.getByLabel("联网搜索").selectOption("members");
      await page.getByLabel("执行终端命令").check();
      await page.getByLabel("服务器工作目录", { exact: false }).fill(home);
      await open(page, "保存");
      await open(page, "Codex 自带工具");
      assert.equal(await page.getByLabel("联网搜索").inputValue(), "members");
      assert.equal(await page.getByLabel("执行终端命令").isChecked(), true);
      assert.equal(await page.getByLabel("编辑文件").isChecked(), false);
      await open(page, "取消");
      await open(page, "返回设置");
      await open(page, "Bot 资料");
      await page.getByText("引擎、模型与能力", { exact: true }).click();
      assert.equal(await page.getByLabel("使用的引擎").inputValue(), "codex");
      await page.getByLabel("使用的引擎").selectOption("pi");
      await open(page, "保存资料");
      await page.getByRole("heading", { name: "对话设置" }).waitFor();
    }
    await open(page, "关闭");
  }
  await owner.getByRole("textbox", { name: "消息", exact: true }).fill("确认测试");
  await open(owner, "发送消息");
  await owner.getByRole("button", { name: "允许这一次" }).waitFor();
  await owner.reload();
  await owner.locator(".tool-call pre").filter({ hasText: "测试参数" }).waitFor();
  assert.equal(toolCount, 0);
  await open(owner, "允许这一次");
  await owner.locator("#messages").getByText("收到：确认测试", { exact: true }).waitFor();
  assert.equal(toolCount, 1);
  await owner.getByText("调用结果", { exact: true }).click();
  await owner.getByText("服务确认收到", { exact: true }).waitFor();
  await owner.getByRole("textbox", { name: "消息", exact: true }).fill("请记住：清单按购买地点分组");
  await open(owner, "发送消息");
  await owner.getByLabel("记住的内容").waitFor();
  assert.equal(await owner.getByLabel("记住的内容").inputValue(), "清单按购买地点分组");
  await open(owner, "保存私人记忆");
  await owner.locator("#status").filter({hasText:/已记住，可以在/}).waitFor();
  await open(owner, "对话设置");
  await open(owner, "记住的事");
  await owner.getByRole("dialog").getByText("清单按购买地点分组", { exact: true }).waitFor();
  await open(owner, "关闭");
  await open(owner, "对话设置");
  await open(owner, "请其他 Bot 帮忙");
  await owner.getByLabel("任务内容").fill("帮我按人数列一份野餐清单");
  await open(owner, "预览发送内容");
  await owner.getByRole("heading", { name: "确认交给 清单搭档？" }).waitFor();
  await shot(owner, "bot-mobile-consent");
  await desk.reload();
  await desk.locator("#delegation-cards button").click();
  await desk.getByRole("heading", { name: "确认交给 清单搭档？" }).waitFor();
  await shot(desk, "bot-desktop-consent");
  await open(desk, "关闭");
  assert.equal(delegated.length, 0);
  await owner.getByLabel("交给对方的完整内容").fill("帮我按人数列一份露营清单");
  await open(owner, "确认发送");
  await owner.locator("#messages").getByText(/建议先确定人数/).waitFor();
  assert.deepEqual(delegated, ["帮我按人数列一份露营清单"]);
  await write(owner, "想安排一次周末野餐", "可以从这份两人清单开始。");
  await desk.reload();
  await desk.locator("#messages").getByText("可以从这份两人清单开始。", { exact: true }).waitFor();
  for (const page of [owner, desk]) {
    const reply = page.locator(".reply-text", { hasText: "两人清单" });
    assert.equal(await reply.locator("strong").count(), 2);
    assert.equal(await reply.locator("ul > li").count(), 2);
    assert.equal(await reply.locator("ol > li").count(), 2);
    const delegation = page.locator(".line.assistant", { hasText: "建议先确定人数" });
    assert.equal(await delegation.locator(".who .bot-avatar").textContent(), "清");
  }
  await shot(owner, "bot-mobile-chat");
  await shot(desk, "bot-desktop-chat");
  for (const [page, size] of [[owner, "mobile"], [desk, "desktop"]]) {
    const trigger = page.getByRole("button", {name:"添加", exact:true});
    await trigger.click();
    const menu = page.locator("#compose-actions");
    await menu.waitFor();
    const triggerBox = await trigger.boundingBox(), menuBox = await menu.boundingBox();
    const gap = triggerBox.y - (menuBox.y + menuBox.height);
    assert.ok(Math.abs(triggerBox.x - menuBox.x) <= 3 && gap >= 3 && gap <= 18,
      "添加菜单应紧贴按钮上方 " + JSON.stringify({ size, triggerBox, menuBox }));
    assert.equal(await menu.getByRole("menuitem", {name:"照片"}).isVisible(), true);
    await shot(page, "bot-" + size + "-add-menu");
    await page.keyboard.press("Escape");
    await menu.waitFor({state:"hidden"});
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
    await trigger.click();
    await menu.getByRole("menuitem", {name:"提醒"}).click();
    const panel = page.getByRole("dialog", {name:"新提醒"});
    await panel.waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.matches("input,textarea")), false);
    await panel.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    const bounds = await panel.boundingBox(), {width,height} = page.viewportSize();
    const geometry = JSON.stringify({bounds, width, height});
    if (size === "mobile") {
      assert.ok(bounds.x <= 1 && Math.abs(bounds.width - width) <= 2 && Math.abs(bounds.y + bounds.height - height) <= 2, "手机提醒面板应贴底并与屏幕同宽 " + geometry);
    } else {
      assert.ok(Math.abs(bounds.x + bounds.width/2 - width/2) <= 2 && Math.abs(bounds.y + bounds.height/2 - height/2) <= 2, "PC 提醒弹窗应位于窗口中央 " + geometry);
    }
    const add = panel.getByRole("button", {name:"添加",exact:true});
    assert.equal(await add.isDisabled(), true);
    await panel.getByLabel("内容",{exact:true}).fill("周末带上水壶");
    await panel.getByLabel("内容",{exact:true}).blur();
    assert.equal(await add.isEnabled(), true);
    await shot(page, "bot-" + size + "-reminder");
    if (size === "mobile") {
      await panel.getByRole("button", {name:"取消",exact:true}).click();
    } else {
      await add.click();
      await panel.waitFor({state:"hidden"});
      await page.reload();
      await open(page, "1 个待提醒");
      await page.getByRole("dialog").getByRole("button", {name:/周末带上水壶/}).click();
      await open(page, "取消这个提醒");
      await page.locator("#reminders").waitFor({state:"hidden"});
    }
  }
  for (const [page, size] of [[owner, "mobile"], [desk, "desktop"]]) {
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(page, "bot-" + size + "-dark-chat");
  }
  await owner.emulateMedia({ colorScheme: "light" });
  // A reduced visible height approximates the space left to a composer above a phone keyboard.
  await owner.setViewportSize({ width: 390, height: 470 });
  await checkComposer(owner);
  await owner.setViewportSize({ width: 390, height: 844 });
  await deskContext.close();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWNgcFkFQhAKABduA7lrxR6YAAAAAElFTkSuQmCC",
    "base64",
  );
  await owner.locator("#photo").setInputFiles({ name: "notice.png", mimeType: "image/png", buffer: png });
  await owner.getByRole("img", { name: "待发送的照片" }).waitFor();
  await write(owner, "看这张通知，提醒我带水壶");
  assert.equal(seen.at(-1).hasPhoto, true);
  await open(owner, "1 个待提醒");
  await owner.getByRole("dialog").getByRole("button", { name: /带水壶/ }).click();
  await owner.getByLabel("提醒时间").fill(new Date(Date.now() + 86400_000).toISOString().slice(0, 16));
  await open(owner, "保存时间");
  await owner.locator("#messages").getByText("已更新提醒：带水壶",{exact:true}).waitFor();
  await open(owner, "1 个待提醒");
  await owner.getByRole("dialog").getByRole("button", { name: /带水壶/ }).click();
  await open(owner, "取消这个提醒");
  await owner.locator("#messages").getByText("已取消提醒：带水壶",{exact:true}).waitFor();
  // A notification can open a different thread while text and a photo are still being composed.
  const composer = owner.getByRole("textbox", {name:"消息", exact:true});
  const preview = owner.getByRole("img", {name:"待发送的照片"});
  const transitions = [];
  async function draftState() {
    return owner.evaluate(() => ({
      url:location.href, thread:document.querySelector("#rail-list [aria-current=true]")?.dataset.thread,
      name:document.querySelector("#bot-name").textContent, text:document.querySelector("#message").value,
      photo:!!document.querySelector("#preview img"), timeOrigin:performance.timeOrigin,
      pane:document.querySelector("#chat").dataset.pane,
    }));
  }
  async function followDeviceLink(url) {
    const before = await draftState();
    await owner.evaluate(link => navigator.serviceWorker.dispatchEvent(new MessageEvent("message", {data:{type:"open",url:link}})), url);
    await owner.waitForURL(url);
    const after = await draftState();
    transitions.push({before, after, target:url});
    const diagnostic = JSON.stringify({privateURL, secondURL, transitions});
    assert.equal(after.thread, new URL(url).searchParams.get("thread"), diagnostic);
    assert.equal(after.timeOrigin, before.timeOrigin, "通知跳转意外刷新整个页面 " + diagnostic);
    return diagnostic;
  }
  await composer.fill(retryText);
  await owner.locator("#photo").setInputFiles({name:"draft.png",mimeType:"image/png",buffer:png});
  await preview.waitFor();
  assert.equal(await composer.inputValue(),retryText, "离开原对话前草稿应已就绪 " + JSON.stringify(await draftState()));
  await followDeviceLink(secondURL);
  assert.equal(await composer.inputValue(), "");
  assert.equal(await preview.count(), 0);
  await composer.fill("另一段对话的草稿");
  const restored = await followDeviceLink(privateURL);
  assert.equal(await composer.inputValue(), retryText, restored);
  await preview.waitFor();
  await open(owner, "发送消息");
  await owner.getByRole("button", {name:"重新发送",exact:true}).waitFor();
  await shot(owner, "bot-mobile-retry");
  await open(owner, "重新发送");
  await owner.locator("#messages").getByText("收到：" + retryText, {exact:true}).waitFor();
  assert.deepEqual(seen.filter(x => x.data.latest.text === retryText).map(x => x.hasPhoto), [true, true]);
  await followDeviceLink(secondURL);
  assert.equal(await composer.inputValue(), "另一段对话的草稿");
  await followDeviceLink(privateURL);
  assert.equal(await composer.inputValue(), "");
  await open(owner, "对话设置");
  await open(owner, "请其他 Bot 帮忙");
  await open(owner, "发起协作");
  await owner.getByLabel("任务内容").fill(unavailableTask);
  await open(owner, "预览发送内容");
  await open(owner, "确认发送");
  await owner.locator("#delegation-cards").getByText("未完成", {exact:true}).waitFor();
  await open(owner, "对话设置");
  await open(owner, "最近通知");
  await owner.getByRole("dialog").getByRole("button", {name:/未读，.*协作未完成/}).click();
  await owner.getByRole("dialog").getByText(unavailableTask, {exact:true}).waitFor();
  await owner.getByRole("button", {name:"确认重新发送"}).waitFor();
  await shot(owner, "bot-mobile-delegation-retry");
  await open(owner, "关闭");
  await open(owner, "对话设置");
  await open(owner, "最近通知");
  await owner.getByRole("dialog").getByRole("button", {name:/已读，.*协作未完成/}).waitFor();
  await open(owner, "关闭");
  await open(owner, "对话设置");
  await open(owner, "邀请成员");
  await open(owner, "生成邀请链接");
  const invite = await owner.getByLabel("邀请链接", { exact: true }).inputValue();
  await open(owner, "进入共享对话");
  assert.notEqual(owner.url(), privateURL);
  await write(owner, "一起整理购物清单");
  const guestContext = await browser.newContext({ ...display, viewport: { width: 1280, height: 800 } });
  const guest = await guestContext.newPage();
  guest.on("pageerror", (error) => errors.push(error.message));
  await guest.goto(invite);
  await guest.getByLabel("用户名", { exact: true }).fill("bob");
  await guest.getByLabel("密码（至少 8 位）").fill("fixture-guest-2026");
  await open(guest, "创建账号并加入");
  await guest.locator("#messages").getByText("一起整理购物清单", { exact: true }).waitFor();
  assert.equal(await guest.locator("#messages").getByText(/带水壶/).count(), 0);
  await write(guest, "我来买水");
  await owner.locator("#messages").getByText("我来买水", { exact: true }).waitFor();
  await shot(owner, "bot-shared");
  const sharedURL = owner.url();
  await open(owner, "添加");
  await owner.getByRole("menuitem", {name:"提醒"}).click();
  const privateReminder = "为下周旅行预订车票";
  const reminderForm = owner.getByRole("dialog", {name:"新提醒"});
  await reminderForm.getByLabel("内容", {exact:true}).fill(privateReminder);
  await reminderForm.getByRole("button", {name:"添加",exact:true}).click();
  await reminderForm.waitFor({state:"hidden"});
  async function readThreadAs(page, url) {
    const thread = new URL(url).searchParams.get("thread");
    const response = await page.request.get(base + "/api/bots/threads/" + encodeURIComponent(thread) + "/messages");
    assert.equal(response.status(), 200);
    return response.json();
  }
  const ownerPrivate = await readThreadAs(owner, privateURL);
  assert.ok(ownerPrivate.reminders.some(r => r.text === privateReminder), "在共享对话新建的私人提醒应归入本人私聊");
  for (const account of [owner, guest]) {
    const shared = await readThreadAs(account, sharedURL);
    assert.ok(!shared.reminders.some(r => r.text === privateReminder));
    assert.ok(!shared.messages.some(m => m.text?.includes(privateReminder)), "共享记录不得出现此私人提醒内容");
  }
  await guest.goto(privateURL);
  await guest.getByRole("heading", { name: "有什么想交给我？" }).waitFor();
  assert.equal(await guest.locator("#audience").innerText(), "仅你可见");
  await guest.goto(sharedURL);
  await guest.locator("#messages").getByText("我来买水", { exact: true }).waitFor();
  await open(owner, "对话设置");
  await open(owner, "管理共用成员");
  await open(owner, "移除");
  await open(owner, "确认移除");
  await guest.locator("#audience").filter({hasText:"仅你可见"}).waitFor();
  assert.equal(await guest.locator("#messages").getByText("一起整理购物清单", { exact: true }).count(), 0);
  await open(owner, "收回为仅自己可用");
  await open(owner, "停止共用");
  await owner.waitForURL(privateURL);
  await open(owner, "对话设置");
  await open(owner, "共享归档");
  await owner.getByRole("dialog").getByRole("button", { name: /条消息/ }).click();
  const dialog = owner.getByRole("dialog");
  await dialog.getByText("一起整理购物清单", { exact: true }).waitFor();
  await shot(owner, "bot-mobile-archive");
  await open(owner, "跟进记录");
  await dialog.getByRole("heading", { name: "共享归档 · 跟进记录" }).waitFor();
  await open(owner, "共享记忆");
  await dialog.getByRole("heading", { name: "共享归档 · 共享记忆" }).waitFor();
  await open(owner, "返回归档列表");
  await open(owner, "返回");
  await open(owner, "管理 Bot");
  await open(owner, "删除这个 Bot");
  assert.equal(await dialog.getByRole("button", { name: "返回", exact: true }).evaluate(el => el === document.activeElement), true);
  await open(owner, "永久删除 Bot");
  await owner.getByRole("heading", { name: "有什么想交给我？" }).waitFor();
  assert.notEqual(owner.url(), privateURL);
  assert.deepEqual(errors, []);
});
