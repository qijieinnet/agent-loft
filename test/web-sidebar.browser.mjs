// 浏览器回归：通过 AGENT_LOFT_PLAYWRIGHT、PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 指定本地浏览器。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const { chromium } = await import(process.env.AGENT_LOFT_PLAYWRIGHT || "playwright-core");
const root = new URL("../", import.meta.url);
const styles = (await fs.readFile(new URL("web/index.html", root), "utf8")).match(/<link[^>]+rel="stylesheet"[^>]*>/g).join("\n");
const vendor = {
  "/vendor/marked.js": "node_modules/marked/lib/marked.esm.js",
  "/vendor/purify.js": "node_modules/dompurify/dist/purify.es.mjs",
  "/vendor/hljs.js": "node_modules/@highlightjs/cdn-assets/es/highlight.min.js",
  "/vendor/hljs-light.css": "node_modules/@highlightjs/cdn-assets/styles/github.min.css",
  "/vendor/hljs-dark.css": "node_modules/@highlightjs/cdn-assets/styles/github-dark.min.css",
};
const defaults = ["search", "tasks", "library", "remote", "settings"].map((id) => ({ id, visible: id !== "settings" }));

async function fixture(t, { mobile = false, colorScheme = "light", feishu = false } = {}) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ["--no-sandbox"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: mobile ? 390 : 1280, height: 850 },
    isMobile: mobile, hasTouch: mobile, colorScheme, serviceWorkers: "block",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(() => { window.WebSocket = class { readyState = 0; close() {} send() {} }; });
  let saved = structuredClone(defaults);
  let saves = 0;
  let failSave = false;
  const conv = { key: "web:1", channel: "web", channelId: "web", agent: "claude", title: "Test", cwd: "/workspace", activeAt: 1, busy: false };
  const botConvs = Array.from({ length: 17 }, (_, i) => ({ ...conv, key: `feishu:bot:${i}`, channel: "feishu", channelId: "bot", title: `飞书聊天 ${i}`, activeAt: 100 - i, cwd: "/workspace/feishu", agent: "codex", expert: { id: "e_helper", name: "助手", engine: "codex" } }));
  let botLoads = 0;
  let failBotLoad = false;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/")) {
      let data = { ok: true };
      if (url.pathname === "/api/me") data = { authed: true, user: { id: "u1", role: "admin" } };
      if (url.pathname === "/api/bootstrap") data = {
        user: { id: "u1", role: "admin" }, agents: feishu ? [{ id: "claude", enabled: true, available: true }, { id: "codex", enabled: true, available: true }] : [],
        experts: feishu ? [botConvs[0].expert] : [],
        bots: feishu ? [{ id: "bot", name: "阿奇", agents: ["codex"] }, { id: "empty", name: "空机器人", agents: ["claude"] }] : [], pending: [],
        conversations: feishu ? [...new Map([conv, botConvs[0], botConvs.find((c) => c.key === url.searchParams.get("current"))].filter(Boolean).map((c) => [c.key, c])).values()] : [conv],
        workspaceRoot: "/workspace", quotaEnabled: false, sidebarNav: saved,
        remote: { allowed: true, terminal: { allowed: true, available: true } },
        sidebar: { recent: { next: null }, dirs: [{ dir: "/workspace", at: 1, next: null }] },
      };
      if (url.pathname.endsWith("/history")) {
        const key = decodeURIComponent(url.pathname.split("/")[3]);
        data = { info: [conv, ...botConvs].find((c) => c.key === key), allowedAgents: [], messages: [], live: [], pending: [], seq: 0 };
      }
      if (url.pathname.startsWith("/api/agents/")) data = { models: [] };
      if (url.pathname === "/api/conversations/page" && url.searchParams.get("scope") === "bot") {
        botLoads++;
        if (failBotLoad) return route.fulfill({ status: 500, json: { error: "测试加载失败" } });
        const list = url.searchParams.get("bot") === "bot" ? botConvs : [];
        const start = url.searchParams.has("key") ? list.findIndex((c) => c.key === url.searchParams.get("key")) + 1 : 0;
        const items = list.slice(start, start + Number(url.searchParams.get("limit") || 200));
        const last = items.at(-1);
        data = { conversations: items, next: last && start + items.length < list.length ? { at: last.activeAt, key: last.key } : null };
      }
      if (url.pathname === "/api/ui/sidebar-nav") {
        saves++;
        if (failSave) return route.fulfill({ status: 500, json: { error: "测试保存失败" } });
        saved = route.request().postDataJSON().items;
        data = { items: saved };
      }
      return route.fulfill({ json: data });
    }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `
      <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${styles}<div id="app"></div><script type="module">
        import { S, ui } from '/state.js'; import { boot } from '/views/layout.js'; import { renderSidebar } from '/views/sidebar.js';
        window.S = S; window.ui = ui; window.renderSidebar = renderSidebar; await boot(); window.booted = true;
      </script>` });
    try {
      return route.fulfill({ contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript", body: await fs.readFile(new URL(vendor[url.pathname] ?? `web${url.pathname}`, root), "utf8") });
    } catch { return route.fulfill({ status: 404, body: "" }); }
  });
  await page.goto("https://sidebar.example.test/#web%3A1");
  await page.waitForFunction(() => window.booted);
  if (mobile) await page.locator(".topbar .menu-btn").click();
  return { page, getSaved: () => saved, getSaves: () => saves, failSave: (value = true) => { failSave = value; }, getBotLoads: () => botLoads, failBotLoad: (value = true) => { failBotLoad = value; } };
}

