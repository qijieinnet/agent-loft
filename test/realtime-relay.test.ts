import { test } from "node:test";
import assert from "node:assert/strict";
import { RealtimeRelay } from "../src/core/realtime-relay.js";

test("语音中转：offer 里有 Opus 音频和 OpenAI 要的数据通道；关掉之后再推声音、再 accept 都不出错", async () => {
  const { relay, offer } = await RealtimeRelay.create();
  assert.match(offer, /m=audio .*\r?\n[\s\S]*a=rtpmap:\d+ opus\/48000\/2/i);
  assert.match(offer, /a=sendrecv/);
  assert.match(offer, /m=application .* webrtc-datachannel/);
  // 还没连上：凑帧编码照常、发不出去也不抛（不到一帧的留着，超过的按 20ms 切）
  relay.pushAudio(Buffer.alloc(960 * 3 + 100));
  relay.close();
  relay.pushAudio(Buffer.alloc(960));
  await assert.rejects(relay.accept("v=0\r\n"), /已挂断/);
});

test("语音中转：上行攒够 60ms 才开始发，之后按 20ms 一帧匀速发；断流后时间戳跟着真实时间跳；积压多了加速追", async () => {
  const { relay } = await RealtimeRelay.create();
  try {
    const r = relay as unknown as { pace(now: number): void; nextAt: number; ts: number; lastSentAt: number; paceTimer?: NodeJS.Timeout };
    // 节拍器换成手动拨：拿掉定时器，免得和手动的时间打架
    const frame = Buffer.alloc(960);
    relay.pushAudio(Buffer.concat([frame, frame]));
    clearInterval(r.paceTimer);
    assert.equal(relay.stats.txFrames, 0, "不到 60ms 不发");
    relay.pushAudio(frame);
    clearInterval(r.paceTimer);
    assert.equal(relay.stats.txFrames, 1, "攒够就先发一帧");
    const t0 = r.nextAt - 20;
    r.pace(t0 + 10);
    assert.equal(relay.stats.txFrames, 1, "没到点不发");
    r.pace(t0 + 40);
    assert.equal(relay.stats.txFrames, 3, "到点了按拍补发");
    r.pace(t0 + 60);
    assert.equal(relay.stats.txUnderruns, 1, "没货了算断流");
    // 断了 200ms 又来了：时间戳往前跳，不是接着上一帧
    const tsBefore = r.ts;
    r.lastSentAt -= 200;
    for (let i = 0; i < 3; i++) relay.pushAudio(frame);
    clearInterval(r.paceTimer);
    assert.ok(((r.ts - tsBefore) >>> 0) > 960 * 2, "时间戳跳过了中间没声音的那段");
    // 一下子涌来 20 帧：积压超过 10 帧时每拍发两帧
    relay.pushAudio(Buffer.alloc(960 * 20));
    clearInterval(r.paceTimer);
    const sent = relay.stats.txFrames;
    r.pace(r.nextAt);
    assert.equal(relay.stats.txFrames - sent, 2, "积压时一拍发两帧");
  } finally {
    relay.close();
  }
});
