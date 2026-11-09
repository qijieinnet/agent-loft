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
    test(`${width}px ${role}：专家页内置 Agent 的「设置」：默认模型、技能/MCP 分别保存和恢复`, async (t) => {
      const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}), args: ["--no-sandbox"] });
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: "block" });
      const errors = [];
      page.on("pageerror", (err) => errors.push(err.message));
      t.after(() => assert.deepEqual(errors, []));
      const prefs = () => ({ skills: null, mcp: role === "admin" ? null : [], machineSkills: role === "admin" });
      const data = { agents: { claude: prefs(), codex: prefs() }, skills: [{ id: "s_nas", name: "nas-portainer" }], mcp: [{ id: "m_nas", name: "nas" }], ...(role === "admin" ? { machineMcp: { claude: ["local"], codex: ["local"] }, machinePrefix: "machine:" } : {}) };
      const cfg = { agents: { claude: { enabled: true, models: [], defaultModel: "", defaultEffort: "" }, codex: { enabled: true, models: [], path: "codex", home: "", sandbox: "workspace-write" } }, web: {} };
      let saves = 0;
      const configPuts = [];
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        const method = route.request().method();
        if (url.pathname === "/api/agents/defaults") {
          if (method === "PUT") { saves++; Object.assign(data.agents, route.request().postDataJSON().agents); }
          return route.fulfill({ json: data });
        }
        if (url.pathname === "/api/config") {
          if (method === "PUT") {
            const patch = route.request().postDataJSON();
            configPuts.push(patch);
            for (const [id, v] of Object.entries(patch.agents ?? {})) Object.assign(cfg.agents[id], v);
          }
          return route.fulfill({ json: cfg });
        }
        if (url.pathname === "/api/bootstrap") return route.fulfill({ json: { agents: [], bots: [], servers: [] } });
        if (url.pathname === "/api/experts") return route.fulfill({ json: { expertOrder: [], experts: [], builtin: [{ id: "claude", name: "Claude Code", engine: "claude" }, { id: "codex", name: "Codex", engine: "codex" }], engines: ["claude", "codex"], templates: [], access: [], skills: [], mcp: [], limits: {} } });
        if (url.pathname === "/api/agents/health") return route.fulfill({ json: { agents: [] } });
        if (/\/api\/agents\/\w+\/models/.test(url.pathname)) return route.fulfill({ json: { models: [{ id: "default", label: "默认", isDefault: true, efforts: ["low", "high"] }, { id: "opus", label: "Opus", efforts: ["low", "high"] }] } });
        if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${styles}<div id="app"></div><script type="module">
          import { S, ui } from '/state.js'; import { openSettings } from '/settings/index.js';
          ui.topbar = document.createElement('div');
          S.user = { id: 'u_test', role: '${role}' }; S.current = 'fixture'; await openSettings('Agent');
        </script>` });
        try { return route.fulfill({ contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript", body: await fs.readFile(new URL(vendor[url.pathname] ?? `web${url.pathname}`, root), "utf8") }); }
        catch { return route.fulfill({ status: 404, body: "" }); }
      });
      await page.goto("https://agent-settings.example.test/");
      const nav = page.locator(".settings-nav");
      if (role === "admin") {
        // 管理员的 Agent 页：没有默认模型 / 默认权限 / 默认加载了
        await page.locator('.settings-page [data-agent="claude"]').waitFor();
        assert.equal(await page.locator(".settings-page").getByText("默认思考程度").count(), 0);
        assert.equal(await page.locator(".settings-page .builtin-agent-defaults").count(), 0);
        await nav.getByRole("button", { name: "专家", exact: true }).click();
      } else {
        // 成员没有 Agent 页，「Agent」打开的是专家页
        await page.locator(".experts-page .expert-sort-card").first().waitFor();
        assert.equal(await nav.getByRole("button", { name: "Agent", exact: true }).count(), 0);
      }
      const openDefaults = async (name) => {
        await page.getByRole("button", { name: `${name} 默认设置`, exact: true }).click();
        const dlg = page.locator(".modal").filter({ has: page.getByRole("heading", { name: `${name} 默认设置`, exact: true }) });
        await dlg.getByRole("combobox", { name: `${name} 技能`, exact: true }).waitFor();
        return dlg;
      };

      let dlg = await openDefaults("Claude Code");
      const save = dlg.getByRole("button", { name: "保存 Claude Code 默认设置", exact: true });
      assert.equal(await save.isEnabled(), false);
      assert.equal(await dlg.getByText("默认模型", { exact: true }).count(), role === "admin" ? 1 : 0);
      await dlg.getByRole("combobox", { name: "Claude Code 技能", exact: true }).selectOption("pick");
      await dlg.getByRole("checkbox", { name: "nas-portainer", exact: true }).check();
      await dlg.getByRole("combobox", { name: "Claude Code MCP", exact: true }).selectOption("pick");
      await dlg.getByRole("checkbox", { name: "nas", exact: true }).check();
      if (role === "admin") {
        await dlg.locator(".picker select").first().selectOption("opus");
        await dlg.locator(".picker select").nth(1).selectOption("high");
      }
      const overflow = await dlg.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      assert.equal(overflow, false, "手机与桌面布局不应横向溢出");
      await save.click();
      await dlg.waitFor({ state: "detached" });

      dlg = await openDefaults("Codex");
      await dlg.getByRole("combobox", { name: "Codex 技能", exact: true }).selectOption("pick");
      await dlg.getByRole("combobox", { name: "Codex MCP", exact: true }).selectOption("pick");
      if (role === "admin") await dlg.getByRole("checkbox", { name: "同时加载机器上的技能" }).uncheck();
      else assert.equal(await dlg.getByText("同时加载机器上的技能").count(), 0);
      await dlg.getByRole("button", { name: "保存 Codex 默认设置", exact: true }).click();
      await dlg.waitFor({ state: "detached" });

      assert.equal(saves, 2);
      assert.deepEqual(data.agents.claude.skills, ["s_nas"]);
      assert.deepEqual(data.agents.claude.mcp, ["m_nas"]);
      assert.deepEqual(data.agents.codex, { permission: null, skills: [], mcp: [], machineSkills: false });
      // 只有管理员改了模型：只存改了的那个 agent 的默认模型，不带别的字段
      assert.deepEqual(configPuts, role === "admin" ? [{ agents: { claude: { defaultModel: "opus", defaultEffort: "high" } } }] : []);

      dlg = await openDefaults("Claude Code");
      assert.equal(await dlg.getByRole("checkbox", { name: "nas-portainer", exact: true }).isChecked(), true);
      assert.equal(await dlg.getByRole("checkbox", { name: "nas", exact: true }).isChecked(), true);
    });
  }
}
