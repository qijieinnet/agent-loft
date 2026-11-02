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

async function fixture(t, { mobile = false, colorScheme = "light", feishu = false, projects = false, order = null, bootstrap = {} } = {}) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    // 验证页面手势时关闭 Chromium 自身的横滑历史导航。
    args: ["--no-sandbox", "--disable-features=TouchpadOverscrollHistoryNavigation,OverscrollHistoryNavigation", "--overscroll-history-navigation=0"],
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
  let dirOrder = order;
  const projectConvs = projects ? ["a", "b"].map((id, i) => ({ ...conv, key: `web:${id}`, title: `项目 ${id}`, cwd: `/workspace/project-${id}`, activeAt: i + 2 })) : [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/")) {
      let data = { ok: true };
      if (url.pathname === "/api/me") data = { authed: true, user: { id: "u1", role: "admin" } };
      if (url.pathname === "/api/bootstrap") data = {
        user: { id: "u1", role: "admin" }, agents: feishu ? [{ id: "claude", enabled: true, available: true }, { id: "codex", enabled: true, available: true }] : [],
        experts: feishu ? [botConvs[0].expert] : [],
        bots: feishu ? [{ id: "bot", name: "阿奇", agents: ["codex"] }, { id: "empty", name: "空机器人", agents: ["claude"] }] : [], pending: [],
        conversations: [...projectConvs, ...(feishu ? [...new Map([conv, botConvs[0], botConvs.find((c) => c.key === url.searchParams.get("current"))].filter(Boolean).map((c) => [c.key, c])).values()] : [conv])],
        workspaceRoot: "/workspace", quotaEnabled: false, sidebarNav: saved,
        remote: { allowed: true, terminal: { allowed: true, available: true } },
        dirOrder,
        sidebar: { recent: { next: null }, dirs: [conv, ...projectConvs].map((c) => ({ dir: c.cwd, at: c.activeAt, next: null })) },
        ...bootstrap,
      };
      if (url.pathname.endsWith("/history")) {
        const key = decodeURIComponent(url.pathname.split("/")[3]);
        data = { info: [...(bootstrap.conversations ?? []), conv, ...botConvs].find((c) => c.key === key), allowedAgents: [], messages: [], live: [], pending: [], seq: 0 };
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
      if (url.pathname === "/api/conversations/page" && url.searchParams.get("scope") === "weixin") {
        const list = (bootstrap.conversations ?? []).filter((c) => c.channel === "weixin" && c.channelId === url.searchParams.get("user")).sort((a, b) => b.activeAt - a.activeAt);
        const start = url.searchParams.has("key") ? list.findIndex((c) => c.key === url.searchParams.get("key")) + 1 : 0;
        const items = list.slice(start, start + Number(url.searchParams.get("limit") || 5));
        const last = items.at(-1);
        data = { conversations: items, next: last && start + items.length < list.length ? { at: last.activeAt, key: last.key } : null };
      }
      if (url.pathname === "/api/ui/sidebar-nav") {
        saves++;
        if (failSave) return route.fulfill({ status: 500, json: { error: "测试保存失败" } });
        saved = route.request().postDataJSON().items;
        data = { items: saved };
      }
      if (url.pathname === "/api/ui/dir-order") {
        const body = route.request().postDataJSON();
        dirOrder = body.order ?? [...new Set([...(dirOrder ?? []), ...(body.append ?? [])])];
        data = { order: dirOrder };
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
  return { page, getSaved: () => saved, getSaves: () => saves, failSave: (value = true) => { failSave = value; }, getBotLoads: () => botLoads, failBotLoad: (value = true) => { failBotLoad = value; }, getOrder: () => dirOrder };
}

const groupOrder = (page) => page.locator(".conv-list .proj-row").evaluateAll((rows) => rows.map((row) => row.dataset.group));

async function touchInput(page) {
  const client = await page.context().newCDPSession(page);
  const point = (x, y, id = 0) => ({ x, y, id });
  const dispatch = (type, touchPoints = []) => client.send("Input.dispatchTouchEvent", { type, touchPoints });
  return {
    start: (x, y) => dispatch("touchStart", [point(x, y)]),
    move: (x, y) => dispatch("touchMove", [point(x, y)]),
    end: () => dispatch("touchEnd"),
    cancel: () => dispatch("touchCancel"),
    multi: (x, y) => dispatch("touchStart", [point(x, y), point(x + 30, y, 1)]),
  };
}

test("侧栏手势：左边缘右滑跟手展开，左滑收起，短滑回弹且不点击起点按钮", async (t) => {
  const { page } = await fixture(t, { mobile: true });
  const touch = await touchInput(page);
  const isOpen = () => page.locator(".layout").evaluate((el) => el.classList.contains("side-open"));
  await page.evaluate(async () => (await import("/views/sidebar.js")).closeSide());
  await page.waitForFunction(() => ui.sidebar.getBoundingClientRect().right <= 0);
  assert.equal(await page.locator(".sidebar").evaluate((el) => getComputedStyle(el).boxShadow), "none", "收起时无左边缘残留投影");

  await touch.start(20, 420);
  await touch.move(120, 420);
  assert.equal(await page.locator(".layout").evaluate((el) => el.classList.contains("side-dragging")), true);
  const drag = await page.evaluate(() => ({ right: ui.sidebar.getBoundingClientRect().right, opacity: Number(getComputedStyle(document.querySelector(".scrim")).opacity) }));
  assert.ok(Math.abs(drag.right - 100) < 2, "侧栏随手指移动 100px");
  assert.ok(drag.opacity > 0 && drag.opacity < 1, "遮罩随展开程度变化");
  await touch.end();
  assert.equal(await isOpen(), true);
  await page.waitForFunction(() => ui.sidebar.getBoundingClientRect().left === 0);

  // 从新建按钮上左滑，不能误触新建会话。
  const button = await page.locator(".side-top .new-chat").boundingBox();
  const y = button.y + button.height / 2;
  await touch.start(200, y);
  await touch.move(90, y);
  await touch.move(40, y);
  await touch.end();
  assert.equal(await isOpen(), false);
  assert.equal(await page.evaluate(() => S.current), "web:1");
  await page.waitForFunction(() => ui.sidebar.getBoundingClientRect().right <= 0);

  await touch.start(20, 420);
  await touch.move(36, 420);
  await touch.end();
  assert.equal(await isOpen(), false, "短滑恢复收起状态");
  await page.locator(".menu-btn").tap();
  assert.equal(await isOpen(), true, "横滑后的下一次点击仍然可用");
});

test("侧栏手势：非边缘、纵向滚动、横向内容和多指取消均不误开", async (t) => {
  const { page } = await fixture(t, { mobile: true });
  const touch = await touchInput(page);
  await page.evaluate(async () => (await import("/views/sidebar.js")).closeSide());
  await page.waitForFunction(() => ui.sidebar.getBoundingClientRect().right <= 0);
  const assertClosed = async () => {
    assert.equal(await page.locator(".layout").evaluate((el) => el.classList.contains("side-open") || el.classList.contains("side-dragging")), false);
  };
  await touch.start(100, 420);
  await touch.move(220, 420);
  await touch.end();
  await assertClosed();

  await page.evaluate(() => { ui.msgInner.style.minHeight = "2400px"; ui.messages.scrollTop = 100; });
  await touch.start(20, 600);
  await touch.move(22, 560);
  await touch.move(24, 450);
  await touch.end();
  await assertClosed();
  assert.ok(await page.locator(".messages").evaluate((el) => el.scrollTop > 100), "纵向聊天滚动仍生效");

  await page.evaluate(() => {
    ui.messages.scrollTop = 0;
    const scroller = document.createElement("div");
    scroller.id = "horizontal-fixture";
    scroller.style.cssText = "position:absolute;left:0;top:300px;width:200px;height:80px;overflow-x:auto;z-index:6";
    scroller.innerHTML = '<div style="width:800px;height:60px">横向内容</div>';
    ui.main.append(scroller);
  });
  await touch.start(20, 340);
  await touch.move(150, 340);
  await touch.end();
  await assertClosed();

  await touch.start(20, 500);
  await touch.move(110, 500);
  await touch.multi(110, 500);
  await touch.cancel();
  await assertClosed();
  assert.equal(await page.locator(".layout").evaluate((el) => el.style.getPropertyValue("--side-reveal")), "");
});

for (const mobile of [false, true]) {
  test(`${mobile ? "触屏" : "桌面"}：多条微信会话归为同组、分页、刷新恢复并可打开旧会话`, async (t) => {
    const convs = Array.from({ length: 17 }, (_, i) => ({ key: `weixin:u1:${i}`, channel: "weixin", channelId: "u1", agent: "claude", cwd: "/workspace", title: `微信话题 ${i}`, activeAt: 100 - i }));
    const { page } = await fixture(t, { mobile, bootstrap: { conversations: [{ key: "web:1", channel: "web", channelId: "web", agent: "claude", cwd: "/workspace", activeAt: 1 }, ...convs] } });
    const group = page.locator('[data-group="weixin:weixin:u1"]');
    const header = group.locator(".conv-item.proj");
    const chats = page.locator('.conv-list [data-key^="weixin:"]');
    assert.equal(await group.count(), 1, "新 key 按账号归组，不会一条对话一个分组");
    await header.click();
    await page.waitForFunction(() => document.querySelectorAll('.conv-list [data-key^="weixin:"]').length === 5);
    await page.locator(".sub-more .conv-more").getByText("展开显示", { exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.conv-list [data-key^="weixin:"]').length === 15);
    await page.locator(".sub-more .conv-more").getByText("展开显示", { exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.conv-list [data-key^="weixin:"]').length === 17);
    await page.reload();
    await page.waitForFunction(() => window.booted && document.querySelectorAll('.conv-list [data-key^="weixin:"]').length === 5);
    if (mobile) await page.locator(".topbar .menu-btn").click();
    await chats.nth(2).click();
    await page.waitForFunction(() => S.current === "weixin:u1:2");
    if (mobile) await page.locator(".topbar .menu-btn").click();
    assert.equal(await header.getAttribute("aria-expanded"), "true");
    assert.equal(await chats.nth(2).evaluate((el) => el.classList.contains("active")), true);
    await header.click();
    assert.equal(await chats.count(), 0);
  });

  test(`${mobile ? "触屏" : "桌面"}：顶部新建与刷新沿用最近活跃会话的专家和目录`, async (t) => {
    const expert = { id: "e_helper", name: "助手", engine: "codex", cwd: "/workspace/expert-default" };
    const latest = { key: "web:latest", channel: "web", channelId: "web", agent: "codex", expert, cwd: "/workspace/recent", activeAt: 100, title: "最近会话", busy: false };
    const bootstrap = { experts: [expert], conversations: [
      latest,
      { ...latest, key: "web:hidden", hidden: true, activeAt: 200, cwd: "/workspace/hidden" },
      { ...latest, key: "web:1", agent: "claude", expert: undefined, cwd: "/workspace/older", activeAt: 1 },
    ] };
    const { page } = await fixture(t, { mobile, feishu: true, bootstrap });
    await page.evaluate(() => {
      S.draftExpert = "claude";
      S.draftAgent = "claude";
      S.draftCwd = "/workspace/stale";
      S.draftCwdPicked = true;
    });
    await page.locator(".side-top .new-chat").click();
    const selection = () => page.evaluate(() => [S.current, S.draftExpert, S.draftAgent, S.draftCwd, S.draftCwdPicked, location.hash]);
    assert.deepEqual(await selection(), [null, "e_helper", "codex", "/workspace/recent", true, "#new"]);
    assert.equal(await page.locator(".hero-dir").textContent(), "recent");

    // 刷新重新读取服务端最近会话，放弃未发送草稿里临时改过的选择。
    bootstrap.conversations[0] = { ...latest, cwd: "/workspace", activeAt: 300 };
    await page.evaluate(() => {
      S.draftCwd = "/workspace/unsent";
      localStorage.setItem("aim.expert", "claude");
      localStorage.setItem("aim.agent", "claude");
    });
    await page.reload();
    await page.waitForFunction(() => window.booted);
    assert.deepEqual(await selection(), [null, "e_helper", "codex", "/workspace", true, "#new"]);
    assert.equal(await page.locator(".hero-dir").textContent(), "workspace");

    // 根目录必须明确提交，不能落到这个专家的默认目录。
    let created;
    await page.route("**/api/conversations", async (route) => {
      created = route.request().postDataJSON();
      const info = { ...latest, key: "web:created", cwd: created.cwd };
      bootstrap.conversations.push(info);
      await route.fulfill({ json: info });
    });
    await page.evaluate(async () => {
      const { ensureConversation } = await import("/views/composer.js");
      await ensureConversation();
    });
    assert.deepEqual(created, { expert: "e_helper", cwd: "/workspace" });
    await page.reload();
    await page.waitForFunction(() => window.booted);
    assert.equal(await page.evaluate(() => S.current), "web:created", "创建后刷新仍打开该会话");
  });
}

test("顶部新建：旧会话沿用内置专家，不可用专家回退；没有历史会话时仍可刷新", async (t) => {
  const { page } = await fixture(t, { feishu: true });
  await page.evaluate(() => {
    S.convs.clear();
    S.convs.set("web:legacy", { key: "web:legacy", agent: "codex", cwd: "/workspace/legacy", activeAt: 1 });
  });
  await page.locator(".side-top .new-chat").click();
  assert.deepEqual(await page.evaluate(() => [S.draftExpert, S.draftAgent, S.draftCwd]), ["codex", "codex", "/workspace/legacy"]);
  await page.evaluate(() => {
    S.convs.get("web:legacy").expert = { id: "deleted-expert" };
  });
  await page.locator(".side-top .new-chat").click();
  assert.deepEqual(await page.evaluate(() => [S.draftExpert, S.draftCwd]), ["claude", "/workspace/legacy"]);

  const empty = await fixture(t, { feishu: true, bootstrap: { conversations: [] } });
  await empty.page.locator(".side-top .new-chat").click();
  await empty.page.reload();
  await empty.page.waitForFunction(() => window.booted);
  assert.deepEqual(await empty.page.evaluate(() => [S.current, S.draftExpert, S.draftCwd, location.hash]), [null, "claude", null, "#new"]);
});

test("飞书与项目混合拖拽：置于项目前和项目之间，整组会话跟随，刷新及新设备保留顺序", async (t) => {
  const initial = ["/workspace/project-a", "/workspace", "/workspace/project-b"];
  const { page, getOrder } = await fixture(t, { feishu: true, projects: true, order: initial });
  const bot = page.locator('[data-bot="bot"]');
  const projectA = page.locator('[data-dir="/workspace/project-a"]');
  const projectB = page.locator('[data-dir="/workspace/project-b"]');
  assert.deepEqual(await groupOrder(page), [...initial, "feishu:bot", "feishu:empty"], "保留旧的项目顺序");
  await bot.locator(".conv-item.proj").click();
  await page.waitForFunction(() => document.querySelectorAll('.conv-list [data-key^="feishu:bot:"]').length === 5);
  await bot.dragTo(projectB, { targetPosition: { x: 20, y: 2 } });
  assert.deepEqual(await groupOrder(page), [initial[0], initial[1], "feishu:bot", initial[2], "feishu:empty"]);
  const children = await bot.evaluate((row) => {
    const keys = [];
    for (let el = row.nextElementSibling; el && !el.classList.contains("proj-row"); el = el.nextElementSibling) if (el.dataset.key) keys.push(el.dataset.key);
    return keys;
  });
  assert.equal(children.length, 5, "展开后的飞书会话与分组一起移动");
  assert.ok(children.every((key) => key.startsWith("feishu:bot:")));
  await bot.dragTo(projectA, { targetPosition: { x: 20, y: 2 } });
  assert.equal((await groupOrder(page))[0], "feishu:bot");
  const savedOrder = page.waitForResponse((res) => res.url().endsWith("/api/ui/dir-order") && res.request().postDataJSON().order?.[1] === initial[2] && res.ok());
  await projectB.dragTo(projectA, { targetPosition: { x: 20, y: 2 } });
  const expected = ["feishu:bot", initial[2], initial[0], initial[1], "feishu:empty"];
  assert.deepEqual(await groupOrder(page), expected, "项目也能跨过飞书分组调整顺序");
  await savedOrder;
  assert.deepEqual(getOrder(), expected);
  await page.evaluate(() => {
    S.bots[0].name = "机器人新名字";
    S.convs.get("feishu:bot:0").activeAt = Date.now();
    window.renderSidebar();
  });
  assert.deepEqual(await groupOrder(page), expected, "改名和新消息不改变固定位置");
  await page.evaluate(() => localStorage.removeItem("aim.side"));
  await page.reload();
  await page.waitForFunction(() => window.booted);
  assert.deepEqual(await groupOrder(page), expected, "仅从账号配置恢复混合顺序");
});

test("触屏分组菜单：飞书与项目可互相置顶、上下移动，保留历史会话入口", async (t) => {
  const { page } = await fixture(t, { mobile: true, feishu: true, projects: true });
  const bot = page.locator('[data-bot="bot"]');
  await bot.click({ button: "right" });
  assert.equal(await page.getByText("历史会话…", { exact: true }).isVisible(), true);
  await page.getByText("置顶", { exact: true }).click();
  assert.equal((await groupOrder(page))[0], "feishu:bot");
  await bot.click({ button: "right" });
  await page.getByText("下移", { exact: true }).click();
  assert.equal((await groupOrder(page))[1], "feishu:bot");
  await bot.click({ button: "right" });
  await page.getByText("上移", { exact: true }).click();
  assert.equal((await groupOrder(page))[0], "feishu:bot");
  await page.locator('[data-dir="/workspace/project-b"]').click({ button: "right" });
  await page.getByText("置顶", { exact: true }).click();
  assert.equal((await groupOrder(page))[0], "/workspace/project-b");
});

for (const mobile of [false, true]) {
  test(`${mobile ? "触屏" : "桌面"}：微信与飞书统一分组，记住折叠、显示状态、排序并继承专家和目录`, async (t) => {
    const wx = { key: "weixin:u1", channel: "weixin", channelId: "u1", agent: "codex", title: "微信里的聊天", cwd: "/workspace/weixin", activeAt: 200, busy: true, expert: { id: "e_helper", name: "助手", engine: "codex" } };
    const initial = ["/workspace", "weixin:weixin:u1", "feishu:bot", "feishu:empty"];
    const web = { key: "web:1", channel: "web", channelId: "web", agent: "claude", title: "Test", cwd: "/workspace", activeAt: 1, busy: false };
    const { page, getOrder } = await fixture(t, { mobile, feishu: true, order: initial, bootstrap: { conversations: [web, wx] } });
    const group = page.locator('[data-group="weixin:weixin:u1"]');
    const header = group.locator(".conv-item.proj");
    const chat = page.locator('[data-key="weixin:u1"]');
    assert.deepEqual(await groupOrder(page), initial, "沿用微信原来的排序键");
    assert.equal(await header.getAttribute("aria-expanded"), "false");
    assert.equal(await chat.count(), 0);
    assert.equal(await header.locator(".conv-spin").count(), 1, "收起时仍显示运行状态");
    assert.equal(await group.locator(".weixin-mark").isVisible(), true);
    if (!mobile) {
      await header.hover();
      assert.equal(await group.locator(".weixin-mark").isVisible(), false);
      assert.equal(await group.locator(".bot-plus").isVisible(), true);
    }
    await header.click();
    assert.equal(await chat.locator(".title").textContent(), wx.title);
    assert.equal(await header.locator(".conv-spin").count(), 0);
    assert.equal(await chat.locator(".conv-spin").count(), 1);
    if (mobile) {
      await group.locator(".bot-new").focus();
      assert.equal(await group.locator(".weixin-mark").isVisible(), true);
      assert.equal(await group.locator(".bot-plus").isVisible(), false);
    }
    await page.reload();
    await page.waitForFunction(() => window.booted);
    if (mobile) await page.locator(".topbar .menu-btn").click();
    assert.equal(await header.getAttribute("aria-expanded"), "true", "刷新后保留展开状态");
    await chat.click();
    await page.waitForFunction(() => S.current === "weixin:u1");
    if (mobile) await page.locator(".topbar .menu-btn").click();
    assert.equal(await chat.evaluate((el) => el.classList.contains("active")), true);
    await header.click();
    assert.equal(await chat.count(), 0, "正在看的微信会话也能收起");
    await page.evaluate(() => {
      S.pending.set("wx-ask", { convKey: "weixin:u1", settled: false });
      window.renderSidebar();
    });
    assert.equal(await header.locator(".dot.ask").count(), 1, "待处理状态汇总到分组标题");
    await group.locator(".bot-new").click();
    assert.deepEqual(await page.evaluate(() => [S.current, S.draftExpert, S.draftAgent, S.draftCwd, S.draftCwdPicked]), [null, "e_helper", "codex", wx.cwd, true]);
    await page.reload();
    await page.waitForFunction(() => window.booted);
    if (mobile) await page.locator(".topbar .menu-btn").click();
    assert.equal(await header.getAttribute("aria-expanded"), "false", "刷新后保留收起状态");
    await group.click({ button: "right" });
    const savedOrder = page.waitForResponse((res) => res.url().endsWith("/api/ui/dir-order") && res.request().postDataJSON().order?.[0] === "weixin:weixin:u1" && res.ok());
    await page.getByText("置顶", { exact: true }).click();
    assert.equal((await groupOrder(page))[0], "weixin:weixin:u1");
    await savedOrder;
    assert.equal(getOrder()[0], "weixin:weixin:u1");
    if (!mobile) {
      await group.dragTo(page.locator('[data-bot="bot"]'), { targetPosition: { x: 20, y: 2 } });
      assert.deepEqual(await groupOrder(page), initial, "微信可拖到飞书前面");
    }
    await page.goto("https://sidebar.example.test/#weixin%3Au1");
    await page.reload();
    await page.waitForFunction(() => window.booted && S.current === "weixin:u1");
    if (mobile) await page.locator(".topbar .menu-btn").click();
    assert.equal(await header.getAttribute("aria-expanded"), "true", "直达微信会话自动展开");
    assert.equal(await chat.evaluate((el) => el.classList.contains("active")), true);
  });

  test(`${mobile ? "触屏" : "桌面"}：飞书分组展开、分页、记住折叠状态，图标按钮继承专家和目录`, async (t) => {
    const { page, getBotLoads } = await fixture(t, { mobile, feishu: true });
    const bot = page.locator('[data-bot="bot"]');
    const header = bot.locator(".conv-item.proj");
    const chats = page.locator('.conv-list [data-key^="feishu:bot:"]');
    assert.equal(getBotLoads(), 0);
    assert.equal(await header.getAttribute("aria-expanded"), "false");
    assert.equal(await bot.locator(".feishu-mark").isVisible(), true);
    assert.equal(await bot.locator(".bot-plus").isVisible(), false);
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
    if (mobile) {
      await bot.locator(".bot-new").focus();
      assert.equal(await bot.locator(".feishu-mark").isVisible(), true, "触屏点击或聚焦后仍显示渠道图标");
      assert.equal(await bot.locator(".bot-plus").isVisible(), false);
    }
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
