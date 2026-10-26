import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { vncLogin, ByteReader, serveNoAuth, VncAuthError } from "../src/core/vnc-auth.js";

/** 装成 macOS 屏幕共享：只给苹果认证，解开凭据核对用户名密码 */
async function fakeMac(r: ByteReader, write: (b: Buffer) => void, user: string, pass: string): Promise<void> {
  write(Buffer.from("RFB 003.889\n", "latin1"));
  assert.equal((await r.read(12)).toString("latin1"), "RFB 003.008\n");
  write(Buffer.from([4, 30, 33, 36, 35]));
  assert.equal((await r.read(1))[0], 30);
  const dh = crypto.createDiffieHellman(1024);
  const pub = dh.generateKeys();
  const prime = dh.getPrime();
  const head = Buffer.alloc(4);
  dh.getGenerator().copy(head, 2 - dh.getGenerator().length);
  head.writeUInt16BE(prime.length, 2);
  write(Buffer.concat([head, prime, Buffer.concat([Buffer.alloc(prime.length - pub.length), pub])]));
  const enc = await r.read(128);
  const clientPub = await r.read(prime.length);
  const shared = dh.computeSecret(clientPub);
  const key = crypto.createHash("md5").update(Buffer.concat([Buffer.alloc(prime.length - shared.length), shared])).digest();
  const d = crypto.createDecipheriv("aes-128-ecb", key, null);
  d.setAutoPadding(false);
  const creds = Buffer.concat([d.update(enc), d.final()]);
  const cstr = (b: Buffer) => b.subarray(0, b.indexOf(0)).toString("utf8");
  const ok = cstr(creds.subarray(0, 64)) === user && cstr(creds.subarray(64)) === pass;
  write(Buffer.from([0, 0, 0, ok ? 0 : 1]));
}

function pipe() {
  const toServer = new ByteReader();
  const toClient = new ByteReader();
  return { toServer, toClient, sendToServer: (b: Buffer) => toServer.push(b), sendToClient: (b: Buffer) => toClient.push(b) };
}

test("苹果认证：用户名密码对了能登录，不对报认证失败", async () => {
  for (const [pass, ok] of [["密码 pass", true], ["wrong", false]] as const) {
    const p = pipe();
    const mac = fakeMac(p.toServer, p.sendToClient, "qijie", "密码 pass");
    const login = vncLogin(p.toClient, p.sendToServer, { username: "qijie", password: pass });
    await mac;
    if (ok) await login;
    else await assert.rejects(login, (e) => e instanceof VncAuthError && /用户名或密码不对/.test(e.message));
  }
});

test("苹果认证：对页面装成不用认证的 VNC，认证失败时把原因告诉页面", async () => {
  for (const ok of [true, false]) {
    const page = pipe();
    const login = ok ? Promise.resolve() : Promise.reject(new VncAuthError("Mac 的用户名或密码不对"));
    const served = serveNoAuth(page.toServer, page.sendToClient, login);
    assert.equal((await page.toClient.read(12)).toString("latin1"), "RFB 003.008\n");
    page.sendToServer(Buffer.from("RFB 003.008\n", "latin1"));
    assert.deepEqual([...(await page.toClient.read(2))], [1, 1]);
    page.sendToServer(Buffer.from([1]));
    const status = (await page.toClient.read(4)).readUInt32BE(0);
    if (ok) {
      await served;
      assert.equal(status, 0);
      continue;
    }
    await assert.rejects(served);
    assert.equal(status, 1);
    const len = (await page.toClient.read(4)).readUInt32BE(0);
    assert.equal((await page.toClient.read(len)).toString("utf8"), "Mac 的用户名或密码不对");
  }
});

test("苹果认证：服务不支持时说清楚，连接断了读的那头报错", async () => {
  const p = pipe();
  p.sendToClient(Buffer.from("RFB 003.008\n", "latin1"));
  p.sendToClient(Buffer.from([1, 2]));
  await assert.rejects(vncLogin(p.toClient, p.sendToServer, { username: "u", password: "p" }), /不支持用 Mac 用户名登录/);

  const r = new ByteReader();
  const pending = r.read(4);
  r.fail(new Error("断了"));
  await assert.rejects(pending, /断了/);
});

test("VNC 密码认证：DES 加密服务端给的 16 字节，和 OpenSSL（钥匙按位反转）算的一样", async () => {
  const p = pipe();
  p.sendToClient(Buffer.from("RFB 003.008\n", "latin1"));
  p.sendToClient(Buffer.from([2, 1, 2]));
  p.sendToClient(Buffer.from("00112233445566778899aabbccddeeff", "hex"));
  p.sendToClient(Buffer.from([0, 0, 0, 0]));
  await vncLogin(p.toClient, p.sendToServer, { password: "secret12" });
  assert.equal((await p.toServer.read(12)).toString("latin1"), "RFB 003.008\n");
  assert.equal((await p.toServer.read(1))[0], 2);
  assert.equal((await p.toServer.read(16)).toString("hex"), "817402416b165d7ade9c46b5faa42370");
});
