// 语音对话的音频处理（AudioWorklet，跑在音频线程里）。声音经服务器中转：两头都是 24kHz、16 位、单声道的 PCM。
// rt-capture：麦克风 → 重采样到 24kHz → 每 20ms 一块 Int16 发给主线程（主线程走 WebSocket 发给服务器）
// rt-play：服务器发来的 Int16 24kHz → 攒一点缓冲 → 重采样到 AudioContext 的采样率放出来
//   放空之后很快（JB_JITTER_SEC 内）又来了声音 = 说到一半网络抖了：把缓冲加长一点；隔得久的是正常停顿，不算。
//   一阵子没再放空就慢慢缩回去；攒得比目标多太多（卡了一阵又一下子涌来）就跳回目标，免得越放越晚

const RATE = 24000;
const CHUNK = 480; // 20ms
/** 播放缓冲（24kHz 采样数）：起步、最短、最长、每次放空加多少 */
const JB_START = RATE * 0.1;
const JB_MIN = RATE * 0.06;
const JB_MAX = RATE * 0.4;
const JB_STEP = RATE * 0.06;
/** 这么久（秒）没放空，缓冲缩短 20ms */
const JB_DECAY_SEC = 8;
/** 放空后这么久（秒）内又来了声音，算网络抖动 */
const JB_JITTER_SEC = 0.3;
/** 比目标多出这么多就跳回目标 */
const JB_SLACK = RATE * 0.3;
/** 没攒够目标、但这么久（秒）没再来声音：先放掉（很短的一句别卡在缓冲里） */
const JB_FLUSH_SEC = 0.1;

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
    this.target = JB_START;
    /** 上次放空 / 缩短缓冲以来放了多少个输出采样 */
    this.smooth = 0;
    /** 说着说着放空的时刻（currentFrame），等下一块声音来了判断是抖动还是停顿 */
    this.starvedAt = -1;
    /** 最近一次收到声音的时刻（currentFrame） */
    this.lastData = 0;
    this.port.onmessage = (e) => {
      if (e.data === "flush") {
        this.avail = 0;
        this.playing = false;
        this.target = JB_START;
        this.starvedAt = -1;
        return;
      }
      const pcm = new Int16Array(e.data);
      this.lastData = currentFrame;
      if (this.starvedAt >= 0) {
        if (currentFrame - this.starvedAt < sampleRate * JB_JITTER_SEC) this.target = Math.min(JB_MAX, this.target + JB_STEP);
        this.starvedAt = -1;
      }
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
      // 太多了说明延迟越积越大，追回到目标
      if (this.avail > this.target + JB_SLACK) {
        const skip = this.avail - this.target;
        this.read = (this.read + skip) % this.size;
        this.avail -= skip;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const ch = out[0];
    if (!ch) return true;
    // 先攒够目标再开始放，扛网络抖动；放空了就停下来重新攒，下次多攒一点
    if (!this.playing && this.avail >= 2 && (this.avail >= this.target || currentFrame - this.lastData > sampleRate * JB_FLUSH_SEC)) {
      this.playing = true;
      this.smooth = 0;
    }
    for (let i = 0; i < ch.length; i++) {
      if (!this.playing || this.avail < 2) {
        if (this.playing) this.starvedAt = currentFrame + i;
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
    if (this.playing && (this.smooth += ch.length) > sampleRate * JB_DECAY_SEC) {
      this.smooth = 0;
      this.target = Math.max(JB_MIN, this.target - RATE * 0.02);
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch);
    return true;
  }
}

registerProcessor("rt-capture", Capture);
registerProcessor("rt-play", Play);
