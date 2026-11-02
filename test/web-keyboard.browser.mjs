// 模拟 iOS PWA 的可见视口事件时序；软键盘本身仍需 iPhone 真机验证。
// AGENT_LOFT_PLAYWRIGHT / PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 可指定本地浏览器。
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
  "/vendor/xterm.js": "node_modules/@xterm/xterm/lib/xterm.mjs",
  "/vendor/xterm-fit.js": "node_modules/@xterm/addon-fit/lib/addon-fit.mjs",
  "/vendor/xterm.css": "node_modules/@xterm/xterm/css/xterm.css",
};

async function fixture(t, { touch = true, standalone = true } = {}) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ["--no-sandbox"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: touch, isMobile: touch, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(() => {
    window.WebSocket = class { readyState = 0; close() {} send() {} };
    const vv = Object.assign(new EventTarget(), { height: innerHeight, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    window.viewport = (values, event = "resize") => {
      Object.assign(vv, values);
      if (event) vv.dispatchEvent(new Event(event));
    };
  });
  const conv = { key: "web:1", channel: "web", channelId: "1", agent: "claude", title: "键盘测试", cwd: "/workspace", activeAt: 1, busy: false };
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p.startsWith("/api/")) {
      let data = { ok: true };
      if (p === "/api/me") data = { authed: true, user: { id: "u1", role: "admin" } };
      if (p === "/api/bootstrap") data = {
        user: { id: "u1", role: "admin" }, agents: [], bots: [], experts: [], pending: [], conversations: [conv],
        workspaceRoot: "/workspace", quotaEnabled: false, sidebar: { recent: { next: null }, dirs: [] },
        remote: { allowed: true, terminal: { allowed: true, available: true } },
      };
      if (p.endsWith("/history")) data = { info: conv, allowedAgents: [], messages: [], live: [], pending: [], seq: 0 };
      if (p === "/api/terminals") data = { enabled: true, allowed: true, available: false, terminals: [] };
      return route.fulfill({ json: data });
    }
    if (p === "/") return route.fulfill({ contentType: "text/html", body: `
      <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<div id="app"></div><script type="module">
        import { S, ui } from '/state.js'; import { boot } from '/views/layout.js';
        window.S = S; window.ui = ui; await boot(); window.booted = true;
      </script>` });
    try {
      let body = await fs.readFile(new URL(vendor[p] ?? `web${p}`, root), "utf8");
      if (p.endsWith(".css")) {
        // 无头 Chromium 不能安装 iOS PWA：激活同一套 standalone 样式，并模拟底部安全区。
        if (standalone) body = body.replaceAll("(display-mode: standalone)", "(min-width: 0px)");
        body = body.replaceAll("env(safe-area-inset-bottom)", "34px");
      }
      return route.fulfill({ contentType: p.endsWith(".css") ? "text/css" : "text/javascript", body });
    } catch { return route.fulfill({ status: 404, body: "" }); }
  });
  await page.goto("https://keyboard.example.test/#web%3A1");
  await page.waitForFunction(() => window.booted && window.S.current === "web:1");
  return { page };
}

async function expectAboveKeyboard(page) {
  await page.waitForFunction(() => {
    const bottom = visualViewport.height + visualViewport.offsetTop;
    return Math.abs(ui.layout.getBoundingClientRect().bottom - bottom) < 2
      && ui.composer.getBoundingClientRect().bottom <= bottom
      && ui.input.getBoundingClientRect().top >= visualViewport.offsetTop;
  }, null, { timeout: 3000 });
}

for (const standalone of [true, false]) test(`${standalone ? "PWA" : "浏览器"}：首次聚焦、反复开合、视口平移和多行输入均避开键盘`, async (t) => {
  const { page } = await fixture(t, { standalone });
  assert.equal(await page.locator(".remote-pane").count(), 0, "无需先打开远程控制");
  await page.locator(".composer textarea").fill("一行草稿\n".repeat(50));
  for (const offsetTop of [0, 90, 0, 125]) {
    await page.evaluate((offsetTop) => window.viewport({ height: 450, offsetTop }), offsetTop);
    await expectAboveKeyboard(page);
    const geometry = await page.evaluate(() => ({
      input: ui.input.getBoundingClientRect().height,
      bottomGap: ui.layout.getBoundingClientRect().bottom - ui.composer.getBoundingClientRect().bottom,
      draft: ui.input.value,
    }));
    assert.ok(geometry.input <= 180, "多行草稿按键盘上方的可见高度限高");
    assert.equal(geometry.bottomGap, 8, "有键盘时不重复垫底部安全区");
    assert.equal(geometry.draft, "一行草稿\n".repeat(50));
    await page.evaluate(() => window.viewport({ height: innerHeight, offsetTop: 0 }));
    await expectAboveKeyboard(page);
    assert.equal(await page.evaluate(() => ui.layout.getBoundingClientRect().bottom - ui.composer.getBoundingClientRect().bottom), 42, "收键盘恢复安全区");
  }
});

