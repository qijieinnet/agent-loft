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
  test(`${width}px：机器人可直接勾选共享专家、设置默认、保存恢复和扫码创建`, async (t) => {
    const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}), args: ["--no-sandbox"] });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: "block" });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.addInitScript(() => { window.WebSocket = class { readyState = 0; close() {} send() {} }; });
    const agents = [{ id: "claude", label: "Claude Code", enabled: true, available: true }, { id: "codex", label: "Codex", enabled: true, available: true }];
    const shared = { id: "e_123abc", name: "家庭助手", engine: "claude", shared: true };
    const cfg = { agents: { claude: { enabled: true, models: [] }, codex: { enabled: true, models: [] } }, web: { quotaEnabled: false }, feishu: { bots: [{ id: "family", name: "家庭机器人", enabled: false, appId: "cli_test", appSecret: "***", domain: "feishu", allowFrom: [], agents: ["codex"], defaultAgent: "codex" }] } };
    let saved;
    let registration;
    await page.route("**/*", async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.startsWith("/api/")) {
        let data = {};
        if (p === "/api/me") data = { authed: true, user: { id: "u1", role: "admin" } };
        if (p === "/api/bootstrap") data = { user: { id: "u1", role: "admin" }, agents, bots: cfg.feishu.bots, experts: [shared], conversations: [], pending: [], workspaceRoot: "/workspace", quotaEnabled: false, remote: { allowed: false }, sidebar: { recent: { next: null }, dirs: [] } };
        if (p === "/api/config") {
          if (route.request().method() === "PUT") { saved = route.request().postDataJSON(); cfg.feishu = saved.feishu; }
          data = cfg;
        }
        if (p === "/api/experts/brief") data = { experts: [shared, { id: "e_private", name: "私人专家", engine: "claude", shared: false }] };
        if (p === "/api/pairing") data = { pending: [], approved: [] };
        if (p === "/api/feishu/status") data = [];
        if (p === "/api/feishu/slash") data = { bots: [] };
        if (p === "/api/feishu/register") { registration = route.request().postDataJSON(); data = { id: "r", qrSvg: "<svg></svg>", qrUrl: "https://example.test/qr" }; }
        if (p.startsWith("/api/agents/")) data = { models: [] };
        return route.fulfill({ json: data });
      }
      if (p === "/") return route.fulfill({ contentType: "text/html", body: `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<div id="app"></div><script type="module">
        import { boot } from '/views/layout.js'; import { openSettings } from '/settings/index.js'; await boot(); await openSettings('飞书');
      </script>` });
      try { return route.fulfill({ contentType: p.endsWith(".css") ? "text/css" : "text/javascript", body: await fs.readFile(new URL(vendor[p] ?? `web${p}`, root), "utf8") }); }
      catch { return route.fulfill({ status: 404, body: "" }); }
    });
    await page.goto("https://feishu-experts.example.test/");
    const bot = page.locator(".section").filter({ has: page.locator("h4").filter({ hasText: "家庭机器人" }) });
    await bot.getByRole("checkbox", { name: "Codex", exact: true }).uncheck();
    await bot.getByRole("checkbox", { name: "家庭助手（共享）", exact: true }).check();
    assert.equal(await bot.getByRole("checkbox", { name: "Claude Code", exact: true }).isChecked(), false, "无需勾底层 Agent");
    assert.equal(await page.getByRole("checkbox", { name: "私人专家", exact: true }).count(), 0);
    assert.equal(await bot.getByRole("combobox", { name: "默认专家", exact: true }).inputValue(), shared.id);
    await bot.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".save-btn")?.disabled);
    assert.deepEqual(saved.feishu.bots[0].experts, [shared.id]);
    assert.deepEqual(saved.feishu.bots[0].agents, ["claude"]);
    assert.equal(saved.feishu.bots[0].defaultExpert, shared.id);
    await page.reload();
    assert.equal(await bot.getByRole("checkbox", { name: "家庭助手（共享）", exact: true }).isChecked(), true);
    await bot.getByRole("checkbox", { name: "Codex", exact: true }).check();
    const def = bot.getByRole("combobox", { name: "默认专家", exact: true });
    await def.selectOption("codex");
    await def.selectOption(shared.id);
    await bot.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".save-btn")?.disabled);
    assert.deepEqual(saved.feishu.bots[0].experts, ["codex", shared.id]);
    assert.equal(saved.feishu.bots[0].defaultExpert, shared.id);
    assert.equal(await page.locator(".settings-body").evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
    await page.getByRole("button", { name: "扫码创建新机器人", exact: true }).click();
    const reg = page.locator(".modal").last();
    await reg.getByRole("checkbox", { name: "家庭助手（共享）", exact: true }).check();
    await reg.getByRole("button", { name: "生成二维码", exact: true }).click();
    await reg.getByText("等待扫码确认…", { exact: true }).waitFor();
    assert.deepEqual(registration.experts, [shared.id]);
    assert.equal(registration.defaultExpert, shared.id);
  });
}
