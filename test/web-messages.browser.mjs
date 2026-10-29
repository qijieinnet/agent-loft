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

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
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
