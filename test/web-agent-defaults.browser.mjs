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
  "/vendor/hljs-light.css": "node_modules/@highlightjs/cdn-assets/styles/github.min.css",
  "/vendor/hljs-dark.css": "node_modules/@highlightjs/cdn-assets/styles/github-dark.min.css",
};

for (const width of [390, 1280]) {
  for (const role of ["member", "admin"]) {
    test(`${width}px ${role}：内置 Agent 默认技能/MCP 可分别选择、全部关闭、保存和恢复`, async (t) => {
      const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}), args: ["--no-sandbox"] });
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: "block" });
      const errors = [];
      page.on("pageerror", (err) => errors.push(err.message));
      t.after(() => assert.deepEqual(errors, []));
      const prefs = () => ({ skills: null, mcp: role === "admin" ? null : [], machineSkills: role === "admin" });
      const data = { agents: { claude: prefs(), codex: prefs() }, skills: [{ id: "s_nas", name: "nas-portainer" }], mcp: [{ id: "m_nas", name: "nas" }], ...(role === "admin" ? { machineMcp: { claude: ["local"], codex: ["local"] }, machinePrefix: "machine:" } : {}) };
      let saves = 0;
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/api/agents/defaults") {
          if (route.request().method() === "PUT") { saves++; data.agents = route.request().postDataJSON().agents; }
          return route.fulfill({ json: data });
        }
        if (url.pathname === "/api/config") return route.fulfill({ json: { agents: { claude: { enabled: true, models: [] }, codex: { enabled: true, models: [], path: "codex", home: "", sandbox: "workspace-write" } }, web: {} } });
        if (url.pathname === "/api/agents/health") return route.fulfill({ json: { agents: [] } });
        if (/\/api\/agents\/\w+\/models/.test(url.pathname)) return route.fulfill({ json: { models: [{ id: "default", label: "默认" }] } });
        if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${styles}<div id="app"></div><script type="module">
          import { S } from '/state.js'; import { openSettings } from '/settings/index.js';
          S.user = { id: 'u_test', role: '${role}' }; S.current = 'fixture'; await openSettings('Agent');
        </script>` });
        try { return route.fulfill({ contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript", body: await fs.readFile(new URL(vendor[url.pathname] ?? `web${url.pathname}`, root), "utf8") }); }
        catch { return route.fulfill({ status: 404, body: "" }); }
      });
      await page.goto("https://agent-settings.example.test/");
      const save = page.getByRole("button", { name: "保存默认加载设置", exact: true });
      await save.waitFor();
      assert.equal(await save.isEnabled(), false);
      const claude = page.locator(".builtin-agent-defaults").nth(0);
      const codex = page.locator(".builtin-agent-defaults").nth(1);
      await page.getByRole("combobox", { name: "Claude Code 技能", exact: true }).selectOption("pick");
      await claude.getByRole("checkbox", { name: "nas-portainer", exact: true }).check();
      await page.getByRole("combobox", { name: "Claude Code MCP", exact: true }).selectOption("pick");
      await claude.getByRole("checkbox", { name: "nas", exact: true }).check();
      await page.getByRole("combobox", { name: "Codex 技能", exact: true }).selectOption("pick");
      await page.getByRole("combobox", { name: "Codex MCP", exact: true }).selectOption("pick");
      if (role === "admin") await codex.getByRole("checkbox", { name: "同时加载机器上的技能" }).uncheck();
      else assert.equal(await page.getByText("同时加载机器上的技能").count(), 0);
      await save.click();
      await page.waitForFunction(() => document.querySelector(".save-btn").disabled);
      assert.equal(saves, 1);
      assert.deepEqual(data.agents.claude.skills, ["s_nas"]);
      assert.deepEqual(data.agents.claude.mcp, ["m_nas"]);
      assert.deepEqual(data.agents.codex, { skills: [], mcp: [], machineSkills: false });
      await page.reload(); await save.waitFor();
      assert.equal(await claude.getByRole("checkbox", { name: "nas-portainer", exact: true }).isChecked(), true);
      assert.equal(await claude.getByRole("checkbox", { name: "nas", exact: true }).isChecked(), true);
      assert.equal(await codex.getByRole("checkbox", { name: "nas-portainer", exact: true }).isChecked(), false);
      const overflow = await page.locator(".settings-body").evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      assert.equal(overflow, false, "手机与桌面布局不应横向溢出");
    });
  }
}
