// 浏览器回归：node --test test/web-workspace.browser.mjs。
// 需要 playwright-core 和 Chromium；可用 AGENT_LOFT_PLAYWRIGHT 指定模块路径，
// 用 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 指定已有的浏览器。
// 工作区面板要读真实的文件和 git 仓库，所以这里起一个真的服务，不模拟接口。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.AGENT_LOFT_PLAYWRIGHT || "playwright-core");
const root = fileURLToPath(new URL("../", import.meta.url));

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });

const SERVER = `
const src = (p) => new URL(p, "file://" + process.env.AIM_ROOT + "/src/").href;
const { config, loadConfig, saveConfig } = await import(src("core/config.ts"));
const { createUser } = await import(src("core/users.ts"));
const { createSession } = await import(src("channels/web/auth.ts"));
const { startWeb } = await import(src("channels/web/server.ts"));
const { ensureConversation } = await import(src("core/store.ts"));
const { hub } = await import(src("core/hub.ts"));
const fs = await import("node:fs");
const path = await import("node:path");
// 假的 agent：消息是「写 文件名」就在工作目录里写这个文件
const histories = new Map();
let sessions = 0;
hub.registerDriver({
  id: "claude", label: "Fake", capabilities: { effort: false, fork: false, cost: false, streaming: false },
  start: async () => {}, stop: async () => {},
  createSession: (opts, events) => {
    const id = "fake-session-" + ++sessions;
    return {
      sessionId: id,
      send: (input) => {
        events.onSessionId(id);
        for (const name of input.text.match(/写 (\\S+)/)?.[1]?.split(",") ?? []) fs.writeFileSync(path.join(opts.cwd, name), "第一行\\n第二行\\n");
        const text = "好了：" + input.text;
        histories.set(id, [...(histories.get(id) ?? []), { role: "user", text: input.text }, { role: "assistant", text }]);
        setTimeout(() => events.onResult({ text, durationMs: 5 }), 10);
      },
      interrupt: async () => {}, setModel: async () => {}, describeRuntime: async () => ({}), dispose: async () => {},
    };
  },
  listSessions: async () => [], sessionExists: async () => true, readHistory: async (id) => histories.get(id) ?? [], listModels: async () => [],
  catalog: async () => [], defaults: async () => ({}), statusLines: async () => [], diagnose: () => ({ kind: "x", chatMessage: "x", consoleHint: "" }),
});
loadConfig();
const port = Number(process.env.AIM_PORT);
const workspace = process.env.AIM_WORKSPACE;
saveConfig({ ...structuredClone(config()), workspaceRoot: workspace, web: { ...config().web, host: "127.0.0.1", port, quotaEnabled: false } });
const admin = createUser({ name: "boss", password: "password-1", role: "admin" });
const member = createUser({ name: "member", password: "password-1" });
const conv = (key, cwd, owner) => ensureConversation({ key, cwd, owner, channel: "web", channelId: "web", agent: "claude", title: key });
conv("web:repo", workspace + "/project", admin.id);
conv("web:plain", workspace + "/plain", admin.id);
conv("web:member", workspace + "/project", member.id);
conv("web:turn", workspace + "/turn", admin.id);
conv("web:ops", workspace + "/ops", admin.id);
conv("web:undo", workspace + "/undo", admin.id);
await startWeb();
console.log("READY " + JSON.stringify({ admin: createSession(admin.id, "127.0.0.1", "test"), member: createSession(member.id, "127.0.0.1", "test") }));
`;

async function fixture(t) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aim-ws-browser-")));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, "home");
  const workspace = path.join(tmp, "workspace");
  const project = path.join(workspace, "project");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "plain"));
  fs.mkdirSync(path.join(workspace, "ops"));
  const undoRepo = path.join(workspace, "undo");
  fs.mkdirSync(undoRepo);
  git(undoRepo, "init");
  fs.writeFileSync(path.join(undoRepo, "base.txt"), "x\n");
  git(undoRepo, "add", "-A");
  git(undoRepo, "commit", "-m", "init");
  const turn = path.join(workspace, "turn");
  fs.mkdirSync(turn);
  git(turn, "init");
  fs.writeFileSync(path.join(turn, "old.txt"), "旧内容\n");
  git(turn, "add", "-A");
  git(turn, "commit", "-m", "init");
  fs.mkdirSync(home);
  const plain = path.join(workspace, "plain");
  fs.writeFileSync(path.join(plain, "note.md"), "# 标题\n\n正文\n");
  fs.writeFileSync(path.join(plain, "code.ts"), "const a = 1;\n");
  fs.writeFileSync(path.join(plain, "crlf.txt"), "第一行\r\n第二行\r\n");
  fs.writeFileSync(path.join(plain, "data.csv"), '\ufeff名称,数量,备注\n苹果,3,"有逗号,和""引号"""\n<b>梨</b>,5,"换\n行"\n短行\n');
  fs.writeFileSync(path.join(plain, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  git(project, "init");
  fs.writeFileSync(path.join(project, "src/a.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  fs.writeFileSync(path.join(project, "gone.txt"), "bye\n");
  fs.writeFileSync(path.join(project, "README.md"), "# 项目\n\n说明文字\n");
  git(project, "add", "-A");
  git(project, "commit", "-m", "第一次提交");
  git(project, "branch", "feature/other");
  fs.writeFileSync(path.join(project, "src/a.ts"), "const a = 1;\nconst b = 20;\nconst c = 3;\nconst d = 4;\n");
  fs.rmSync(path.join(project, "gone.txt"));
  fs.writeFileSync(path.join(project, "new file.txt"), "<b>不是标签</b>\n");
  fs.writeFileSync(path.join(project, "staged.txt"), "暂存\n");
  git(project, "add", "staged.txt");
  fs.writeFileSync(path.join(project, ".env"), "TOKEN=secret\n");

  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", SERVER], {
    cwd: root,
    env: { ...process.env, AGENT_LOFT_HOME: home, AIM_ROOT: root.replace(/\/$/, ""), AIM_PORT: String(port), AIM_WORKSPACE: workspace },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => child.kill());
  const sessions = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      const m = /READY (\{.*\})/.exec(out);
      if (m) resolve(JSON.parse(m[1]));
    });
    child.once("exit", (code) => reject(new Error(`服务退出了（${code}）\n${out}`)));
  });
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ["--no-sandbox"],
  });
  t.after(() => browser.close());
  const base = `http://127.0.0.1:${port}`;
  const open = async (who, hash, viewport = { width: 1400, height: 900 }, device = {}) => {
    const context = await browser.newContext({ serviceWorkers: "block", viewport, ...device });
    await context.addCookies([{ name: "aim_session", value: sessions[who], url: base }]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.goto(`${base}/#${encodeURIComponent(hash)}`);
    return page;
  };
  return { open, project, plain, turn, undoRepo };
}

async function toggleWorkspace(page) {
  await page.locator(".top-more").click();
  await page.locator(".top-menu").getByRole("button", { name: "文件", exact: true }).click();
}

async function refreshWorkspaceGit(page) {
  await page.evaluate(async () => {
    const entry = document.querySelector('script[type="module"][src]').src;
    await (await import(new URL("./views/workspace-entry.js", entry).href)).refreshGit();
  });
}

