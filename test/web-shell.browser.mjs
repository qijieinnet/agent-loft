// 浏览器回归：node --test test/web-shell.browser.mjs。
// 需要 playwright-core 和 Chromium；可用 AGENT_LOFT_PLAYWRIGHT 指定模块路径，
// 用 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 指定已有的浏览器。所有请求都在本地模拟。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const { chromium } = await import(process.env.AGENT_LOFT_PLAYWRIGHT || "playwright-core");
const root = new URL("../", import.meta.url);
const host = "https://host.example.test";
const guest = "https://guest.example.test";
const serverId = "a1b2c3d4";
const endpoint = "https://web.push.apple.com/example";
const info = { self: { id: "home", name: "Host", icon: "" }, list: [{ id: serverId, name: "Guest", icon: "", url: guest }] };
const conv = { key: "web:1", channel: "web", channelId: "1", agent: "claude", title: "Test", cwd: "/tmp", activeAt: 1, busy: false };
const vendor = {
  "/vendor/marked.js": "node_modules/marked/lib/marked.esm.js",
  "/vendor/purify.js": "node_modules/dompurify/dist/purify.es.mjs",
  "/vendor/hljs.js": "node_modules/@highlightjs/cdn-assets/es/highlight.min.js",
  "/vendor/hljs-light.css": "node_modules/@highlightjs/cdn-assets/styles/github.min.css",
  "/vendor/hljs-dark.css": "node_modules/@highlightjs/cdn-assets/styles/github-dark.min.css",
};
const styles = (await fs.readFile(new URL("web/index.html", root), "utf8")).match(/<link[^>]+rel="stylesheet"[^>]*>/g).join("\n");

async function fixture(t, { relayDelay = 0, unsubscribeDelay = 0, guestAuthed = true, guestDown = false } = {}) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ["--no-sandbox"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: "block" });
  const calls = [];
  const subscriptions = new Map();
  await context.addInitScript(({ endpoint }) => {
    window.WebSocket = class { readyState = 0; close() {} send() {} };
    window.mockSub = { endpoint, options: {}, toJSON() { return { endpoint: this.endpoint, keys: { p256dh: "test", auth: "test" } }; } };
    window.opened = [];
    document.addEventListener("aim:shell-open", (e) => window.opened.push(e.detail));
  }, { endpoint });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/")) {
      const body = route.request().postDataJSON();
      calls.push({ origin: url.origin, path: url.pathname, body });
      if (url.pathname === "/api/push/relay") {
        if (relayDelay) await new Promise((r) => setTimeout(r, relayDelay));
        subscriptions.set(body.subscription.endpoint, true);
      }
      if (url.pathname === "/api/push/unsubscribe") {
        if (unsubscribeDelay) await new Promise((r) => setTimeout(r, unsubscribeDelay));
        subscriptions.delete(body.endpoint);
      }
      let data = { ok: true };
      if (url.pathname === "/api/me") data = { authed: url.origin !== guest || guestAuthed, user: { id: "u1", role: "admin" } };
      if (url.pathname === "/api/bootstrap") data = {
        user: { id: "u1", role: "admin" }, servers: info, agents: [], bots: [], pending: [], conversations: [conv],
        workspaceRoot: "/tmp", quotaEnabled: false, sidebar: { recent: { next: null }, dirs: [] },
      };
      if (url.pathname.endsWith("/history")) data = { info: { ...conv, key: decodeURIComponent(url.pathname.split("/")[3]) }, allowedAgents: [], messages: [], live: [], interactions: [], pending: [], seq: 0 };
      if (url.pathname === "/api/push/relay-key") data = { publicKey: "test", privateJwk: {} };
      return route.fulfill({ json: data });
    }
    if (url.origin === guest && url.pathname === "/" && guestDown) return route.fulfill({ status: 503, body: "Offline" });
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `
      ${styles}<div id="app"></div><script type="module">
        import * as shell from '/lib/shell.js'; import { S } from '/state.js'; window.shell = shell; window.S = S;
        import { boot } from '/views/layout.js'; await boot();
        window.booted = true;
      </script>` });
    if (url.origin === host && url.pathname === "/lib/push.js") return route.fulfill({
      contentType: "text/javascript",
      body: "export async function currentPushSub() { return window.mockSub; } export async function releaseForeignPushSub() {}",
    });
    try {
      return route.fulfill({ contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript", body: await fs.readFile(new URL(vendor[url.pathname] ?? `web${url.pathname}`, root), "utf8") });
    } catch {
      return route.fulfill({ status: 404, body: "" });
    }
  });
  const page = await context.newPage();
  const errors = [];
  context.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
  page.on("pageerror", (e) => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  const registered = guestAuthed && !guestDown ? page.waitForResponse((r) => r.url() === `${guest}/api/push/relay`) : Promise.resolve();
  await page.goto(`${host}/#web%3A1`);
  await page.waitForFunction((down) => window.booted && (down || window.shell.SH.servers[1]?.state === "ready"), guestDown);
  const frame = page.frames().find((f) => f.url().startsWith(guest));
  if (!guestDown) await frame.waitForFunction(() => window.booted && window.shell.SH.push, null, { polling: 50 });
  return { page, frame, context, calls, subscriptions, registered };
}

