// 语音对话的音频处理（AudioWorklet，跑在音频线程里）。声音经服务器中转：两头都是 24kHz、16 位、单声道的 PCM。
// rt-capture：麦克风 → 低通（防混叠）→ 重采样到 24kHz → 每 20ms 一块 Int16 发给主线程（主线程走 WebSocket 发给服务器）
// rt-play：服务器发来的 Int16 24kHz → 攒一点缓冲 → 重采样到 AudioContext 的采样率放出来
//   放空之后很快（JB_JITTER_SEC 内）又来了声音 = 说到一半网络抖了：把缓冲加长一点；隔得久的是正常停顿，不算。
//   一阵子没再放空就慢慢缩回去；攒得比目标多（卡了一阵又一下子涌来）就稍微放快一点追回来，
//   多得离谱才直接跳（跳会丢字，听起来就是断断续续）
//   每 STATS_SEC 秒把统计（放空几次、缓冲多长、跳过多少）报给主线程，挂断时带给服务器记日志

const RATE = 24000;
const CHUNK = 480; // 20ms
/** 播放缓冲（24kHz 采样数）：起步、最短、最长、每次放空加多少。手机走流量 / 隧道，起步给足一点 */
const JB_START = RATE * 0.18;
const JB_MIN = RATE * 0.1;
const JB_MAX = RATE * 0.6;
const JB_STEP = RATE * 0.08;
/** 这么久（秒）没放空，缓冲缩短 20ms */
const JB_DECAY_SEC = 8;
/** 放空后这么久（秒）内又来了声音，算网络抖动 */
const JB_JITTER_SEC = 0.3;
/** 比目标多出这么多就放快 JB_FAST 倍追（音调高一点点，听不太出来）；多出 JB_SLACK 才直接跳回目标 */
const JB_AHEAD = RATE * 0.15;
const JB_FAST = 1.06;
const JB_SLACK = RATE * 1.5;
const STATS_SEC = 2;
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
    // 降到 24kHz 之前先把 10.5kHz 以上滤掉（两节巴特沃斯二阶 = 四阶），不然高频折回来成了杂音，识别更差
    this.lp = sampleRate > RATE * 1.05 ? [biquadLowpass(10500, sampleRate, 0.5412), biquadLowpass(10500, sampleRate, 1.3066)] : null;
    this.tmp = new Float32Array(128);
  }

  process(inputs) {
    let input = inputs[0]?.[0];
    if (!input) return true;
    // 多声道输入只取第一路就够（getUserMedia 一般是单声道）
    if (this.lp) {
      if (this.tmp.length < input.length) this.tmp = new Float32Array(input.length);
      const x = this.tmp.subarray(0, input.length);
      x.set(input);
      for (const f of this.lp) f(x);
      input = x;
    }
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
    /** 统计：说着说着放空几次、其中算网络抖动的几次、直接跳过了多少采样 */
    this.stats = { starves: 0, jitter: 0, skipped: 0 };
    this.statsAt = 0;
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
        if (currentFrame - this.starvedAt < sampleRate * JB_JITTER_SEC) {
          this.target = Math.min(JB_MAX, this.target + JB_STEP);
          this.stats.jitter++;
        }
        this.starvedAt = -1;
      }
      // 放不下（网络卡了一阵又一下子涌来）：丢掉最旧的，宁可跳一下也不越放越晚
      const over = this.avail + pcm.length - this.size;
      if (over > 0) {
        this.read = (this.read + over) % this.size;
        this.avail -= over;
        this.stats.skipped += over;
      }
      for (let i = 0; i < pcm.length; i++) {
        this.buf[this.write] = pcm[i] / 0x8000;
        this.write = (this.write + 1) % this.size;
      }
      this.avail += pcm.length;
      // 多得离谱（卡了很久又一下子涌来）：直接跳回目标；多一点的在 process 里放快追
      if (this.avail > this.target + JB_SLACK) {
        const skip = this.avail - this.target;
        this.read = (this.read + skip) % this.size;
        this.avail -= skip;
        this.stats.skipped += skip;
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
    const step = this.avail > this.target + JB_AHEAD ? this.step * JB_FAST : this.step;
    for (let i = 0; i < ch.length; i++) {
      if (!this.playing || this.avail < 2) {
        if (this.playing) {
          this.starvedAt = currentFrame + i;
          this.stats.starves++;
        }
        ch[i] = 0;
        this.playing = false;
        continue;
      }
      const i0 = Math.floor(this.read);
      const f = this.read - i0;
      const a = this.buf[i0 % this.size];
      const b = this.buf[(i0 + 1) % this.size];
      ch[i] = a + (b - a) * f;
      const next = this.read + step;
      const used = Math.floor(next) - i0;
      this.avail -= used;
      this.read = next % this.size;
    }
    if (this.playing && (this.smooth += ch.length) > sampleRate * JB_DECAY_SEC) {
      this.smooth = 0;
      this.target = Math.max(JB_MIN, this.target - RATE * 0.02);
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch);
    if (currentFrame - this.statsAt > sampleRate * STATS_SEC) {
      this.statsAt = currentFrame;
      const { starves, jitter, skipped } = this.stats;
      this.port.postMessage({ starves, jitter, jbMs: (this.target / RATE) * 1000, skippedMs: (skipped / RATE) * 1000 });
    }
    return true;
  }
}

/** 二阶低通（RBJ biquad），返回一个就地处理 Float32Array 的函数，状态跨块保留 */
function biquadLowpass(freq, rate, q) {
  const w = (2 * Math.PI * freq) / rate;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0;
  const b1 = (1 - cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (buf) => {
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y < 1e-25 && y > -1e-25 ? 0 : y;
      buf[i] = y;
    }
  };
}

registerProcessor("rt-capture", Capture);
registerProcessor("rt-play", Play);
