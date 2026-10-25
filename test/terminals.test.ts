import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-terminals-"));
process.env.AGENT_LOFT_HOME = home;

const { loadConfig, config, saveConfig } = await import("../src/core/config.js");
loadConfig();
const users = await import("../src/core/users.js");
const terms = await import("../src/core/terminals.js");

test("输出记录：重连时只补 since 之后的，早于记录开头的整屏重画", () => {
  const log = new terms.OutputLog(100);
  log.append("hello ");
  log.append("world");
  assert.deepEqual(log.since(6), { reset: false, data: "world" });
  assert.deepEqual(log.since(11), { reset: false, data: "" });
  // 第一次打开（-1）、来自别的进程的数（比 total 大）：整屏重画
  assert.deepEqual(log.since(-1), { reset: true, data: "hello world" });
  assert.equal(log.since(99).reset, true);

  // 超出上限后从换行处截掉前面的
  for (let i = 0; i < 30; i++) log.append(`line ${i}\n`);
  const all = log.since(-1).data;
  assert.ok(all.length <= 125);
  assert.ok(all.startsWith("line "), all);
  assert.ok(all.endsWith("line 29\n"));
  assert.equal(log.since(0).reset, true);
  const tail = log.since(log.total - 8);
  assert.deepEqual(tail, { reset: false, data: "line 29\n" });
});

test("权限：管理员能用，成员要单独开；停用、总开关关掉都不能用", () => {
  const admin = users.createUser({ name: "boss", password: "password-1", role: "admin" });
  const member = users.createUser({ name: "guest", password: "password-2" });
  assert.equal(terms.canUseTerminal(users.getUser(admin.id)), true);
  assert.equal(terms.canUseTerminal(users.getUser(member.id)), false);

  users.updateUser(member.id, { remote: true });
  assert.equal(terms.canUseTerminal(users.getUser(member.id)), true);
  users.updateUser(member.id, { disabled: true });
  assert.equal(terms.canUseTerminal(users.getUser(member.id)), false);
  users.updateUser(member.id, { disabled: false, remote: false });
  assert.equal(users.getUser(member.id)!.remote, undefined);
  assert.equal(terms.canUseTerminal(users.getUser(member.id)), false);

  const cfg = structuredClone(config());
  cfg.remote.terminal = false;
  saveConfig(cfg);
  assert.equal(terms.canUseTerminal(users.getUser(admin.id)), false);
  cfg.remote.terminal = true;
  saveConfig(cfg);
  assert.equal(terms.canUseTerminal(undefined), false);
});

test("开终端、收发、按 since 接上；成员不能开；权限收回时 shell 结束", { skip: !terms.terminalAvailability().available }, async () => {
  terms.watchTerminalAccess();
  const admin = users.findUserByName("boss")!;
  const member = users.findUserByName("guest")!;
  assert.throws(() => terms.createTerminal(member, {}), /权限/);

  const info = terms.createTerminal(admin, { cwd: home, cols: 100, rows: 30 });
  assert.equal(info.cwd, home);
  assert.equal(terms.getTerminal(info.id, member.id), undefined, "别人的终端当不存在");

  const got: unknown[] = [];
  let closed: number | null = null;
  const peer = { send: (m: unknown) => got.push(m), close: (code: number) => (closed = code) };
  assert.equal(terms.attachTerminal(info.id, member.id, peer, -1), false);
  assert.equal(terms.attachTerminal(info.id, admin.id, peer, -1), true);
  terms.writeTerminal(info.id, "echo aloft-$((40+2))\r");
  const output = () => got.map((m) => (m as { d?: string }).d ?? "").join("");
  for (let i = 0; i < 50 && !output().includes("aloft-42"); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(output(), /aloft-42/);

  // 断开再接上：since 等于收到的总数，就不用重放
  terms.detachTerminal(info.id, peer);
  const seen = got.reduce<number>((n, m) => {
    const msg = m as { t: string; d: string; total?: number };
    return msg.t === "a" ? msg.total! : n + msg.d.length;
  }, 0);
  const again: { t: string; reset?: boolean; d?: string }[] = [];
  terms.attachTerminal(info.id, admin.id, { send: (m) => again.push(m as never), close: () => {} }, seen);
  assert.equal(again[0]!.t, "a");
  assert.equal(again[0]!.reset, false);

  // 降成成员：shell 立刻结束
  const other = users.createUser({ name: "boss2", password: "password-3", role: "admin" });
  users.updateUser(admin.id, { role: "member" });
  assert.equal(terms.getTerminal(info.id, admin.id), undefined);
  assert.ok(again.some((m) => m.t === "x"));
  users.updateUser(admin.id, { role: "admin" });
  users.removeUser(other.id);
  assert.equal(closed, null, "已经断开的页面不会再被通知");
  terms.killAllTerminals();
});

test("远程桌面：权限跟着远程控制走，总开关关了谁都不能用；用已有的 VNC 服务时直接给配置里的地址", async () => {
  const desktop = await import("../src/core/desktop.js");
  const admin = users.findUserByName("boss")!;
  const member = users.findUserByName("guest")!;
  assert.equal(desktop.canUseDesktop(admin), true);
  assert.equal(desktop.canUseDesktop(member), false);
  users.updateUser(member.id, { remote: true });
  assert.equal(desktop.canUseDesktop(users.getUser(member.id)), true);
  users.updateUser(member.id, { remote: false });

  const cfg = structuredClone(config());
  cfg.remote.desktopSource = "vnc";
  cfg.remote.vncHost = "127.0.0.1";
  cfg.remote.vncPort = 5999;
  cfg.remote.vncPassword = "secret";
  saveConfig(cfg);
  assert.deepEqual(desktop.desktopAvailability(), { available: true, source: "vnc" });
  assert.deepEqual(await desktop.desktopTarget(), { host: "127.0.0.1", port: 5999, password: "secret" });
  assert.equal(desktop.desktopRunning(), false, "用已有的服务时不起 x11vnc");

  cfg.remote.desktop = false;
  saveConfig(cfg);
  assert.equal(desktop.canUseDesktop(admin), false);
  cfg.remote.desktop = true;
  cfg.remote.desktopSource = "auto";
  cfg.remote.display = ":987";
  saveConfig(cfg);
  const st = desktop.desktopAvailability();
  if (process.platform === "linux") {
    assert.equal(st.available, false);
    assert.match(st.reason!, /:987/);
  }
});
