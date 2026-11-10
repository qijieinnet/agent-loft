// AGENT_LOFT_PLAYWRIGHT / PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 可指定本地浏览器。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const { chromium } = await import(process.env.AGENT_LOFT_PLAYWRIGHT || "playwright-core");
const root = new URL("../", import.meta.url);
const styles = (await fs.readFile(new URL("web/index.html", root), "utf8")).match(/<link[^>]+rel="stylesheet"[^>]*>/g).join("\n");
const vendor = {
  "/vendor/marked.js": "node_modules/marked/lib/marked.esm.js",
  "/vendor/purify.js": "node_modules/dompurify/dist/purify.es.mjs",
  "/vendor/hljs.js": "node_modules/@highlightjs/cdn-assets/es/highlight.min.js",
  "/vendor/hljs-light.css": "node_modules/@highlightjs/cdn-assets/styles/github.min.css",
  "/vendor/hljs-dark.css": "node_modules/@highlightjs/cdn-assets/styles/github-dark.min.css",
};
const conv = { key: "web:1", channel: "web", channelId: "1", agent: "codex", title: "一起构建一个小工具", cwd: "/workspace", activeAt: 1, busy: false };

async function fixture(t, { width = 390, height = 844, colorScheme = "light", reducedMotion = "no-preference", desktop = false, audioSupported = true } = {}) {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}), args: ["--no-sandbox"] });
  t.after(() => browser.close());
  // Safari 走 AudioContext 直接播放，音频设备和服务端用可控桩替代，不创建真实通话。
  const page = await browser.newPage({ viewport: { width, height }, colorScheme, reducedMotion, userAgent: "Version/18.0 Safari/605.1.15", serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(({ desktop, audioSupported }) => {
    if (desktop) window.agentLoftDesktop = { setState() {}, setQuota() {}, onOpen() {}, notify() {} };
    window.WebSocket = class { readyState = 0; close() {} send() {} };
    window.audio = { mic: 0, out: 0, tracks: [], requests: [], sent: [], holdMic: false };
    const node = () => ({ connect() {}, disconnect() {} });
    window.AudioContext = class {
      state = "running";
      sampleRate = 24000;
      destination = node();
      audioWorklet = { addModule: async () => {} };
      analysers = 0;
      resume() { this.state = "running"; return Promise.resolve(); }
      suspend() { this.state = "suspended"; return Promise.resolve(); }
      createMediaStreamSource() { return node(); }
      createGain() { return { ...node(), gain: { value: 0 } }; }
      createAnalyser() {
        const input = this.analysers++ % 2 === 0;
        return { ...node(), getFloatTimeDomainData(buf) { buf.fill(input ? audio.mic : audio.out); } };
      }
    };
    window.AudioWorkletNode = class {
      port = { postMessage() {} };
      connect() {}
      disconnect() {}
    };
    HTMLMediaElement.prototype.play = async () => {};
    HTMLMediaElement.prototype.pause = () => {};
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => {
      if (audio.micError) throw new DOMException("Permission denied", "NotAllowedError");
      const track = { readyState: "live", muted: false, enabled: true, stopped: false, stop() { this.stopped = true; } };
      audio.tracks.push(track);
      const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
      if (audio.holdMic) return new Promise((resolve) => { audio.releaseMic = () => resolve(stream); });
      return stream;
    } });
    if (!audioSupported) window.AudioWorkletNode = undefined;
  }, { desktop, audioSupported });
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p.startsWith("/api/")) {
      let data = { ok: true };
      if (p === "/api/me") data = { authed: true, user: { id: "u1", role: "admin" } };
      if (p === "/api/bootstrap") data = { user: { id: "u1", role: "admin" }, agents: [{ id: "codex", enabled: true }], bots: [], pending: [], conversations: [conv], workspaceRoot: "/workspace", quotaEnabled: false, sidebar: { recent: { next: null }, dirs: [] } };
      if (p.endsWith("/history")) data = { info: conv, allowedAgents: ["codex"], messages: [], live: [], pending: [], seq: 0 };
      if (p.endsWith("/models")) data = { models: [] };
      return route.fulfill({ json: data });
    }
    if (p === "/") return route.fulfill({ contentType: "text/html", body: `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<div id="app"></div><script type="module">
      import { S, ui } from '/state.js'; import { boot } from '/views/layout.js';
      import * as voice from '/views/voice-call.js'; import { WS } from '/lib/ws.js';
      window.S = S; window.ui = ui; window.voice = voice;
      WS.request = async (msg) => { audio.requests.push(msg); if (audio.holdStart) await new Promise((resolve) => { audio.releaseStart = resolve; }); return {}; };
      WS.raw = (msg) => audio.sent.push(msg);
      await boot(); window.booted = true;
    </script>` });
    try { return route.fulfill({ contentType: p.endsWith(".css") ? "text/css" : "text/javascript", body: await fs.readFile(new URL(vendor[p] ?? `web${p}`, root), "utf8") }); }
    catch { return route.fulfill({ status: 404, body: "" }); }
  });
  await page.goto("https://voice.example.test/#web%3A1");
  await page.waitForFunction(() => window.booted && S.current === "web:1");
  return page;
}

