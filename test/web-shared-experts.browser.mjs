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

for (const width of [390, 1280]) {
  for (const editable of [true, false]) {
    test(`${width}px ${editable ? "发布者" : "家人"}：共享设定、只读权限和个人工具保存`, async (t) => {
      const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}), args: ["--no-sandbox"] });
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: "block" });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      t.after(() => assert.deepEqual(errors, []));
      const e = { id: "e_ab1234", name: "家庭助手", shared: true, editable, description: "全家共用的设定", engine: "claude", access: "web", prompt: "共同的提示词", skills: [], mcp: [], subagents: [], memory: true, quickPrompts: [] };
      const data = { experts: [e], builtin: [], engines: ["claude", "codex"], access: [{ id: "web", label: "只能联网" }], skills: [{ id: "s_mine", name: "我的技能" }], mcp: [{ id: "m_mine", name: "我的日历" }] };
      let toolSaves = 0;
      let definitionSaves = 0;
      await page.route("**/*", async (route) => {
        const p = new URL(route.request().url()).pathname;
        if (p === `/api/experts/${e.id}/tools`) {
          assert.equal(route.request().method(), "PUT");
          const payload = route.request().postDataJSON();
          assert.deepEqual(payload, { skills: ["s_mine"], mcp: ["m_mine"] });
          Object.assign(e, payload); toolSaves++;
          return route.fulfill({ json: payload });
        }
        if (p === `/api/experts/${e.id}`) {
          assert.equal(editable, true, "家人不能修改专家设定");
          assert.equal(route.request().method(), "PATCH");
          const payload = route.request().postDataJSON();
          assert.equal(payload.shared, false);
          Object.assign(e, payload); definitionSaves++;
          return route.fulfill({ json: e });
        }
        if (p === "/api/experts") return route.fulfill({ json: data });
        if (p === "/api/experts/brief") return route.fulfill({ json: { experts: [e] } });
        if (/\/api\/agents\/\w+\/models/.test(p)) return route.fulfill({ json: { models: [] } });
        if (p === "/") return route.fulfill({ contentType: "text/html", body: `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<div id="app" style="height:100vh;overflow:auto;padding:16px"><div id="panel"></div></div><script type="module">
          import { S } from '/state.js'; import { expertsTab } from '/settings/experts.js';
          S.user = { id: 'u_viewer', role: 'member' }; S.workspaceRoot = '/workspace'; S.current = 'fixture';
          S.agents = [{ id: 'claude', label: 'Claude Code', enabled: true }, { id: 'codex', label: 'Codex', enabled: true }];
          await expertsTab(document.querySelector('#panel'));
        </script>` });
        try { return route.fulfill({ contentType: p.endsWith(".css") ? "text/css" : "text/javascript", body: await fs.readFile(new URL(vendor[p] ?? `web${p}`, root), "utf8") }); }
        catch { return route.fulfill({ status: 404, body: "" }); }
      });
      await page.goto("https://shared-experts.example.test/");
      await page.getByRole("button", { name: "我的工具", exact: true }).click();
      await page.getByRole("checkbox", { name: "我的技能", exact: true }).check();
      await page.getByRole("checkbox", { name: "我的日历", exact: true }).check();
      assert.equal(await page.locator(".modal").evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
      await page.getByRole("button", { name: "保存我的工具", exact: true }).click();
      await page.locator(".modal").waitFor({ state: "detached" });
      assert.equal(toolSaves, 1);
      await page.reload();
      await page.getByRole("button", { name: "我的工具", exact: true }).click();
      assert.equal(await page.getByRole("checkbox", { name: "我的技能", exact: true }).isChecked(), true);
      assert.equal(await page.getByRole("checkbox", { name: "我的日历", exact: true }).isChecked(), true);
      await page.locator(".modal-head button").click();
      await page.getByRole("button", { name: "家庭助手", exact: true }).click();
      if (editable) {
        await page.getByRole("checkbox", { name: "共享给所有账号", exact: true }).uncheck();
        assert.equal(await page.locator(".modal").evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
        await page.getByRole("button", { name: "保存", exact: true }).click();
        await page.locator(".modal").waitFor({ state: "detached" });
        assert.equal(definitionSaves, 1);
      } else {
        assert.equal(await page.getByRole("textbox", { name: "提示词", exact: true }).getAttribute("readonly"), "");
        assert.equal(await page.getByRole("button", { name: "保存", exact: true }).count(), 0);
        await page.locator(".modal-head button").click();
        await page.getByRole("button", { name: "更多", exact: true }).click();
        assert.equal(await page.getByText("编辑…", { exact: true }).count(), 0);
        assert.equal(await page.getByText("删除", { exact: true }).count(), 0);
        assert.equal(definitionSaves, 0);
      }
      assert.equal(await page.locator("#panel").evaluate((el) => el.scrollWidth > el.clientWidth + 1), false, "手机和桌面不横向溢出");
    });
  }
}
