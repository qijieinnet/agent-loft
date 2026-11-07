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
};

async function fixture(t, mobile) {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}), args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1280, height: 1000 }, isMobile: mobile, hasTouch: mobile, colorScheme: mobile ? "dark" : "light", serviceWorkers: "block" });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(() => { window.WebSocket = class { readyState = 0; close() {} send() {} }; });
  const agents = [{ id: "claude", label: "Claude Code", enabled: true, available: true }, { id: "codex", label: "Codex", enabled: true, available: true }];
  const own = { id: "e_123abc", name: "我的专家", engine: "claude", access: "web", editable: true, skills: [], mcp: [], subagents: [], memory: true };
  const shared = { ...own, id: "e_456def", name: "共享专家", shared: true, editable: false };
  const experts = [own, shared];
  let order = [];
  let saves = 0;
  let failSave = false;
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p.startsWith("/api/")) {
      let data = {};
      if (p === "/api/me") data = { authed: true, user: { id: "viewer", role: "member" } };
      if (p === "/api/bootstrap") data = { user: { id: "viewer", role: "member" }, agents, experts, expertOrder: order, bots: [], conversations: [], pending: [], workspaceRoot: "/workspace", quotaEnabled: false, remote: { allowed: false }, sidebar: { recent: { next: null }, dirs: [] } };
      if (p === "/api/experts") data = { experts, expertOrder: order, builtin: agents.map((a) => ({ id: a.id, engine: a.id, name: a.label })), engines: ["claude", "codex"], access: [{ id: "web", label: "只能联网" }], skills: [], mcp: [] };
      if (p === "/api/experts/brief") data = { experts, expertOrder: order, builtin: agents.map((a) => a.id) };
      if (p === "/api/experts/order") {
        assert.equal(route.request().method(), "PUT");
        saves++;
        if (failSave) return route.fulfill({ status: 500, json: { error: "测试保存失败" } });
        order = route.request().postDataJSON().order;
        data = { order };
      }
      if (p.startsWith("/api/agents/")) data = { models: [] };
      return route.fulfill({ json: data });
    }
    if (p === "/") return route.fulfill({ contentType: "text/html", body: `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<div id="app"></div><script type="module">
      import { S } from '/state.js'; import { boot } from '/views/layout.js'; import { openSettings } from '/settings/index.js';
      window.S = S; await boot(); await openSettings('专家'); window.booted = true;
    </script>` });
    try { return route.fulfill({ contentType: p.endsWith(".css") ? "text/css" : "text/javascript", body: await fs.readFile(new URL(vendor[p] ?? `web${p}`, root), "utf8") }); }
    catch { return route.fulfill({ status: 404, body: "" }); }
  });
  await page.goto("https://expert-order.example.test/#new");
  await page.waitForFunction(() => window.booted);
  await page.locator(".expert-sort-card").first().waitFor();
  return { page, experts, getOrder: () => order, getSaves: () => saves, failSave: (value) => { failSave = value; } };
}

const listOrder = (page) => page.locator(".expert-sort-card").evaluateAll((els) => els.map((el) => el.dataset.expert));
const choiceOrder = (page) => page.evaluate(async () => (await import("/views/experts.js")).expertChoices().map((e) => e.id));

for (const mobile of [false, true]) {
  test(`${mobile ? "触屏" : "桌面"}：内置、自建和共享专家混合拖动，自动保存，选择器和刷新沿用顺序`, async (t) => {
    const { page, experts, getOrder, getSaves } = await fixture(t, mobile);
    const initial = ["claude", "codex", ...experts.map((e) => e.id)];
    assert.deepEqual(await listOrder(page), initial);
    const handle = page.getByRole("button", { name: "调整共享专家顺序", exact: true });
    await handle.scrollIntoViewIfNeeded();
    const from = await handle.boundingBox();
    const target = await page.locator('[data-expert="claude"]').boundingBox();
    const saved = page.waitForResponse((res) => res.url().endsWith("/api/experts/order") && res.ok());
    if (mobile) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x + from.width / 2, y: from.y + from.height / 2 }] });
      for (let i = 1; i <= 12; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + from.width / 2, y: from.y + from.height / 2 + (target.y + 2 - from.y - from.height / 2) * i / 12 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2, target.y + 2, { steps: 12 });
      await page.mouse.up();
    }
    await saved;
    await page.waitForFunction(() => !document.querySelector(".expert-sort-grip").disabled);
    const expected = [experts[1].id, "claude", "codex", experts[0].id];
    assert.deepEqual(await listOrder(page), expected);
    assert.deepEqual(getOrder(), expected);
    assert.equal(getSaves(), 1, "一次拖动只保存一次");
    assert.deepEqual(await choiceOrder(page), expected);
    assert.equal(await page.locator(".settings-body").evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
    await page.screenshot({ path: `/tmp/agent-loft-expert-order-${mobile ? "mobile" : "desktop"}.png` });
    await page.locator(".modal-head .icon-btn").click();
    await page.locator('[title="选择专家"]').click();
    assert.deepEqual(await page.locator(".expert-pop .pop-item .t").allTextContents(), ["共享专家", "Claude Code", "Codex", "我的专家"]);
    await page.locator(".expert-pop .pop-item").first().click();
    assert.equal(await page.evaluate(() => S.draftExpert), experts[1].id);
    await page.reload();
    await page.waitForFunction(() => window.booted);
    assert.deepEqual(await listOrder(page), expected);
    assert.deepEqual(await choiceOrder(page), expected);
    assert.equal(await page.evaluate(() => S.draftExpert), experts[1].id, "排序不会覆盖已选专家");
    await page.evaluate(() => { S.agents[0].available = false; });
    assert.deepEqual(await choiceOrder(page), ["codex"], "排序不绕过可用性筛选");
    await page.evaluate(() => { S.agents[0].available = true; S.experts.push({ id: "e_new", name: "新增", engine: "claude" }); });
    assert.deepEqual(await choiceOrder(page), [...expected, "e_new"], "新专家接在末尾");
  });
}

test("专家排序：键盘可调整；保存失败回退，可重试；取消拖动不保存", async (t) => {
  const { page, getOrder, getSaves, failSave } = await fixture(t, false);
  const before = await listOrder(page);
  const handle = page.getByRole("button", { name: "调整Codex顺序", exact: true });
  failSave(true);
  await handle.press("ArrowUp");
  await page.getByText("保存专家顺序失败：测试保存失败", { exact: true }).waitFor();
  assert.deepEqual(await listOrder(page), before);
  assert.deepEqual(await choiceOrder(page), before);
  assert.deepEqual(getOrder(), []);
  failSave(false);
  const saved = page.waitForResponse((res) => res.url().endsWith("/api/experts/order") && res.ok());
  await handle.press("ArrowUp");
  await saved;
  await page.waitForFunction(() => !document.querySelector(".expert-sort-grip").disabled);
  assert.deepEqual(await listOrder(page), ["codex", "claude", ...before.slice(2)]);
  const order = await listOrder(page);
  const saves = getSaves();
  const r = await handle.boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2, r.y + 150, { steps: 5 });
  await handle.dispatchEvent("pointercancel");
  await page.mouse.up();
  assert.deepEqual(await listOrder(page), order);
  assert.equal(getSaves(), saves);
});
