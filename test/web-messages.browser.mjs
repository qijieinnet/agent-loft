// 浏览器回归：AGENT_LOFT_PLAYWRIGHT=/path/to/playwright-core/index.mjs node --test test/web-messages.browser.mjs
// 可用 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 指定已有的 Chromium。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const { chromium } = await import(process.env.AGENT_LOFT_PLAYWRIGHT || "playwright-core");
const root = new URL("../", import.meta.url);
const conv = { key: "web:1", channel: "web", channelId: "1", agent: "claude", title: "Test", cwd: "/tmp", activeAt: 1, busy: false };
const vendor = {
  "/vendor/marked.js": "node_modules/marked/lib/marked.esm.js",
  "/vendor/purify.js": "node_modules/dompurify/dist/purify.es.mjs",
  "/vendor/hljs.js": "node_modules/@highlightjs/cdn-assets/es/highlight.min.js",
  "/vendor/hljs-light.css": "node_modules/@highlightjs/cdn-assets/styles/github.min.css",
  "/vendor/hljs-dark.css": "node_modules/@highlightjs/cdn-assets/styles/github-dark.min.css",
  "/vendor/mermaid.js": "node_modules/mermaid/dist/mermaid.min.js",
  "/vendor/echarts.js": "node_modules/echarts/dist/echarts.min.js",
};
const styles = (await fs.readFile(new URL("web/index.html", root), "utf8")).match(/<link[^>]+rel="stylesheet"[^>]*>/g).join("\n");

async function fixture(t, viewport) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ["--no-sandbox"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(() => {
    window.WebSocket = class { readyState = 0; close() {} send() {} };
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/")) {
      let data = { ok: true };
      if (url.pathname === "/api/me") data = { authed: true, user: { id: "u1", role: "admin" } };
      if (url.pathname === "/api/bootstrap") data = {
        user: { id: "u1", role: "admin" }, agents: [], bots: [], pending: [], conversations: [conv],
        workspaceRoot: "/tmp", quotaEnabled: false, sidebar: { recent: { next: null }, dirs: [] },
      };
      if (url.pathname.endsWith("/history")) data = { info: conv, allowedAgents: [], messages: [], live: [], pending: [], seq: 0 };
      return route.fulfill({ json: data });
    }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `
      ${styles}<div id="app"></div><script type="module">
        import { S, ui } from '/state.js';
        import { boot } from '/views/layout.js';
        import * as messages from '/views/messages.js';
        window.S = S; window.ui = ui; window.messages = messages;
        await boot(); window.booted = true;
      </script>` });
    try {
      return route.fulfill({ contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript", body: await fs.readFile(new URL(vendor[url.pathname] ?? `web${url.pathname}`, root), "utf8") });
    } catch {
      return route.fulfill({ status: 404, body: "" });
    }
  });
  await page.goto("https://host.example.test/#web%3A1");
  await page.waitForFunction(() => window.booted && window.S.current === "web:1" && window.ui.msgInner.querySelector(".empty"));
  await page.evaluate(() => {
    window.emit = (ev) => window.messages.applyEvent({ key: window.S.current, seq: (window.S.seq.get(window.S.current) ?? 0) + 1, ts: Date.now(), ev });
    window.send = (id, queued = false) => {
      window.S.pinNext = true;
      window.emit({ type: "user", id, text: id, queued, origin: { channel: "web" } });
    };
    window.position = (id) => {
      const el = window.S.items.find((it) => it.id === id).el;
      return el.getBoundingClientRect().top - Math.max(window.ui.messages.getBoundingClientRect().top, window.ui.topbar.getBoundingClientRect().bottom) - 12;
    };
    window.messages.addItem({ type: "user", text: "更早的消息" });
    window.messages.addItem({ type: "ai", steps: [], committed: "之前的回复\n\n".repeat(40), partial: "", done: true });
    window.send("active");
    window.emit({ type: "text", text: "正在回复" });
  });
  await page.waitForTimeout(600);
  return page;
}