test("嵌入页退出先等注册完成，再退订，不影响外壳的浏览器订阅", async (t) => {
  const { page, frame, calls, subscriptions } = await fixture(t, { relayDelay: 400 });
  await frame.evaluate(async () => {
    const { dropPushSub } = await import("/lib/push.js");
    const { api } = await import("/lib/api.js");
    await dropPushSub();
    await api("/api/logout", { method: "POST" });
  });
  const paths = calls.filter((c) => c.origin === guest && (c.path.startsWith("/api/push/") || c.path === "/api/logout")).map((c) => c.path);
  assert.deepEqual(paths, ["/api/push/relay", "/api/push/unsubscribe", "/api/logout"]);
  assert.equal(subscriptions.has(endpoint), false);
  assert.equal(await page.evaluate(() => !!window.mockSub), true);
  // 外壳再次发来订阅，也不能在退出过程中把旧账号重新注册回去。
  await page.evaluate(() => document.querySelector("iframe").contentWindow.postMessage({ ns: "agent-loft", t: "push", push: window.shell.SH.push }, "https://guest.example.test"));
  await frame.evaluate(() => new Promise((r) => setTimeout(r, 100)));
  assert.equal(calls.filter((c) => c.path === "/api/push/relay").length, 1);
});

test("通过切换菜单往返，角标同步，隐藏页面不被视为正在查看", async (t) => {
  const { page, frame } = await fixture(t);
  await frame.evaluate(() => window.shell.reportShellState(2, 1));
  await page.waitForFunction(() => window.shell.SH.servers[1].pending === 2);
  await page.locator(".side-switch .server-switch").click();
  await page.locator(".menu .srv-item").filter({ hasText: "Guest" }).click();
  assert.equal(await page.evaluate(() => window.shell.shownHere()), false);
  await frame.waitForFunction(() => window.shell.shownHere());
  await frame.locator(".side-switch .server-switch").click();
  await frame.locator(".menu .srv-item").filter({ hasText: "Host" }).click();
  await page.waitForFunction(() => window.shell.SH.current === "home");
  await frame.waitForFunction(() => !window.shell.shownHere(), null, { polling: 50 });
  assert.equal(await page.locator("#app").evaluate((el) => el.inert), false);
});

test("手机窄屏展开侧栏切换，切回时侧栏已关闭", async (t) => {
  const { page, frame } = await fixture(t);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".topbar .menu-btn").click();
  await page.locator(".side-switch .server-switch").click();
  await page.locator(".menu .srv-item").filter({ hasText: "Guest" }).click();
  await frame.locator(".topbar .menu-btn").click();
  await frame.locator(".side-switch .server-switch").click();
  await frame.locator(".menu .srv-item").filter({ hasText: "Host" }).click();
  await page.waitForFunction(() => window.shell.SH.current === "home");
  assert.equal(await page.locator(".layout").evaluate((el) => el.classList.contains("side-open")), false);
  assert.equal(await frame.locator(".layout").evaluate((el) => el.classList.contains("side-open")), false);
});

test("修改尚未保存的服务器地址后禁止授权，恢复原地址后可授权", async (t) => {
  const { page } = await fixture(t);
  await page.evaluate(async (info) => {
    const { serversTab } = await import("/settings/servers.js");
    const panel = document.createElement("div");
    panel.id = "test-servers";
    panel.style.cssText = "position:fixed;inset:0;z-index:100;background:white;overflow:auto";
    document.body.append(panel);
    serversTab({ servers: { selfName: "Host", selfIcon: "", list: info.list, embedders: [] } }, panel);
  }, info);
  const authorize = page.locator("#test-servers .srv-edit-actions button").filter({ hasText: "授权" });
  assert.equal(await authorize.isDisabled(), false);
  const url = page.locator("#test-servers .srv-edit-fields input:nth-child(3)");
  await url.fill("https://changed.example.test");
  assert.equal(await authorize.isDisabled(), true);
  await url.fill(guest);
  assert.equal(await authorize.isDisabled(), false);
});

