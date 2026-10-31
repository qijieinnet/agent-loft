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
  for (const mine of [true, false]) {
    test(`${width}px ${mine ? "作者" : "安装者"}：共享范围、预览、安装与卸载`, async (t) => {
      const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}), args: ["--no-sandbox"] });
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: "block" });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      t.after(() => assert.deepEqual(errors, []));
      const skill = {
        id: "s_ab1234", name: "shared-demo", description: "共享技能说明", ownerName: "发布者", mine,
        visibility: mine ? "private" : "users", sharedWith: [], vars: [{ name: "DEMO_TOKEN", required: true, secret: true }],
        source: "manual", updatedAt: Date.now(), installed: mine, enabled: true, canDelete: mine,
        body: "## 操作说明\n\n使用你自己的变量。", files: [{ path: "scripts/demo.sh", size: 9 }],
      };
      const data = { skills: [skill], users: [{ id: "u_reader", name: "家人" }], vars: {} };
      let shareSaves = 0;
      let installs = 0;
      let uninstalls = 0;
      let creates = 0;
      await page.route("**/*", async (route) => {
        const p = new URL(route.request().url()).pathname;
        const method = route.request().method();
        if (p === `/api/skills/${skill.id}/install`) {
          assert.equal(mine, false);
          const { on } = route.request().postDataJSON();
          skill.installed = on;
          if (on) installs++; else uninstalls++;
          return route.fulfill({ json: skill });
        }
        if (p === `/api/skills/${skill.id}/file`) return route.fulfill({ json: { text: "echo demo", size: 9 } });
        if (p === `/api/skills/${skill.id}`) {
          if (method === "PATCH") {
            assert.equal(mine, true, "安装者不能改内容或共享范围");
            const payload = route.request().postDataJSON();
            assert.deepEqual(Object.keys(payload).sort(), ["sharedWith", "visibility"]);
            Object.assign(skill, payload); shareSaves++;
          }
          return route.fulfill({ json: skill });
        }
        if (p === "/api/skills") {
          if (method === "POST") {
            const payload = route.request().postDataJSON();
            assert.equal(payload.visibility, "private", "默认不共享");
            assert.deepEqual(payload.sharedWith, []);
            creates++;
            return route.fulfill({ json: { ...skill, ...payload } });
          }
          return route.fulfill({ json: data });
        }
        if (p === "/") return route.fulfill({ contentType: "text/html", body: `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<div id="app" style="height:100vh;overflow:auto;padding:16px"><div id="panel"></div></div><script type="module">
          import { skillsTab } from '/settings/skills.js';
          await skillsTab(document.querySelector('#panel'));
        </script>` });
        try { return route.fulfill({ contentType: p.endsWith(".css") ? "text/css" : "text/javascript", body: await fs.readFile(new URL(vendor[p] ?? `web${p}`, root), "utf8") }); }
        catch { return route.fulfill({ status: 404, body: "" }); }
      });
      await page.goto("https://shared-skills.example.test/");
      const noOverflow = async () => {
        assert.equal(await page.locator("#panel").evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
        for (const el of await page.locator(".modal").all()) assert.equal(await el.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
      };
      if (mine) {
        await page.getByRole("button", { name: "新建", exact: true }).click();
        assert.equal(await page.getByRole("combobox", { name: "共享范围" }).inputValue(), "private");
        await page.getByPlaceholder("小写字母、数字和 -，比如 weather-report").fill("new-demo");
        await page.getByPlaceholder("一两句话说清什么时候用它。agent 靠这句话判断要不要用这个技能。").fill("新技能");
        await noOverflow();
        await page.getByRole("button", { name: "创建", exact: true }).click();
        await page.locator(".modal").waitFor({ state: "detached" });
        assert.equal(creates, 1);
        await page.getByRole("button", { name: "更多", exact: true }).click();
        await page.getByRole("button", { name: "共享…", exact: true }).click();
        await page.getByRole("combobox", { name: "共享范围" }).selectOption("users");
        await page.getByRole("button", { name: "保存", exact: true }).click();
        await page.getByText("选「指定用户」时至少勾一个人", { exact: true }).waitFor();
        assert.equal(shareSaves, 0);
        await page.getByRole("checkbox", { name: "家人", exact: true }).check();
        await noOverflow();
        await page.getByRole("button", { name: "保存", exact: true }).click();
        await page.locator(".modal").waitFor({ state: "detached" });
        assert.deepEqual(skill.sharedWith, ["u_reader"]);
        await page.getByText("共享给指定用户", { exact: true }).waitFor();
        await page.getByRole("button", { name: "shared-demo", exact: true }).click();
        await page.getByRole("button", { name: "共享…", exact: true }).click();
        assert.equal(await page.getByRole("checkbox", { name: "家人", exact: true }).isChecked(), true);
        await page.getByRole("combobox", { name: "共享范围" }).selectOption("all");
        await page.getByRole("button", { name: "保存", exact: true }).click();
        await page.locator(".modal").waitFor({ state: "detached" });
        assert.equal(skill.visibility, "all");
        assert.deepEqual(skill.sharedWith, []);
        await page.getByText("所有人可见", { exact: true }).waitFor();
        await page.getByRole("button", { name: "更多", exact: true }).click();
        await page.getByRole("button", { name: "共享…", exact: true }).click();
        await page.getByRole("combobox", { name: "共享范围" }).selectOption("private");
        await page.getByRole("button", { name: "保存", exact: true }).click();
        await page.locator(".modal").waitFor({ state: "detached" });
        assert.equal(skill.visibility, "private");
        assert.equal(shareSaves, 3);
      } else {
        await page.getByRole("button", { name: "共享技能 1", exact: true }).click();
        await page.getByPlaceholder("搜索名字、说明").fill("找不到的技能");
        await page.getByText("没有找到", { exact: true }).waitFor();
        await page.getByPlaceholder("搜索名字、说明").fill("发布者");
        await page.getByRole("button", { name: "shared-demo", exact: true }).click();
        await page.getByRole("heading", { name: "操作说明", exact: true }).waitFor();
        await page.getByRole("button", { name: "scripts/demo.sh 9 B", exact: true }).click();
        await page.getByText("echo demo", { exact: true }).waitFor();
        assert.equal(await page.getByRole("button", { name: "共享…", exact: true }).count(), 0);
        await noOverflow();
        await page.locator(".modal").getByRole("button", { name: "安装", exact: true }).click();
        await page.getByRole("heading", { name: "shared-demo 的变量", exact: true }).waitFor();
        assert.equal(await page.locator(".modal").count(), 1, "安装后关闭详情并提示填写自己的变量");
        await page.getByRole("button", { name: "关闭", exact: true }).click();
        assert.equal(installs, 1);
        await page.getByText("已安装", { exact: true }).waitFor();
        await page.getByPlaceholder("搜索名字、说明").fill("");
        await page.getByRole("button", { name: "我的技能 1", exact: true }).click();
        await page.getByRole("button", { name: "更多", exact: true }).click();
        assert.equal(await page.getByRole("button", { name: "共享…", exact: true }).count(), 0);
        assert.equal(await page.getByRole("button", { name: "编辑…", exact: true }).count(), 0);
        await page.getByRole("button", { name: "卸载", exact: true }).click();
        await page.locator(".confirm-dialog").getByRole("button", { name: "卸载", exact: true }).click();
        await page.locator(".confirm-dialog").waitFor({ state: "detached" });
        await page.getByRole("button", { name: "我的技能 0", exact: true }).waitFor();
        assert.equal(uninstalls, 1);
        await page.getByRole("button", { name: "共享技能 1", exact: true }).click();
        await page.getByRole("button", { name: "安装", exact: true }).click();
        await page.getByRole("heading", { name: "shared-demo 的变量", exact: true }).waitFor();
        assert.equal(installs, 2);
      }
      await noOverflow();
    });
  }
}
