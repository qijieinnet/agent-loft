import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { WebSocket } from "ws";

process.env.AGENT_LOFT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aim-push-presence-"));
const { config, loadConfig, saveConfig } = await import("../src/core/config.js");
const { createUser } = await import("../src/core/users.js");
const { createSession } = await import("../src/channels/web/auth.js");
const { startWeb, stopWeb } = await import("../src/channels/web/server.js");
const { addSubscription } = await import("../src/channels/web/push.js");
const { hub } = await import("../src/core/hub.js");
loadConfig();

test("前台推送按设备暂停，切到后台恢复；跨账号、过期和断开的状态不拦截", { timeout: 15000 }, async (t) => {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((err) => err ? reject(err) : resolve()));
  saveConfig({ ...structuredClone(config()), web: { ...config().web, host: "127.0.0.1", port, quotaEnabled: false } });
  const alice = createUser({ name: "alice", password: "password-1" });
  const bob = createUser({ name: "bob", password: "password-2" });
  const phone = "https://web.push.apple.com/phone";
  const tablet = "https://web.push.apple.com/tablet";
  for (const endpoint of [phone, tablet]) {
    const ua = crypto.createECDH("prime256v1");
    ua.generateKeys();
    addSubscription({ endpoint, keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") } }, "", alice.id);
  }
  const sent: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.ok([phone, tablet].includes(String(url)), "测试不向外部推送服务发请求");
    sent.push(String(url));
    return new Response(null, { status: 201 });
  });
  const key = "web:push-presence";
  hub.ensure({ key, channel: "web", channelId: "web", defaultAgent: "claude", owner: alice.id });
  await startWeb();
  t.after(() => stopWeb());
  async function connect(userId: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      origin: `http://127.0.0.1:${port}`,
      headers: { Cookie: `aim_session=${createSession(userId, "127.0.0.1", "test")}` },
    });
    t.after(() => ws.terminate());
    await once(ws, "message"); // hello
    return ws;
  }
  const ws = await connect(alice.id);
  const other = await connect(bob.id);
  async function presence(socket: WebSocket, foreground: boolean, pushEndpoint = phone, viewing = "") {
    socket.send(JSON.stringify({ t: "presence", visible: !!viewing, key: viewing, foreground, pushEndpoint }));
    // 等服务端处理完 presence，避免依赖定时等待。
    const pong = new Promise<void>((resolve) => {
      const listener = (raw: Buffer) => {
        if (JSON.parse(raw.toString()).t !== "pong") return;
        socket.off("message", listener);
        resolve();
      };
      socket.on("message", listener);
    });
    socket.send(JSON.stringify({ t: "ping" }));
    await pong;
  }
  async function notify() {
    sent.length = 0;
    hub.emit("event", { key, seq: 1, ts: Date.now(), ev: { type: "result", text: "完成", footer: "", at: Date.now() } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    return [...sent].sort();
  }
  await presence(ws, true);
  assert.deepEqual(await notify(), [tablet], "前台手机不推，另一台设备照常推；未选会话或空闲也免打扰");
  await presence(ws, true, phone, key);
  assert.deepEqual(await notify(), [tablet], "手机正看着这条会话时也不影响其它设备");
  await presence(ws, false);
  assert.deepEqual(await notify(), [phone, tablet], "切到后台即恢复");
  await presence(other, true);
  assert.deepEqual(await notify(), [phone, tablet], "其他账号不能冒用订阅来拦截通知");
  await presence(ws, true);
  const now = Date.now();
  const clock = t.mock.method(Date, "now", () => now + 41_000);
  assert.deepEqual(await notify(), [phone, tablet], "40 秒未更新的前台状态失效");
  clock.mock.restore();
  await presence(ws, true);
  ws.close();
  await once(ws, "close");
  assert.deepEqual(await notify(), [phone, tablet], "断开后不再免打扰");
});
