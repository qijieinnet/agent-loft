import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-ui-prefs-api-"));
process.env.AGENT_LOFT_HOME = home;
const { config, loadConfig, saveConfig } = await import("../src/core/config.js");
const { createUser } = await import("../src/core/users.js");
const { createSession } = await import("../src/channels/web/auth.js");
const { startWeb, stopWeb } = await import("../src/channels/web/server.js");
loadConfig();

test("侧栏菜单接口：按登录账号保存，刷新 bootstrap 返回配置，拒绝未登录及跨站修改", { timeout: 20000 }, async (t) => {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((err) => err ? reject(err) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  saveConfig({ ...structuredClone(config()), workspaceRoot: home, web: { ...config().web, host: "127.0.0.1", port, quotaEnabled: false } });
  const alice = createUser({ name: "alice", password: "password-1" });
  const bob = createUser({ name: "bob", password: "password-2" });
  const cookie = (id: string) => `aim_session=${createSession(id, "127.0.0.1", "test")}`;
  const aliceCookie = cookie(alice.id);
  const bobCookie = cookie(bob.id);
  await startWeb();
  t.after(() => stopWeb());
  const put = (body: unknown, auth = aliceCookie, origin = base) => fetch(`${base}/api/ui/sidebar-nav`, {
    method: "PUT", headers: { Cookie: auth, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const bootstrap = async (auth: string) => (await (await fetch(`${base}/api/bootstrap`, { headers: { Cookie: auth } })).json()) as { sidebarNav: { id: string; visible: boolean }[] };
  const defaults = (await bootstrap(aliceCookie)).sidebarNav;
  assert.equal((await put({ items: [] }, "")).status, 401);
  assert.equal((await put({ items: [] }, aliceCookie, "https://other.example")).status, 403);
  assert.equal((await put({ items: "invalid" })).status, 400);
  const items = [...defaults].reverse().map((it) => ({ ...it, visible: false }));
  const res = await put({ items, userId: bob.id });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { items });
  assert.deepEqual((await bootstrap(aliceCookie)).sidebarNav, items);
  assert.deepEqual((await bootstrap(bobCookie)).sidebarNav, defaults);
});
