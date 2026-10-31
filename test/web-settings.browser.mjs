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

async function fixture(t, width, colorScheme) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ["--no-sandbox"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 850 }, colorScheme, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  let failRefresh = false;
  let reads = 0;
  const mem = {
    enabled: true, about: "测试简介", chatHistory: true, limits: { about: 4000, item: 500 },
    curate: { when: "manual", agent: "auto", scope: "all", experts: [], dailyHour: 3 },
    items: Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, text: `记忆条目 ${i}：偏好简洁清晰的回答。`, source: "user", updatedAt: 1000 - i })),
  };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/experts") return route.fulfill({ json: { experts: [], builtin: [], engines: ["claude", "codex"], skills: [], mcp: [], machineMcp: {} } });
    if (/\/api\/agents\/\w+\/models/.test(url.pathname)) return route.fulfill({ json: { models: [] } });
    if (url.pathname === "/api/account/memory" && method === "GET") {
      if (reads++) await new Promise((resolve) => setTimeout(resolve, 250));
      if (failRefresh) return route.fulfill({ status: 500, json: { error: "刷新失败" } });
      return route.fulfill({ json: mem });
    }
    if (url.pathname === "/api/account/memory/items" && method === "POST") {
      mem.items.unshift({ id: "new", text: route.request().postDataJSON().text, source: "user", updatedAt: Date.now() });
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname.startsWith("/api/account/memory/items/")) {
      const id = url.pathname.split("/").at(-1);
      const index = mem.items.findIndex((it) => it.id === id);
      if (method === "DELETE") mem.items.splice(index, 1);
      if (method === "PATCH") Object.assign(mem.items[index], { text: route.request().postDataJSON().text, updatedAt: Date.now() });
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === "/api/account/history") return route.fulfill({ json: { conversations: 0, count: 0 } });
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `
      <meta charset="utf-8">${styles}<div id="app"></div><script type="module">
        import { openSettings } from '/settings/index.js';
        await openSettings('记忆');
      </script>` });
    try {
      return route.fulfill({ contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript", body: await fs.readFile(new URL(vendor[url.pathname] ?? `web${url.pathname}`, root), "utf8") });
    } catch {
      return route.fulfill({ status: 404, body: "" });
    }
  });
  await page.goto("https://settings.example.test/");
  await page.getByRole("heading", { name: "记住的事（40）", exact: true }).waitFor({ timeout: 10000 }).catch(async (err) => {
    throw new Error(`${err.message}\n页面：${await page.locator("body").innerText()}\n错误：${errors.join("\n")}`);
  });
  return { page, failNextRefresh: () => { failRefresh = true; } };
}

for (const width of [1280, 390]) {
  test(`${width}px：设置、嵌套专家编辑和重命名只通过按钮关闭，误点遮罩及 Esc 保留输入`, async (t) => {
    const { page } = await fixture(t, width, "light");
    const settings = page.locator(".modal").filter({ has: page.locator(".settings") });
    const about = settings.locator("textarea").first();
    await about.fill("还没保存的自我介绍");
    await page.locator(".overlay").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("Escape");
    assert.equal(await about.inputValue(), "还没保存的自我介绍");
    assert.equal(await page.locator(".confirm-dialog").count(), 0);

    await settings.getByRole("button", { name: "关闭", exact: true }).click();
    const confirm = page.locator(".confirm-dialog");
    await confirm.waitFor();
    await page.locator(".dialog-overlay").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("Escape");
    assert.equal(await confirm.isVisible(), true);
    await confirm.getByRole("button", { name: "取消", exact: true }).click();
    await confirm.waitFor({ state: "detached" });
    assert.equal(await about.inputValue(), "还没保存的自我介绍");
    await settings.getByRole("button", { name: "关闭", exact: true }).click();
    await confirm.getByRole("button", { name: "不保存", exact: true }).click();
    await page.locator(".overlay").waitFor({ state: "detached" });

    await page.evaluate(async () => { const { openSettings } = await import('/settings/index.js'); await openSettings('专家'); });
    await settings.getByRole("button", { name: "新建", exact: true }).click();
    const editor = page.locator(".modal").filter({ has: page.getByRole("heading", { name: "新建专家", exact: true }) });
    const name = editor.getByPlaceholder("比如：证券观察员", { exact: true });
    const prompt = editor.locator("textarea.skill-body-input");
    await name.fill("尚未保存的专家");
    await prompt.fill("编辑中的完整提示词");
    await page.locator(".overlay").last().click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".modal").count(), 2);
    assert.equal(await name.inputValue(), "尚未保存的专家");
    assert.equal(await prompt.inputValue(), "编辑中的完整提示词");
    await editor.getByRole("button", { name: "关闭", exact: true }).click();
    assert.equal(await page.locator(".modal").count(), 1);
    await settings.getByRole("button", { name: "关闭", exact: true }).click();
    await page.locator(".overlay").waitFor({ state: "detached" });

    await page.evaluate(async () => {
      const { S } = await import('/state.js'); const { renameConv } = await import('/views/conv-actions.js');
      S.convs.set('web:rename', { key: 'web:rename', title: '原名称', agent: 'claude', cwd: '/workspace' }); renameConv('web:rename');
    });
    await page.locator(".rename-input").fill("尚未保存的名称");
    await page.locator(".dialog-overlay").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".rename-input").inputValue(), "尚未保存的名称");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.locator(".dialog-overlay").waitFor({ state: "detached" });
  });
}

