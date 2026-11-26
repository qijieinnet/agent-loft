// Exercise the shipped CLI with disposable services, auth, and recorded data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/cli.js", import.meta.url));

async function port() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const value = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  return value;
}

test("CLI start keeps workbench, preserves legacy Bot data, and refuses Bot-only auth", { timeout: 45_000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "loft-start-"));
  const data = path.join(home, "data");
  const [systemPort, oldBotPort] = await Promise.all([port(), port()]);
  const base = "http://127.0.0.1:" + systemPort;
  await mkdir(data);
  await writeFile(path.join(home, "config.json"), JSON.stringify({
    workspaceRoot: home, web: { host: "127.0.0.1", port: systemPort },
    agents: { claude: { enabled: false }, codex: { enabled: false } },
  }));
  const dbPath = path.join(data, "agent-loft.db");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec("CREATE TABLE web_bot_messages (text TEXT); INSERT INTO web_bot_messages VALUES ('keep me');");
  legacy.close();
  const env = { ...process.env, AGENT_LOFT_HOME: home, AGENT_LOFT_WEB_MODE: "both",
    AGENT_LOFT_BOT_HOST: "127.0.0.1", AGENT_LOFT_BOT_PORT: String(oldBotPort) };
  const child = spawn(process.execPath, [cli, "start"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  let log = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { log += chunk; });
  t.after(async () => {
    child.kill("SIGTERM");
    await closed;
    await rm(home, { recursive: true, force: true });
  });
  const deadline = Date.now() + 35_000;
  while (!log.includes("[web] 已监听")) {
    assert.ok(child.exitCode === null && Date.now() < deadline, log.replace(/设置码：\S+/g, "设置码已隐藏"));
    await delay(100);
  }
  await assert.rejects(fetch("http://127.0.0.1:" + oldBotPort, { signal: AbortSignal.timeout(2000) }));
  assert.equal((await fetch(base + "/")).status, 200);
  assert.equal((await fetch(base + "/open-bot?invite=old", { redirect: "manual" })).status, 404);
  assert.equal((await fetch(base + "/api/bots")).status, 404);
  const token = (await readFile(path.join(data, "web-setup-token"), "utf8")).trim();
  const credentials = { name: "owner", password: "fixture-password" };
  const post = (api: string, body: object) => fetch(base + api, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const setup = await post("/api/setup", { token, ...credentials });
  assert.equal(setup.status, 200);
  const usersFile = path.join(data, "users.json");
  const store = JSON.parse(await readFile(usersFile, "utf8"));
  const owner = store.users[0];
  store.users.push({ ...owner, id: "u_legacy", name: "old-bot-guest", role: "member", botOnly: true });
  await writeFile(usersFile, JSON.stringify(store));
  assert.equal((await post("/api/login", { ...credentials, name: "old-bot-guest" })).status, 403);
  const login = await post("/api/login", { password: credentials.password });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const status = await (await fetch(base + "/api/me", { headers: { Cookie: cookie } })).json() as { authed: boolean; multiUser: boolean };
  assert.equal(status.authed, true);
  assert.equal(status.multiUser, false);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT text FROM web_bot_messages").get()?.text, "keep me");
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name GLOB 'web_bot_*'").get()?.n, 1);
  } finally {
    db.close();
  }
});

test("CLI explicitly rejects the retired Bot-only startup mode", async () => {
  const child = spawn(process.execPath, [cli, "start", "bot"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const [code] = await once(child, "close");
  assert.equal(code, 1);
  assert.match(stderr, /Web Bot 已移除/);
});
