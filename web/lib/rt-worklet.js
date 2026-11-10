// 语音对话的音频处理（AudioWorklet，跑在音频线程里）。声音经服务器中转：两头都是 24kHz、16 位、单声道的 PCM。
// rt-capture：麦克风 → 重采样到 24kHz → 每 20ms 一块 Int16 发给主线程（主线程走 WebSocket 发给服务器）
// rt-play：服务器发来的 Int16 24kHz → 攒一点缓冲 → 重采样到 AudioContext 的采样率放出来

const RATE = 24000;
const CHUNK = 480; // 20ms

class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / RATE; // 每出一个 24kHz 采样，输入前进多少
    this.pos = 0; // 下一个输出采样在输入里的位置（相对 prev 之后）
    this.prev = 0; // 上一块的最后一个采样，插值跨块用
    this.out = new Int16Array(CHUNK);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    // 多声道输入只取第一路就够（getUserMedia 一般是单声道）
    const len = input.length;
    // 位置 -1 对应 prev，0..len-1 对应 input
    while (this.pos < len) {
      const i = Math.floor(this.pos);
      const f = this.pos - i;
      const a = i < 0 ? this.prev : input[i];
      const b = i + 1 < len ? input[i + 1] : input[len - 1];
      let v = a + (b - a) * f;
      v = v < -1 ? -1 : v > 1 ? 1 : v;
      this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === CHUNK) {
        this.port.postMessage(this.out.buffer, [this.out.buffer]);
        this.out = new Int16Array(CHUNK);
        this.n = 0;
      }
      this.pos += this.step;
    }
    this.pos -= len;
    this.prev = input[len - 1];
    return true;
  }
}

class Play extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = RATE / sampleRate; // 每出一个输出采样，24kHz 的缓冲前进多少
    this.size = RATE * 4; // 环形缓冲最多 4 秒
    this.buf = new Float32Array(this.size);
    this.read = 0; // 读位置（小数）
    this.avail = 0; // 还没放的采样数
    this.write = 0;
    this.playing = false;
    this.port.onmessage = (e) => {
      if (e.data === "flush") {
        this.avail = 0;
        this.playing = false;
        return;
      }
      const pcm = new Int16Array(e.data);
      // 放不下（网络卡了一阵又一下子涌来）：丢掉最旧的，宁可跳一下也不越放越晚
      const over = this.avail + pcm.length - this.size;
      if (over > 0) {
        this.read = (this.read + over) % this.size;
        this.avail -= over;
      }
      for (let i = 0; i < pcm.length; i++) {
        this.buf[this.write] = pcm[i] / 0x8000;
        this.write = (this.write + 1) % this.size;
      }
      this.avail += pcm.length;
      // 太多了（超过 1 秒）说明延迟越积越大，追到只剩 0.2 秒
      if (this.avail > RATE) {
        const skip = this.avail - RATE / 5;
        this.read = (this.read + skip) % this.size;
        this.avail -= skip;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const ch = out[0];
    if (!ch) return true;
    // 先攒 60ms 再开始放，扛一点网络抖动；放空了就停下来重新攒
    if (!this.playing && this.avail >= RATE * 0.06) this.playing = true;
    for (let i = 0; i < ch.length; i++) {
      if (!this.playing || this.avail < 2) {
        ch[i] = 0;
        this.playing = false;
        continue;
      }
      const i0 = Math.floor(this.read);
      const f = this.read - i0;
      const a = this.buf[i0 % this.size];
      const b = this.buf[(i0 + 1) % this.size];
      ch[i] = a + (b - a) * f;
      const next = this.read + this.step;
      const used = Math.floor(next) - i0;
      this.avail -= used;
      this.read = next % this.size;
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch);
    return true;
  }
}

registerProcessor("rt-capture", Capture);
registerProcessor("rt-play", Play);
