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
const { createExpert } = await import("../src/core/experts.js");
const { resetUiPrefsForTest } = await import("../src/core/ui-prefs.js");
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
  const bootstrap = async (auth: string) => (await (await fetch(`${base}/api/bootstrap`, { headers: { Cookie: auth } })).json()) as { sidebarNav: { id: string; visible: boolean }[]; dirOrder: string[] | null; expertOrder: string[] };
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

  const order = ["feishu:bot-a", "/project-a", "feishu:bot-b", "/project-b"];
  const putOrder = (body: unknown, auth = aliceCookie, origin = base) => fetch(`${base}/api/ui/dir-order`, {
    method: "PUT", headers: { Cookie: auth, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await putOrder({ order }, "")).status, 401);
  assert.equal((await putOrder({ order }, aliceCookie, "https://other.example")).status, 403);
  assert.equal((await putOrder({ order, userId: bob.id })).status, 200);
  assert.deepEqual((await bootstrap(aliceCookie)).dirOrder, order);
  assert.equal((await bootstrap(bobCookie)).dirOrder, null);
  assert.deepEqual(await (await putOrder({ append: ["feishu:bot-a", "/new-project"] })).json(), { order: [...order, "/new-project"] });
  assert.deepEqual(await (await putOrder({ append: ["recent", "/another-project"] })).json(), { order: ["recent", ...order, "/new-project", "/another-project"] });
  const moved = [...order, "recent"];
  await putOrder({ order: moved });
  assert.deepEqual(await (await putOrder({ append: ["recent", "/last-project"] })).json(), { order: [...moved, "/last-project"] }, "最近已有位置时不重新置顶");
  assert.deepEqual((await bootstrap(aliceCookie)).sidebarNav, items, "混合排序不覆盖菜单偏好");

  const own = createExpert(alice.id, { name: "我的专家", engine: "claude", access: "web" });
  const shared = createExpert(bob.id, { name: "共享专家", engine: "codex", access: "web", shared: true });
  const expertOrder = [shared.id, "codex", own.id, "claude"];
  const putExperts = (body: unknown, auth = aliceCookie, origin = base) => fetch(`${base}/api/experts/order`, {
    method: "PUT", headers: { Cookie: auth, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await putExperts({ order: expertOrder }, "")).status, 401);
  assert.equal((await putExperts({ order: expertOrder }, aliceCookie, "https://other.example")).status, 403);
  for (const invalid of [null, "all", [123], [""], Array(2001).fill("claude")]) assert.equal((await putExperts({ order: invalid })).status, 400);
  assert.deepEqual(await (await putExperts({ order: [...expertOrder, "codex"], userId: bob.id })).json(), { order: expertOrder }, "去重，不能修改其他账号的排序");
  resetUiPrefsForTest();
  for (const endpoint of ["/api/bootstrap", "/api/experts", "/api/experts/brief"]) {
    const data = await (await fetch(`${base}${endpoint}`, { headers: { Cookie: aliceCookie } })).json() as { expertOrder: string[] };
    assert.deepEqual(data.expertOrder, expertOrder, `${endpoint} 返回持久化的混合排序`);
  }
  assert.deepEqual((await bootstrap(bobCookie)).expertOrder, []);
  assert.deepEqual((await bootstrap(aliceCookie)).sidebarNav, items);
  assert.deepEqual((await bootstrap(aliceCookie)).dirOrder, [...moved, "/last-project"]);
});
