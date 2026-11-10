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
/** 浏览器发过来的还没凑够一帧的、积压的上限（约 1 秒），再多说明来不及发，丢掉旧的 */
const MAX_PENDING = RELAY_RATE * 2;

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
  private dropTimer: NodeJS.Timeout | undefined;

  private constructor() {
    this.pc = new RTCPeerConnection({
      codecs: { audio: [new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2 })] },
    });
    const transceiver = this.pc.addTransceiver(this.track, { direction: "sendrecv" });
    transceiver.onTrack.subscribe((remote) => {
      remote.onReceiveRtp.subscribe((rtp) => {
        if (this.closed || !rtp.payload.length) return;
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

  /** 浏览器发来的麦克风 PCM：凑够 20ms 就编码发出去 */
  pushAudio(pcm: Buffer): void {
    if (this.closed || !pcm.length) return;
    this.pending = this.pending.length ? Buffer.concat([this.pending, pcm]) : Buffer.from(pcm);
    if (this.pending.length > MAX_PENDING) this.pending = this.pending.subarray(this.pending.length - MAX_PENDING);
    while (this.pending.length >= FRAME_BYTES) {
      const frame = this.pending.subarray(0, FRAME_BYTES);
      this.pending = this.pending.subarray(FRAME_BYTES);
      this.sendFrame(frame);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.dropTimer);
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
    try {
      this.track.writeRtp(new RtpPacket(header, Buffer.from(payload)));
    } catch {
      // 还没连上 / 已经关了
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
