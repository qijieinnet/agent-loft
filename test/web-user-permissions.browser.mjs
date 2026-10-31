// 与其他 browser.mjs 一样，可通过 AGENT_LOFT_PLAYWRIGHT 指定已安装的 Playwright。
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
  for (const tab of ["users", "account"]) {
    test(`${width}px ${tab}：成员授权新增、编辑与回显；用户自助修改名称`, async (t) => {
      const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}), args: ["--no-sandbox"] });
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: "block" });
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      t.after(() => assert.deepEqual(errors, []));
      const member = { id: "u_member", name: "家人", role: "member", createdAt: Date.now(), devices: 0, permissions: { experts: ["e_shared"], agents: ["codex"], servers: [] } };
      const data = { me: "u_admin", users: [{ id: "u_admin", name: "admin", role: "admin", createdAt: Date.now(), devices: 1 }, member], resources: {
        experts: [{ id: "e_shared", name: "家庭助手" }], agents: [{ id: "claude", name: "Claude Code" }, { id: "codex", name: "Codex" }], servers: [{ id: "nas", name: "NAS" }],
      } };
      let creates = 0;
      let patches = 0;
      let renames = 0;
      await page.route("**/*", async (route) => {
        const p = new URL(route.request().url()).pathname;
        if (p === "/api/users") {
          if (route.request().method() === "POST") {
            const body = route.request().postDataJSON();
            assert.equal(body.name, "new-member");
            assert.equal(body.remote, false);
            assert.deepEqual(body.permissions, { experts: [], agents: ["codex"], servers: [] });
            creates++;
          }
          return route.fulfill({ json: data });
        }
        if (p === "/api/users/u_member") {
          assert.equal(route.request().method(), "PATCH");
          const body = route.request().postDataJSON();
          assert.deepEqual(body, { permissions: { experts: [], agents: null, servers: ["nas"] } });
          member.permissions = body.permissions;
          patches++;
          return route.fulfill({ json: member });
        }
        if (p === "/api/account") {
          assert.equal(route.request().method(), "PATCH");
          assert.deepEqual(route.request().postDataJSON(), { name: "新的名字" });
          renames++;
          return route.fulfill({ json: { user: { id: "u_member", name: "新的名字", role: "member" } } });
        }
        if (p === "/api/web-sessions") return route.fulfill({ json: [] });
        if (p === "/api/account/feishu") return route.fulfill({ json: { bots: [], links: [] } });
        if (p === "/") return route.fulfill({ contentType: "text/html", body: `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles}
          <div id="app" style="height:100vh;overflow:auto;padding:16px"><div id="panel"></div></div><script type="module">
            import { S } from '/state.js'; import { usersTab } from '/settings/users.js'; import { accountTab } from '/settings/security.js';
            import { markDirty } from '/settings/common.js';
            S.user = { id: '${tab === "users" ? "u_admin" : "u_member"}', name: '${tab === "users" ? "admin" : "家人"}', role: '${tab === "users" ? "admin" : "member"}' };
            window.testState = S;
            const page = document.querySelector('#panel');
            for (const event of ['input', 'change']) page.addEventListener(event, (e) => markDirty(e.target.closest('[data-form]')));
            await ${tab === "users" ? "usersTab" : "accountTab"}(page);
          </script>` });
        try { return route.fulfill({ contentType: p.endsWith(".css") ? "text/css" : "text/javascript", body: await fs.readFile(new URL(vendor[p] ?? `web${p}`, root), "utf8") }); }
        catch { return route.fulfill({ status: 404, body: "" }); }
      });
      await page.goto("https://user-permissions.example.test/");
      if (tab === "users") {
        const add = page.locator(".section").filter({ has: page.getByRole("heading", { name: "添加用户", exact: true }) });
        await add.getByLabel("用户名", { exact: true }).fill("new-member");
        await add.getByLabel(/^密码/).fill("password-new");
        await add.getByRole("combobox", { name: "共享专家范围", exact: true }).selectOption("pick");
        await add.getByRole("checkbox", { name: "家庭助手", exact: true }).uncheck();
        await add.getByRole("combobox", { name: "内置 Agent范围", exact: true }).selectOption("pick");
        await add.getByRole("checkbox", { name: "Claude Code", exact: true }).uncheck();
        await add.getByRole("combobox", { name: "服务器切换范围", exact: true }).selectOption("pick");
        await add.getByRole("checkbox", { name: "NAS", exact: true }).uncheck();
        await add.getByRole("button", { name: "添加", exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('[data-dirty]'));
        assert.equal(creates, 1);
        const memberRow = page.locator(".list-item").filter({ hasText: "家人" });
        await memberRow.getByRole("button", { name: "使用权限", exact: true }).click();
        assert.equal(await memberRow.getByRole("checkbox", { name: "Codex", exact: true }).isChecked(), true);
        await memberRow.getByRole("checkbox", { name: "家庭助手", exact: true }).uncheck();
        await memberRow.getByRole("combobox", { name: "内置 Agent范围", exact: true }).selectOption("all");
        await memberRow.getByRole("checkbox", { name: "NAS", exact: true }).check();
        assert.equal(await page.locator("#panel").evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
        await memberRow.getByRole("button", { name: "保存使用权限", exact: true }).click();
        await memberRow.getByRole("button", { name: "保存使用权限", exact: true }).waitFor({ state: "detached" });
        assert.equal(patches, 1);
        await memberRow.getByRole("button", { name: "使用权限", exact: true }).click();
        assert.equal(await memberRow.getByRole("combobox", { name: "内置 Agent范围", exact: true }).inputValue(), "all");
        assert.equal(await memberRow.getByRole("checkbox", { name: "家庭助手", exact: true }).isChecked(), false);
        assert.equal(await memberRow.getByRole("checkbox", { name: "NAS", exact: true }).isChecked(), true);
      } else {
        await page.getByRole("textbox", { name: /^账号名称/ }).fill(" 新的名字 ");
        await page.getByRole("button", { name: "保存账号名称", exact: true }).click();
        await page.waitForFunction(() => window.testState.user.name === "新的名字");
        assert.equal(renames, 1);
        assert.equal(await page.getByRole("textbox", { name: /^账号名称/ }).inputValue(), "新的名字");
        assert.equal(await page.getByRole("button", { name: "保存账号名称", exact: true }).isDisabled(), true);
      }
      assert.equal(await page.locator("#panel").evaluate((el) => el.scrollWidth > el.clientWidth + 1), false, "手机和桌面不横向溢出");
    });
  }
}
