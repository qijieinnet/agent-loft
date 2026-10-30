// 浏览器回归：与 web-messages.browser.mjs 一样，通过环境变量指定 Playwright 和 Chromium。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const { chromium } = await import(process.env.AGENT_LOFT_PLAYWRIGHT || "playwright-core");
const root = new URL("../", import.meta.url);
const vendor = {
  "/vendor/marked.js": "node_modules/marked/lib/marked.esm.js",
  "/vendor/purify.js": "node_modules/dompurify/dist/purify.es.mjs",
  "/vendor/hljs.js": "node_modules/@highlightjs/cdn-assets/es/highlight.min.js",
  "/vendor/hljs-light.css": "node_modules/@highlightjs/cdn-assets/styles/github.min.css",
  "/vendor/hljs-dark.css": "node_modules/@highlightjs/cdn-assets/styles/github-dark.min.css",
};
const styles = (await fs.readFile(new URL("web/index.html", root), "utf8")).match(/<link[^>]+rel="stylesheet"[^>]*>/g).join("\n");

async function fixture(t, width, colorScheme = "light") {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ["--no-sandbox"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 }, locale: "zh-CN", deviceScaleFactor: 2, colorScheme, serviceWorkers: "block" });
  const calls = [];
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(() => {
    window.WebSocket = class { readyState = 0; close() {} send() {} };
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/")) {
      calls.push({ path: url.pathname, method: route.request().method(), body: route.request().postDataJSON() });
      let data = { ok: true };
      if (url.pathname === "/api/me") data = { authed: true, user: { id: "u1", role: "admin" } };
      if (url.pathname === "/api/bootstrap") data = {
        user: { id: "u1", role: "admin" }, agents: [{ id: "claude", enabled: true, available: true }], bots: [], pending: [], conversations: [],
        workspaceRoot: "/tmp", quotaEnabled: false, sidebar: { recent: { next: null }, dirs: [] },
      };
      if (url.pathname === "/api/tasks" && route.request().method() === "GET") data = { tasks: [], tz: "Asia/Hong_Kong" };
      return route.fulfill({ json: data });
    }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `
      ${styles}<div id="app"></div><script type="module">
        import { boot } from '/views/layout.js';
        import { openTasks, openTaskForm } from '/views/tasks.js';
        window.openTaskForm = openTaskForm;
        await boot(); await openTasks(); window.booted = true;
      </script>` });
    try {
      return route.fulfill({ contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript", body: await fs.readFile(new URL(vendor[url.pathname] ?? `web${url.pathname}`, root), "utf8") });
    } catch {
      return route.fulfill({ status: 404, body: "" });
    }
  });
  await page.goto("https://host.example.test/#tasks");
  await page.waitForFunction(() => window.booted);
  return { page, calls };
}

