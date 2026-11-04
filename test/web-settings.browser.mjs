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

async function fixture(t, width, colorScheme, role = "member") {
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
    counts: { core: 0, active: 40, archive: 0, trash: 0 },
    summaries: { conv: 0, month: 1 },
    searchStats: { searches: 12, empty: 3 },
    ...(role === "admin" ? { backup: { dir: "/backups/db", count: 2, last: { name: "x", at: Date.now() - 3600_000, size: 1048576 } } } : {}),
    archived: [],
    trashed: [],
    logEntries: [{ id: 7, itemId: "m1", action: "update", actor: "auto", oldText: "旧内容", newText: "新内容", at: Date.now() - 60_000 }],
    summaryRows: [{ id: 1, kind: "month", scope: "2026-10", title: "折腾软路由", text: "这个月主要在配 OpenClash。", toTs: Date.now(), fromTs: Date.now() }],
  };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/config") return route.fulfill({ json: { web: { host: "127.0.0.1", port: 3000 } } });
    if (url.pathname === "/api/push") return route.fulfill({ json: { subscriptions: [] } });
    if (url.pathname === "/api/system") return route.fulfill({ json: { version: "1.0", node: "v22", uptimeMs: 1000, underSystemd: false } });
    if (url.pathname === "/api/server/version") return route.fulfill({ json: { version: "1.0", latest: "1.0", updateAvailable: false } });
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
    if (url.pathname === "/api/account/memory/items" && method === "GET") {
      const view = url.searchParams.get("view");
      return route.fulfill({ json: { items: view === "archive" ? mem.archived : mem.trashed } });
    }
    if (url.pathname === "/api/account/memory/log") return route.fulfill({ json: { log: mem.logEntries } });
    if (/\/api\/account\/memory\/log\/\d+\/undo$/.test(url.pathname)) {
      mem.undone = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === "/api/account/memory/summaries") return route.fulfill({ json: { summaries: mem.summaryRows } });
    const restore = /\/api\/account\/memory\/items\/(\w+)\/restore$/.exec(url.pathname);
    if (restore) {
      const i = mem.trashed.findIndex((it) => it.id === restore[1]);
      mem.items.unshift(...mem.trashed.splice(i, 1));
      mem.counts.trash = mem.trashed.length;
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname.startsWith("/api/account/memory/items/")) {
      const id = url.pathname.split("/").at(-1);
      const index = mem.items.findIndex((it) => it.id === id);
      const body = method === "PATCH" ? route.request().postDataJSON() : {};
      if (method === "DELETE") {
        mem.trashed.push(...mem.items.splice(index, 1).map((it) => ({ ...it, deletedAt: Date.now() })));
        mem.counts.trash = mem.trashed.length;
      }
      if (method === "PATCH" && body.tier === "archive") {
        mem.archived.push(...mem.items.splice(index, 1));
      } else if (method === "PATCH" && body.tier === "active" && index < 0) {
        const i = mem.archived.findIndex((it) => it.id === id);
        mem.items.unshift(...mem.archived.splice(i, 1).map((it) => ({ ...it, tier: "active", locked: false })));
      } else if (method === "PATCH" && body.tier) {
        Object.assign(mem.items[index], { tier: body.tier, locked: body.tier === "core" });
      } else if (method === "PATCH") {
        Object.assign(mem.items[index], { text: body.text, updatedAt: Date.now() });
      }
      mem.counts.archive = mem.archived.length;
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === "/api/account/history") return route.fulfill({ json: { conversations: 0, count: 0 } });
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `
      <meta charset="utf-8">${styles}<div id="app"></div><script type="module">
        import { openSettings } from '/settings/index.js'; import { S } from '/state.js';
        S.user = { id: 'u_test', role: '${role}' }; await openSettings('记忆');
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
  return { page, mem, failNextRefresh: () => { failRefresh = true; } };
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
      await memories.getByPlaceholder(/^手动加一条/).fill("新增的测试记忆");
      await add.scrollIntoViewIfNeeded();
      let before = await recordScroll(page);
      await add.click();
      await page.getByRole("heading", { name: "记住的事（41）", exact: true }).waitFor();
      await checkScroll(page, before);

      let row = memories.locator(".list-item").nth(8);
      await row.getByRole("button", { name: "编辑", exact: true }).click();
      assert.equal(await row.getByRole("button", { name: "编辑", exact: true }).isVisible(), false);
      assert.equal(await row.getByRole("button", { name: "删除", exact: true }).isVisible(), false);
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

for (const width of [390, 1280]) {
  for (const role of ["member", "admin"]) {
    test(`${width}px ${role}：通知归入系统，保留个人设备设置且管理项按权限显示`, async (t) => {
      const { page } = await fixture(t, width, "light", role);
      assert.equal(await page.locator('.settings-nav').getByRole('button', { name: '通知', exact: true }).count(), 0);
      await page.locator('.settings-nav').getByRole('button', { name: '系统', exact: true }).click();
      await page.getByRole('heading', { name: '系统通知', exact: true }).waitFor();
      const headings = await page.locator('.settings-page > .section > h4:first-child').allTextContents();
      assert.deepEqual(headings, role === 'admin' ? ['服务端', '网络访问', '系统通知'] : ['系统通知']);
      await page.getByRole('heading', { name: '已开启通知的设备', exact: true }).waitFor();
      assert.equal(await page.locator('.settings-body').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
      // 旧入口和已保存的「通知」标签仍能定位到系统页。
      await page.locator('.modal-head').getByRole('button', { name: '关闭', exact: true }).click();
      await page.evaluate(async () => { localStorage.setItem('aim.settingsTab', '通知'); await (await import('/settings/index.js')).openSettings(); });
      await page.getByRole('heading', { name: '系统通知', exact: true }).waitFor();
      assert.equal(await page.locator('.settings-nav button.on').textContent(), '系统');
    });
  }
}

for (const width of [390, 1280]) {
  test(`${width}px：记忆页的筛选、置顶、归档、回收站、改动记录、摘要、导出`, async (t) => {
    const { page, mem } = await fixture(t, width, "light", "admin");
    const memories = page.locator(".settings-page > .section").filter({ has: page.getByRole("heading", { name: /^记住的事/ }) });
    // 筛选：输入就筛，改了东西刷新之后筛选词还在
    await memories.getByPlaceholder("筛选记住的事").fill("条目 3");
    assert.ok((await memories.locator(".list-item").count()) < 40);
    await memories.locator(".list-item").first().getByRole("button", { name: "置顶", exact: true }).click();
    await memories.getByRole("button", { name: "取消置顶", exact: true }).first().waitFor();
    assert.equal(await memories.getByPlaceholder("筛选记住的事").inputValue(), "条目 3");
    assert.match(await memories.locator(".list-item").first().textContent(), /已置顶/);
    await memories.locator(".list-item").first().getByRole("button", { name: "归档", exact: true }).click();
    await page.locator("summary").filter({ hasText: "归档（1）" }).waitFor();
    await memories.getByPlaceholder("筛选记住的事").fill("");
    // 归档：点开才读，能恢复；刷新后还开着
    await page.locator("summary").filter({ hasText: "归档（1）" }).click();
    const archived = page.locator(".section").filter({ has: page.locator("summary", { hasText: "归档（" }) });
    await archived.getByRole("button", { name: "恢复", exact: true }).click();
    await page.locator("summary").filter({ hasText: "归档（0）" }).waitFor();
    assert.equal(await page.locator("details").filter({ hasText: "归档（0）" }).evaluate((el) => el.open), true);
    // 回收站：删除进回收站，能恢复
    await memories.locator(".list-item").first().getByRole("button", { name: "删除", exact: true }).click();
    await page.locator("summary").filter({ hasText: "回收站（1）" }).waitFor();
    await page.locator("summary").filter({ hasText: "回收站（1）" }).click();
    const trash = page.locator(".section").filter({ has: page.locator("summary", { hasText: "回收站（" }) });
    await trash.getByRole("button", { name: "彻底删除", exact: true }).waitFor();
    await trash.getByRole("button", { name: "恢复", exact: true }).click();
    await page.locator("summary").filter({ hasText: "回收站（0）" }).waitFor();
    // 改动记录能撤销
    await page.locator("summary").filter({ hasText: "改动记录" }).click();
    const logBox = page.locator(".section").filter({ has: page.locator("summary", { hasText: "改动记录" }) });
    await logBox.getByText("改成：新内容（原来是：旧内容）").waitFor();
    await logBox.getByRole("button", { name: "撤销", exact: true }).click();
    await page.locator(".toast").filter({ hasText: "已撤销" }).waitFor();
    assert.ok(mem.undone);
    // 摘要
    await page.locator("summary").filter({ hasText: "摘要（1）" }).click();
    await page.getByText("2026-10 月度：折腾软路由").waitFor();
    // 导出、备份（管理员）
    assert.equal(await page.getByRole("link", { name: "导出记忆", exact: true }).getAttribute("href"), "/api/account/memory/export");
    assert.equal(await page.getByRole("link", { name: "导出聊天记录", exact: true }).getAttribute("href"), "/api/account/history/export");
    await page.getByRole("button", { name: "现在备份", exact: true }).waitFor();
    await page.getByText("近 30 天 agent 搜了 12 次聊天记录，3 次没搜到。").waitFor();
    assert.equal(await page.locator(".settings-body").evaluate((el) => el.scrollWidth > el.clientWidth + 1), false, "窄屏不横向溢出");
    if (process.env.MEMORY_SHOTS) await page.screenshot({ path: `${process.env.MEMORY_SHOTS}/memory-${width}.png`, fullPage: false });
  });
}