// 在接口等待和最终替换期间持续采样，防止先跳到顶部再恢复也被当成通过。
async function recordScroll(page) {
  return page.evaluate(() => {
    const panel = document.querySelector(".settings-body");
    window.scrollSamples = [panel.scrollTop];
    window.recordScroll = true;
    const sample = () => {
      if (!window.recordScroll) return;
      window.scrollSamples.push(panel.scrollTop);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    return panel.scrollTop;
  });
}

async function checkScroll(page, before) {
  const samples = await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    window.recordScroll = false;
    return [...window.scrollSamples, document.querySelector(".settings-body").scrollTop];
  });
  assert.ok(before > 100, "操作前已向下滚动");
  assert.ok(samples.every((top) => Math.abs(top - before) <= 1), `更新期间应保持位置 ${before}，实际范围 ${Math.min(...samples)}–${Math.max(...samples)}`);
}

for (const width of [1280, 390]) {
  for (const colorScheme of ["light", "dark"]) {
    test(`${width}px ${colorScheme}：设置焦点使用主题灰色，增删改记忆不跳动`, async (t) => {
      const { page, failNextRefresh } = await fixture(t, width, colorScheme);
      for (const selector of ['.settings-page input[type="text"], .settings-page input:not([type])', ".settings-page textarea", ".settings-page select"]) {
        const input = page.locator(selector).first();
        await input.focus();
        const colors = await input.evaluate((el) => ({
          border: getComputedStyle(el).borderColor,
          theme: getComputedStyle(el).getPropertyValue("--fg-soft").trim(),
        }));
        const expected = await page.evaluate((color) => {
          const el = document.createElement("span");
          el.style.color = color;
          document.body.append(el);
          const rgb = getComputedStyle(el).color;
          el.remove();
          return rgb;
        }, colors.theme);
        assert.equal(colors.border, expected);
      }
      const memories = page.locator(".settings-page > .section").filter({ has: page.getByRole("heading", { name: /^记住的事/ }) });
      const add = memories.getByRole("button", { name: "添加", exact: true });
      await memories.locator("input").fill("新增的测试记忆");
      await add.scrollIntoViewIfNeeded();
      let before = await recordScroll(page);
      await add.click();
      await page.getByRole("heading", { name: "记住的事（41）", exact: true }).waitFor();
      await checkScroll(page, before);

      let row = memories.locator(".list-item").nth(8);
      await row.getByRole("button", { name: "编辑", exact: true }).click();
      await row.locator("textarea").fill("修改后的记忆");
      const save = row.getByRole("button", { name: "保存", exact: true });
      await save.scrollIntoViewIfNeeded();
      before = await recordScroll(page);
      await save.click();
      await memories.getByText("修改后的记忆", { exact: true }).waitFor({ state: "attached" });
      await checkScroll(page, before);

      row = memories.locator(".list-item").nth(10);
      const del = row.getByRole("button", { name: "删除", exact: true });
      await del.scrollIntoViewIfNeeded();
      before = await recordScroll(page);
      await del.click();
      await page.getByRole("heading", { name: "记住的事（40）", exact: true }).waitFor({ state: "attached" });
      await checkScroll(page, before);

      failNextRefresh();
      const failedDelete = memories.locator(".list-item").nth(12).getByRole("button", { name: "删除", exact: true });
      await failedDelete.scrollIntoViewIfNeeded();
      before = await recordScroll(page);
      await failedDelete.click();
      await page.locator(".toast").filter({ hasText: "刷新失败" }).waitFor();
      assert.equal(await memories.locator(".list-item").count(), 40, "刷新失败保留当前页面");
      await checkScroll(page, before);
    });
  }
}
