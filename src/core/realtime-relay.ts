/**
 * 实时语音的中转：服务器自己当 WebRTC 端点连 OpenAI，浏览器那头走现有的 WebSocket 收发 PCM。
 * 这样声音和网页走同一条路（反向代理、Cloudflare Tunnel 都能过），浏览器不用直连 OpenAI。
 *
 * 浏览器 ⇄ 这里：16 位小端、单声道、24kHz 的 PCM（每块多长都行）。
 * 这里 ⇄ OpenAI：Opus（RTP 时钟 48kHz，每包 20ms），加上 OpenAI 要求的 oai-events 数据通道。
 */
import OpusScript from "opusscript";
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, RtpHeader, RtpPacket } from "werift";

export const RELAY_RATE = 24000;
/** 20ms 一帧：24kHz 下 480 个采样；RTP 时间戳按 48kHz 走，一帧加 960 */
const FRAME = 480;
const FRAME_BYTES = FRAME * 2;
const RTP_STEP = 960;
/**
 * 上行（麦克风）按 20ms 的节拍匀速发给 OpenAI：浏览器经 WebSocket（TCP、过代理 / 隧道）送来的声音是一阵一阵的，
 * 来了就发，OpenAI 那头的抖动缓冲会把晚到的丢掉、把空档当成你说完了，识别断断续续。
 * 断流后攒够 PREBUFFER 再开始发；积压超过 CATCHUP 就每拍多发一帧追上；超过 MAX_PENDING 丢掉最旧的
 */
const PREBUFFER = FRAME_BYTES * 3;
const CATCHUP = FRAME_BYTES * 10;
const MAX_PENDING = FRAME_BYTES * 50;
const FRAME_MS = 20;
const PACE_MS = 10;
/**
 * 收的方向丢了几个包以内用 Opus 的丢包补偿填上（解码空包 = PLC，一次给 120ms，按丢的帧数截）。
 * 服务器到 OpenAI 这段常过代理，实测丢 2~3%：不填的话浏览器那头的缓冲每丢一包就少 20ms，过一阵就放空、一卡一卡
 */
const MAX_CONCEAL = 6;
/** libopus 的 CTL 编号 */
const OPUS_SET_INBAND_FEC = 4012;
const OPUS_SET_PACKET_LOSS_PERC = 4014;

/** 一通电话的传输统计（挂断时打到日志里，用来判断卡在哪一段） */
export interface RelayStats {
  /** 下行（OpenAI → 这里）收到的包、序号上看丢了的包、用丢包补偿填上的帧 */
  rxPackets: number;
  rxLost: number;
  rxConcealed: number;
  /** 上行（这里 → OpenAI）发出的帧、断流（浏览器没及时送来）次数、积压太多丢掉的帧 */
  txFrames: number;
  txUnderruns: number;
  txDropped: number;
}

export class RealtimeRelay {
  /** 收到 OpenAI 的声音（解码后的 PCM），交给浏览器 */
  onAudio: (pcm: Buffer) => void = () => {};
  /** 和 OpenAI 的连接断了（不是 close() 主动关的） */
  onFailed: (reason: string) => void = () => {};

  private readonly pc: RTCPeerConnection;
  private readonly track = new MediaStreamTrack({ kind: "audio" });
  private readonly encoder = new OpusScript(RELAY_RATE, 1, OpusScript.Application.VOIP);
  private readonly decoder = new OpusScript(RELAY_RATE, 1, OpusScript.Application.VOIP);
  private pending = Buffer.alloc(0);
  private seq = Math.floor(Math.random() * 0xffff);
  private ts = Math.floor(Math.random() * 0xffffffff);
  private closed = false;
  /** 收到的上一个 RTP 包的序号 */
  private lastSeq: number | undefined;
  private dropTimer: NodeJS.Timeout | undefined;
  private paceTimer: NodeJS.Timeout | undefined;
  /** 上行正在匀速发（断流后要重新攒够 PREBUFFER） */
  private sending = false;
  /** 下一帧该发的时刻、上一帧实际发出的时刻（performance.now） */
  private nextAt = 0;
  private lastSentAt = 0;
  readonly stats: RelayStats = { rxPackets: 0, rxLost: 0, rxConcealed: 0, txFrames: 0, txUnderruns: 0, txDropped: 0 };