async function start(page) {
  await page.getByRole("button", { name: "语音对话", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".call-status")?.textContent === "正在听");
}

async function fits(page) {
  assert.equal(await page.locator(".call-panel").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true, "通话界面无横向溢出");
  const box = await page.getByRole("button", { name: "结束语音对话" }).boundingBox();
  const { width, height } = page.viewportSize();
  assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= height, "挂断按钮可见");
}

for (const width of [390, 1280]) for (const colorScheme of ["light", "dark"]) test(`语音光球、字幕、静音、收起、重连和挂断（${width}px ${colorScheme}）`, async (t) => {
  const page = await fixture(t, { width, colorScheme });
  await start(page);
  const dialog = page.getByRole("dialog", { name: "Codex 语音对话", exact: true });
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await dialog.evaluate((el) => el.matches(":modal")), true, "沉浸界面使用原生模态焦点管理");
  await fits(page);
  if (process.env.AGENT_LOFT_UI_SCREENSHOTS) await page.screenshot({ path: `/tmp/voice-${colorScheme}-${width}.png` });
  await page.evaluate(() => { audio.out = 0.12; });
  await page.waitForFunction(() => document.querySelector(".call-status").textContent === "Codex 正在说");
  assert.ok(Number(await page.locator(".call-orb").evaluate((el) => el.style.getPropertyValue("--voice-scale"))) > 1.05, "光球响应实际音量");
  await page.evaluate(() => voice.onRealtimeEvent({ key: S.current, ev: { type: "transcript", role: "assistant", delta: "我们可以把这个想法做成一个小工具。" } }));
  assert.equal(await dialog.locator(".call-text").textContent(), "我们可以把这个想法做成一个小工具。");
  await page.getByRole("button", { name: "静音", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "取消静音" }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.evaluate(() => audio.tracks[0].enabled), false);
  await page.evaluate(() => { audio.out = 0; });
  await page.waitForFunction(() => document.querySelector(".call-status").textContent === "已静音");
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), false);
  await fits(page);
  assert.equal(await page.locator(".call-panel.compact .call-text").textContent(), "我们可以把这个想法做成一个小工具。");
  assert.equal(await page.evaluate(() => audio.tracks[0].stopped), false, "收起保持通话");
  // 输入框重绘后，收起的通话条仍会挂回新的输入框。
  await page.evaluate(async () => { const { renderComposer } = await import('/views/composer.js'); renderComposer(); });
  assert.equal(await page.locator(".call-panel.compact").count(), 1);
  await page.getByRole("button", { name: "展开通话" }).click();
  assert.equal(await dialog.isVisible(), true);
  await page.getByRole("button", { name: "取消静音" }).click();
  await page.evaluate(() => { S.busy = true; });
  await page.waitForFunction(() => document.querySelector(".call-status").textContent === "Codex 正在处理…");
  await page.getByRole("button", { name: "音色和语言" }).click();
  await fits(page);
  await page.getByRole("combobox", { name: "音色", exact: true }).selectOption("juniper");
  await page.waitForFunction(() => audio.requests.length === 2 && !document.querySelector(".call-panel.connecting"));
  assert.equal(await page.getByRole("combobox", { name: "音色", exact: true }).inputValue(), "juniper");
  assert.equal(await page.evaluate(() => audio.requests[1].voice), "juniper");
  assert.equal(await page.evaluate(() => audio.tracks[0].stopped), true, "切换音色释放旧麦克风");
  await page.evaluate(() => voice.onRealtimeEvent({ key: S.current, ev: { type: "transcript_done", role: "user", text: "字幕很长。".repeat(150) } }));
  await fits(page);
  await page.waitForFunction(() => { const el = document.querySelector(".call-caption"); return el.scrollHeight - el.clientHeight - el.scrollTop < 2; });
  if (process.env.AGENT_LOFT_UI_SCREENSHOTS) await page.screenshot({ path: `/tmp/voice-options-${colorScheme}-${width}.png` });
  await page.getByRole("button", { name: "结束语音对话" }).click();
  assert.equal(await page.locator(".call-panel").count(), 0);
  assert.equal(await page.evaluate(() => audio.tracks.every((t) => t.stopped)), true);
  assert.equal(await page.locator(".composer").isVisible(), true);
  assert.equal(await page.locator('.composer-row .send-btn:not([hidden])').evaluate((el) => el === document.activeElement), true);
});

