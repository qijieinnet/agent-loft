import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 模拟升级前的安装：只有一个全局密码，和一个没记用户的登录态
const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-users-"));
process.env.AGENT_LOFT_HOME = home;
fs.mkdirSync(path.join(home, "data"), { recursive: true });

const users = await import("../src/core/users.js");
const legacyHash = users.hashPassword("old-password");
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ web: { passwordHash: legacyHash } }));
const legacyToken = "legacy-token";
const crypto = await import("node:crypto");
fs.writeFileSync(
  path.join(home, "data", "web-sessions.json"),
  JSON.stringify({
    [crypto.createHash("sha256").update(legacyToken).digest("hex")]: {
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      lastSeen: Date.now(),
      ip: "127.0.0.1",
      userAgent: "test",
    },
  }),
);

const { loadConfig } = await import("../src/core/config.js");
loadConfig();
const auth = await import("../src/channels/web/auth.js");
const store = await import("../src/core/store.js");
const access = await import("../src/channels/web/access.js");

test("升级：原来的密码变成管理员 admin，原来的登录态继续有效", () => {
  const list = users.listUsers();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.name, "admin");
  assert.equal(list[0]!.role, "admin");
  assert.equal(auth.needsSetup(), false);
  // 只有一个用户：登录不用填用户名
  assert.equal(users.verifyLogin(undefined, "old-password")?.name, "admin");
  assert.equal(users.verifyLogin(undefined, "wrong-password"), undefined);
  // 升级前的登录态认给了 admin
  assert.equal(auth.sessionUser(legacyToken)?.name, "admin");
  assert.equal(auth.listSessions(list[0]!.id).length, 1);
});

test("多个用户：要填用户名；用户名不区分大小写、不能重名", () => {
  const bob = users.createUser({ name: "Bob", password: "bob-password" });
  assert.equal(bob.role, "member");
  assert.equal("passwordHash" in bob, false, "对外不带密码哈希");
  assert.throws(() => users.createUser({ name: "bob", password: "whatever-1" }), /已经有人用了/);
  assert.throws(() => users.createUser({ name: "carol", password: "short" }), /至少 8 位/);
  assert.throws(() => users.createUser({ name: "a b", password: "long-enough" }), /用户名/);
  assert.equal(users.verifyLogin(undefined, "bob-password"), undefined, "多个用户时不填用户名不让登");
  assert.equal(users.verifyLogin("BOB", "bob-password")?.id, bob.id);
  assert.equal(users.verifyLogin("bob", "old-password"), undefined, "别人的密码不行");
});

test("至少保留一个能登录的管理员", () => {
  const admin = users.findUserByName("admin")!;
  assert.throws(() => users.updateUser(admin.id, { role: "member" }), /至少要保留/);
  assert.throws(() => users.updateUser(admin.id, { disabled: true }), /至少要保留/);
  assert.throws(() => users.removeUser(admin.id), /至少要保留/);
  // 有了第二个管理员就可以
  const second = users.createUser({ name: "root2", password: "root2-password", role: "admin" });
  users.updateUser(admin.id, { role: "member" });
  users.updateUser(admin.id, { role: "admin" });
  users.removeUser(second.id);
});

test("停用的用户：登录态立刻失效，也登不进来", () => {
  const bob = users.findUserByName("bob")!;
  const token = auth.createSession(bob.id, "1.2.3.4", "ua");
  assert.equal(auth.sessionUser(token)?.id, bob.id);
  users.updateUser(bob.id, { disabled: true });
  assert.equal(auth.sessionUser(token), undefined);
  assert.equal(users.verifyLogin("bob", "bob-password"), undefined);
  users.updateUser(bob.id, { disabled: false });
  assert.equal(auth.sessionUser(token)?.id, bob.id);
});

test("改密码：只有这个用户的设备下线，旧的全局密码一并作废", () => {
  const admin = users.findUserByName("admin")!;
  const bob = users.findUserByName("bob")!;
  const bobToken = auth.createSession(bob.id, "1.2.3.4", "ua");
  auth.setUserPassword(admin.id, "new-admin-password");
  assert.equal(auth.sessionUser(legacyToken), undefined, "admin 的设备下线");
  assert.equal(auth.sessionUser(bobToken)?.id, bob.id, "bob 的不受影响");
  assert.equal(users.verifyLogin("admin", "old-password"), undefined);
  assert.equal(users.verifyLogin("admin", "new-admin-password")?.id, admin.id);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(cfg.web.passwordHash, "");
});

test("成员只能踢自己的设备", () => {
  const admin = users.findUserByName("admin")!;
  const bob = users.findUserByName("bob")!;
  auth.createSession(admin.id, "1.1.1.1", "admin-device");
  const adminDevice = auth.listSessions(admin.id)[0]!;
  assert.equal(auth.revokeSession(adminDevice.id, bob.id), false);
  assert.equal(auth.revokeSession(adminDevice.id), true);
});

