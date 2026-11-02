// 微信渠道的端到端回归：真的 agent-loft 服务 + 本地假 iLink + 真浏览器，走扫码、输数字、收发、断开。
// 通过 AGENT_LOFT_PLAYWRIGHT、PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 指定本地浏览器。
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.AGENT_LOFT_PLAYWRIGHT || "playwright-core");
const repo = fileURLToPath(new URL("../", import.meta.url));

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

test("扫码连接微信、收发消息、断开", async (t) => {
  const reqs = [];
  const inbox = [];
  const qr = [{ status: "wait" }, { status: "scaned" }, { status: "need_verifycode" }, { status: "confirmed", bot_token: "tok-secret", ilink_bot_id: "b@im.bot", ilink_user_id: "me@im.wechat" }];
  let qrIdx = 0;
  const ilink = http.createServer((q, s) => {
    let b = "";
    q.on("data", (d) => (b += d));
    q.on("end", () => {
      const u = new URL(q.url, "http://x");
      reqs.push({ p: u.pathname, b: b && JSON.parse(b) });
      const j = (o) => s.end(JSON.stringify(o));
      if (u.pathname.endsWith("get_bot_qrcode")) return j({ qrcode: "q1", qrcode_img_content: "https://liteapp.weixin.qq.com/q/q1" });
      if (u.pathname.endsWith("get_qrcode_status")) {
        const st = qr[qrIdx];
        if (st.status === "need_verifycode") {
          const code = u.searchParams.get("verify_code");
          if (!code || code === "111") return j(st);
          qrIdx += 1;
          return j(qr[qrIdx]);
        }
        qrIdx += 1;
        return setTimeout(() => j(st), 300);
      }
      if (u.pathname.endsWith("getupdates")) return setTimeout(() => j({ ret: 0, msgs: inbox.splice(0), get_updates_buf: "b" }), 100);
      if (u.pathname.endsWith("sendmessage")) return j({ ret: 0, message_id: "1" });
      return j({ ret: 0, typing_ticket: "t" });
    });
  });
  await new Promise((r) => ilink.listen(0, "127.0.0.1", r));
  t.after(() => {
    ilink.closeAllConnections();
    ilink.close();
  });

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-wx-"));
  const port = await freePort();
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ workspaceRoot: home, agents: { claude: { enabled: true }, codex: { enabled: false } }, web: { enabled: true, port, host: "127.0.0.1" } }),
  );
  let log = "";
  const srv = spawn("node", ["--import", "tsx", "src/main.ts"], {
    cwd: repo,
    env: { ...process.env, AGENT_LOFT_HOME: home, AGENT_LOFT_ILINK_BASE_URL: `http://127.0.0.1:${ilink.address().port}` },
  });
  srv.stdout.on("data", (d) => (log += d));
  srv.stderr.on("data", (d) => (log += d));
  t.after(() => srv.kill("SIGKILL"));
  const wait = async (f, what, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await f();
      if (v) return v;
      if (Date.now() > end) assert.fail(`等不到 ${what}\n${log.slice(-1500)}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  const token = await wait(() => /设置码[^A-Za-z0-9]*([A-Za-z0-9_-]{4,})/.exec(log)?.[1] ?? /token[=: ]+([A-Za-z0-9_-]{6,})/i.exec(log)?.[1], "设置码");

  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ["--no-sandbox"],
  });
  t.after(() => browser.close());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const base = `http://127.0.0.1:${port}`;
  const setup = await ctx.request.post(`${base}/api/setup`, { data: { token, name: "admin", password: "password123" } });
  assert.ok(setup.ok(), await setup.text());
  const account = async () => (await ctx.request.get(`${base}/api/account/weixin`)).json();
  const sends = () => reqs.filter((r) => r.p.endsWith("sendmessage"));
  const openSettings = async () => {
    await page.goto(base);
    await page.waitForTimeout(1000);
    await page.evaluate(() => document.dispatchEvent(new CustomEvent("aim:open-settings", { detail: "账号" })));
    await page.locator(".settings-page").waitFor({ timeout: 8000 });
  };

  assert.equal((await account()).linked, false);
  await openSettings();
  await page.getByRole("button", { name: "扫码连接微信" }).click();
  await page.locator(".modal:has(.qr) .qr svg").waitFor({ timeout: 8000 });

  const code = page.getByPlaceholder("手机上显示的数字");
  await code.waitFor({ timeout: 15000 });
  await code.fill("111");
  await page.getByRole("button", { name: "确定" }).click();
  await page.getByText("数字不对").waitFor({ timeout: 10000 });
  await code.fill("222");
  await page.getByRole("button", { name: "确定" }).click();
  await page.locator(".modal:has(.qr)").waitFor({ state: "detached", timeout: 15000 });
  await page.getByText("已连接", { exact: true }).waitFor({ timeout: 10000 });

  const linked = await account();
  assert.equal(linked.linked, true);
  assert.ok(!JSON.stringify(linked).includes("tok-secret"), "接口不带 token");
  assert.equal((fs.statSync(path.join(home, "data", "weixin-accounts.json")).mode & 0o777).toString(8), "600");

  // /pwd 不会跑真 agent
  inbox.push({ message_id: "1", from_user_id: "me@im.wechat", message_type: 1, context_token: "c1", item_list: [{ type: 1, text_item: { text: "/pwd" } }] });
  await wait(() => sends().length === 1, "微信回复");
  const sent = sends()[0].b.msg;
  assert.equal(sent.context_token, "c1");
  assert.equal(sent.to_user_id, "me@im.wechat");
  assert.ok(sent.item_list[0].text_item.text.includes(path.basename(home)));
  inbox.push({ message_id: "2", from_user_id: "stranger@im.wechat", message_type: 1, context_token: "c2", item_list: [{ type: 1, text_item: { text: "/pwd" } }] });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(sends().length, 1, "陌生微信号被忽略");

  await page.goto(base);
  const row = page.locator('.conv-item[data-key^="weixin:"]');
  await row.waitFor({ timeout: 8000 });
  assert.equal((await row.locator(".title").innerText()).trim(), "微信");
  await row.click();
  await page.waitForTimeout(500);

  await openSettings();
  await page.getByRole("button", { name: "断开" }).click();
  await page.locator(".overlay").last().getByRole("button", { name: "断开" }).click();
  await page.getByRole("button", { name: "扫码连接微信" }).waitFor({ timeout: 8000 });
  assert.equal((await account()).linked, false);
  await new Promise((r) => setTimeout(r, 300));
  const count = reqs.length;
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(reqs.length - count <= 1, "断开后不再轮询");

  assert.deepEqual(errors, []);
  assert.ok(!log.includes("tok-secret"), "日志不带 token");
});