test("连接时取消与快速重拨不会让旧麦克风或旧响应覆盖新通话", async (t) => {
  const page = await fixture(t);
  await page.evaluate(() => { audio.holdMic = true; });
  await page.getByRole("button", { name: "语音对话", exact: true }).click();
  await page.waitForFunction(() => audio.releaseMic);
  await page.getByRole("button", { name: "静音", exact: true }).click();
  await page.getByRole("button", { name: "结束语音对话" }).click();
  await page.evaluate(() => { audio.holdMic = false; });
  await start(page);
  await page.evaluate(() => audio.releaseMic());
  await page.waitForFunction(() => audio.tracks[0].stopped);
  assert.equal(await page.evaluate(() => audio.tracks[1].stopped), false);
  assert.equal(await page.locator(".call-panel").count(), 1);
  await page.getByRole("button", { name: "结束语音对话" }).click();
  await page.evaluate(() => { audio.holdStart = true; });
  await page.getByRole("button", { name: "语音对话", exact: true }).click();
  await page.waitForFunction(() => audio.releaseStart);
  await page.getByRole("button", { name: "结束语音对话" }).click();
  await page.evaluate(() => audio.releaseStart());
  assert.equal(await page.locator(".call-panel").count(), 0);
  assert.equal(await page.evaluate(() => audio.tracks.every((t) => t.stopped)), true);
  await page.evaluate(() => { audio.holdStart = false; audio.micError = true; });
  await page.getByRole("button", { name: "语音对话", exact: true }).click();
  await page.getByText("语音对话没能开始：没有麦克风权限，请在浏览器里允许使用麦克风", { exact: true }).waitFor();
  assert.equal(await page.locator(".call-panel").count(), 0);
});

test("手机横屏、窄屏与减少动态效果；断线和切换会话会结束通话", async (t) => {
  const page = await fixture(t, { width: 320, height: 700, reducedMotion: "reduce" });
  await start(page);
  assert.equal(await page.locator(".call-orb-surface").evaluate((el) => getComputedStyle(el).animationName), "none");
  await page.getByRole("button", { name: "收起通话" }).click();
  await fits(page);
  await page.getByRole("button", { name: "展开通话" }).click();
  await page.setViewportSize({ width: 844, height: 390 });
  await fits(page);
  await page.getByRole("button", { name: "音色和语言" }).click();
  await page.evaluate(() => voice.onRealtimeEvent({ key: S.current, ev: { type: "transcript_done", role: "user", text: "横屏长字幕。".repeat(100) } }));
  await fits(page);
  await page.evaluate(() => voice.onSocketLost());
  assert.equal(await page.locator(".call-panel").count(), 0);
  await start(page);
  await page.evaluate(() => { S.current = "web:2"; voice.syncCall(); });
  assert.equal(await page.locator(".call-panel").count(), 0);
  assert.equal(await page.evaluate(() => audio.tracks.every((t) => t.stopped)), true);
});