for (const width of [1280, 390]) test(`普通图片预览：关闭、缩放、拖动、下载和失败提示（${width}px）`, async (t) => {
  const page = await fixture(t, { width, height: 800 });
  await page.route("**/api/file?*", (route) => route.fulfill({
    contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600"><rect width="2400" height="1600" fill="skyblue"/></svg>',
  }));
  await page.evaluate(() => window.messages.addItem({ type: "user", text: "图片", files: [{ kind: "image", name: "大图.svg", path: "/tmp/large.svg" }] }));
  const trigger = page.getByRole("button", { name: "大图.svg", exact: true });
  await trigger.click();
  const viewer = page.getByRole("dialog", { name: "图片预览" });
  const close = viewer.getByRole("button", { name: "关闭图片预览" });
  await page.waitForFunction(() => document.querySelector(".diagram-stage img")?.style.width);
  assert.equal(await close.isVisible(), true);
  assert.equal(await close.textContent(), "关闭");
  assert.equal(await viewer.locator("strong").textContent(), "大图.svg");
  assert.ok(await viewer.evaluate((el) => el.scrollWidth <= el.clientWidth), "窄屏预览不溢出");
  const image = viewer.locator("img"), stage = viewer.locator(".diagram-stage");
  const initial = await image.boundingBox(), bounds = await stage.boundingBox();
  assert.ok(initial.width <= bounds.width + 1 && initial.height <= bounds.height + 1);
  const download = new URL(await viewer.getByRole("link", { name: "下载" }).getAttribute("href"), page.url());
  assert.equal(download.searchParams.get("path"), "/tmp/large.svg");
  assert.equal(download.searchParams.get("download"), "1");
  await viewer.getByRole("button", { name: "原始大小" }).click();
  assert.equal(await viewer.locator("output").textContent(), "100%");
  await viewer.getByRole("button", { name: "放大图片" }).click();
  assert.equal(await viewer.locator("output").textContent(), "125%");
  await viewer.getByRole("button", { name: "缩小图片" }).click();
  assert.equal(await viewer.locator("output").textContent(), "100%");
  const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -150);
  await page.waitForFunction(() => document.querySelector(".diagram-scale").textContent !== "100%");
  const before = await image.boundingBox();
  await page.mouse.down();
  await page.mouse.move(cx + 30, cy + 20, { steps: 3 });
  await page.mouse.up();
  const after = await image.boundingBox();
  assert.ok(Math.abs(after.x - before.x - 30) < 1 && Math.abs(after.y - before.y - 20) < 1);
  assert.equal(await viewer.isVisible(), true, "图片操作不会误关预览");
  await viewer.getByRole("button", { name: "适应窗口" }).click();
  assert.ok(Math.abs((await image.boundingBox()).width - initial.width) < 1);
  await close.click();
  await viewer.waitFor({ state: "detached" });
  assert.equal(await trigger.evaluate((el) => el === document.activeElement), true);
  await trigger.click();
  await page.keyboard.press("Escape");
  await viewer.waitFor({ state: "detached" });
  await page.route("**/broken-image.png", (route) => route.fulfill({ status: 404, body: "gone" }));
  await page.evaluate(() => window.messages.openLightbox("/broken-image.png", "已失效图片"));
  await viewer.getByRole("status").filter({ hasText: "图片无法加载" }).waitFor();
  assert.equal(await viewer.getByRole("link", { name: "下载" }).count(), 0);
  await close.click();
  await viewer.waitFor({ state: "detached" });
});