test("PWA：视口数据在事件之后才更新、聚焦后漏发 resize、回到前台均能重新校正", async (t) => {
  const { page } = await fixture(t);
  await page.locator(".composer textarea").focus();
  await page.evaluate(() => {
    window.viewport({ height: 450, offsetTop: 0 });
    // 模拟 WebKit 先触发事件，之后才更新 offsetTop，且没有补发事件。
    setTimeout(() => window.viewport({ offsetTop: 110 }, null), 100);
  });
  await page.waitForFunction(() => visualViewport.offsetTop === 110);
  await expectAboveKeyboard(page);
  await page.evaluate(() => {
    ui.input.blur();
    setTimeout(() => window.viewport({ height: innerHeight, offsetTop: 0 }, null), 100);
  });
  await page.waitForFunction(() => visualViewport.height === innerHeight);
  await expectAboveKeyboard(page);
  await page.evaluate(() => {
    ui.input.focus();
    setTimeout(() => window.viewport({ height: 430 }, null), 100);
  });
  await page.waitForFunction(() => visualViewport.height === 430);
  await expectAboveKeyboard(page);
  for (const event of ["pageshow", "visibilitychange"]) {
    await page.evaluate((event) => {
      window.viewport({ height: visualViewport.height - 20 }, null);
      (event === "pageshow" ? window : document).dispatchEvent(new Event(event));
    }, event);
    await expectAboveKeyboard(page);
  }
});

test("横屏和原生缩小布局视口的浏览器不重复补偿；没有可见视口 API 时保持 CSS 布局", async (t) => {
  const { page } = await fixture(t);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.evaluate(() => {
    window.viewport({ height: 220, offsetTop: 0 }, null);
    dispatchEvent(new Event("orientationchange"));
  });
  await expectAboveKeyboard(page);
  await page.setViewportSize({ width: 390, height: 480 });
  await page.evaluate(() => window.viewport({ height: 480, offsetTop: 0 }));
  await expectAboveKeyboard(page);
  assert.equal(await page.evaluate(() => ui.layout.offsetHeight), 480);
  await page.addInitScript(() => Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true }));
  await page.reload();
  await page.waitForFunction(() => window.booted);
  assert.equal(await page.evaluate(() => ui.layout.offsetHeight), 480);
});

test("触屏缩放和桌面视口变化不当成键盘；消息阅读位置在开合键盘后保留", async (t) => {
  const { page } = await fixture(t);
  await page.evaluate(async () => {
    const messages = await import("/views/messages.js");
    messages.addItem({ type: "ai", steps: [], committed: "历史消息\n\n".repeat(100), partial: "", done: true });
    messages.userScrolled();
    ui.messages.scrollTop = 180;
    window.viewport({ height: 420, offsetTop: 40, scale: 2 });
  });
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => ui.layout.offsetHeight), 844, "双指缩放不改变聊天布局高度");
  await page.evaluate(() => window.viewport({ height: 450, offsetTop: 0, scale: 1 }));
  await expectAboveKeyboard(page);
  assert.equal(await page.evaluate(() => ui.messages.scrollTop), 180);
  await page.evaluate(() => window.viewport({ height: innerHeight }));
  await expectAboveKeyboard(page);
  assert.equal(await page.evaluate(() => ui.messages.scrollTop), 180);
  const { page: desktop } = await fixture(t, { touch: false });
  await desktop.evaluate(() => window.viewport({ height: 450, offsetTop: 0 }));
  await desktop.waitForTimeout(100);
  assert.equal(await desktop.evaluate(() => ui.layout.offsetHeight), 844);
});

test("远程终端沿用主布局避让，返回聊天后不残留额外键盘补偿", async (t) => {
  const { page } = await fixture(t);
  await page.evaluate(async () => {
    window.remote = await import("/views/remote.js");
    await window.remote.openRemote("terminal");
    window.viewport({ height: 450, offsetTop: 0 });
  });
  await page.waitForFunction(() => Math.abs(ui.remote.getBoundingClientRect().bottom - 450) < 2);
  assert.equal(await page.locator(".remote-pane").evaluate((el) => getComputedStyle(el).paddingBottom), "0px");
  await page.evaluate(() => window.remote.leaveRemote());
  await expectAboveKeyboard(page);
});
