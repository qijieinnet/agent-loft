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