for (const width of [1280, 390]) test(`Mermaid 大图：点击预览、缩放、拖动、适应窗口与销毁（${width}px）`, async (t) => {
  const page = await fixture(t, { width, height: 800 });
  await page.evaluate(async () => {
    const { renderMarkdown, patchMarkdown } = await import("/lib/markdown.js");
    window.patchDiagram = (text) => patchMarkdown(window.diagramBox, text);
    window.diagramBox = renderMarkdown('```mermaid\ngraph LR\n' + Array.from({ length: 24 }, (_, i) => `N${i}[节点 ${i}] --> N${i + 1}`).join('\n') + '\n```');
    window.ui.msgInner.append(window.diagramBox);
  });
  const diagram = page.locator(".diagram.mermaid");
  await diagram.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector(".diagram-svg")?.naturalWidth > 1000);
  const expand = diagram.getByRole("button", { name: "放大查看" });
  await diagram.locator(".diagram-body").click();
  const viewer = page.getByRole("dialog", { name: "图表预览" });
  const image = viewer.locator("img");
  await page.waitForFunction(() => document.querySelector(".diagram-stage img")?.style.width);
  const initial = await image.boundingBox();
  const stage = viewer.locator(".diagram-stage");
  const bounds = await stage.boundingBox();
  assert.ok(initial.width <= bounds.width + 1 && initial.height <= bounds.height + 1);
  assert.ok(await viewer.evaluate((el) => el.scrollWidth <= el.clientWidth), "窄屏工具栏不溢出");
  await viewer.getByRole("button", { name: "原始大小" }).click();
  assert.equal(await viewer.locator("output").textContent(), "100%");
  await viewer.getByRole("button", { name: "放大图表" }).click();
  assert.equal(await viewer.locator("output").textContent(), "125%");
  await viewer.getByRole("button", { name: "缩小图表" }).click();
  assert.equal(await viewer.locator("output").textContent(), "100%");
  const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -150);
  await page.waitForFunction(() => document.querySelector(".diagram-scale").textContent !== "100%");
  const before = await image.boundingBox();
  await page.mouse.down();
  await page.mouse.move(cx + 50, cy + 30, { steps: 4 });
  await page.mouse.up();
  const after = await image.boundingBox();
  assert.ok(Math.abs(after.x - before.x - 50) < 1 && Math.abs(after.y - before.y - 30) < 1);
  await viewer.getByRole("button", { name: "适应窗口" }).click();
  assert.ok(Math.abs((await image.boundingBox()).width - initial.width) < 1);
  await page.keyboard.press("Escape");
  await viewer.waitFor({ state: "detached" });
  assert.equal(await expand.evaluate((el) => el === document.activeElement), true);
  await expand.click();
  await page.evaluate(() => window.patchDiagram("替换后的文字"));
  assert.equal(await viewer.count(), 0, "重画消息后没有遗留弹层");
});

test("chart 大图保留矢量，触摸支持双指缩放和单指拖动", async (t) => {
  const page = await fixture(t, { width: 390, height: 800 });
  await page.evaluate(async () => {
    const { renderMarkdown } = await import("/lib/markdown.js");
    window.ui.msgInner.append(renderMarkdown('```chart\n{"type":"bar","title":"测试图表","x":["A","B"],"series":[{"data":[10,20]}]}\n```'));
  });
  const expand = page.locator(".diagram.chart").getByRole("button", { name: "放大查看" });
  await expand.scrollIntoViewIfNeeded();
  await expand.click();
  const viewer = page.getByRole("dialog", { name: "图表预览" });
  await page.waitForFunction(() => document.querySelector(".diagram-stage img")?.style.width);
  assert.match(await viewer.locator("img").getAttribute("src"), /^data:image\/svg\+xml/);
  await viewer.getByRole("button", { name: "原始大小" }).click();
  await viewer.locator(".diagram-stage").evaluate((stage) => {
    // 合成指针只验证应用的双指几何逻辑，真实鼠标捕获已由上面的拖动测试覆盖。
    stage.setPointerCapture = () => {};
    const send = (type, pointerId, clientX, clientY) => stage.dispatchEvent(new PointerEvent(type, { pointerId, clientX, clientY, pointerType: "touch", bubbles: true }));
    send("pointerdown", 1, 100, 200);
    send("pointerdown", 2, 200, 200);
    send("pointermove", 2, 250, 200);
    send("pointerup", 2, 250, 200);
    window.touchSend = send;
  });
  assert.equal(await viewer.locator("output").textContent(), "150%");
  const before = await viewer.locator("img").boundingBox();
  await page.evaluate(() => { window.touchSend("pointermove", 1, 120, 210); window.touchSend("pointercancel", 1, 120, 210); });
  const after = await viewer.locator("img").boundingBox();
  assert.ok(Math.abs(after.x - before.x - 20) < 1 && Math.abs(after.y - before.y - 10) < 1);
  await page.setViewportSize({ width: 700, height: 500 });
  await page.waitForFunction(() => document.querySelector(".diagram-scale").textContent !== "150%");
  const image = await viewer.locator("img").boundingBox(), stage = await viewer.locator(".diagram-stage").boundingBox();
  assert.ok(image.width <= stage.width + 1 && image.height <= stage.height + 1);
  await viewer.getByRole("button", { name: "关闭图表预览" }).click();
  assert.equal(await viewer.count(), 0);
});

