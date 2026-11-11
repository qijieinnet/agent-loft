import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

/** 在假的 AudioWorkletGlobalScope 里加载 web/lib/rt-worklet.js，拿到两个处理器类 */
async function load(rate: number) {
  const code = await fs.readFile(new URL("../web/lib/rt-worklet.js", import.meta.url), "utf8");
  const procs: Record<string, new () => any> = {};
  const scope = {
    sampleRate: rate,
    currentFrame: 0,
    AudioWorkletProcessor: class {
      port = { postMessage: (_m: unknown) => {}, onmessage: null as null | ((e: { data: unknown }) => void) };
    },
    registerProcessor: (name: string, cls: new () => any) => (procs[name] = cls),
    Math,
    Float32Array,
    Int16Array,
  };
  vm.runInNewContext(code, scope);
  return { procs, scope };
}

test("语音采集：48kHz 降到 24kHz 前先低通，高频不会折回来变成杂音；正常人声频率保留", async () => {
  const { procs } = await load(48000);
  const rms = (freq: number) => {
    const cap = new procs["rt-capture"]!();
    const out: number[] = [];
    cap.port.postMessage = (buf: ArrayBuffer) => out.push(...new Int16Array(buf));
    for (let b = 0; b < 200; b++) {
      const input = new Float32Array(128);
      for (let i = 0; i < 128; i++) input[i] = 0.5 * Math.sin((2 * Math.PI * freq * (b * 128 + i)) / 48000);
      cap.process([[input]]);
    }
    const tail = out.slice(2400);
    return Math.sqrt(tail.reduce((s, v) => s + (v / 0x8000) ** 2, 0) / tail.length);
  };
  assert.ok(rms(1000) > 0.3, "1kHz 基本不衰减");
  assert.ok(rms(15000) < 0.05, "15kHz（会折回 9kHz）被滤掉");
});

test("语音播放：积压比目标多一点时放快追，不直接跳掉（跳会丢字）", async () => {
  const { procs, scope } = await load(24000);
  const play = new procs["rt-play"]!();
  const msgs: any[] = [];
  play.port.postMessage = (m: unknown) => msgs.push(m);
  // 一下子来了 600ms
  play.port.onmessage!({ data: new Int16Array(24000 * 0.6).fill(1000).buffer });
  const before = play.avail;
  const out = [new Float32Array(128)];
  for (let i = 0; i < 20; i++) {
    play.process([], [out]);
    scope.currentFrame += 128;
  }
  assert.ok(before - play.avail > 128 * 20, "放得比实时快");
  assert.equal(play.stats.skipped, 0, "没有跳");
  // 放空一次再很快来声音：算抖动，缓冲加长
  const target = play.target;
  for (let i = 0; i < 200 && play.playing; i++) {
    play.process([], [out]);
    scope.currentFrame += 128;
  }
  play.process([], [out]);
  scope.currentFrame += 128;
  play.port.onmessage!({ data: new Int16Array(480).buffer });
  assert.equal(play.stats.starves, 1);
  assert.ok(play.target > target);
  scope.currentFrame += 24000 * 3;
  play.process([], [out]);
  assert.ok(msgs.some((m) => typeof m?.starves === "number" && typeof m?.jbMs === "number"), "定时报统计");
});