for (const mobile of [false, true]) {
  test(`${mobile ? "触屏" : "桌面"}：飞书分组展开、分页、记住折叠状态，加号继承专家和目录`, async (t) => {
    const { page, getBotLoads } = await fixture(t, { mobile, feishu: true });
    const bot = page.locator('[data-bot="bot"]');
    const header = bot.locator(".conv-item.proj");
    const chats = page.locator('.conv-list [data-key^="feishu:bot:"]');
    assert.equal(getBotLoads(), 0);
    assert.equal(await header.getAttribute("aria-expanded"), "false");
    assert.equal(await bot.locator(".feishu-mark").isVisible(), !mobile);
    assert.equal(await bot.locator(".bot-plus").isVisible(), mobile);
    if (!mobile) {
      await header.hover();
      assert.equal(await bot.locator(".feishu-mark").isVisible(), false);
      assert.equal(await bot.locator(".bot-plus").isVisible(), true);
      await page.mouse.move(1000, 100);
      assert.equal(await bot.locator(".feishu-mark").isVisible(), true);
      await bot.locator(".bot-new").focus();
      assert.equal(await bot.locator(".bot-plus").isVisible(), true);
    }
    await header.click();
    await page.waitForFunction(() => document.querySelectorAll('.conv-list [data-key^="feishu:bot:"]').length === 5);
    assert.equal(await chats.first().locator(".title").textContent(), "飞书聊天 0");
    assert.equal(getBotLoads(), 1);
    await page.locator(".sub-more .conv-more").getByText("展开显示", { exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.conv-list [data-key^="feishu:bot:"]').length === 15);
    await page.locator(".sub-more .conv-more").getByText("展开显示", { exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.conv-list [data-key^="feishu:bot:"]').length === 17);
    await page.locator(".sub-more .conv-more").getByText("收起", { exact: true }).click();
    assert.equal(await chats.count(), 5);
    await header.click();
    assert.equal(await chats.count(), 0);
    await page.reload();
    await page.waitForFunction(() => window.booted);
    if (mobile) await page.locator(".topbar .menu-btn").click();
    assert.equal(await header.getAttribute("aria-expanded"), "false");
    await header.click();
    await page.waitForFunction(() => document.querySelectorAll('.conv-list [data-key^="feishu:bot:"]').length === 5);
    await chats.nth(2).click();
    await page.waitForFunction(() => S.current === "feishu:bot:2");
    if (mobile) await page.locator(".topbar .menu-btn").click();
    assert.equal(await chats.nth(2).evaluate((el) => el.classList.contains("active")), true);
    await header.click();
    assert.equal(await chats.count(), 0, "当前会话所在分组也能折叠");
    await bot.locator(".bot-new").click();
    assert.deepEqual(await page.evaluate(() => [S.current, S.draftExpert, S.draftAgent, S.draftCwd, S.draftCwdPicked]), [null, "e_helper", "codex", "/workspace/feishu", true]);
    assert.equal(await page.locator(".modal").count(), 0);
    if (mobile) await page.locator(".topbar .menu-btn").click();
    await page.locator('[data-bot="empty"] .conv-item.proj').click();
    await page.getByText("还没有会话", { exact: true }).waitFor();
  });
}

test("飞书分组：加载失败可重试，刷新后补齐展开的列表，直达会话自动展开", async (t) => {
  const { page, failBotLoad } = await fixture(t, { feishu: true });
  const header = page.locator('[data-bot="bot"] .conv-item.proj');
  failBotLoad();
  await header.click();
  await page.getByRole("button", { name: "加载失败，点击重试", exact: true }).waitFor();
  failBotLoad(false);
  await page.getByRole("button", { name: "加载失败，点击重试", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.conv-list [data-key^="feishu:bot:"]').length === 5);
  await page.reload();
  await page.waitForFunction(() => window.booted && document.querySelectorAll('.conv-list [data-key^="feishu:bot:"]').length === 5);
  await header.click();
  await page.goto("https://sidebar.example.test/#feishu%3Abot%3A2");
  await page.reload();
  await page.waitForFunction(() => window.booted && document.querySelectorAll('.conv-list [data-key^="feishu:bot:"]').length === 5);
  assert.equal(await header.getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator('[data-key="feishu:bot:2"]').evaluate((el) => el.classList.contains("active")), true);
});

async function openEditor(page, mobile = false) {
  const more = page.locator("#sidebar-more");
  if (mobile) await more.tap();
  else { await more.focus(); await more.press("ArrowDown"); }
  await page.getByRole("menuitem", { name: "编辑侧边栏", exact: true }).click();
  await page.getByRole("dialog", { name: "编辑侧边栏", exact: true }).waitFor();
}

test("更多：悬停跨过间隙可操作，离开关闭；点击固定，键盘可关闭，设置从顶栏移走", async (t) => {
  const { page } = await fixture(t);
  const more = page.locator("#sidebar-more");
  await more.hover();
  const menu = page.getByRole("menu", { name: "更多菜单" });
  await menu.waitFor();
  assert.equal(await page.getByRole("menuitem", { name: "设置", exact: true }).isVisible(), true);
  await page.getByRole("menuitem", { name: "编辑侧边栏", exact: true }).hover();
  await page.waitForTimeout(300);
  assert.equal(await menu.isVisible(), true);
  await page.mouse.move(1100, 700);
  await menu.waitFor({ state: "detached" });
  assert.equal(await more.getAttribute("aria-expanded"), "false");
  await more.click();
  await page.mouse.move(1100, 700);
  await page.waitForTimeout(300);
  assert.equal(await menu.isVisible(), true);
  await more.focus();
  await more.press("ArrowDown");
  await page.keyboard.press("Escape");
  assert.equal(await more.evaluate((el) => el === document.activeElement), true);
  await page.locator(".top-more").click();
  assert.equal(await page.locator(".top-menu").getByRole("button", { name: "设置", exact: true }).count(), 0);
  assert.equal(await page.locator(".top-menu").getByRole("button", { name: "定时发送", exact: true }).isVisible(), true);
});

for (const mobile of [false, true]) {
  for (const colorScheme of ["light", "dark"]) {
    test(`${mobile ? "触屏" : "桌面"} ${colorScheme}：勾选、拖动、保存、刷新，收起的菜单保持顺序和状态`, async (t) => {
      const { page, getSaved } = await fixture(t, { mobile, colorScheme });
      await openEditor(page, mobile);
      const dialog = page.getByRole("dialog", { name: "编辑侧边栏", exact: true });
      await dialog.getByRole("checkbox", { name: "定时任务", exact: true }).uncheck();
      await dialog.getByRole("checkbox", { name: "远程控制", exact: true }).uncheck();
      const grip = dialog.getByRole("button", { name: "调整资料库顺序", exact: true });
      const from = await grip.boundingBox();
      const target = await dialog.locator('[data-nav="search"]').boundingBox();
      if (mobile) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x + from.width / 2, y: from.y + from.height / 2 }] });
        for (let step = 1; step <= 10; step++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + from.width / 2, y: from.y + (target.y - from.y) * step / 10 }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } else {
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
        await page.mouse.down();
        await page.mouse.move(from.x + from.width / 2, target.y + 4, { steps: 12 });
        await page.mouse.up();
      }
      assert.equal(await dialog.locator(".sidebar-edit-row").first().getAttribute("data-nav"), "library");
      await page.screenshot({ path: `/tmp/agent-loft-sidebar-editor-${mobile ? "mobile" : "desktop"}-${colorScheme}.png` });
      await dialog.getByRole("button", { name: "完成", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      assert.deepEqual(getSaved().filter((it) => it.visible).map((it) => it.id), ["library", "search"]);
      assert.deepEqual(await page.locator(".sidebar-nav [data-nav]").evaluateAll((els) => els.map((el) => el.dataset.nav)), ["library", "search"]);
      await page.reload();
      await page.waitForFunction(() => window.booted);
      if (mobile) await page.locator(".topbar .menu-btn").click();
      assert.deepEqual(await page.locator(".sidebar-nav [data-nav]").evaluateAll((els) => els.map((el) => el.dataset.nav)), ["library", "search"]);
      await page.evaluate(() => { S.view = "remote"; S.remoteLive.terminals = 1; window.renderSidebar(); });
      assert.equal(await page.locator("#sidebar-more").evaluate((el) => el.classList.contains("active") && el.classList.contains("live")), true);
      if (mobile) await page.locator("#sidebar-more").tap();
      else { await page.locator("#sidebar-more").focus(); await page.keyboard.press("ArrowDown"); }
      assert.deepEqual(await page.locator(".side-more-menu [data-nav]").evaluateAll((els) => els.map((el) => el.dataset.nav)), ["tasks", "remote", "settings"]);
      assert.equal(await page.locator('.side-more-menu [data-nav="remote"]').evaluate((el) => el.classList.contains("active") && el.classList.contains("live")), true);
      const rect = await page.locator(".side-more-menu").boundingBox();
      const viewport = page.viewportSize();
      assert.ok(rect.x >= 0 && rect.x + rect.width <= viewport.width && rect.y + rect.height <= viewport.height);
      await page.screenshot({ path: `/tmp/agent-loft-sidebar-${mobile ? "mobile" : "desktop"}-${colorScheme}.png` });
    });
  }
}

test("编辑：取消不保存；保存失败保留编辑；支持键盘排序和把所有菜单收进更多", async (t) => {
  const { page, getSaves, failSave } = await fixture(t);
  await openEditor(page);
  let dialog = page.getByRole("dialog", { name: "编辑侧边栏", exact: true });
  await dialog.getByRole("checkbox", { name: "搜索", exact: true }).uncheck();
  await page.keyboard.press("Escape");
  await page.locator(".overlay").click({ position: { x: 1, y: 1 } });
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await dialog.getByRole("checkbox", { name: "搜索", exact: true }).isChecked(), false);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(getSaves(), 0);
  assert.equal(await page.locator('.sidebar-nav [data-nav="search"]').isVisible(), true);
  await openEditor(page);
  dialog = page.getByRole("dialog", { name: "编辑侧边栏", exact: true });
  await dialog.getByRole("button", { name: "调整定时任务顺序", exact: true }).press("ArrowUp");
  assert.equal(await dialog.locator(".sidebar-edit-row").first().getAttribute("data-nav"), "tasks");
  for (const checkbox of await dialog.getByRole("checkbox").all()) await checkbox.uncheck();
  failSave();
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByText("侧边栏保存失败：测试保存失败", { exact: true }).waitFor();
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await dialog.getByRole("checkbox", { checked: true }).count(), 0);
  assert.equal(await dialog.getByRole("button", { name: "完成", exact: true }).isEnabled(), true);
  assert.equal(await page.locator('.sidebar-nav [data-nav="search"]').isVisible(), true);
  failSave(false);
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await page.locator(".sidebar-nav [data-nav]").count(), 0);
  assert.equal(await page.locator(".side-top .new-chat").isVisible(), true);
  await page.locator("#sidebar-more").focus();
  await page.keyboard.press("ArrowDown");
  assert.deepEqual(await page.locator(".side-more-menu [data-nav]").evaluateAll((els) => els.map((el) => el.dataset.nav)), ["tasks", "search", "library", "remote", "settings"]);
});
