// Pi / Codex 自动命名设置：开关、模型、保存及重开；无需真实服务。
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

for (const width of [390, 1280]) {
  test(`${width}px：Pi 默认自动命名，可关掉 / 换模型，Codex 设置保持兼容`, async (t) => {
    const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}), args: ["--no-sandbox"] });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: "block" });
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    t.after(() => assert.deepEqual(errors, []));
    const cfg = { agents: {
      pi: { enabled: true, models: [], autoTitle: true, titleModel: "" },
      codex: { enabled: true, models: [], path: "codex", home: "", sandbox: "workspace-write", autoTitle: false, titleModel: "" },
    }, web: {} };
    const puts = [];
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/config") {
        if (route.request().method() === "PUT") {
          const patch = route.request().postDataJSON();
          puts.push(patch);
          for (const [id, value] of Object.entries(patch.agents ?? {})) Object.assign(cfg.agents[id], value);
        }
        return route.fulfill({ json: cfg });
      }
      if (url.pathname === "/api/bootstrap") return route.fulfill({ json: { agents: [], bots: [], servers: [] } });
      if (url.pathname === "/api/agents/health") return route.fulfill({ json: { agents: [] } });
      if (/\/api\/agents\/\w+\/models/.test(url.pathname)) return route.fulfill({ json: { models: [{ id: "faux/chat", label: "对话模型" }, { id: "faux/title", label: "低成本命名模型" }] } });
      if (url.pathname === "/api/agents/pi/providers") return route.fulfill({ json: { providers: [] } });
      if (url.pathname === "/api/agents/pi/custom") return route.fulfill({ json: { providers: [] } });
      if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${styles}<div id="app"><div class="layout"></div></div><script type="module">
        import { S, ui } from '/state.js'; import { openSettings } from '/settings/index.js';
        ui.topbar = document.createElement('div'); S.current = 'fixture'; ui.layout = document.querySelector(".layout");
          S.user = { id: 'admin', role: 'admin' }; await openSettings('Agent');
      </script>` });
      try { return route.fulfill({ contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript", body: await fs.readFile(new URL(vendor[url.pathname] ?? `web${url.pathname}`, root), "utf8") }); }
      catch { return route.fulfill({ status: 404, body: "" }); }
    });
    await page.goto("https://pi-titles.example.test/");
    const pi = page.locator('.settings-page [data-agent="pi"]');
    const on = pi.getByRole("checkbox", { name: "自动生成会话名称", exact: true });
    const picker = pi.locator(".title-row select");
    await picker.locator('option[value="faux/title"]').waitFor({ state: "attached" });
    assert.equal(await on.isChecked(), true);
    assert.equal(await picker.inputValue(), "");
    assert.equal(await picker.locator('option[value=""]').innerText(), "默认（会话模型）");
    await on.uncheck();
    assert.equal(await picker.isVisible(), false);
    await pi.getByRole("button", { name: "保存 pi 设置", exact: true }).click();
    await pi.locator('[data-form][data-dirty]').waitFor({ state: "detached" });
    assert.equal(puts.at(-1).agents.pi.autoTitle, false);
    await on.check();
    await picker.selectOption("faux/title");
    await pi.getByRole("button", { name: "保存 pi 设置", exact: true }).click();
    await pi.locator('[data-form][data-dirty]').waitFor({ state: "detached" });
    assert.equal(puts.at(-1).agents.pi.titleModel, "faux/title");
    assert.equal(puts.at(-1).agents.pi.autoTitle, true);
    assert.equal(await pi.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
    const codex = page.locator('.settings-page [data-agent="codex"]');
    assert.equal(await codex.getByRole("checkbox", { name: "自动生成会话名称", exact: true }).isChecked(), false);
    assert.equal(await codex.locator(".title-row select").isVisible(), false);
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await page.evaluate(async () => { const { openSettings } = await import('/settings/index.js'); await openSettings('Agent'); });
    await picker.locator('option[value="faux/title"]').waitFor({ state: "attached" });
    assert.equal(await on.isChecked(), true);
    assert.equal(await picker.inputValue(), "faux/title");
  });
}