for (const width of [1280, 390, 320]) {
  for (const colorScheme of ["light", "dark"]) {
    test(`${width}px ${colorScheme}：星期文字保持单行等宽，执行时刻独立排列`, async (t) => {
      const { page } = await fixture(t, width, colorScheme);
      await page.evaluate(() => window.openTaskForm({
        id: "preview", title: "ETF 投资跟踪", prompt: "查看关注的 ETF 最近 15 个交易日的价格和份额变化，整理走势图与简短摘要。",
        schedule: { kind: "weekly", days: [1, 3, 5], time: "08:00" },
        target: { kind: "dedicated" }, expert: "claude", notify: "always",
      }));
      const chips = page.getByRole("group", { name: "执行星期（可多选）" });
      await chips.scrollIntoViewIfNeeded();
      const geometry = await chips.locator("button").evaluateAll((buttons) => buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(button);
        const text = range.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, bottom: rect.bottom, right: rect.right, textX: text.x, textRight: text.right, lines: range.getClientRects().length };
      }));
      for (const button of geometry) {
        assert.equal(button.lines, 1, "周一至周日不能折成两行");
        assert.ok(Math.abs(button.width - geometry[0].width) < 1, "七个按钮等宽");
        assert.equal(button.y, geometry[0].y, "七个星期保持同一行");
        assert.ok(button.textX >= button.x && button.textRight <= button.right, "文字不能超出按钮");
        assert.ok(button.x >= 0 && button.right <= width, "按钮不能超出屏幕");
      }
      const clock = page.getByRole("textbox", { name: "执行时刻" });
      const clockBounds = await clock.boundingBox();
      assert.ok(clockBounds.y > geometry[0].bottom, "时间框排在星期下一行");
      await chips.getByRole("button", { name: "周日", exact: true }).focus();
      await page.keyboard.press("Space");
      assert.equal(await chips.getByRole("button", { name: "周日", exact: true }).getAttribute("aria-pressed"), "true");
      await page.keyboard.press("Space");
      if (process.env.AGENT_LOFT_UI_SCREENSHOTS) {
        await chips.getByRole("button", { name: "周日", exact: true }).blur();
        const dir = process.env.AGENT_LOFT_UI_SCREENSHOTS;
        await fs.mkdir(dir, { recursive: true });
        await page.locator(".task-weekly-controls").screenshot({ path: `${dir}/schedule-${width}-${colorScheme}.png` });
        await page.locator(".modal").screenshot({ path: `${dir}/form-${width}-${colorScheme}.png` });
      }
    });
  }
}

for (const width of [1280, 390]) {
  test(`${width}px：执行星期可多选，保存后编辑回填，空选择不提交`, async (t) => {
    const { page, calls } = await fixture(t, width);
    await page.evaluate(() => window.openTaskForm());
    const chips = page.getByRole("group", { name: "执行星期（可多选）" });
    assert.deepEqual(await chips.locator("button").allTextContents(), ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]);
    assert.equal(await chips.locator('[aria-pressed="true"]').count(), 7);
    await page.locator(".task-form textarea").fill("检查更新");
    for (const name of ["周二", "周四", "周六"]) await chips.getByRole("button", { name, exact: true }).click();
    await page.locator('.task-form input[type="time"]').fill("08:45");
    const bounds = await chips.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, "手机上星期选择不溢出");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await page.locator(".overlay").waitFor({ state: "detached" });
    const created = calls.find((c) => c.path === "/api/tasks" && c.method === "POST");
    assert.deepEqual(created.body.schedule, { kind: "weekly", days: [1, 3, 5, 0], time: "08:45" });

    await page.evaluate((body) => window.openTaskForm({ ...body, id: "t1" }), created.body);
    assert.deepEqual(await chips.locator('[aria-pressed="true"]').allTextContents(), ["周一", "周三", "周五", "周日"]);
    assert.equal(await page.locator('.task-form input[type="time"]').inputValue(), "08:45");
    for (const name of ["周一", "周三", "周五", "周日"]) await chips.getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
    assert.match(await page.locator(".toast").last().textContent(), /至少选择一个执行星期/);
    await chips.getByRole("button", { name: "周日", exact: true }).click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.locator(".overlay").waitFor({ state: "detached" });
    assert.deepEqual(calls.find((c) => c.method === "PATCH").body.schedule, { kind: "weekly", days: [0], time: "08:45" });

    await page.evaluate(() => window.openTaskForm(null, { schedule: { kind: "weekdays", time: "18:00" } }));
    assert.deepEqual(await chips.locator('[aria-pressed="true"]').allTextContents(), ["周一", "周二", "周三", "周四", "周五"]);
    const freq = page.locator(".task-form select").first();
    await freq.selectOption("daily");
    assert.equal(await chips.locator('[aria-pressed="true"]').count(), 7);
    await freq.selectOption("once");
    assert.equal(await chips.count(), 0);
    await freq.selectOption("weekly");
    assert.equal(await chips.locator("button").count(), 7);
    assert.equal(await page.locator('.task-form input[type="time"]').inputValue(), "18:00");
  });
}
