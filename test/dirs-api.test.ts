import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import type { WorkspaceDirListing } from "../src/core/config.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-dirs-api-"));
process.env.AGENT_LOFT_HOME = home;
const { config, loadConfig, saveConfig } = await import("../src/core/config.js");
const { createUser } = await import("../src/core/users.js");
const { createSession } = await import("../src/channels/web/auth.js");
const { startWeb, stopWeb } = await import("../src/channels/web/server.js");
loadConfig();

test("目录选择器：登录后能新建子目录，拒绝覆盖和跳出工作区", { timeout: 20000 }, async (t) => {
  const root = path.join(home, "workspace");
  const outside = path.join(home, "outside");
  fs.mkdirSync(path.join(root, "existing"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, "file.txt"), "keep");
  fs.symlinkSync(outside, path.join(root, "escape"));
  fs.symlinkSync(path.join(root, "existing"), path.join(root, "inside-link"));
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((err) => err ? reject(err) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  saveConfig({ ...structuredClone(config()), workspaceRoot: root, web: { ...config().web, host: "127.0.0.1", port, quotaEnabled: false } });
  const user = createUser({ name: "member", password: "password-1" });
  const cookie = `aim_session=${createSession(user.id, "127.0.0.1", "test")}`;
  await startWeb();
  t.after(() => stopWeb());
  const create = (body: unknown, auth = cookie, origin = base) => fetch(`${base}/api/dirs`, {
    method: "POST", headers: { Cookie: auth, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  await t.test("未登录和跨站请求不能创建目录", async () => {
    assert.equal((await create({ name: "anonymous" }, "")).status, 401);
    assert.equal((await create({ name: "cross-origin" }, cookie, "https://other.example")).status, 403);
    assert.equal(fs.existsSync(path.join(root, "anonymous")), false);
    assert.equal(fs.existsSync(path.join(root, "cross-origin")), false);
  });
  await t.test("支持根目录、嵌套目录、中文、空格和工作区内部链接", async () => {
    const res = await create({ path: "", name: " 新建 项目 " });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { path: path.join(root, "新建 项目") });
    assert.equal(fs.statSync(path.join(root, "新建 项目")).isDirectory(), true);
    const nested = await create({ path: path.join(root, "新建 项目"), name: "子目录" });
    assert.equal(nested.status, 201);
    const listing = await (await fetch(`${base}/api/dirs?path=${encodeURIComponent("新建 项目")}`, { headers: { Cookie: cookie } })).json() as WorkspaceDirListing;
    assert.deepEqual(listing.dirs, [{ name: "子目录", hidden: false }]);
    assert.equal((await create({ path: "inside-link", name: "child" })).status, 201);
    assert.equal(fs.statSync(path.join(root, "existing", "child")).isDirectory(), true);
  });
  await t.test("同名文件和目录不覆盖", async () => {
    for (const name of ["existing", "file.txt", "escape"]) assert.equal((await create({ name })).status, 409);
    assert.equal(fs.readFileSync(path.join(root, "file.txt"), "utf8"), "keep");
    assert.equal(fs.lstatSync(path.join(root, "escape")).isSymbolicLink(), true);
  });
  await t.test("名称必须是单个目录名，父目录必须存在且在工作区内", async () => {
    for (const name of [undefined, 42, "", " ", ".", "..", "../escape", "a/b", "a\\b", "bad\0name", "line\nbreak", "x".repeat(256)]) {
      assert.equal((await create({ name })).status, 400, String(name));
    }
    assert.equal((await create({ path: 42, name: "child" })).status, 400);
    for (const parent of ["..", outside, "escape", "missing", "file.txt"]) {
      assert.equal((await create({ path: parent, name: "child" })).status, 404, parent);
    }
    assert.deepEqual(fs.readdirSync(outside), []);
  });
  await t.test("工作区根目录本身是符号链接时仍能创建", async () => {
    const linkRoot = path.join(home, "linked-workspace");
    fs.symlinkSync(root, linkRoot);
    saveConfig({ ...structuredClone(config()), workspaceRoot: linkRoot });
    const res = await create({ path: "existing", name: "via-linked-root" });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { path: path.join(linkRoot, "existing", "via-linked-root") });
    assert.equal(fs.statSync(path.join(root, "existing", "via-linked-root")).isDirectory(), true);
  });
});