  private constructor() {
    // 带内 FEC：下一个包里捎上前一个包的低码率副本，丢一个包 OpenAI 那头能补回来（服务器到 OpenAI 常过代理，会丢包）
    try {
      this.encoder.setBitrate(32000);
      this.encoder.encoderCTL(OPUS_SET_INBAND_FEC, 1);
      this.encoder.encoderCTL(OPUS_SET_PACKET_LOSS_PERC, 10);
    } catch {
      // 设不上就用默认的
    }
    this.pc = new RTCPeerConnection({
      codecs: { audio: [new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2 })] },
    });
    const transceiver = this.pc.addTransceiver(this.track, { direction: "sendrecv" });
    transceiver.onTrack.subscribe((remote) => {
      remote.onReceiveRtp.subscribe((rtp) => {
        if (this.closed || !rtp.payload.length) return;
        const seq = rtp.header.sequenceNumber;
        if (this.lastSeq !== undefined) {
          const gap = (seq - this.lastSeq) & 0xffff;
          // 重复的、迟到的（已经补过或跳过了）：丢掉，别打乱顺序
          if (gap === 0 || gap > 0x8000) return;
          if (gap > 1) {
            this.stats.rxLost += gap - 1;
            if (gap - 1 <= MAX_CONCEAL) this.conceal(gap - 1);
          }
        }
        this.lastSeq = seq;
        this.stats.rxPackets++;
        try {
          this.onAudio(Buffer.from(this.decoder.decode(rtp.payload)));
        } catch {
          // 坏包丢掉
        }
      });
    });
    // OpenAI 要求 offer 里有这个数据通道（事件我们走 Codex 的通知，用不上它）
    this.pc.createDataChannel("oai-events");
    this.pc.connectionStateChange.subscribe((state) => {
      if (this.closed) return;
      clearTimeout(this.dropTimer);
      if (state === "failed" || state === "closed") this.fail("和语音服务的连接断开了");
      // 网络抖一下会短暂 disconnected，几秒内没恢复才算断
      else if (state === "disconnected") this.dropTimer = setTimeout(() => this.fail("和语音服务的连接断开了"), 5000);
    });
  }

  /** 建好连接对象和 offer（ICE 候选收齐了写在里面），offer 交给 Codex 去 OpenAI 建通话 */
  static async create(): Promise<{ relay: RealtimeRelay; offer: string }> {
    const relay = new RealtimeRelay();
    await relay.pc.setLocalDescription(await relay.pc.createOffer());
    await relay.gathered(1500);
    const offer = relay.pc.localDescription?.sdp;
    if (!offer) {
      relay.close();
      throw new Error("没能建立语音连接");
    }
    return { relay, offer };
  }

  /** OpenAI 的 answer 回来了：连上 */
  async accept(answer: string): Promise<void> {
    if (this.closed) throw new Error("已挂断");
    await this.pc.setRemoteDescription({ type: "answer", sdp: answer });
  }

  /** 浏览器发来的麦克风 PCM：先攒着，由节拍器每 20ms 编码发一帧（见 PREBUFFER） */
  pushAudio(pcm: Buffer): void {
    if (this.closed || !pcm.length) return;
    this.pending = this.pending.length ? Buffer.concat([this.pending, pcm]) : Buffer.from(pcm);
    if (this.pending.length > MAX_PENDING) {
      const over = this.pending.length - MAX_PENDING;
      const frames = Math.ceil(over / FRAME_BYTES);
      this.stats.txDropped += frames;
      this.pending = this.pending.subarray(Math.min(this.pending.length, frames * FRAME_BYTES));
    }
    this.paceTimer ??= setInterval(() => this.pace(), PACE_MS);
    this.pace();
  }

  /** 节拍器：到点就发一帧；没货了算断流，等重新攒够再发 */
  private pace(now = performance.now()): void {
    if (this.closed) return;
    if (!this.sending) {
      if (this.pending.length < PREBUFFER) return;
      this.sending = true;
      // 断了一阵：时间戳跟着真实时间往前跳，OpenAI 那头当成中间没声音，而不是把后面的当迟到的扔掉
      if (this.lastSentAt) {
        const skipped = Math.round((now - this.lastSentAt) / FRAME_MS) - 1;
        if (skipped > 0) this.ts = (this.ts + skipped * RTP_STEP) >>> 0;
      }
      this.nextAt = now;
    }
    while (now >= this.nextAt) {
      if (this.pending.length < FRAME_BYTES) {
        this.sending = false;
        this.stats.txUnderruns++;
        return;
      }
      this.sendFrame(this.takeFrame());
      // 积压多了（浏览器卡了一阵又一下子涌来）：这一拍多发一帧，慢慢追回来
      if (this.pending.length > CATCHUP) this.sendFrame(this.takeFrame());
      this.lastSentAt = now;
      this.nextAt += FRAME_MS;
    }
  }

  private takeFrame(): Buffer {
    const frame = this.pending.subarray(0, FRAME_BYTES);
    this.pending = this.pending.subarray(FRAME_BYTES);
    return frame;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.dropTimer);
    clearInterval(this.paceTimer);
    this.pending = Buffer.alloc(0);
    void this.pc.close().catch(() => {});
    for (const codec of [this.encoder, this.decoder]) {
      try {
        codec.delete();
      } catch {
        // 已经释放
      }
    }
  }

  private sendFrame(frame: Buffer): void {
    let payload: Buffer;
    try {
      payload = this.encoder.encode(frame, FRAME);
    } catch {
      return;
    }
    const header = new RtpHeader({ sequenceNumber: this.seq, timestamp: this.ts, marker: false, payloadType: 111 });
    this.seq = (this.seq + 1) & 0xffff;
    this.ts = (this.ts + RTP_STEP) >>> 0;
    this.stats.txFrames++;
    try {
      this.track.writeRtp(new RtpPacket(header, Buffer.from(payload)));
    } catch {
      // 还没连上 / 已经关了
    }
  }

  /** 丢了 frames 个 20ms 的包：用解码器的丢包补偿顶上同样长的声音 */
  private conceal(frames: number): void {
    try {
      const pcm = this.decoder.decode(Buffer.alloc(0));
      this.onAudio(Buffer.from(pcm.subarray(0, Math.min(pcm.length, frames * FRAME_BYTES))));
      this.stats.rxConcealed += frames;
    } catch {
      // 补不了就算了
    }
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.close();
    this.onFailed(reason);
  }

  private gathered(ms: number): Promise<void> {
    if (this.pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const sub = this.pc.iceGatheringStateChange.subscribe((state) => state === "complete" && done());
      function done(): void {
        clearTimeout(timer);
        sub.unSubscribe();
        resolve();
      }
    });
  }
}