for (const width of [1280, 390]) test(`用户消息：宽度恢复后撤下短消息的展开按钮，长消息仍可展开收起（${width}px）`, async (t) => {
  const page = await fixture(t, { width, height: 800 });
  const initial = await page.evaluate(() => {
    // 模拟首次排版时消息区域还很窄，随后恢复正常宽度。
    window.ui.msgInner.style.width = "72px";
    window.shortUser = window.messages.addItem({ type: "user", text: "苹果设备推送消息的时候，不要显示服务器的图标" });
    const measured = window.shortUser.bubble.scrollHeight;
    const clamped = window.shortUser.bubble.classList.contains("clamped");
    window.ui.msgInner.style.width = "";
    return { measured, clamped };
  });
  assert.ok(initial.measured > 320);
  assert.equal(initial.clamped, true);
  await page.waitForFunction(() => !window.shortUser.el.querySelector(".msg-more"), null, { timeout: 2000 });
  assert.equal(await page.evaluate(() => window.shortUser.bubble.classList.contains("clamped")), false);
  await page.evaluate(() => {
    window.longUser = window.messages.addItem({ type: "user", text: "一条确实很长的消息\n".repeat(30) });
  });
  const more = page.locator(".msg-user-group").last().locator(".msg-more");
  await more.click();
  assert.equal(await more.textContent(), "收起");
  await page.setViewportSize({ width: width + 100, height: 750 });
  await page.waitForFunction(() => !window.longUser.bubble.classList.contains("clamped"));
  assert.equal(await more.textContent(), "收起", "重排不能把用户展开的消息收回去");
  await more.click();
  assert.equal(await page.evaluate(() => window.longUser.bubble.classList.contains("clamped")), true);
});

test("Todo 顶部：多项进行中、完成计数、折叠后更新和全部完成", async (t) => {
  const page = await fixture(t, { width: 1280, height: 800 });
  const update = (statuses) => page.evaluate((statuses) => {
    window.emit({ type: "state", busy: true });
    window.emit({ type: "todos", todos: statuses.map((status, i) => ({ content: `阶段${i + 1}`, activeForm: `做阶段${i + 1}`, status })) });
  }, statuses);
  await update(["in_progress", "in_progress", "in_progress", "pending"]);
  assert.equal(await page.locator(".todo-title").textContent(), "3 项进行中");
  assert.equal(await page.locator(".todo-title").getAttribute("title"), "做阶段1；做阶段2；做阶段3");
  assert.equal(await page.locator(".todo-count").textContent(), "0/4");
  assert.equal(await page.locator(".todo-item.in_progress").count(), 3);
  await page.locator(".todo-toggle").click();
  await update(["completed", "completed", "completed", "in_progress"]);
  assert.equal(await page.locator(".todo-title").textContent(), "做阶段4");
  assert.equal(await page.locator(".todo-count").textContent(), "3/4");
  assert.equal(await page.locator(".todo-list").count(), 0);
  await update(["completed", "completed", "completed", "completed"]);
  assert.equal(await page.locator(".todo-title").textContent(), "全部完成");
  assert.equal(await page.locator(".todo-count").textContent(), "4/4");
  await page.evaluate(() => window.emit({ type: "state", busy: false }));
  assert.equal(await page.locator(".todo-bar").isVisible(), false);
});

test("Todo 面板：新一轮清掉旧清单，排队和本轮作答保留当前进度", async (t) => {
  const page = await fixture(t, { width: 1280, height: 800 });
  const bar = page.locator(".todo-bar");
  for (const status of ["pending", "in_progress", "completed"]) {
    await page.evaluate((status) => {
      window.emit({ type: "state", busy: true });
      window.emit({ type: "todos", todos: [{ content: "旧任务", status }] });
    }, status);
    assert.equal(await bar.isVisible(), true);
    await page.evaluate(() => {
      window.emit({ type: "result", text: "这一轮结束", at: Date.now() });
      window.emit({ type: "state", busy: false });
      window.send("新问题");
      window.emit({ type: "state", busy: true });
    });
    assert.equal(await bar.isVisible(), false, `${status} 的旧清单不能在新一轮显示`);
    assert.equal(await page.evaluate(() => window.S.todos), null);
  }
  await page.evaluate(() => {
    window.emit({ type: "todos", todos: [{ content: "当前任务", status: "in_progress" }] });
    window.emit({ type: "step", text: "正在处理当前任务" });
    window.send("排队的问题", true);
  });
  assert.equal(await bar.isVisible(), true, "排队时当前任务仍在处理");
  await page.evaluate(() => {
    window.send("本轮提问的回答");
    window.emit({ type: "queue", id: "作答", state: "started" });
  });
  assert.equal(await bar.isVisible(), true, "同一轮中的作答不清空进度");
  await page.evaluate(() => {
    window.emit({ type: "result", text: "完成", at: Date.now() });
    window.emit({ type: "queue", id: "排队的问题", state: "started" });
  });
  assert.equal(await bar.isVisible(), false, "排队消息开始新一轮时清空");
  await page.evaluate(() => {
    window.emit({ type: "todos", todos: [{ content: "排队任务", status: "in_progress" }] });
    window.emit({ type: "turn_start" });
  });
  assert.equal(await bar.isVisible(), false, "没有用户消息的轮次也清空旧面板");
  await page.evaluate(() => window.emit({ type: "todos", todos: [{ content: "新任务", status: "in_progress" }] }));
  assert.equal(await bar.isVisible(), true, "本轮更新清单后重新显示");
  assert.equal(await bar.locator(".todo-text").textContent(), "新任务");
});