// 每轮快照仍由工作区使用，聊天回复不再提供改动卡片入口。
async function recordedTurns(page, count) {
  await page.evaluate(async () => {
    const entry = document.querySelector('script[type="module"][src]').src;
    const { S } = await import(new URL("./state.js", entry).href);
    window.workspaceTestState = S;
  });
  const turns = await page.waitForFunction((count) => {
    const items = window.workspaceTestState.items.filter((item) => item.type === "ai" && item.changes);
    return items.length === count ? items.map((item) => item.changes) : false;
  }, count);
  return turns.jsonValue();
}

async function openRecordedTurn(page, changes, file) {
  await page.evaluate(async ({ changes, file }) => {
    const entry = document.querySelector('script[type="module"][src]').src;
    await (await import(new URL("./views/workspace-entry.js", entry).href)).openTurnChanges(changes, file);
  }, { changes, file });
}

test("工作区面板", { timeout: 120000 }, async (t) => {
  const { open, project, plain, turn, undoRepo } = await fixture(t);
  const shots = process.env.AIM_SCREENSHOTS;

  await t.test("分支标记、文件树和预览", async () => {
    const page = await open("admin", "web:repo");
    const chip = page.locator(".top-git");
    await chip.waitFor();
    assert.equal(await chip.locator(".top-git-name").textContent(), "main");
    assert.equal(await chip.locator(".top-git-count").textContent(), "5");
    assert.equal(await page.locator(".top-workspace").count(), 0, "顶栏不直接显示文件按钮");
    await page.locator(".top-more").click();
    const files = page.locator(".top-menu").getByRole("button", { name: "文件", exact: true });
    assert.equal(await files.locator(".ws-add").textContent(), "+4");
    assert.equal(await files.locator(".ws-del").textContent(), "−2");
    const colors = await files.locator(".ws-add, .ws-del").evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).color));
    assert.notEqual(colors[0], colors[1], "新增和删除使用不同颜色");
    fs.writeFileSync(path.join(project, "menu-stats.txt"), "one\ntwo");
    try {
      await refreshWorkspaceGit(page);
      assert.equal(await files.locator(".ws-add").textContent(), "+6", "菜单打开时随状态刷新更新");
    } finally {
      fs.rmSync(path.join(project, "menu-stats.txt"));
      await refreshWorkspaceGit(page);
    }
    await files.click();
    const panel = page.locator(".ws-panel");
    await panel.waitFor();
    await panel.getByRole("button", { name: /README\.md/ }).waitFor();
    const names = await panel.locator(".ws-row .ws-name").allTextContents();
    assert.equal(names[0], "src", "目录在前");
    assert.ok(!names.includes(".git"));
    assert.ok(!names.includes(".env"), "敏感文件不出现");
    if (shots) await page.screenshot({ path: path.join(shots, "1-tree.png") });
    // 展开目录，打开代码文件
    await panel.getByRole("button", { name: /^src/ }).click();
    await panel.getByRole("button", { name: /a\.ts/ }).click();
    await panel.locator(".fv-code").waitFor();
    assert.match(await panel.locator(".fv-code").textContent(), /const b = 20;/);
    if (shots) await page.screenshot({ path: path.join(shots, "2-code.png") });
    await panel.getByRole("button", { name: "返回" }).click();
    // 展开状态还在；Markdown 渲染出来
    await panel.getByRole("button", { name: /a\.ts/ }).waitFor();
    await panel.getByRole("button", { name: /README\.md/ }).click();
    await panel.locator(".fv-doc h1").waitFor();
    assert.equal(await panel.locator(".fv-doc h1").textContent(), "项目");
    // 面板开着的状态记住了，刷新后接着开
    await page.reload();
    await panel.waitFor();
    await page.context().close();
  });

  await t.test("改动列表、diff 和分支", async () => {
    const page = await open("admin", "web:repo");
    await page.locator(".top-git").waitFor();
    await page.locator(".top-git").click();
    const panel = page.locator(".ws-panel");
    await panel.locator(".ws-change").first().waitFor();
    assert.equal(await panel.locator(".ws-tab.on").textContent(), "改动5");
    const groups = await panel.locator(".ws-group").allTextContents();
    assert.deepEqual(groups, ["已暂存1", "未暂存2", "未跟踪2"]);
    assert.ok(await panel.locator(".ws-change", { hasText: ".env" }).locator(".ws-tag").count(), "敏感文件有标记");
    if (shots) await page.screenshot({ path: path.join(shots, "3-changes.png") });

    // 修改的文件：单栏 diff
    await panel.locator(".ws-change", { hasText: "a.ts" }).click();
    await panel.locator(".d-row.d-add").first().waitFor();
    const added = await panel.locator(".d-row.d-add .d-code").allTextContents();
    assert.deepEqual(added, ["const b = 20;", "const d = 4;"]);
    assert.deepEqual(await panel.locator(".d-row.d-del .d-code").allTextContents(), ["const b = 2;"]);
    assert.equal(await panel.locator(".ws-stat").textContent(), "+2−1");
    if (shots) await page.screenshot({ path: path.join(shots, "4-diff.png") });
    // 面板不够宽：没有并排
    assert.equal(await panel.getByRole("button", { name: "并排" }).count(), 0);

    // 加宽后可以并排，配对的两行在同一排
    await page.evaluate(() => document.querySelector(".ws-panel").style.setProperty("--ws-w", "760px"));
    await panel.getByRole("button", { name: "返回" }).click();
    await panel.locator(".ws-change", { hasText: "a.ts" }).click();
    await panel.getByRole("button", { name: "并排" }).click();
    await panel.locator(".d-split-row").first().waitFor();
    const paired = panel.locator(".d-split-row", { hasText: "const b = 2;" });
    assert.match(await paired.textContent(), /const b = 20;/);
    if (shots) await page.screenshot({ path: path.join(shots, "5-split.png") });
    await panel.getByRole("button", { name: "单栏" }).click();
    await panel.locator(".diff:not(.split)").waitFor();

    // 从 diff 看文件，再返回 diff
    await panel.getByRole("button", { name: "看文件" }).click();
    await panel.locator(".fv-code").waitFor();
    await panel.getByRole("button", { name: "返回" }).click();
    await panel.locator(".d-row.d-add").first().waitFor();
    await panel.getByRole("button", { name: "返回" }).click();

    // 新文件的内容不会被当成 HTML
    await panel.locator(".ws-change", { hasText: "new file.txt" }).click();
    await panel.locator(".d-row.d-add").first().waitFor();
    assert.equal(await panel.locator(".d-row.d-add .d-code").first().textContent(), "<b>不是标签</b>");
    assert.equal(await panel.locator(".d-row.d-add .d-code b").count(), 0);
    await panel.getByRole("button", { name: "返回" }).click();

    // 已删除的文件：有 diff，没有「看文件」
    await panel.locator(".ws-change", { hasText: "gone.txt" }).click();
    await panel.locator(".d-row.d-del").first().waitFor();
    assert.equal(await panel.getByRole("button", { name: "看文件" }).count(), 0);
    await panel.getByRole("button", { name: "返回" }).click();

    // 敏感文件：不给内容
    await panel.locator(".ws-change", { hasText: ".env" }).click();
    await panel.getByText("敏感文件，不显示内容").waitFor();
    assert.doesNotMatch(await panel.textContent(), /secret/);
    await panel.getByRole("button", { name: "返回" }).click();

    // 分支列表
    await panel.locator(".ws-branch").click();
    const pop = page.locator(".ws-branches");
    await pop.locator(".ws-branch-row").first().waitFor();
    assert.deepEqual((await pop.locator(".ws-branch-title").allTextContents()).sort(), ["feature/other", "main"]);
    assert.equal(await pop.locator(".ws-branch-row.on .ws-branch-title").textContent(), "main");
    if (shots) await page.screenshot({ path: path.join(shots, "6-branches.png") });
    await page.keyboard.press("Escape");

    // 手动刷新能看到外面的改动
    fs.writeFileSync(path.join(project, "later.txt"), "后来的\n");
    await panel.getByRole("button", { name: "刷新" }).click();
    await panel.locator(".ws-change", { hasText: "later.txt" }).waitFor();
    assert.equal(await page.locator(".top-git-count").textContent(), "6");
    fs.rmSync(path.join(project, "later.txt"));
    await page.context().close();
  });

  await t.test("不是仓库：没有分支标记，文件照常看", async () => {
    const page = await open("admin", "web:plain");
    await page.locator(".top-more").waitFor();
    assert.equal(await page.locator(".top-git").isVisible(), false);
    await page.locator(".top-more").click();
    const files = page.locator(".top-menu").getByRole("button", { name: "文件", exact: true });
    assert.equal(await files.locator(".top-file-stat").isVisible(), false, "非仓库不显示行数");
    await files.click();
    const panel = page.locator(".ws-panel");
    await panel.getByRole("button", { name: /note\.md/ }).waitFor();
    await panel.getByRole("tab", { name: "改动" }).click();
    await panel.getByText("当前目录不是 git 仓库").waitFor();
    await page.context().close();
  });

  /** 打开「普通目录」会话的面板 */
  const openPlain = async () => {
    const page = await open("admin", "web:plain");
    await page.locator(".top-more").waitFor();
    await toggleWorkspace(page);
    const panel = page.locator(".ws-panel");
    await panel.getByRole("button", { name: /note\.md/ }).waitFor();
    return { page, panel };
  };
  /** 把光标放到文档末尾再打字 */
  const typeAtEnd = async (page, panel, text) => {
    await panel.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(text);
  };
  const dialog = (page) => page.locator(".dialog-overlay");
  /** 关掉弹窗，等它真的没了（有个淡出动画，这期间焦点还在弹窗上） */
  const cancelDialog = async (page) => {
    await dialog(page).getByRole("button", { name: "取消" }).click();
    await dialog(page).waitFor({ state: "detached" });
  };

  await t.test("编辑和保存：Ctrl+S、保存按钮、预览没保存的内容", async () => {
    const { page, panel } = await openPlain();
    await panel.getByRole("button", { name: /note\.md/ }).click();
    await panel.locator(".fv-doc h1").waitFor();
    await panel.getByRole("button", { name: "编辑" }).click();
    await panel.locator(".cm-content").waitFor();
    const save = panel.getByRole("button", { name: "保存", exact: true });
    assert.equal(await save.isDisabled(), true, "没改动不能保存");
    await typeAtEnd(page, panel, "\n## 新小节");
    assert.equal(await save.isDisabled(), false);
    assert.equal(await panel.locator(".ws-dirty").isVisible(), true);
    // 预览没保存的内容，不写文件
    await panel.getByRole("button", { name: "预览" }).click();
    await panel.locator(".fv-doc h2").waitFor();
    assert.equal(await panel.locator(".fv-doc h2").textContent(), "新小节");
    assert.equal(fs.readFileSync(path.join(plain, "note.md"), "utf8"), "# 标题\n\n正文\n");
    if (shots) await page.screenshot({ path: path.join(shots, "8-md-preview.png") });
    await panel.getByRole("button", { name: "继续编辑" }).click();
    assert.match(await panel.locator(".cm-content").innerText(), /新小节/, "切回来内容还在");
    await panel.locator(".cm-content").click();
    await page.keyboard.press("Control+s");
    await page.getByText("已保存").waitFor();
    assert.match(fs.readFileSync(path.join(plain, "note.md"), "utf8"), /^# 标题\n\n正文\n\n## 新小节/);
    assert.equal(await save.isDisabled(), true);
    // 返回看到新内容，不再提示
    await panel.getByRole("button", { name: "返回" }).click();
    await panel.locator(".fv-doc h2").waitFor();
    assert.equal(await dialog(page).count(), 0);
    await page.context().close();
  });

  await t.test("代码文件有高亮；图片不给编辑", async () => {
    const { page, panel } = await openPlain();
    await panel.getByRole("button", { name: /code\.ts/ }).click();
    await panel.getByRole("button", { name: "编辑" }).click();
    await panel.locator(".cm-content").waitFor();
    await panel.locator(".cm-content .cm-line span").first().waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, "9-editor.png") });
    await panel.getByRole("button", { name: "返回" }).click();
    await panel.getByRole("button", { name: "返回" }).click();
    await panel.getByRole("button", { name: /photo\.png/ }).click();
    await panel.locator(".fv-actions .btn").first().waitFor();
    assert.equal(await panel.getByRole("button", { name: "编辑" }).count(), 0);
    await page.context().close();
  });

  await t.test("换行符：CRLF 文件改一行，别的行字节不变", async () => {
    const { page, panel } = await openPlain();
    await panel.getByRole("button", { name: /crlf\.txt/ }).click();
    await panel.getByRole("button", { name: "编辑" }).click();
    await panel.locator(".cm-content").waitFor();
    await panel.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("第三行");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Control+s");
    await page.getByText("已保存").waitFor();
    assert.equal(fs.readFileSync(path.join(plain, "crlf.txt"), "utf8"), "第一行\r\n第二行\r\n第三行\r\n");
    await page.context().close();
  });

  await t.test("冲突：文件被改过不覆盖，可以重新加载或覆盖", async () => {
    const file = path.join(plain, "code.ts");
    const { page, panel } = await openPlain();
    await panel.getByRole("button", { name: /code\.ts/ }).click();
    await panel.getByRole("button", { name: "编辑" }).click();
    await panel.locator(".cm-content").waitFor();
    await typeAtEnd(page, panel, "// 我的修改");
    fs.writeFileSync(file, "const agent = true;\n");
    await page.keyboard.press("Control+s");
    await dialog(page).getByText("文件已经被改过了").waitFor();
    assert.equal(fs.readFileSync(file, "utf8"), "const agent = true;\n", "没有覆盖");
    assert.equal(await panel.getByRole("button", { name: "保存", exact: true }).isEnabled(), true, "等选择时不显示保存中");
    if (shots) await page.screenshot({ path: path.join(shots, "10-conflict.png") });
    // 取消：还在编辑，修改还在
    await cancelDialog(page);
    assert.match(await panel.locator(".cm-content").innerText(), /我的修改/);
    // 重新加载：用文件现在的内容
    await page.keyboard.press("Control+s");
    await dialog(page).getByRole("button", { name: "重新加载" }).click();
    await page.getByText("已重新加载").waitFor();
    assert.match(await panel.locator(".cm-content").innerText(), /const agent = true;/);
    assert.equal(await panel.locator(".ws-dirty").isVisible(), false);
    // 再改、再冲突，这次覆盖
    await typeAtEnd(page, panel, "// 第二次");
    fs.writeFileSync(file, "const agent = 2;\n");
    await panel.getByRole("button", { name: "保存", exact: true }).click();
    await dialog(page).getByRole("button", { name: "覆盖保存" }).click();
    await page.getByText("已保存").waitFor();
    assert.match(fs.readFileSync(file, "utf8"), /第二次/);
    await page.context().close();
    fs.writeFileSync(file, "const a = 1;\n");
  });

  await t.test("没保存：离开要问，草稿在刷新后恢复", async () => {
    const file = path.join(plain, "code.ts");
    const { page, panel } = await openPlain();
    await panel.getByRole("button", { name: /code\.ts/ }).click();
    await panel.getByRole("button", { name: "编辑" }).click();
    await panel.locator(".cm-content").waitFor();
    await typeAtEnd(page, panel, "// 草稿内容");
    // 返回：问一下，取消就留下
    await panel.getByRole("button", { name: "返回" }).click();
    await dialog(page).getByText("还有没保存的修改").waitFor();
    await cancelDialog(page);
    assert.match(await panel.locator(".cm-content").innerText(), /草稿内容/);
    // 切页签也问
    await panel.getByRole("tab", { name: "改动" }).click();
    await dialog(page).getByText("还有没保存的修改").waitFor();
    await cancelDialog(page);
    assert.equal(await panel.locator(".ws-tab.on").textContent(), "文件");
    // 收起再打开：编辑器还在，内容还在
    await panel.getByRole("button", { name: "关闭工作区" }).click();
    await toggleWorkspace(page);
    await panel.locator(".cm-content").waitFor();
    assert.match(await panel.locator(".cm-content").innerText(), /草稿内容/);
    // 刷新页面：草稿还在，再打开时恢复
    await page.reload();
    await panel.getByRole("button", { name: /code\.ts/ }).click();
    await panel.getByRole("button", { name: "编辑" }).click();
    await page.getByText("已恢复上次没保存的修改").waitFor();
    assert.match(await panel.locator(".cm-content").innerText(), /草稿内容/);
    assert.equal(await panel.locator(".ws-dirty").isVisible(), true);
    assert.equal(fs.readFileSync(file, "utf8"), "const a = 1;\n");
    // 选「不保存」：丢掉草稿，下次打开是文件的内容
    await panel.getByRole("button", { name: "返回" }).click();
    await dialog(page).getByRole("button", { name: "不保存" }).click();
    await panel.getByRole("button", { name: "编辑" }).click();
    await panel.locator(".cm-content").waitFor();
    assert.doesNotMatch(await panel.locator(".cm-content").innerText(), /草稿内容/);
    await page.context().close();
  });

  await t.test("新建、重命名、上传、删除", async () => {
    const { page, panel } = await openPlain();
    // 新建文件：直接进编辑器
    await panel.getByRole("button", { name: "新建文件", exact: true }).click();
    await page.locator(".modal input").fill("hello.py");
    await page.keyboard.press("Enter");
    await panel.locator(".cm-content").waitFor();
    assert.equal(fs.readFileSync(path.join(plain, "hello.py"), "utf8"), "");
    await page.keyboard.type("print(1)");
    await page.keyboard.press("Control+s");
    await page.getByText("已保存").waitFor();
    assert.equal(fs.readFileSync(path.join(plain, "hello.py"), "utf8"), "print(1)");
    await panel.getByRole("button", { name: "返回" }).click();
    // 同名：弹窗留着，提示原因
    await panel.getByRole("button", { name: "新建文件", exact: true }).click();
    await page.locator(".modal input").fill("hello.py");
    await page.keyboard.press("Enter");
    await page.getByText("同名文件或文件夹已存在").waitFor();
    await page.locator(".modal input").fill("文件夹");
    await page.locator(".modal").getByRole("button", { name: "取消" }).click();
    // 新建文件夹，再用它的菜单在里面新建
    await panel.getByRole("button", { name: "新建文件夹" }).click();
    await page.locator(".modal input").fill("子目录");
    await page.keyboard.press("Enter");
    const dirRow = panel.locator(".ws-entry", { hasText: "子目录" });
    await dirRow.waitFor();
    await dirRow.hover();
    await dirRow.getByRole("button", { name: "更多操作" }).click();
    await page.locator(".menu").getByRole("button", { name: "新建文件", exact: true }).click();
    await page.locator(".modal input").fill("inner.txt");
    await page.keyboard.press("Enter");
    await panel.locator(".cm-content").waitFor();
    await panel.getByRole("button", { name: "返回" }).click();
    assert.equal(fs.existsSync(path.join(plain, "子目录", "inner.txt")), true);
    await panel.getByRole("button", { name: /inner\.txt/ }).waitFor();
    // 重命名：默认只选中不带后缀的部分；右键菜单
    await panel.locator(".ws-entry", { hasText: "hello.py" }).click({ button: "right" });
    await page.locator(".menu").getByRole("button", { name: "重命名" }).click();
    assert.equal(await page.locator(".modal input").evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd)), "hello");
    await page.keyboard.type("world");
    await page.keyboard.press("Enter");
    await panel.getByRole("button", { name: /world\.py/ }).waitFor();
    assert.equal(fs.existsSync(path.join(plain, "world.py")), true);
    assert.equal(fs.existsSync(path.join(plain, "hello.py")), false);
    // 上传：同名要确认
    const chooser = page.waitForEvent("filechooser");
    await panel.getByRole("button", { name: "上传", exact: true }).click();
    await (await chooser).setFiles([{ name: "up.bin", mimeType: "application/octet-stream", buffer: Buffer.from([1, 2, 3]) }]);
    await panel.getByRole("button", { name: /up\.bin/ }).waitFor();
    assert.deepEqual([...fs.readFileSync(path.join(plain, "up.bin"))], [1, 2, 3]);
    const again = page.waitForEvent("filechooser");
    await panel.getByRole("button", { name: "上传", exact: true }).click();
    await (await again).setFiles([{ name: "up.bin", mimeType: "application/octet-stream", buffer: Buffer.from([7]) }]);
    await dialog(page).getByText("已经存在，要覆盖吗").waitFor();
    await dialog(page).getByRole("button", { name: "覆盖" }).click();
    await page.getByText("已上传 1 个文件").last().waitFor();
    assert.deepEqual([...fs.readFileSync(path.join(plain, "up.bin"))], [7]);
    // 删除：取消不删，确认才删
    const row = panel.locator(".ws-entry", { hasText: "up.bin" });
    await row.click({ button: "right" });
    await page.locator(".menu").getByRole("button", { name: "删除" }).click();
    await cancelDialog(page);
    assert.equal(fs.existsSync(path.join(plain, "up.bin")), true);
    await row.click({ button: "right" });
    await page.locator(".menu").getByRole("button", { name: "删除" }).click();
    await dialog(page).getByRole("button", { name: "删除" }).click();
    await row.waitFor({ state: "detached" });
    assert.equal(fs.existsSync(path.join(plain, "up.bin")), false);
    // 删目录
    await panel.locator(".ws-entry", { hasText: "子目录" }).first().click({ button: "right" });
    await page.locator(".menu").getByRole("button", { name: "删除" }).click();
    await dialog(page).getByRole("button", { name: "删除" }).click();
    await panel.locator(".ws-entry", { hasText: "子目录" }).first().waitFor({ state: "detached" });
    assert.equal(fs.existsSync(path.join(plain, "子目录")), false);
    await page.context().close();
  });

  await t.test("CSV：显示成表格，内容不当 HTML，能切源码和编辑", async () => {
    const { page, panel } = await openPlain();
    await panel.getByRole("button", { name: /data\.csv/ }).click();
    const table = panel.locator(".fv-csv table");
    await table.waitFor();
    assert.deepEqual(await table.locator("thead th").allTextContents(), ["", "名称", "数量", "备注"]);
    const rows = table.locator("tbody tr");
    assert.equal(await rows.count(), 3);
    assert.deepEqual(await rows.nth(0).locator("td").allTextContents(), ["1", "苹果", "3", '有逗号,和"引号"']);
    assert.deepEqual(await rows.nth(1).locator("td").allTextContents(), ["2", "<b>梨</b>", "5", "换\n行"]);
    assert.equal(await table.locator("td b").count(), 0, "单元格里的标签不执行");
    assert.deepEqual(await rows.nth(2).locator("td").allTextContents(), ["3", "短行", "", ""], "短行补齐");
    if (shots) await page.screenshot({ path: path.join(shots, "11-csv.png") });
    // 表头固定
    assert.equal(await table.locator("thead th").first().evaluate((el) => getComputedStyle(el).position), "sticky");
    await panel.getByRole("button", { name: "源码" }).click();
    await panel.locator(".fv-code").waitFor();
    assert.match(await panel.locator(".fv-code").textContent(), /苹果,3/);
    await panel.getByRole("button", { name: "表格" }).click();
    await table.waitFor();
    // 按钮的字要看得见（文字和背景不能同色）
    const colors = await panel.getByRole("button", { name: "编辑" }).evaluate((el) => {
      const style = getComputedStyle(el);
      return [style.color, style.backgroundColor];
    });
    assert.notEqual(colors[0], colors[1]);
    // 编辑里能预览成表格，保存后 BOM 还在
    await panel.getByRole("button", { name: "编辑" }).click();
    await panel.locator(".cm-content").waitFor();
    await typeAtEnd(page, panel, "新行,9,x\n");
    await panel.getByRole("button", { name: "预览" }).click();
    await panel.locator(".fv-csv tbody tr", { hasText: "新行" }).waitFor();
    await panel.getByRole("button", { name: "继续编辑" }).click();
    await panel.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByText("已保存").waitFor();
    const saved = fs.readFileSync(path.join(plain, "data.csv"), "utf8");
    assert.equal(saved.charCodeAt(0), 0xfeff, "BOM 保留");
    assert.match(saved, /新行,9,x\n$/);
    await page.context().close();
  });

  await t.test("每轮改动：实时回复和历史回复不追加卡片，工作区仍能读取快照", async () => {
    const page = await open("admin", "web:turn");
    await page.locator(".top-git").waitFor();
    const send = async (text) => {
      await page.locator(".composer textarea, textarea").first().fill(text);
      await page.keyboard.press("Enter");
    };
    await send("写 a.ts,b.md");
    const card = page.locator(".turn-changes");
    const [first] = await recordedTurns(page, 1);
    assert.equal(await card.count(), 0, "收到实时改动事件也不追加卡片");
    assert.deepEqual(first.files.map((f) => f.path).sort(), ["a.ts", "b.md"]);
    // 一轮结束，分支标记也跟着更新
    await page.waitForFunction(() => document.querySelector(".top-git-count")?.textContent === "2");
    if (shots) await page.screenshot({ path: path.join(shots, "12-reply.png") });

    // 工作区仍能读取这一轮的 diff。
    await openRecordedTurn(page, first, first.files.find((f) => f.path === "a.ts"));
    const panel = page.locator(".ws-panel");
    await panel.locator(".d-row.d-add").first().waitFor();
    assert.deepEqual(await panel.locator(".d-row.d-add .d-code").allTextContents(), ["第一行", "第二行"]);
    assert.match(await panel.locator(".ws-detail-sub").textContent(), /这一轮/);
    if (shots) await page.screenshot({ path: path.join(shots, "13-turn-diff.png") });
    // 返回：这一轮的文件列表，再返回：改动页签
    await panel.getByRole("button", { name: "返回" }).click();
    await panel.locator(".ws-change", { hasText: "b.md" }).waitFor();
    assert.match(await panel.locator(".ws-detail-name").textContent(), /这一轮改了 2 个文件/);
    await panel.getByRole("button", { name: "返回" }).click();
    await panel.locator(".ws-branch").waitFor();

    // 第二轮只算第二轮的，且之前的改动没被计入
    await send("写 c.txt");
    const [, second] = await recordedTurns(page, 2);
    assert.equal(await card.count(), 0);
    assert.deepEqual(second.files.map((f) => f.path), ["c.txt"]);

    // 没改文件：没有卡片
    await send("随便聊聊");
    await page.getByText("好了：随便聊聊").waitFor();
    await page.waitForTimeout(300);
    assert.equal(await card.count(), 0);

    // 刷新后的历史回复也没有卡片，快照内容仍可读取。
    await page.reload();
    const [restored] = await recordedTurns(page, 2);
    assert.equal(await card.count(), 0);
    await openRecordedTurn(page, restored);
    await panel.locator(".ws-change", { hasText: "a.ts" }).click();
    await panel.locator(".d-row.d-add").first().waitFor();
    // 之后文件又变了，这一轮的 diff 还是当时的
    fs.writeFileSync(path.join(turn, "a.ts"), "完全不一样了\n");
    await panel.getByRole("button", { name: "刷新" }).click();
    await page.waitForTimeout(300);
    assert.deepEqual(await panel.locator(".d-row.d-add .d-code").allTextContents(), ["第一行", "第二行"]);
    // 快照被清理了：摘要还在，说明看不了具体内容
    for (const ref of git(turn, "for-each-ref", "--format=%(refname)", "refs/agent-loft/t/").split("\n").filter(Boolean)) git(turn, "update-ref", "-d", ref);
    git(turn, "gc", "-q", "--prune=now");
    await panel.getByRole("button", { name: "返回" }).click();
    await panel.locator(".ws-change", { hasText: "b.md" }).click();
    await panel.getByText("这一轮的快照已经清理了").waitFor();
    await page.context().close();
  });

  await t.test("编辑时从顶栏打开改动：没保存的要先问", async () => {
    const page = await open("admin", "web:repo");
    await page.locator(".top-git").waitFor();
    await toggleWorkspace(page);
    const panel = page.locator(".ws-panel");
    await panel.getByRole("tab", { name: "文件" }).click();
    await panel.getByRole("button", { name: /README\.md/ }).click();
    await panel.getByRole("button", { name: "编辑" }).click();
    await panel.locator(".cm-content").waitFor();
    await typeAtEnd(page, panel, "\n没保存");
    await page.locator(".top-git").click();
    await dialog(page).getByText("还有没保存的修改").waitFor();
    await cancelDialog(page);
    assert.equal(await panel.locator(".ws-tab.on").textContent(), "文件");
    assert.match(await panel.locator(".cm-content").innerText(), /没保存/);
    await page.locator(".top-git").click();
    await dialog(page).getByRole("button", { name: "不保存" }).click();
    await panel.locator(".ws-branch").waitFor();
    assert.doesNotMatch(fs.readFileSync(path.join(project, "README.md"), "utf8"), /没保存/);
    await page.context().close();
  });

  await t.test("Git 操作：暂存、提交、历史、切分支、丢弃", async () => {
    const repo = path.join(path.dirname(turn), "ops");
    git(repo, "init");
    git(repo, "config", "user.name", "tester");
    git(repo, "config", "user.email", "t@example.test");
    fs.writeFileSync(path.join(repo, "a.txt"), "一\n");
    fs.writeFileSync(path.join(repo, "b.txt"), "二\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "第一次提交");
    git(repo, "branch", "other");
    fs.writeFileSync(path.join(repo, "a.txt"), "改了\n");
    fs.writeFileSync(path.join(repo, "b.txt"), "也改了\n");
    fs.writeFileSync(path.join(repo, "new.txt"), "新的\n");
    const page = await open("admin", "web:ops");
    await page.locator(".top-git").waitFor();
    await page.locator(".top-git").click();
    const panel = page.locator(".ws-panel");
    const row = (name) => panel.locator(".ws-entry", { hasText: name });
    await row("a.txt").waitFor();
    const groups = () => panel.locator(".ws-list .ws-group").allTextContents();
    assert.deepEqual(await groups(), ["未暂存2", "未跟踪1"]);

    // 暂存一个；打字打到一半时列表刷新，字和焦点都还在
    const message = panel.getByRole("textbox", { name: "提交说明" });
    const commitBtn = panel.locator(".ws-commit-foot .btn");
    assert.equal(await commitBtn.textContent(), "没有已暂存的文件");
    assert.equal(await commitBtn.isDisabled(), true);
    await message.click();
    await page.keyboard.type("改 a");
    await row("a.txt").hover();
    await row("a.txt").getByRole("button", { name: "暂存" }).click();
    await panel.locator(".ws-group", { hasText: "已暂存" }).waitFor();
    assert.deepEqual(await groups(), ["已暂存1", "未暂存1", "未跟踪1"]);
    assert.equal(await message.inputValue(), "改 a");
    assert.equal(await commitBtn.textContent(), "提交 1 个文件");
    if (shots) await page.screenshot({ path: path.join(shots, "14-stage.png") });

    // 取消再暂存：整组按钮
    await panel.getByRole("button", { name: "全部取消暂存" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".ws-list .ws-group")].every((el) => !el.textContent.includes("已暂存")));
    await row("a.txt").hover();
    await row("a.txt").getByRole("button", { name: "暂存" }).click();
    await panel.locator(".ws-group", { hasText: "已暂存" }).waitFor();

    // 提交：只提交暂存的
    await commitBtn.click();
    await page.getByText(/^已提交 /).waitFor();
    assert.equal(await message.inputValue(), "");
    assert.equal(git(repo, "log", "-1", "--format=%s").trim(), "改 a");
    assert.deepEqual(await groups(), ["未暂存1", "未跟踪1"]);

    // 丢弃要确认，取消不动
    await row("b.txt").hover();
    await row("b.txt").getByRole("button", { name: "丢弃改动" }).click();
    await dialog(page).getByText(/丢弃「b\.txt」/).waitFor();
    await cancelDialog(page);
    assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "也改了\n");
    await row("b.txt").hover();
    await row("b.txt").getByRole("button", { name: "丢弃改动" }).click();
    await dialog(page).getByRole("button", { name: "丢弃" }).click();
    await row("b.txt").waitFor({ state: "detached" });
    assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "二\n");
    // 没跟踪的：删除
    await row("new.txt").hover();
    await row("new.txt").getByRole("button", { name: "删除" }).click();
    await dialog(page).getByRole("button", { name: "删除" }).click();
    await panel.getByText("工作区没有改动").waitFor();
    assert.equal(fs.existsSync(path.join(repo, "new.txt")), false);

    // 历史：列表、文件、diff
    await panel.getByRole("tab", { name: "历史" }).click();
    const commit = panel.locator(".ws-commit-row");
    await commit.first().waitFor();
    assert.deepEqual(await panel.locator(".ws-commit-subject").allTextContents(), ["改 a", "第一次提交"]);
    if (shots) await page.screenshot({ path: path.join(shots, "15-log.png") });
    await commit.first().click();
    await panel.locator(".ws-change", { hasText: "a.txt" }).click();
    await panel.locator(".d-row.d-add").first().waitFor();
    assert.deepEqual(await panel.locator(".d-row.d-add .d-code").allTextContents(), ["改了"]);
    assert.match(await panel.locator(".ws-detail-sub").textContent(), /提交 [0-9a-f]{7}/);
    await panel.getByRole("button", { name: "返回" }).click();
    await panel.getByRole("button", { name: "返回" }).click();
    await commit.first().waitFor();

    // 切分支：顶栏和历史都跟着变
    await panel.getByRole("tab", { name: /改动/ }).click();
    await panel.locator(".ws-branch").click();
    await page.locator(".ws-branch-row", { hasText: "other" }).click();
    await page.getByText("已切换到 other").waitFor();
    await page.waitForFunction(() => document.querySelector(".top-git-name")?.textContent === "other");
    assert.equal(git(repo, "branch", "--show-current").trim(), "other");
    await panel.getByRole("tab", { name: "历史" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".ws-commit-row").length === 1);
    // 新建分支
    await panel.getByRole("tab", { name: /改动/ }).click();
    await panel.locator(".ws-branch").click();
    await page.getByRole("button", { name: "新建分支…" }).click();
    await page.locator(".modal input").fill("feature/x");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".top-git-name")?.textContent === "feature/x");
    assert.equal(git(repo, "branch", "--show-current").trim(), "feature/x");
    // git 拒绝时把原因告诉用户
    git(repo, "checkout", "-q", "main");
    git(repo, "checkout", "-q", "feature/x");
    fs.writeFileSync(path.join(repo, "a.txt"), "没提交\n");
    await panel.getByRole("button", { name: "刷新" }).click();
    await row("a.txt").waitFor();
    await panel.locator(".ws-branch").click();
    await page.locator(".ws-branch-row", { hasText: "main" }).click();
    await page.getByText(/有没提交的改动会被覆盖/).waitFor();
    assert.equal(git(repo, "branch", "--show-current").trim(), "feature/x");
    assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "没提交\n");
    await page.context().close();
  });

  await t.test("撤销这一轮和重做", async () => {
    const page = await open("admin", "web:undo");
    await page.locator(".top-git").waitFor();
    await page.locator("textarea").first().fill("写 undo.txt");
    await page.keyboard.press("Enter");
    const [changes] = await recordedTurns(page, 1);
    const file = path.join(undoRepo, "undo.txt");
    assert.equal(fs.existsSync(file), true);
    await openRecordedTurn(page, changes);
    const panel = page.locator(".ws-panel");
    const undo = panel.getByRole("button", { name: "撤销这一轮" });
    await undo.waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, "16-undo.png") });
    // 取消不动
    await undo.click();
    await dialog(page).getByText(/撤销这一轮改的 1 个文件/).waitFor();
    await cancelDialog(page);
    assert.equal(fs.existsSync(file), true);
    await undo.click();
    await dialog(page).getByRole("button", { name: "撤销" }).click();
    await page.getByText("已撤销").waitFor();
    const redo = panel.getByRole("button", { name: "重做" });
    await redo.waitFor();
    assert.equal(fs.existsSync(file), false);
    assert.match(await panel.locator(".ws-detail-sub").textContent(), /已经撤销了/);
    await redo.click();
    await dialog(page).getByRole("button", { name: "重做" }).click();
    await undo.waitFor();
    assert.equal(fs.readFileSync(file, "utf8"), "第一行\n第二行\n");
    // 之后又改过：提醒，列出文件，取消不动
    fs.writeFileSync(file, "后来改的\n");
    await panel.getByRole("button", { name: "刷新" }).click();
    await panel.getByText("这些文件之后又被改过").first().waitFor();
    await undo.click();
    await dialog(page).getByRole("button", { name: "撤销" }).click();
    await page.locator(".dialog-overlay", { hasText: "这些文件之后又被改过了" }).getByText(/undo\.txt/).waitFor();
    await page.locator(".dialog-overlay", { hasText: "这些文件之后又被改过了" }).getByRole("button", { name: "取消" }).click();
    await page.waitForTimeout(200);
    assert.equal(fs.readFileSync(file, "utf8"), "后来改的\n");
    await page.context().close();
  });

  await t.test("触屏手机：暂存和丢弃的按钮一直看得到，点了能用，不溢出", async () => {
    const repo = path.join(path.dirname(turn), "ops");
    fs.writeFileSync(path.join(repo, "b.txt"), "手机上改的\n");
    const page = await open("admin", "web:ops", { width: 390, height: 844 }, { hasTouch: true, isMobile: true });
    assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), true, "确实是触屏环境");
    await page.locator(".top-more").waitFor();
    await toggleWorkspace(page);
    const panel = page.locator(".ws-panel");
    await panel.getByRole("tab", { name: /改动/ }).tap();
    const row = panel.locator(".ws-entry", { hasText: "b.txt" });
    await row.waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, "17-mobile-ops.png") });
    const stage = row.getByRole("button", { name: "暂存" });
    const discardBtn = row.getByRole("button", { name: "丢弃改动" });
    // 不用悬停就看得到，点得到，和文件名不重叠
    assert.equal(await stage.evaluate((el) => getComputedStyle(el.parentElement).opacity), "1");
    const box = await stage.boundingBox();
    assert.ok(box.width >= 30 && box.height >= 30, "手指点得到");
    const name = await row.locator(".ws-name").boundingBox();
    const discardBox = await discardBtn.boundingBox();
    assert.ok(name.x + name.width <= discardBox.x, "按钮不压住文件名");
    assert.equal(await panel.locator(".ws-commit").evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
    assert.equal(await panel.locator(".ws-list").first().evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
    await stage.tap();
    await panel.locator(".ws-group", { hasText: "已暂存" }).waitFor();
    assert.match(git(repo, "status", "--porcelain=v1"), /^M {2}b\.txt/m);
    // 文件树的「更多」按钮也一样
    await panel.getByRole("tab", { name: "文件" }).tap();
    const more = panel.locator(".ws-entry", { hasText: "a.txt" }).getByRole("button", { name: "更多操作" });
    await more.waitFor();
    assert.ok(Number(await more.evaluate((el) => getComputedStyle(el).opacity)) > 0.5);
    await more.tap();
    await page.locator(".menu").getByRole("button", { name: "重命名" }).waitFor();
    await page.context().close();
  });

  await t.test("回复里的文件能在工作区打开", async () => {
    const page = await open("admin", "web:plain");
    await page.locator("textarea").first().waitFor();
    await page.locator("textarea").first().fill("看 `note.md`");
    await page.keyboard.press("Enter");
    await page.locator(".msg-ai .file-link, .file-link").first().waitFor();
    await page.locator(".file-link").last().click();
    await page.locator(".file-viewer .fv-doc").waitFor();
    await page.locator(".file-viewer").getByRole("button", { name: "在工作区打开" }).click();
    const panel = page.locator(".ws-panel");
    await panel.locator(".fv-doc").waitFor();
    assert.equal(await page.locator(".file-viewer").count(), 0);
    assert.equal(await panel.locator(".ws-detail-name").textContent(), "note.md");
    assert.equal(await panel.locator(".ws-tab.on").textContent(), "文件");
    await page.context().close();
  });

  await t.test("切换会话：没保存的内容留着，提交说明不带过去", async () => {
    const { page, panel } = await openPlain();
    await panel.getByRole("button", { name: /code\.ts/ }).click();
    await panel.getByRole("button", { name: "编辑" }).click();
    await panel.locator(".cm-content").waitFor();
    await typeAtEnd(page, panel, "// 切会话前写的");
    // 走页面内的切换：编辑器还开着，草稿要在这时存下来
    const go = (key) => page.evaluate(async (k) => {
      const m = await import(document.querySelector('script[src*="app.js"]').src.replace(/app\.js.*/, "views/messages.js"));
      await m.openConversation(k);
    }, key);
    await go("web:repo");
    await page.getByText("没保存的修改已留在这台设备上").waitFor();
    await panel.getByRole("button", { name: /README\.md/ }).waitFor();
    // 在这条会话写了提交说明，再切走
    await panel.getByRole("tab", { name: /改动/ }).click();
    await panel.getByRole("textbox", { name: "提交说明" }).fill("写给 repo 的说明");
    await go("web:plain");
    await panel.getByRole("tab", { name: "文件" }).click();
    await panel.getByRole("button", { name: /code\.ts/ }).click();
    await panel.getByRole("button", { name: "编辑" }).click();
    await page.getByText("已恢复上次没保存的修改").waitFor();
    assert.match(await panel.locator(".cm-content").innerText(), /切会话前写的/);
    // 这条会话不是仓库，切回 repo 时说明应该已经清了
    await panel.getByRole("button", { name: "返回" }).click();
    await dialog(page).getByRole("button", { name: "不保存" }).click();
    await go("web:repo");
    await panel.getByRole("tab", { name: /改动/ }).click();
    assert.equal(await panel.getByRole("textbox", { name: "提交说明" }).inputValue(), "");
    await page.context().close();
  });

  await t.test("拖文件到面板上传；放在别的页签不会把页面换掉", async () => {
    const { page, panel } = await openPlain();
    const drop = (selector, name) =>
      page.evaluate(
        ([sel, fileName]) => {
          const dt = new DataTransfer();
          dt.items.add(new File(["拖进来的"], fileName));
          const el = document.querySelector(sel);
          const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt });
          el.dispatchEvent(over);
          const ev = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
          el.dispatchEvent(ev);
          return [over.defaultPrevented, ev.defaultPrevented];
        },
        [selector, name],
      );
    assert.deepEqual(await drop(".ws-list", "dropped.txt"), [true, true]);
    await panel.getByRole("button", { name: /dropped\.txt/ }).waitFor();
    assert.equal(fs.readFileSync(path.join(plain, "dropped.txt"), "utf8"), "拖进来的");
    // 放到文件夹上：传到那个文件夹
    fs.mkdirSync(path.join(plain, "拖放目录"));
    await panel.getByRole("button", { name: "刷新" }).click();
    await panel.locator(".ws-entry", { hasText: "拖放目录" }).waitFor();
    assert.deepEqual(await drop('.ws-entry[data-dir="拖放目录"]', "in-dir.txt"), [true, true]);
    await page.waitForFunction(() => document.querySelector('.ws-entry[data-dir="拖放目录"] [aria-expanded="true"]'));
    assert.equal(fs.existsSync(path.join(plain, "拖放目录", "in-dir.txt")), true);
    // 打开了文件时：拦住，不上传，页面不跳走
    await panel.getByRole("button", { name: /note\.md/ }).click();
    await panel.locator(".fv-doc").waitFor();
    assert.deepEqual(await drop(".ws-body", "ignored.txt"), [true, true]);
    await page.waitForTimeout(200);
    assert.equal(fs.existsSync(path.join(plain, "ignored.txt")), false);
    fs.rmSync(path.join(plain, "dropped.txt"));
    fs.rmSync(path.join(plain, "拖放目录"), { recursive: true });
    await page.context().close();
  });

  await t.test("合并冲突：界面上能看到、解决、提交", async () => {
    const repo = path.join(path.dirname(turn), "ops");
    git(repo, "checkout", "-q", "--", ".");
    git(repo, "reset", "-q", "--hard");
    git(repo, "clean", "-fdq");
    git(repo, "checkout", "-q", "-b", "side");
    fs.writeFileSync(path.join(repo, "a.txt"), "side 的\n");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qam", "side");
    git(repo, "checkout", "-q", "feature/x");
    fs.writeFileSync(path.join(repo, "a.txt"), "feature 的\n");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qam", "feature");
    assert.throws(() => execFileSync("git", ["merge", "side"], { cwd: repo, stdio: "ignore" }));
    const page = await open("admin", "web:ops");
    await page.locator(".top-git").waitFor();
    await page.locator(".top-git").click();
    const panel = page.locator(".ws-panel");
    const row = panel.locator(".ws-entry", { hasText: "a.txt" });
    await panel.locator(".ws-group", { hasText: "有冲突" }).waitFor();
    assert.equal(await row.getByRole("button", { name: "丢弃改动" }).count(), 0, "冲突的不给丢弃");
    await row.locator(".ws-change").click();
    await panel.locator(".d-raw").waitFor();
    assert.match(await panel.locator(".d-raw").textContent(), /<<<<<<</);
    if (shots) await page.screenshot({ path: path.join(shots, "18-conflict.png") });
    await panel.getByRole("button", { name: "返回" }).click();
    fs.writeFileSync(path.join(repo, "a.txt"), "解决了\n");
    await row.hover();
    await row.getByRole("button", { name: "标记为已解决并暂存" }).click();
    await panel.locator(".ws-group", { hasText: "已暂存" }).waitFor();
    await panel.getByRole("textbox", { name: "提交说明" }).fill("合并 side");
    await panel.locator(".ws-commit-foot .btn").click();
    await page.getByText(/^已提交 /).waitFor();
    assert.equal(git(repo, "log", "-1", "--format=%P").trim().split(" ").length, 2, "是合并提交");
    await page.context().close();
  });

  await t.test("手机上弹窗盖在面板上面，手势不会在面板后面打开侧栏", async () => {
    const page = await open("admin", "web:plain", { width: 390, height: 844 }, { hasTouch: true, isMobile: true });
    await page.locator(".top-more").waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, "19-mobile-top.png") });
    const top = await page.locator(".topbar").evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    assert.equal(top, true, "顶栏不溢出");
    await toggleWorkspace(page);
    const panel = page.locator(".ws-panel");
    await panel.getByRole("button", { name: "新建文件", exact: true }).tap();
    const input = page.locator(".modal input");
    await input.waitFor();
    const covered = await input.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === el;
    });
    assert.equal(covered, true, "弹窗在最上面");
    await page.locator(".modal").getByRole("button", { name: "取消" }).tap();
    // 菜单也在面板上面
    const more = panel.locator(".ws-entry", { hasText: "note.md" }).getByRole("button", { name: "更多操作" });
    await more.tap();
    const item = page.locator(".menu").getByRole("button", { name: "重命名" });
    await item.waitFor();
    assert.equal(await item.evaluate((el) => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.left + 5, r.top + 5) === el; }), true, "菜单在最上面");
    await page.mouse.click(5, 5);
    // 从左边缘横滑：不打开侧栏
    await page.evaluate(() => {
      const el = document.querySelector(".ws-panel .ws-list");
      const fire = (type, x) => {
        const touch = new Touch({ identifier: 1, target: el, clientX: x, clientY: 400 });
        el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === "touchend" ? [] : [touch], changedTouches: [touch] }));
      };
      fire("touchstart", 5); fire("touchmove", 60); fire("touchmove", 200); fire("touchend", 200);
    });
    assert.equal(await page.locator(".layout").evaluate((el) => el.classList.contains("side-open")), false);
    await page.context().close();
  });

  await t.test("深色模式下看得清", async () => {
    const page = await open("admin", "web:turn", { width: 1400, height: 900 }, { colorScheme: "dark" });
    const [changes] = await recordedTurns(page, 2);
    assert.equal(await page.locator(".turn-changes").count(), 0);
    if (shots) await page.screenshot({ path: path.join(shots, "20-dark-reply.png") });
    await openRecordedTurn(page, changes, changes.files[0]);
    const panel = page.locator(".ws-panel");
    await panel.locator(".d-row, .ws-empty").first().waitFor();
    await panel.getByRole("button", { name: "返回" }).click();
    await panel.getByRole("button", { name: "返回" }).click();
    await panel.getByRole("tab", { name: "文件" }).click();
    await panel.getByRole("button", { name: /old\.txt/ }).click();
    await panel.getByRole("button", { name: "编辑" }).click();
    await panel.locator(".cm-content").waitFor();
    const colors = await panel.locator(".cm-editor").evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]);
    assert.notEqual(colors[0], "rgb(255, 255, 255)", "编辑器背景是深色的");
    if (shots) await page.screenshot({ path: path.join(shots, "21-dark-editor.png") });
    await page.context().close();
  });

  await t.test("成员默认没有入口，接口也不给", async () => {
    const page = await open("member", "web:member");
    await page.locator(".conv-expert-icon").waitFor();
    assert.equal(await page.locator(".top-workspace").count(), 0);
    assert.equal(await page.locator(".top-git").count(), 0);
    await page.locator(".top-more").click();
    assert.equal(await page.locator(".top-menu").getByRole("button", { name: "文件", exact: true }).count(), 0);
    const status = await page.evaluate(() => fetch("/api/conversations/web%3Amember/workspace-tree").then((r) => r.status));
    assert.equal(status, 403);
    await page.context().close();
  });

  await t.test("管理员在设置里开通后，成员就能用了；关掉又不行", async () => {
    const admin = await open("admin", "web:repo");
    await admin.locator(".top-more").waitFor();
    await admin.evaluate(() => document.dispatchEvent(new CustomEvent("aim:open-settings", { detail: "用户" })));
    const memberRow = admin.locator(".user-entry").filter({ hasText: "member" });
    await memberRow.waitFor();
    const more = memberRow.getByRole("button", { name: "管理 ▾" });
    await more.click();
    await admin.locator(".menu").getByRole("button", { name: "开通工作区面板…" }).click();
    await admin.locator(".dialog-overlay").getByRole("button", { name: "开通" }).click();
    await memberRow.getByText("工作区面板", { exact: true }).waitFor();
    const member = await open("member", "web:member");
    await member.locator(".top-more").waitFor();
    await toggleWorkspace(member);
    await member.locator(".ws-panel").getByRole("button", { name: /README\.md/ }).waitFor();
    assert.equal(await member.evaluate(() => fetch("/api/conversations/web%3Amember/workspace-tree").then((r) => r.status)), 200);
    await more.click();
    await admin.locator(".menu").getByRole("button", { name: "关闭工作区面板" }).click();
    await member.waitForFunction(() => fetch("/api/conversations/web%3Amember/workspace-tree").then((r) => r.status === 403));
    await member.context().close();
    await admin.context().close();
  });

  await t.test("手机：全屏，不横向溢出，关掉回到对话", async () => {
    const page = await open("admin", "web:repo", { width: 390, height: 844 });
    await page.locator(".top-more").waitFor();
    await toggleWorkspace(page);
    const panel = page.locator(".ws-panel");
    await panel.getByRole("button", { name: /README\.md/ }).waitFor();
    const box = await panel.boundingBox();
    assert.equal(box.width, 390);
    assert.equal(box.x, 0);
    await panel.getByRole("tab", { name: /改动/ }).click();
    await panel.locator(".ws-change", { hasText: "a.ts" }).click();
    await panel.locator(".d-row.d-add").first().waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, "7-mobile.png") });
    const overflow = await panel.locator(".ws-diff-scroll").evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    assert.equal(overflow, false);
    await panel.getByRole("button", { name: "关闭工作区" }).click();
    assert.equal(await panel.isVisible(), false);
    await page.context().close();
  });
});