test("远端未登录时显示登录页，仍能通过切换菜单返回本机", async (t) => {
  const { page, frame, calls } = await fixture(t, { guestAuthed: false });
  await page.evaluate((id) => window.shell.switchServer(id), serverId);
  await frame.locator(".auth-card").waitFor();
  await frame.locator(".auth-switch .server-switch").click();
  await frame.locator(".menu .srv-item").filter({ hasText: "Host" }).click();
  await page.waitForFunction(() => window.shell.SH.current === "home");
  assert.equal(calls.some((c) => c.path === "/api/push/relay"), false);
});

test("远端离线时显示重试提示，浮动切换菜单可返回本机", async (t) => {
  const { page } = await fixture(t, { guestDown: true });
  await page.evaluate((id) => window.shell.switchServer(id), serverId);
  await page.locator(".srv-card h3").waitFor();
  assert.match(await page.locator(".srv-card").innerText(), /没有响应/);
  await page.locator(".srv-pill .server-switch").click();
  await page.locator(".menu .srv-item").filter({ hasText: "Host" }).click();
  assert.equal(await page.evaluate(() => window.shell.SH.current), "home");
});

test("外壳开关通知后远端订阅跟着撤销和恢复，服务器改名同步到通知标签", async (t) => {
  const { page, frame, calls, registered } = await fixture(t);
  await registered;
  await page.evaluate(async () => {
    window.savedSub = window.mockSub;
    window.mockSub = null;
    await window.shell.refreshShellPush();
  });
  await frame.waitForFunction(() => !window.shell.SH.push, null, { polling: 50 });
  await page.evaluate(async () => { window.mockSub = window.savedSub; await window.shell.refreshShellPush(); });
  await frame.waitForFunction(() => !!window.shell.SH.push, null, { polling: 50 });
  await page.evaluate((info) => window.shell.applyShellInfo({ ...info, list: info.list.map((s) => ({ ...s, name: "Renamed" })) }), info);
  await frame.waitForFunction(() => window.shell.SH.servers[1].name === "Renamed", null, { polling: 50 });
  await frame.evaluate(() => new Promise((r) => setTimeout(r, 100)));
  const registrations = calls.filter((c) => c.path === "/api/push/relay");
  assert.equal(registrations.at(-1).body.via.label, "Renamed");
  assert.equal(calls.filter((c) => c.path === "/api/push/unsubscribe").length, 1);
});

test("删除最后一台时保留 iframe，等慢退订完成并确认后再移除", async (t) => {
  const { page, calls, subscriptions, registered } = await fixture(t, { unsubscribeDelay: 700 });
  await registered;
  assert.equal(subscriptions.has(endpoint), true);
  await page.evaluate(() => window.shell.applyShellInfo(null));
  await page.waitForTimeout(350);
  assert.equal(page.frames().length, 2, "远端退订完成前不能销毁 iframe");
  assert.equal(await page.locator("#app").evaluate((el) => el.inert), false);
  await page.waitForFunction(() => !document.querySelector(".server-frames"));
  assert.equal(subscriptions.has(endpoint), false);
  assert.equal(page.frames().length, 1);
  assert.equal(calls.filter((c) => c.path === "/api/push/unsubscribe").length, 1);
});

test("刷新恢复所选服务器，新开的本机会话链接与通知链接仍优先定位", async (t) => {
  const { page, context } = await fixture(t);
  await page.evaluate((id) => window.shell.switchServer(id), serverId);
  await page.reload();
  await page.waitForFunction(() => window.booted);
  assert.equal(await page.evaluate(() => window.shell.SH.current), serverId);
  // 同一个浏览器另开一个本机链接，不继承其他标签页的历史记录状态。
  const direct = await context.newPage();
  await direct.goto(`${host}/#web%3A1`);
  await direct.waitForFunction(() => window.booted);
  assert.equal(await direct.evaluate(() => window.shell.SH.current), "home");
  await direct.goto(`${host}/?srv=${serverId}#web%3A2`);
  await direct.waitForFunction(() => window.booted && window.shell.SH.servers[1]?.state === "ready");
  assert.equal(await direct.evaluate(() => window.shell.SH.current), serverId);
  const frame = direct.frames().find((f) => f.url().startsWith(guest));
  await frame.waitForFunction(() => window.opened.includes("web:2"));
  await direct.goto(`${host}/?srv=home#web%3A1`);
  await direct.waitForFunction(() => window.booted);
  assert.equal(await direct.evaluate(() => window.shell.SH.current), "home");
});