test("Todo 面板：重开会话只恢复最后一轮，实时回放恢复本轮更新", async (t) => {
  const page = await fixture(t, { width: 1280, height: 800 });
  const oldTodos = [{ content: "旧任务", status: "in_progress" }];
  const newTodos = [{ content: "新任务", status: "pending" }];
  const messages = [
    { role: "user", text: "旧问题" },
    { role: "assistant", text: "旧回复", todos: oldTodos },
    { role: "user", text: "新问题" },
    { role: "assistant", text: "新回复没有清单" },
  ];
  const history = { info: conv, allowedAgents: [], messages, live: [], pending: [], seq: 100 };
  await page.route("**/api/conversations/*/history", (route) => route.fulfill({ json: history }));
  const reopen = () => page.evaluate(() => window.messages.openConversation("web:1"));
  const bar = page.locator(".todo-bar");
  await reopen();
  assert.equal(await bar.isVisible(), false, "不能越过最后一条用户消息恢复旧清单");
  messages.push({ role: "assistant", text: "开始新任务", todos: newTodos, segment: true });
  messages.push({ role: "assistant", text: "同一轮的后半段" });
  await reopen();
  assert.equal(await bar.locator(".todo-text").textContent(), "新任务");
  assert.equal(await bar.isVisible(), true, "同一轮分段的回复保留最新清单");
  messages.push({ role: "assistant", text: "清空清单", todos: [] });
  await reopen();
  assert.equal(await bar.isVisible(), false);
  messages.pop();
  history.info = { ...conv, busy: true };
  history.live = [
    { key: conv.key, seq: 1, ts: Date.now(), ev: { type: "user", text: "正在处理的问题" } },
    { key: conv.key, seq: 2, ts: Date.now(), ev: { type: "turn_start" } },
  ];
  await reopen();
  assert.equal(await bar.isVisible(), false, "进行中但没有更新清单时保持隐藏");
  history.live.push({ key: conv.key, seq: 3, ts: Date.now(), ev: { type: "todos", todos: newTodos } });
  await reopen();
  assert.equal(await bar.isVisible(), true);
  assert.equal(await bar.locator(".todo-text").textContent(), "新任务");
});

for (const width of [1280, 390]) test(`闲置提示：打开历史后显示，点击继续或发送消息后撤下（${width}px）`, async (t) => {
  const page = await fixture(t, { width, height: 800 });
  const expired = { ...conv, sessionId: "old-context", idleExpired: true };
  let continued = false;
  let fail = true;
  await page.route("**/api/conversations/*/history", (route) => route.fulfill({ json: {
    info: { ...expired, idleExpired: !continued }, allowedAgents: [],
    messages: [{ role: "user", text: "旧任务" }, { role: "assistant", text: "旧回复" }],
    live: [], pending: [], seq: 10,
  } }));
  await page.route("**/api/conversations/*/continue", async (route) => {
    assert.equal(route.request().method(), "POST");
    assert.deepEqual(route.request().postDataJSON(), { agent: "claude", sessionId: "old-context" });
    if (fail) return route.fulfill({ status: 500, json: { error: "暂时无法继续" } });
    continued = true;
    return route.fulfill({ json: { ...expired, idleExpired: false, activeAt: Date.now() } });
  });
  await page.evaluate(() => window.messages.openConversation("web:1"));
  const notice = page.locator(".idle-session-notice");
  assert.equal(await notice.textContent(), "当前会话闲置太久，直接发送消息将开启新会话，也可以继续当前会话");
  assert.equal(await page.evaluate(() => window.ui.msgInner.lastElementChild.classList.contains("idle-session-notice")), true);
  const button = notice.getByRole("button", { name: "继续当前会话", exact: true });
  assert.match(await button.evaluate((el) => getComputedStyle(el).textDecorationLine), /underline/);
  await button.click();
  await page.getByText("暂时无法继续", { exact: true }).waitFor();
  assert.equal(await button.isEnabled(), true, "失败后能重试");
  fail = false;
  await button.click();
  await notice.waitFor({ state: "detached" });
  assert.equal(await page.getByText("旧回复", { exact: true }).count(), 1, "续接不清空历史");
  await page.evaluate(() => window.messages.openConversation("web:1"));
  assert.equal(await notice.count(), 0, "再次打开已续期的会话不提示");
  continued = false;
  await page.evaluate(() => window.messages.openConversation("web:1"));
  assert.equal(await notice.count(), 1);
  await page.evaluate(() => window.messages.renderIdleNotice({ ...window.S.convs.get("web:1"), idleExpired: false }));
  assert.equal(await notice.count(), 0, "其他页面续期时同步撤下提示");
  await page.evaluate(() => window.messages.openConversation("web:1"));
  await page.evaluate(() => window.send("直接发送"));
  assert.equal(await notice.count(), 0, "发送消息后撤下旧提示");
});

