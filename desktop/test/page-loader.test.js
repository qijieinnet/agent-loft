import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createPageLoader } from "../src/page-loader.js";

const url = "http://127.0.0.1:8800/";

function fixture(t, { canRetry } = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const wc = new EventEmitter();
  let destroyed = false;
  wc.isDestroyed = () => destroyed;
  wc.destroy = () => {
    destroyed = true;
    wc.emit("destroyed");
  };
  const loads = [];
  // Electron 会同时发 did-fail-load 并拒绝 loadURL 的 Promise。
  wc.loadURL = (target) => {
    loads.push(target);
    return Promise.reject(new Error("net::ERR_CONNECTION_REFUSED"));
  };
  let state = {};
  let ready = 0;
  const loader = createPageLoader(wc, {
    url, canRetry,
    onConnecting: () => { state = { connecting: true }; },
    onFailure: (error) => { state = { connecting: false, error }; },
    onLoaded: () => { state = { connecting: false }; ready++; },
  });
  t.after(() => wc.destroy());
  return {
    wc, loads, loader,
    state: () => state,
    ready: () => ready,
    fail: (code = -102, message = "net::ERR_CONNECTION_REFUSED", main = true, target = url) =>
      wc.emit("did-fail-load", {}, code, message, target, main),
    finish: () => wc.emit("did-finish-load"),
  };
}

test("cold startup stays connecting and loads successfully once the server is ready", (t) => {
  const f = fixture(t);
  f.loader.start();
  f.fail();
  f.finish(); // Chromium 错误页的加载完成不能被视为成功。
  assert.deepEqual(f.state(), { connecting: true });
  assert.equal(f.ready(), 0);
  t.mock.timers.tick(2000);
  assert.equal(f.loads.length, 2);
  f.fail();
  t.mock.timers.tick(2000);
  f.finish();
  assert.deepEqual(f.loads, [url, url, url]);
  assert.deepEqual(f.state(), { connecting: false });
  assert.equal(f.ready(), 1);
  t.mock.timers.tick(60_000);
  assert.equal(f.loads.length, 3);
});

test("persistent refusal shows an error only after the retry window is exhausted", (t) => {
  const f = fixture(t);
  f.loader.start();
  for (let i = 0; i < 30; i++) {
    f.fail();
    assert.deepEqual(f.state(), { connecting: true });
    t.mock.timers.tick(2000);
  }
  f.fail();
  assert.equal(f.loads.length, 31);
  assert.deepEqual(f.state(), { connecting: false, error: { code: -102, message: "net::ERR_CONNECTION_REFUSED" } });
  t.mock.timers.tick(60_000);
  assert.equal(f.loads.length, 31);
});

test("slow failures use elapsed time instead of extending the retry window", (t) => {
  const f = fixture(t);
  f.loader.start();
  t.mock.timers.tick(59_000);
  f.fail();
  t.mock.timers.tick(1000);
  assert.equal(f.loads.length, 2);
  f.fail();
  assert.equal(f.state().connecting, false);
  t.mock.timers.tick(60_000);
  assert.equal(f.loads.length, 2);
});

test("manual retry resets the budget and cancels the previous pending retry", (t) => {
  const f = fixture(t);
  f.loader.start();
  f.fail();
  t.mock.timers.tick(1000);
  f.loader.start();
  t.mock.timers.tick(1000);
  assert.equal(f.loads.length, 2);
  f.fail();
  t.mock.timers.tick(2000);
  assert.equal(f.loads.length, 3);
  f.finish();
  assert.equal(f.ready(), 1);

  // 失败页上的「重试」也重新获得完整的等待窗口。
  f.loader.start();
  t.mock.timers.tick(60_000);
  f.fail();
  assert.equal(f.state().connecting, false);
  f.loader.start();
  f.fail();
  assert.equal(f.state().connecting, true);
  t.mock.timers.tick(2000);
  f.finish();
  assert.equal(f.ready(), 2);
});

test("certificate and non-network errors fail immediately", (t) => {
  const f = fixture(t);
  for (const [code, message] of [[-202, "net::ERR_CERT_AUTHORITY_INVALID"], [-300, "net::ERR_INVALID_URL"]]) {
    f.loader.start();
    f.fail(code, message);
    assert.deepEqual(f.state(), { connecting: false, error: { code, message } });
  }
  t.mock.timers.tick(60_000);
  assert.equal(f.loads.length, 2);
});

test("gateway failures are not retried against the server homepage", (t) => {
  const f = fixture(t, { canRetry: (target) => new URL(target).origin === new URL(url).origin });
  f.loader.start();
  f.fail(-102, "net::ERR_CONNECTION_REFUSED", true, "https://login.example.com/");
  assert.equal(f.state().connecting, false);
  t.mock.timers.tick(60_000);
  assert.equal(f.loads.length, 1);
});

test("aborted navigation and subframe errors do not trigger retries", (t) => {
  const f = fixture(t);
  f.loader.start();
  f.fail(-3, "net::ERR_ABORTED");
  f.fail(-102, "net::ERR_CONNECTION_REFUSED", false);
  f.finish();
  assert.equal(f.ready(), 1);
  t.mock.timers.tick(60_000);
  assert.equal(f.loads.length, 1);
});

test("destroying the view cancels retries and prevents further state changes", (t) => {
  const f = fixture(t);
  f.loader.start();
  f.fail();
  f.wc.destroy();
  t.mock.timers.tick(60_000);
  f.loader.start();
  f.finish();
  assert.equal(f.loads.length, 1);
  assert.equal(f.ready(), 0);
});
