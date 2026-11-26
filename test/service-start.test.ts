// Runs the published CLI entry with a disposable home. Reserving a port makes
// the losing service fail at the same point as an actual conflicting listener.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/cli.js", import.meta.url));

async function reserve() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

for (const mode of ["both", "bot", "system", "bot port occupied", "system port occupied"] as const) {
  test("CLI start: " + mode, { timeout: 45_000 }, async t => {
    const home = await mkdtemp(path.join(os.tmpdir(), "loft-start-"));
    const bot = await reserve();
    const system = await reserve();
    const blockedBot = mode === "bot port occupied";
    const blockedSystem = mode === "system port occupied";
    if (!blockedBot) await bot.close();
    if (!blockedSystem) await system.close();
    await writeFile(path.join(home, "config.json"), JSON.stringify({
      workspaceRoot: home, web: { host: "127.0.0.1", port: system.port },
      agents: { claude: { enabled: false }, codex: { enabled: false } },
    }));

    const args = mode === "bot" || mode === "system" ? ["start", mode] : ["start"];
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, AGENT_LOFT_HOME: home, AGENT_LOFT_WEB_MODE: "both", AGENT_LOFT_BOT_HOST: "127.0.0.1", AGENT_LOFT_BOT_PORT: String(bot.port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    let log = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { log += chunk; });
    t.after(async () => {
      child.kill("SIGTERM");
      await closed;
      if (blockedBot) await bot.close();
      if (blockedSystem) await system.close();
      await rm(home, { recursive: true, force: true });
    });

    const wantBot = mode !== "system" && !blockedBot;
    const wantSystem = mode !== "bot" && !blockedSystem;
    const base = (port: number) => "http://127.0.0.1:" + port;
    const deadline = Date.now() + 35_000;
    while ((wantBot && !log.includes("[bot] 已监听")) || (wantSystem && !log.includes("[web] 已监听")) ||
      ((blockedBot || blockedSystem) && !log.includes("服务已退出"))) {
      assert.ok(child.exitCode === null && Date.now() < deadline, log.replace(/设置码：\S+/g, "设置码已隐藏"));
      await delay(100);
    }
    if (wantBot) {
      const response = await fetch(base(bot.port));
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Loft Bot/);
      assert.equal((await fetch(base(bot.port) + "/api/bootstrap")).status, 403);
    } else if (!blockedBot) await assert.rejects(fetch(base(bot.port)));
    if (wantSystem) {
      const response = await fetch(base(system.port) + "/open-bot?invite=old", { redirect: "manual" });
      assert.equal(response.headers.get("location"), base(bot.port) + "/?invite=old");
      assert.equal((await fetch(base(system.port) + "/api/bots")).status, 404);
      assert.equal((await fetch(base(system.port) + "/api/me")).status, 200);
    } else if (!blockedSystem) await assert.rejects(fetch(base(system.port)));

    if (mode === "both") {
      const token = (await readFile(path.join(home, "data/web-setup-token"), "utf8")).trim();
      const credentials = { name: "owner", password: "fixture-password" };
      const post = (port: number, api: string, body: object) => fetch(base(port) + api, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const setup = await post(system.port, "/api/setup", { token, ...credentials });
      assert.equal(setup.status, 200);
      const sessions = await Promise.all([bot.port, system.port].map(port => post(port, "/api/login", credentials)));
      for (const response of sessions) {
        assert.equal(response.status, 200);
        const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
        for (const port of [bot.port, system.port]) {
          const me = await fetch(base(port) + "/api/me", { headers: { Cookie: cookie } });
          const status = await me.json() as { authed: boolean };
          assert.equal(status.authed, true);
        }
      }
    }
  });
}