test("相册：流式半段 JSON 不加载图片，完整后渲染；预览失败回退，删除块关闭弹层，错误格式保留源码", async (t) => {
  const page = await fixture(t, { width: 1280, height: 800 });
  await page.route("**/api/conversations/*/file?*", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") === "/tmp/preview.jpg") return route.fulfill({ status: 404, body: "gone" });
    return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=", "base64") });
  });
  await page.evaluate(async () => {
    const { renderMarkdown, patchMarkdown } = await import("/lib/markdown.js");
    const { linkReplyFiles } = await import("/views/file-preview.js");
    window.patchAlbum = (text, live = false) => patchMarkdown(window.albumBox, text, { live, enhance: linkReplyFiles });
    window.albumBox = renderMarkdown('```album\n{"items":[', { live: true, enhance: linkReplyFiles });
    window.ui.msgInner.append(window.albumBox);
  });
  const box = page.locator(".md").filter({ has: page.locator(".album-pending") });
  assert.equal(await box.locator("img").count(), 0);
  assert.equal(await page.locator(".album-pending").textContent(), "正在整理相册…");
  await page.evaluate(() => window.patchAlbum('```album\n' + JSON.stringify({ title: '<img src=x onerror="alert(1)">', items: [{ src: "/tmp/thumb.webp", preview: "/tmp/preview.jpg", name: "照片" }] }) + '\n```'));
  assert.equal(await page.locator(".album-slide img").count(), 1);
  assert.equal(await page.locator(".album-head img").count(), 0, "标题作为文字显示");
  await page.getByRole("button", { name: "放大第 1 张：照片", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".photo-status")?.textContent === "预览不可用，显示缩略图");
  assert.equal(new URL(await page.locator(".photo-stage img").getAttribute("src"), page.url()).searchParams.get("path"), "/tmp/thumb.webp");
  await page.evaluate(() => window.patchAlbum("改为普通文字"));
  assert.equal(await page.locator(".photo-viewer").count(), 0);
  await page.evaluate(() => window.patchAlbum('```album\n{"items":[{"src":"https://remote.example/photo.jpg"}]}\n```'));
  assert.equal(await page.locator(".album-track").count(), 0);
  assert.equal(await page.locator(".album-error").textContent(), "相册图片需要使用已下载的本地绝对路径");
  assert.match(await page.locator("pre code.language-album").textContent(), /remote\.example/);
  await page.evaluate(() => window.patchAlbum('```album\n{"items":[]}\n```'));
  assert.equal(await page.locator(".album-empty").textContent(), "没有照片");
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`${viewport.width}px：相册轮播、滑动、缩略图跳转和可缩放预览，更新保留当前照片`, async (t) => {
    const page = await fixture(t, viewport);
    const previews = new Set();
    await page.route("**/api/conversations/*/file?*", (route) => {
      const path = new URL(route.request().url()).searchParams.get("path");
      if (path.includes("预览")) previews.add(path);
      return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1200"><defs><linearGradient id="s" x2="0" y2="1"><stop stop-color="#567881"/><stop offset="1" stop-color="#d6c9b2"/></linearGradient></defs><rect width="1800" height="1200" fill="url(#s)"/><circle cx="1280" cy="290" r="100" fill="#eadbc0"/><path d="M0 1000 550 420 1100 1040 1500 550 1800 900V1200H0" fill="#435c56"/><path d="M0 1150 500 850 950 1100 1450 800 1800 1100V1200H0" fill="#293d3b"/></svg>' });
    });
    await page.evaluate(() => {
      const items = Array.from({ length: 29 }, (_, i) => ({ src: `/tmp/家庭 ${i}.webp`, preview: `/tmp/预览 ${i}.jpg`, name: `家庭相片 ${i + 1}`, date: "2025-11-07 10:19", caption: "一起走过的秋天" }));
      window.albumItem = window.messages.addItem({ type: "ai", steps: [], committed: '```album\n' + JSON.stringify({ title: "那年今日 · 11月7日", total: 120, items }) + '\n```', partial: "", done: true });
    });
    const album = page.locator(".photo-album"), track = album.locator(".album-track"), thumbs = album.locator(".album-thumb");
    await album.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector(".album-slide img")?.naturalWidth);
    assert.equal(await thumbs.count(), 29);
    assert.equal(await album.getByText("已载入 29 / 共 120 张").isVisible(), true);
    assert.equal(await thumbs.first().locator("img").getAttribute("loading"), "lazy");
    assert.ok(previews.size <= 2, "首次只加载当前及相邻大图");
    assert.equal(await album.locator(".album-count").textContent(), "1 / 29");
    assert.equal(await album.getByRole("button", { name: "上一张照片" }).isDisabled(), true);
    await album.getByRole("button", { name: "下一张照片" }).click();
    await page.waitForFunction(() => document.querySelector(".album-count").textContent === "2 / 29");
    await track.evaluate((el) => el.scrollTo({ left: el.clientWidth * 3, behavior: "instant" }));
    await page.waitForFunction(() => document.querySelector(".album-count").textContent === "4 / 29");
    await track.focus();
    await page.keyboard.press("Home");
    await page.waitForFunction(() => document.querySelector(".album-count").textContent === "1 / 29");
    await page.waitForFunction(() => document.querySelector(".album-track").scrollLeft < 2);
    // 在 Chromium 中发送真实触摸事件，验证原生滚动与 snap 的左右滑动。
    const touch = await page.context().newCDPSession(page);
    const bounds = await track.boundingBox();
    const y = Math.max(10, bounds.y) + Math.min(bounds.height / 2, 120);
    const x = bounds.x + bounds.width * 0.8;
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= 6; step++) await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - bounds.width * 0.6 * step / 6, y }] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForFunction(() => document.querySelector(".album-count").textContent !== "1 / 29");
    await touch.detach();
    await thumbs.nth(12).click();
    await page.waitForFunction(() => document.querySelector(".album-count").textContent === "13 / 29" && Math.abs(document.querySelector(".album-track").scrollLeft / document.querySelector(".album-track").clientWidth - 12) < 0.01);
    assert.equal(await thumbs.nth(12).getAttribute("aria-pressed"), "true");
    await page.evaluate(() => { window.albumItem.committed += "\n\n这是相册之后的新文字。"; window.messages.updateItem(window.albumItem); });
    await page.getByText("这是相册之后的新文字。", { exact: true }).waitFor();
    assert.equal(await album.locator(".album-count").textContent(), "13 / 29");
    if (process.env.AGENT_LOFT_UI_SCREENSHOTS) {
      await album.evaluate((el) => {
        const host = document.createElement("div");
        host.id = "album-design-preview";
        host.className = "md";
        host.style.cssText = `position:fixed;inset:0;z-index:99999;overflow:auto;background:var(--bg);width:${el.clientWidth + 2}px;margin:auto`;
        const copy = el.cloneNode(true);
        host.append(copy);
        document.body.append(host);
        for (const cls of [".album-track", ".album-filmstrip"]) copy.querySelector(cls).scrollLeft = el.querySelector(cls).scrollLeft;
      });
      await page.locator("#album-design-preview .photo-album").screenshot({ path: `/tmp/album-carousel-${viewport.width}.png` });
      await page.locator("#album-design-preview").evaluate((el) => el.remove());
    }
    await album.locator(".album-open").click();
    const viewer = page.getByRole("dialog", { name: "照片预览" });
    await page.waitForFunction(() => document.querySelector(".photo-stage img")?.style.visibility === "");
    assert.equal(await viewer.locator(".photo-count").textContent(), "13 / 29");
    assert.equal(new URL(await viewer.locator("img").getAttribute("src"), page.url()).searchParams.get("path"), "/tmp/预览 12.jpg");
    await page.keyboard.press("ArrowRight");
    assert.equal(await viewer.locator(".photo-count").textContent(), "14 / 29");
    await page.waitForFunction(() => document.querySelector(".photo-stage img").style.visibility === "");
    const stage = await viewer.locator(".photo-stage").boundingBox();
    const cx = stage.x + stage.width * 0.7, cy = stage.y + stage.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 100, cy, { steps: 4 });
    await page.mouse.up();
    assert.equal(await viewer.locator(".photo-count").textContent(), "15 / 29", "适应窗口时可滑动切换");
    await page.waitForFunction(() => document.querySelector(".photo-stage img").style.visibility === "");
    await viewer.getByRole("button", { name: "原始大小" }).click();
    await viewer.getByRole("button", { name: "放大照片" }).click();
    assert.equal(await viewer.locator("output").textContent(), "125%");
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 100, cy, { steps: 4 });
    await page.mouse.up();
    assert.equal(await viewer.locator(".photo-count").textContent(), "15 / 29", "放大后拖动不误切换照片");
    await viewer.getByRole("button", { name: "关闭照片预览" }).click();
    await viewer.waitFor({ state: "detached" });
    assert.equal(await album.locator(".album-count").textContent(), "15 / 29", "预览和卡片同步当前位置");
    assert.equal(await album.locator(".album-open").evaluate((el) => document.activeElement === el), true);
    await track.focus();
    await page.keyboard.press("End");
    await page.waitForFunction(() => document.querySelector(".album-count").textContent === "29 / 29");
    assert.equal(await album.getByRole("button", { name: "下一张照片" }).isDisabled(), true);
    assert.ok(await album.evaluate((el) => el.scrollWidth <= el.clientWidth), "窄屏相册不横向溢出");
    await page.setViewportSize({ width: viewport.width === 390 ? 700 : 900, height: viewport.height });
    await page.waitForFunction(() => Math.abs(document.querySelector(".album-track").scrollLeft / document.querySelector(".album-track").clientWidth - 28) < 0.01);
  });

  test(`${viewport.width}px：排队保持当前轮定位，回复继续跟随，开始下一轮才切换`, async (t) => {
    const page = await fixture(t, viewport);
    assert.ok(Math.abs(await page.evaluate(() => window.position("active"))) < 3);
    await page.evaluate(() => {
      for (let i = 0; i < 15; i++) window.send(`queued-${i}`, true);
    });
    await page.waitForTimeout(600);
    assert.ok(Math.abs(await page.evaluate(() => window.position("active"))) < 3, "队列超过一屏也保留当前用户消息在顶部");
    assert.equal(await page.evaluate(() => window.S.pinNext), false, "排队回显应消费本次发送的定位标记");

    await page.evaluate(() => window.emit({ type: "delta", text: "\n\n回复继续输出" }));
    await page.waitForTimeout(100);
    assert.ok(Math.abs(await page.evaluate(() => window.position("active"))) < 3);
    await page.setViewportSize({ ...viewport, height: viewport.height - 100 });
    await page.waitForTimeout(100);
    assert.ok(Math.abs(await page.evaluate(() => window.position("active"))) < 3, "输入区或窗口变高时仍保留当前轮定位");

    await page.evaluate(() => window.emit({ type: "delta", text: "\n\n较长的回复继续输出。".repeat(60) }));
    await page.waitForTimeout(150);
    const replyBottom = await page.evaluate(() => window.S.turnAi.el.getBoundingClientRect().bottom - window.ui.messages.getBoundingClientRect().bottom);
    assert.ok(replyBottom <= 1 && replyBottom >= -45, "长回复跟随到回复末尾，不跟到排队消息末尾");

    await page.evaluate(() => {
      window.emit({ type: "result", text: "完成" });
      window.emit({ type: "queue", id: "queued-0", state: "started" });
    });
    await page.waitForTimeout(600);
    assert.ok(Math.abs(await page.evaluate(() => window.position("queued-0"))) < 3, "轮到排队消息时才定位到它");
    await page.evaluate(() => {
      window.messages.userScrolled();
      window.ui.messages.scrollTop = 0;
      window.send("queued-manual", true);
      window.emit({ type: "result", text: "完成" });
      window.emit({ type: "queue", id: "queued-1", state: "started" });
    });
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => window.ui.follow), false);
    assert.equal(await page.evaluate(() => window.ui.messages.scrollTop), 0, "手动翻阅时，排队和开始回复都不抢滚动位置");
  });
}