for (const width of [390, 1280]) test(`输入框末尾在通话、发送与停止之间切换（${width}px）`, async (t) => {
  const page = await fixture(t, { width });
  const call = page.getByRole("button", { name: "语音对话", exact: true });
  const send = page.locator(".send-btn:not(.call-btn)");
  const oneAction = async () => assert.equal(await page.locator('.composer-row .send-btn:visible').count(), 1);
  await oneAction();
  assert.equal(await call.isVisible(), true);
  const original = await call.boundingBox();
  await page.locator(".composer textarea").fill("你好 Codex");
  await oneAction();
  assert.equal(await call.isVisible(), false);
  assert.equal(await send.isEnabled(), true);
  const next = await send.boundingBox();
  assert.equal(next.x, original.x, "发送与通话占据相同位置");
  assert.equal(next.width, original.width);
  await send.click();
  await page.waitForFunction(() => ui.input.value === "" && !ui.callBtn.hidden);
  assert.equal(await page.evaluate(() => audio.requests.at(-1).t), "send");
  assert.equal(await page.evaluate(() => audio.requests.at(-1).text), "你好 Codex");
  assert.equal(await page.locator(".call-panel").count(), 0, "发送文字不触发语音通话");
  await page.locator(".composer textarea").fill("   \n  ");
  assert.equal(await call.isVisible(), true, "纯空白不作为草稿");
  await page.evaluate(async () => {
    S.uploads = [{ id: "f1", name: "demo.txt" }];
    (await import('/views/composer.js')).renderChips();
  });
  assert.equal(await call.isVisible(), false, "只有附件也切到发送");
  assert.equal(await send.isEnabled(), true);
  await page.locator(".chip button").click();
  assert.equal(await call.isVisible(), true);
  await page.evaluate(async () => (await import('/views/composer.js')).setBusy(true));
  await oneAction();
  assert.equal(await send.getAttribute("title"), "停止");
  assert.equal(await send.isEnabled(), true);
  await page.locator(".composer textarea").fill("追加消息");
  assert.equal(await send.getAttribute("title"), "发送", "生成期间仍可发送追加消息");
  await page.locator(".composer textarea").fill("");
  await page.evaluate(async () => (await import('/views/composer.js')).setBusy(false));
  assert.equal(await call.isVisible(), true);
  await page.evaluate(async () => { S.sending = true; (await import('/views/composer.js')).updateSendBtn(); });
  assert.equal(await call.isVisible(), false);
  assert.equal(await send.locator(".send-spinner").count(), 1);
  assert.equal(await send.isDisabled(), true);
  await page.evaluate(async () => { S.sending = false; S.editingMessage = S.current; (await import('/views/composer.js')).updateSendBtn(); });
  assert.equal(await call.isVisible(), false);
  assert.equal(await send.getAttribute("title"), "正在恢复消息…");
  await page.evaluate(async () => { S.editingMessage = null; (await import('/views/composer.js')).updateSendBtn(); });
  assert.equal(await call.isVisible(), true);
  await page.evaluate(() => { S.convs.get(S.current).agent = "claude"; voice.syncCall(); });
  await oneAction();
  assert.equal(await call.isVisible(), false, "非 Codex 会话保留发送逻辑");
  assert.equal(await send.isDisabled(), true);
  await page.evaluate(() => { S.convs.get(S.current).agent = "codex"; voice.syncCall(); });
  assert.equal(await call.isVisible(), true, "换回 Codex 恢复语音入口");
});

for (const mode of ["desktop", "unsupported"]) test(`${mode}：不支持通话时保留原来的发送与停止逻辑`, async (t) => {
  const page = await fixture(t, { desktop: mode === "desktop", audioSupported: mode !== "unsupported" });
  const send = page.locator(".send-btn:not(.call-btn)");
  assert.equal(await page.locator(".call-btn").isVisible(), false);
  assert.equal(await send.isVisible(), true);
  assert.equal(await send.isDisabled(), true);
  await page.locator(".composer textarea").fill("消息");
  assert.equal(await send.isEnabled(), true);
  await page.locator(".composer textarea").fill("");
  await page.evaluate(async () => (await import('/views/composer.js')).setBusy(true));
  assert.equal(await send.getAttribute("title"), "停止");
  assert.equal(await send.isEnabled(), true);
  assert.equal(await page.locator(".call-btn").isVisible(), false);
});