test("归属：自己的归自己；没主的和主人已删除的归管理员", () => {
  const admin = users.findUserByName("admin")!;
  const bob = users.findUserByName("bob")!;
  const web = (owner?: string) => ({ key: "k", channel: "web", owner }) as never;
  assert.equal(access.canSeeConv(bob, web(bob.id)), true);
  assert.equal(access.canSeeConv(admin, web(bob.id)), false, "管理员也不看成员的对话列表");
  assert.equal(access.canSeeConv(bob, web(admin.id)), false);
  assert.equal(access.canSeeConv(bob, web(undefined)), false, "飞书 / 升级前的会话只给管理员");
  assert.equal(access.canSeeConv(admin, web(undefined)), true);
  assert.equal(access.canSeeConv(admin, web("u_gone")), true, "主人被删了，归管理员");
  assert.equal(access.canSeeConv(bob, web("u_gone")), false);
  assert.equal(users.adminVisible(bob.id), false);
  assert.equal(users.adminVisible(admin.id), true);
  assert.equal(users.adminVisible(undefined), true);
});

test("agent 会话按开它的人过滤，第一次记下的主人不会被改", () => {
  const admin = users.findUserByName("admin")!;
  const bob = users.findUserByName("bob")!;
  store.recordSessionOwner("s-bob", bob.id);
  store.recordSessionOwner("s-bob", admin.id);
  assert.equal(store.sessionOwner("s-bob"), bob.id);
  const bobSees = access.sessionVisibleTo(bob)!;
  const adminSees = access.sessionVisibleTo(admin)!;
  assert.equal(bobSees("s-bob"), true);
  assert.equal(adminSees("s-bob"), false);
  assert.equal(bobSees("s-terminal"), false, "终端里开的会话只给管理员");
  assert.equal(adminSees("s-terminal"), true);
});

test("推送订阅：没记主人的算最早的管理员的", () => {
  const admin = users.findUserByName("admin")!;
  const bob = users.findUserByName("bob")!;
  assert.equal(access.pushOwnedBy(admin.id)(undefined), true);
  assert.equal(access.pushOwnedBy(bob.id)(undefined), false);
  assert.equal(access.pushOwnedBy(bob.id)(bob.id), true);
});

test("一个用户都没有时才要设置码", () => {
  assert.equal(auth.ensureSetupToken(), null);
});

test("改用户是原子的：密码不合格时，角色也不会被改", () => {
  const bob = users.findUserByName("bob")!;
  assert.throws(() => auth.patchUser(bob.id, { role: "admin", password: "short" }), /至少 8 位/);
  assert.equal(users.findUserByName("bob")!.role, "member");
});

test("/approve：别人会话里的请求当不存在；会落盘的「总是允许」成员不能点", async () => {
  const { hub } = await import("../src/core/hub.js");
  const { interactions } = await import("../src/core/interactions.js");
  const keep = setInterval(() => {}, 1000);
  const spec = { kind: "approval" as const, title: "t", detail: "d", alwaysLabel: "总是", alwaysGlobal: true };
  const pending = interactions.create("web:other", spec, 60_000);
  const id = interactions.listPending("web:other")[0]!.id;
  const run = (ctx: object, decision = "allow-once") =>
    hub.command("web:mine", { kind: "approve", requestId: id, decision: decision as "allow-once" }, { allowedAgents: [], by: "t", ...ctx });
  assert.match(JSON.stringify(await run({ convVisible: () => false })), /不存在或已处理/);
  assert.match(JSON.stringify(await run({ convVisible: () => true, allowGlobalAlways: false }, "allow-always")), /只有管理员/);
  assert.equal(interactions.isPending(id), true, "上面两次都没放行");
  await run({ convVisible: () => true, allowGlobalAlways: true }, "allow-always");
  assert.equal((await pending).settlement, "allow-always");
  clearInterval(keep);
});

test("升级前的推送订阅：第一次读到时记到迁移出来的管理员名下，之后不再换人", async () => {
  const admin = users.findUserByName("admin")!;
  const keys = { p256dh: Buffer.alloc(65, 4).toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") };
  fs.writeFileSync(
    path.join(home, "data", "push.json"),
    JSON.stringify({ subscriptions: [{ endpoint: "https://push.example/old", keys, label: "旧手机", createdAt: 1 }] }),
  );
  const push = await import("../src/channels/web/push.js");
  push.resetPushStoreForTest();
  assert.equal(push.listSubscriptions((owner) => owner === admin.id).length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(home, "data", "push.json"), "utf8"));
  assert.equal(saved.subscriptions[0].userId, admin.id);
});

test("建第一个管理员时，残留的登录态全部作废", () => {
  // 模拟：users.json 被删了、旧密码也清掉了，web-sessions.json 里还有没记用户的登录态
  const stale = "stale-token";
  fs.rmSync(path.join(home, "data", "users.json"));
  users.resetUsersForTest();
  fs.writeFileSync(
    path.join(home, "data", "web-sessions.json"),
    JSON.stringify({
      [crypto.createHash("sha256").update(stale).digest("hex")]: {
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
        lastSeen: Date.now(),
        ip: "1.1.1.1",
        userAgent: "old",
      },
    }),
  );
  assert.equal(auth.needsSetup(), true);
  auth.setupFirstAdmin("root", "root-password");
  assert.equal(auth.sessionUser(stale), undefined);
});
