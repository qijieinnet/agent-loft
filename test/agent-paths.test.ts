import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import type { AppConfig } from "../src/core/config.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "loft-agent paths-"));
process.env.AGENT_LOFT_HOME = path.join(home, "loft");
mock.method(os, "homedir", () => home);
const { expandHomePath } = await import("../src/core/paths.js");
const { defaultConfig, config, loadConfig, saveConfig, onConfigChange } = await import("../src/core/config.js");
const { configPath, readJson, writeJsonAtomic } = await import("../src/home.js");

const pathsOf = (cfg: AppConfig) => [
  cfg.agents.codex.path, cfg.agents.codex.home, cfg.agents.workbuddy.cliPath,
  cfg.agents.dsh.path, cfg.agents.dsh.home, cfg.agents.dsh.patch,
];
const relativePaths = ["~/.local/bin/codex", "~/.codex", "~/Apps/Work Buddy/codebuddy", "~/.local/bin/dsh", "~/.dsh", "~/.dsh/loft patch.yml"];
function withPaths(cfg: AppConfig, values: string[]): AppConfig {
  const next = structuredClone(cfg);
  [next.agents.codex.path, next.agents.codex.home, next.agents.workbuddy.cliPath,
    next.agents.dsh.path, next.agents.dsh.home, next.agents.dsh.patch] = values as [string, string, string, string, string, string];
  return next;
}
const expandedPaths = relativePaths.map((p) => path.join(home, p.slice(2)));

test("Agent 路径：配置加载、保存、热更新、Web 校验和运行时一致展开家目录", { timeout: 20000 }, async (t) => {
  t.after(() => { mock.restoreAll(); fs.rmSync(home, { recursive: true, force: true }); });

  await t.test("只展开当前用户的 ~，保留空值、PATH 命令、相对路径和字面量", () => {
    assert.equal(expandHomePath(" ~ "), home);
    assert.equal(expandHomePath(" ~/ "), home);
    for (const p of ["", "codex", "dsh", "./bin/codex", "/opt/bin/codex", "~someone/.codex", "$HOME/.codex", "dir/~/.codex"]) {
      assert.equal(expandHomePath(` ${p} `), p);
    }
  });

  await t.test("加载已有配置也展开全部六个路径字段", () => {
    writeJsonAtomic(configPath, withPaths(defaultConfig(), relativePaths));
    assert.deepEqual(pathsOf(loadConfig()), expandedPaths);
  });

  await t.test("保存时展开并持久化，通知消费者时已是最终路径", () => {
    const values = relativePaths.map((p) => ` ${p} `);
    let notified: string[] | undefined;
    const off = onConfigChange((next) => { notified = pathsOf(next); });
    try {
      assert.deepEqual(pathsOf(saveConfig(withPaths(config(), values))), expandedPaths);
      assert.deepEqual(notified, expandedPaths);
      assert.deepEqual(pathsOf(readJson<AppConfig>(configPath, defaultConfig())), expandedPaths);
      const empty = saveConfig(withPaths(config(), ["codex", "", "", "dsh", "", ""]));
      assert.deepEqual(pathsOf(empty), ["codex", "", "", "dsh", "", ""]);
    } finally { off(); }
  });

  await t.test("手改配置触发热更新时同样展开", async () => {
    let off = () => {};
    let timer: ReturnType<typeof setTimeout>;
    const updated = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("等待配置热更新超时")), 5000);
      off = onConfigChange((next) => {
        if (next.agents.codex.home === expandedPaths[1]) resolve();
      });
    });
    try {
      writeJsonAtomic(configPath, withPaths(config(), relativePaths));
      await updated;
      assert.deepEqual(pathsOf(config()), expandedPaths);
    } finally { off(); clearTimeout(timer!); }
  });

  await t.test("dsh 启动环境与 patch、本机 Codex 技能、WorkBuddy CLI 使用展开后的路径", async () => {
    const { dshHome, launchSpec } = await import("../src/agents/dsh/sdk.js");
    const { desktopCli } = await import("../src/agents/workbuddy/sdk.js");
    const { machineSkills } = await import("../src/core/skill-runtime.js");
    const launch = launchSpec({ cwd: home, mode: "read-only" });
    try {
      assert.equal(dshHome(), expandedPaths[4]);
      assert.equal(launch.spawn.command, expandedPaths[3]);
      assert.equal(launch.spawn.env?.DSH_HOME, expandedPaths[4]);
      assert.deepEqual(launch.spawn.args, ["--profile", "acp", "--patch", expandedPaths[5]]);
      fs.mkdirSync(path.dirname(expandedPaths[2]!), { recursive: true });
      fs.writeFileSync(expandedPaths[2]!, "fixture");
      assert.equal(desktopCli(), expandedPaths[2]);
      const dir = path.join(config().agents.codex.home, "skills", "path-fixture");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: path-fixture\ndescription: 检查路径展开\n---\n");
      assert.ok(machineSkills().some((s) => s.dir === dir && s.agents.includes("codex")));
    } finally { launch.cleanup(); }
  });

  await t.test("设置 API 接受 ~/，仍拒绝 WorkBuddy 与 dsh 的普通相对路径", async (t) => {
    const { createUser } = await import("../src/core/users.js");
    const { createSession } = await import("../src/channels/web/auth.js");
    const { startWeb, stopWeb } = await import("../src/channels/web/server.js");
    const { closeDatabaseForTest } = await import("../src/core/db.js");
    t.after(async () => { await stopWeb(); closeDatabaseForTest(); });
    const probe = net.createServer();
    await new Promise<void>((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve, reject) => probe.close((err) => err ? reject(err) : resolve()));
    saveConfig({ ...config(), web: { ...config().web, host: "127.0.0.1", port, quotaEnabled: false } });
    const admin = createUser({ name: "admin", password: "password-paths", role: "admin" });
    const base = `http://127.0.0.1:${port}`;
    const headers = { Cookie: `aim_session=${createSession(admin.id, "127.0.0.1", "test")}`, Origin: base, "Content-Type": "application/json" };
    await startWeb();
    const put = (agents: unknown) => fetch(`${base}/api/config`, { method: "PUT", headers, body: JSON.stringify({ agents }) });
    const result = await put(withPaths(config(), relativePaths).agents);
    assert.equal(result.status, 200, await result.text());
    assert.deepEqual(pathsOf(config()), expandedPaths);
    const response = await fetch(`${base}/api/config`, { headers });
    assert.deepEqual(pathsOf(await response.json() as AppConfig), expandedPaths);
    for (const agents of [{ workbuddy: { cliPath: "relative/cli" } }, { dsh: { home: "relative/home" } }, { dsh: { patch: "relative/patch.yml" } }]) {
      assert.equal((await put(agents)).status, 400);
      assert.deepEqual(pathsOf(config()), expandedPaths);
    }
    assert.equal((await put({ codex: { path: "codex", home: "" }, workbuddy: { cliPath: "" }, dsh: { path: "dsh", home: "", patch: "" } })).status, 200);
    assert.deepEqual(pathsOf(config()), ["codex", "", "", "dsh", "", ""]);
  });
});
