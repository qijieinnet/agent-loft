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
const { ensureConversation, getConversation, updateConversation } = await import("../src/core/store.js");
const { hub } = await import("../src/core/hub.js");
const { addScheduled, listScheduled } = await import("../src/core/scheduled.js");
const { saveBuffer } = await import("../src/core/uploads.js");
const { recordFile, listLibrary } = await import("../src/core/library.js");
const { getDirOrder, setDirOrder } = await import("../src/core/ui-prefs.js");
loadConfig();

test("项目目录：新建、确认删除所需的清理及权限边界", { timeout: 20000 }, async (t) => {
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
  const remove = (body: unknown, auth = cookie, origin = base) => fetch(`${base}/api/dirs`, {
    method: "DELETE", headers: { Cookie: auth, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const conv = (key: string, cwd: string, owner = user.id, channel = "web") => ensureConversation({ key, cwd, owner, channel, channelId: channel, agent: "claude" });

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
  await t.test("删除目录需要登录和同源请求，拒绝根目录、越界、无效路径和链接", async () => {
    assert.equal((await remove({ path: "existing" }, "")).status, 401);
    assert.equal((await remove({ path: "existing" }, cookie, "https://other.example")).status, 403);
    for (const input of [undefined, 42, "", " "]) assert.equal((await remove({ path: input })).status, 400);
    for (const input of [root, ".", "existing/.."]) assert.equal((await remove({ path: input })).status, 403);
    for (const input of ["..", outside, "escape", "missing", "file.txt"]) assert.equal((await remove({ path: input })).status, 404);
    assert.equal((await remove({ path: "inside-link" })).status, 400);
    assert.equal(fs.existsSync(path.join(root, "existing")), true);
  });
  await t.test("删除项目清理全部分页会话、分叉、隐藏会话、子目录和附件，保留相邻项目", async () => {
    const dir = path.join(root, "待删除 项目");
    const nested = path.join(dir, "nested");
    const sibling = `${dir}-keep`;
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(nested, "data.txt"), "delete");
    fs.symlinkSync(outside, path.join(dir, "external-link"));
    fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
    const keys = Array.from({ length: 18 }, (_, i) => `web:project-delete:${i}`);
    for (const key of keys) conv(key, dir);
    updateConversation(keys[1]!, { forkOf: keys[0] });
    updateConversation(keys[17]!, { hidden: true });
    keys.push("web:project-delete:nested", "feishu:project-delete");
    conv(keys[18]!, nested);
    conv(keys[19]!, dir, user.id, "feishu");
    const kept = conv("web:project-keep", sibling);
    const file = saveBuffer({ key: keys[0]!, name: "attachment.txt", data: Buffer.from("attachment") });
    recordFile({ owner: user.id, convKey: keys[0]!, path: file.path, name: file.name, kind: file.kind, size: file.size, source: "upload" });
    addScheduled(keys[0]!, "remove", Date.now() + 60_000);
    addScheduled(kept.key, "keep", Date.now() + 60_000);
    setDirOrder(user.id, [dir, nested, sibling, "feishu:bot"]);
    const event = new Promise<{ owner: string; path: string; keys: string[] }>((resolve) => hub.once("project-deleted", resolve));
    const res = await remove({ path: dir });
    assert.equal(res.status, 200, await res.clone().text());
    const result = await res.json() as { path: string; keys: string[]; dirOrder: string[] };
    assert.equal(result.path, dir);
    assert.deepEqual(result.keys.toSorted(), keys.toSorted());
    assert.deepEqual((await event).keys.toSorted(), keys.toSorted());
    for (const key of keys) assert.equal(getConversation(key)?.hidden, true, key);
    assert.equal(kept.hidden, undefined);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(fs.existsSync(sibling), true);
    assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep");
    assert.equal(fs.existsSync(file.path), false);
    assert.deepEqual(listLibrary(user).files, []);
    assert.deepEqual(listScheduled(keys[0]!), []);
    assert.equal(listScheduled(kept.key).length, 1);
    assert.deepEqual(getDirOrder(user.id), [sibling, "feishu:bot"]);
    assert.equal((await remove({ path: dir })).status, 404);
  });
  await t.test("其他用户的会话（包括隐藏的和子目录中的）会阻止删除整个项目", async () => {
    const dir = path.join(root, "shared");
    const nested = path.join(dir, "nested");
    fs.mkdirSync(nested, { recursive: true });
    const other = createUser({ name: "other", password: "password-2" });
    const mine = conv("web:shared:mine", dir);
    const theirs = conv("web:shared:other", nested, other.id);
    updateConversation(theirs.key, { hidden: true });
    const res = await remove({ path: dir });
    assert.equal(res.status, 403);
    assert.equal(fs.existsSync(nested), true);
    assert.equal(mine.hidden, undefined);
  });
  await t.test("空文件夹可直接删除；文件系统删除失败时保留会话和项目", async () => {
    fs.mkdirSync(path.join(root, "empty"));
    assert.equal((await remove({ path: "empty" })).status, 200);
    assert.equal(fs.existsSync(path.join(root, "empty")), false);
    const dir = path.join(root, "denied");
    fs.mkdirSync(dir);
    const c = conv("web:denied", dir);
    const rm = fs.rmSync;
    fs.rmSync = (target, options) => {
      if (target === dir) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return rm(target, options);
    };
    try {
      assert.equal((await remove({ path: dir })).status, 403);
      assert.equal(c.hidden, undefined);
      assert.equal(fs.existsSync(dir), true);
    } finally {
      fs.rmSync = rm;
    }
  });
  await t.test("等待会话退出时新增、移走会话或替换目录，会中止删除", async () => {
    for (const mode of ["new-session", "new-message", "move-session", "replace-directory", "outside-link"]) {
      const dir = path.join(root, `changed-${mode}`);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "keep.txt"), "keep");
      const c = conv(`web:changed:${mode}`, dir);
      const drop = hub.drop;
      hub.drop = async (key, note) => {
        await drop.call(hub, key, note);
        if (key !== c.key) return;
        if (mode === "new-session") conv(`${c.key}:new`, dir);
        else if (mode === "new-message") updateConversation(c.key, { activeAt: c.activeAt + 1 });
        else if (mode === "move-session") updateConversation(c.key, { cwd: root });
        else {
          fs.renameSync(dir, `${dir}-original`);
          if (mode === "outside-link") fs.symlinkSync(outside, dir);
          else fs.mkdirSync(dir);
        }
      };
      try {
        assert.equal((await remove({ path: dir })).status, 409, mode);
        assert.equal(c.hidden, undefined);
        assert.equal(fs.existsSync(dir), true);
        const original = mode === "outside-link" || mode === "replace-directory" ? `${dir}-original` : dir;
        assert.equal(fs.readFileSync(path.join(original, "keep.txt"), "utf8"), "keep");
      } finally {
        hub.drop = drop;
      }
    }
  });
  await t.test("工作区根目录本身是符号链接时仍能创建", async () => {
    const linkRoot = path.join(home, "linked-workspace");
    fs.symlinkSync(root, linkRoot);
    saveConfig({ ...structuredClone(config()), workspaceRoot: linkRoot });
    const res = await create({ path: "existing", name: "via-linked-root" });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { path: path.join(linkRoot, "existing", "via-linked-root") });
    assert.equal(fs.statSync(path.join(root, "existing", "via-linked-root")).isDirectory(), true);
    assert.equal((await remove({ path: linkRoot })).status, 403);
    assert.equal((await remove({ path: "existing/via-linked-root" })).status, 200);
    assert.equal(fs.existsSync(path.join(root, "existing", "via-linked-root")), false);
  });
});
