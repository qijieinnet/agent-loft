// 远程桌面转码：服务端自己当 VNC 客户端连上桌面，把画面缩小、压成 JPEG 再给页面（noVNC）。
//
// 为什么要：macOS 屏幕共享只给 ZRLE（无损）和原始像素，不给 JPEG；5K 屏一整屏 ZRLE 有十几 MB，
// 隔着公网又卡又费流量，noVNC 的「画质」参数对它也不起作用。这里的做法：
//   - 和 VNC 服务之间收全分辨率的画面，存成内存里的一份「原画」。VNC 服务在本机时要原始像素（本机不怕大，
//     macOS 出原始像素比出 ZRLE 快几倍：5K 屏约 1 秒一帧，ZRLE 要 4 秒）；在别的机器上时要 ZRLE；
//   - macOS 每次都把整屏发过来（哪怕只变了一点）：和原画逐格比，真变了的格子才更新原画、
//     按面积平均缩到「输出画面」上，并记下输出画面上哪些格子脏了；
//   - 页面要画面（FramebufferUpdateRequest）时，把脏的格子拼成几个矩形，用 sharp 压成 JPEG，按 Tight 编码发过去；
//   - 页面发来的鼠标坐标按比例放大回原画的坐标，键盘、剪贴板原样转发。
// 对页面来说就是一个分辨率小一些、只用 Tight JPEG 的 VNC 服务（认证由 vnc-auth.ts 在服务端做完）。
//
// 流量控制：页面画完一帧才会要下一帧，WebSocket 积压多了也先不发；和 VNC 服务之间每帧最少隔 FRAME_MS。
import zlib from "node:zlib";
import { ByteReader, serveNoAuth, vncLogin, type VncCreds } from "./vnc-auth.js";

/** 画质档位：长边缩到多少像素、JPEG 质量 */
export const DESKTOP_QUALITIES = {
  smooth: { edge: 1280, jpeg: 50 },
  standard: { edge: 1920, jpeg: 70 },
  high: { edge: 2560, jpeg: 82 },
} as const;
export type DesktopQuality = keyof typeof DESKTOP_QUALITIES;

export function isDesktopQuality(q: unknown): q is DesktopQuality {
  return typeof q === "string" && Object.hasOwn(DESKTOP_QUALITIES, q);
}

const ENC_RAW = 0;
const ENC_COPYRECT = 1;
const ENC_TIGHT = 7;
const ENC_ZRLE = 16;
const ENC_DESKTOP_SIZE = -223;
const ENC_CURSOR = -239;

/** 脏格子的边长（输出画面上的像素） */
const TILE = 64;
/** 拼出来的矩形最高这么多格：一个 JPEG 别太大（Tight 的长度字段最多 4MB） */
const MAX_RECT_TILES = 8;
/** 和 VNC 服务之间每帧最少隔多久（毫秒）：解码、缩放都在主线程上，别占满 CPU */
const FRAME_MS = 40;
/** 页面收得慢：WebSocket 里积压到这么多就先不发 */
const HIGH_WATER = 2 * 1024 * 1024;

type Rect = { x: number; y: number; w: number; h: number };

/** 原画和缩小后的输出画面（都是每像素 4 字节 R G B X），外加输出画面上的脏格子 */
export class Frame {
  srcW = 0;
  srcH = 0;
  outW = 0;
  outH = 0;
  src = Buffer.alloc(0);
  out = new Uint8Array(0);
  /** 每个输出像素对应原画的哪一段：[x0[i], x1[i]) */
  private x0 = new Int32Array(0);
  private x1 = new Int32Array(0);
  private y0 = new Int32Array(0);
  private y1 = new Int32Array(0);
  private tilesX = 0;
  private tilesY = 0;
  private dirty = new Uint8Array(0);
  private dirtyCount = 0;

  constructor(
    srcW: number,
    srcH: number,
    private readonly edge: number,
  ) {
    this.resize(srcW, srcH);
  }

  resize(srcW: number, srcH: number): void {
    const k = Math.min(1, this.edge / Math.max(srcW, srcH, 1));
    this.srcW = srcW;
    this.srcH = srcH;
    this.outW = Math.max(1, Math.round(srcW * k));
    this.outH = Math.max(1, Math.round(srcH * k));
    this.src = Buffer.alloc(srcW * srcH * 4);
    // 不用缩：输出画面就是原画
    this.out = this.scaled ? new Uint8Array(this.outW * this.outH * 4) : this.src;
    const ranges = (outN: number, srcN: number) => {
      const lo = new Int32Array(outN);
      const hi = new Int32Array(outN);
      for (let i = 0; i < outN; i++) {
        lo[i] = Math.floor((i * srcN) / outN);
        hi[i] = Math.max(lo[i]! + 1, Math.min(srcN, Math.floor(((i + 1) * srcN) / outN)));
      }
      return [lo, hi] as const;
    };
    [this.x0, this.x1] = ranges(this.outW, srcW);
    [this.y0, this.y1] = ranges(this.outH, srcH);
    this.tilesX = Math.ceil(this.outW / TILE);
    this.tilesY = Math.ceil(this.outH / TILE);
    this.dirty = new Uint8Array(this.tilesX * this.tilesY);
    this.dirtyCount = 0;
    this.markOut(0, 0, this.outW, this.outH);
  }

  get scaled(): boolean {
    return this.outW !== this.srcW || this.outH !== this.srcH;
  }

  get hasDirty(): boolean {
    return this.dirtyCount > 0;
  }

  /** 原画上比较变化用的格子边长：对应输出画面上一个脏格子 */
  private get cell(): number {
    return Math.max(TILE, Math.ceil((TILE * this.srcW) / this.outW));
  }

  /**
   * VNC 服务发来原画上 (x, y, w, h) 这块的新像素（紧凑的 R G B X）：逐格和原画比，变了的才写进去、记脏。
   * 返回变了的格子数
   */
  update(x: number, y: number, w: number, h: number, data: Buffer): number {
    const cell = this.cell;
    const stride = this.srcW * 4;
    let changed = 0;
    for (let cy = y; cy < y + h; cy += cell) {
      const ch = Math.min(cell, y + h - cy);
      for (let cx = x; cx < x + w; cx += cell) {
        const cw = Math.min(cell, x + w - cx);
        const bytes = cw * 4;
        let differs = false;
        for (let row = 0; row < ch && !differs; row++) {
          const from = ((cy - y + row) * w + (cx - x)) * 4;
          const to = (cy + row) * stride + cx * 4;
          differs = data.compare(this.src, to, to + bytes, from, from + bytes) !== 0;
        }
        if (!differs) continue;
        for (let row = 0; row < ch; row++) {
          const from = ((cy - y + row) * w + (cx - x)) * 4;
          data.copy(this.src, (cy + row) * stride + cx * 4, from, from + bytes);
        }
        this.damage(cx, cy, cw, ch);
        changed++;
      }
    }
    return changed;
  }

  /** 原画上这块变了：缩到输出画面上，记脏 */
  damage(x: number, y: number, w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    const ox0 = Math.max(0, Math.floor((x * this.outW) / this.srcW));
    const oy0 = Math.max(0, Math.floor((y * this.outH) / this.srcH));
    const ox1 = Math.min(this.outW, Math.ceil(((x + w) * this.outW) / this.srcW));
    const oy1 = Math.min(this.outH, Math.ceil(((y + h) * this.outH) / this.srcH));
    if (this.scaled) this.downscale(ox0, oy0, ox1, oy1);
    this.markOut(ox0, oy0, ox1 - ox0, oy1 - oy0);
  }

  /** 输出画面上这块要重发（页面要整屏时） */
  markOut(x: number, y: number, w: number, h: number): void {
    const tx1 = Math.min(this.tilesX, Math.ceil((x + w) / TILE));
    const ty1 = Math.min(this.tilesY, Math.ceil((y + h) / TILE));
    for (let ty = Math.max(0, Math.floor(y / TILE)); ty < ty1; ty++) {
      for (let tx = Math.max(0, Math.floor(x / TILE)); tx < tx1; tx++) {
        const i = ty * this.tilesX + tx;
        if (!this.dirty[i]) {
          this.dirty[i] = 1;
          this.dirtyCount++;
        }
      }
    }
  }

  /** 按面积平均：每个输出像素取它盖住的那几个原画像素的平均 */
  private downscale(ox0: number, oy0: number, ox1: number, oy1: number): void {
    const { src, out, srcW, outW, x0, x1, y0, y1 } = this;
    for (let oy = oy0; oy < oy1; oy++) {
      const sy0 = y0[oy]!;
      const sy1 = y1[oy]!;
      let o = (oy * outW + ox0) * 4;
      for (let ox = ox0; ox < ox1; ox++, o += 4) {
        const sx0 = x0[ox]!;
        const sx1 = x1[ox]!;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          let i = (sy * srcW + sx0) * 4;
          for (let sx = sx0; sx < sx1; sx++, i += 4) {
            r += src[i]!;
            g += src[i + 1]!;
            b += src[i + 2]!;
          }
        }
        const n = (sx1 - sx0) * (sy1 - sy0);
        out[o] = (r / n + 0.5) | 0;
        out[o + 1] = (g / n + 0.5) | 0;
        out[o + 2] = (b / n + 0.5) | 0;
      }
    }
  }

  /** 把脏格子拼成矩形（横着连成一段，上下段一样宽的再并起来），清掉脏标记 */
  takeDirty(): Rect[] {
    if (!this.dirtyCount) return [];
    const done: Rect[] = [];
    /** 上一行的段：key 是 "起始格,结束格"，还能往下接 */
    let open = new Map<string, { tx0: number; tx1: number; ty0: number; ty1: number }>();
    const close = (s: { tx0: number; tx1: number; ty0: number; ty1: number }) => {
      const x = s.tx0 * TILE;
      const y = s.ty0 * TILE;
      done.push({ x, y, w: Math.min(this.outW, s.tx1 * TILE) - x, h: Math.min(this.outH, s.ty1 * TILE) - y });
    };
    for (let ty = 0; ty < this.tilesY; ty++) {
      const next = new Map<string, { tx0: number; tx1: number; ty0: number; ty1: number }>();
      for (let tx = 0; tx < this.tilesX; ) {
        if (!this.dirty[ty * this.tilesX + tx]) {
          tx++;
          continue;
        }
        const tx0 = tx;
        while (tx < this.tilesX && this.dirty[ty * this.tilesX + tx]) tx++;
        const key = `${tx0},${tx}`;
        const prev = open.get(key);
        if (prev && prev.ty1 - prev.ty0 < MAX_RECT_TILES) {
          prev.ty1 = ty + 1;
          open.delete(key);
          next.set(key, prev);
        } else next.set(key, { tx0, tx1: tx, ty0: ty, ty1: ty + 1 });
      }
      for (const s of open.values()) close(s);
      open = next;
    }
    for (const s of open.values()) close(s);
    this.dirty.fill(0);
    this.dirtyCount = 0;
    return done;
  }

  /** 输出画面上一块，拷成紧凑的 RGBX（给 sharp） */
  region(r: Rect): Buffer {
    const buf = Buffer.allocUnsafe(r.w * r.h * 4);
    for (let row = 0; row < r.h; row++) {
      const start = ((r.y + row) * this.outW + r.x) * 4;
      buf.set(this.out.subarray(start, start + r.w * 4), row * r.w * 4);
    }
    return buf;
  }

  /** 输出画面的坐标 → 原画的坐标（鼠标） */
  toSrc(x: number, y: number): [number, number] {
    const sx = Math.floor(((x + 0.5) * this.srcW) / this.outW);
    const sy = Math.floor(((y + 0.5) * this.srcH) / this.outH);
    return [Math.min(this.srcW - 1, Math.max(0, sx)), Math.min(this.srcH - 1, Math.max(0, sy))];
  }
}

// ---------- ZRLE ----------

/** ZRLE 整条连接共用一个 zlib 流，每个矩形的数据都以 sync flush 结尾 */
class Inflater {
  private z = zlib.createInflate();
  private chunks: Buffer[] = [];
  private error: Error | null = null;

  constructor() {
    this.z.on("data", (d: Buffer) => this.chunks.push(d));
    this.z.on("error", (e) => (this.error = e));
  }

  inflate(data: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.z.write(data);
      this.z.flush(zlib.constants.Z_SYNC_FLUSH, () => {
        if (this.error) return reject(this.error);
        let c: Buffer | null;
        while ((c = this.z.read() as Buffer | null) !== null) this.chunks.push(c);
        const out = Buffer.concat(this.chunks);
        this.chunks = [];
        resolve(out);
      });
    });
  }

  close(): void {
    this.z.destroy();
  }
}

/** 解一个 w×h 的 ZRLE 矩形到 fb（紧凑的 R G B X）。像素格式是我们定的 32 位，CPIXEL 是前 3 个字节 */
export function decodeZrle(d: Buffer, fb: Uint8Array, w: number, h: number): void {
  const W = w;
  const x = 0;
  const y = 0;
  let p = 0;
  const palette = new Uint8Array(128 * 3);
  const runLength = () => {
    let n = 1;
    let b: number;
    do {
      b = d[p++]!;
      n += b;
    } while (b === 255);
    return n;
  };
  for (let ty = y; ty < y + h; ty += 64) {
    const th = Math.min(64, y + h - ty);
    for (let tx = x; tx < x + w; tx += 64) {
      const tw = Math.min(64, x + w - tx);
      const sub = d[p++]!;
      if (sub === 0) {
        for (let j = 0; j < th; j++) {
          let i = ((ty + j) * W + tx) * 4;
          for (let k = 0; k < tw; k++, i += 4, p += 3) {
            fb[i] = d[p]!;
            fb[i + 1] = d[p + 1]!;
            fb[i + 2] = d[p + 2]!;
          }
        }
      } else if (sub === 1) {
        const r = d[p]!;
        const g = d[p + 1]!;
        const b = d[p + 2]!;
        p += 3;
        for (let j = 0; j < th; j++) {
          let i = ((ty + j) * W + tx) * 4;
          for (let k = 0; k < tw; k++, i += 4) {
            fb[i] = r;
            fb[i + 1] = g;
            fb[i + 2] = b;
          }
        }
      } else if (sub <= 16) {
        // 调色板 + 每像素 1 / 2 / 4 位的索引，每行补齐到整字节，高位在前
        for (let c = 0; c < sub * 3; c++) palette[c] = d[p++]!;
        const bits = sub === 2 ? 1 : sub <= 4 ? 2 : 4;
        const mask = (1 << bits) - 1;
        for (let j = 0; j < th; j++) {
          let i = ((ty + j) * W + tx) * 4;
          let byte = 0;
          let left = 0;
          for (let k = 0; k < tw; k++, i += 4) {
            if (left === 0) {
              byte = d[p++]!;
              left = 8;
            }
            left -= bits;
            const c = ((byte >> left) & mask) * 3;
            fb[i] = palette[c]!;
            fb[i + 1] = palette[c + 1]!;
            fb[i + 2] = palette[c + 2]!;
          }
        }
      } else if (sub === 128 || sub >= 130) {
        // 游程：128 是颜色 + 长度；130 以上是调色板索引（高位为 1 时后面跟长度）
        const paletted = sub >= 130;
        if (paletted) for (let c = 0; c < (sub - 128) * 3; c++) palette[c] = d[p++]!;
        const total = tw * th;
        let n = 0;
        while (n < total) {
          let r: number;
          let g: number;
          let b: number;
          let run = 1;
          if (paletted) {
            const v = d[p++]!;
            const c = (v & 127) * 3;
            r = palette[c]!;
            g = palette[c + 1]!;
            b = palette[c + 2]!;
            if (v & 128) run = runLength();
          } else {
            r = d[p]!;
            g = d[p + 1]!;
            b = d[p + 2]!;
            p += 3;
            run = runLength();
          }
          const end = Math.min(total, n + run);
          for (; n < end; n++) {
            const i = ((ty + ((n / tw) | 0)) * W + tx + (n % tw)) * 4;
            fb[i] = r;
            fb[i + 1] = g;
            fb[i + 2] = b;
          }
        }
      } else throw new Error(`ZRLE 里有不认识的子编码 ${sub}`);
      if (p > d.length) throw new Error("ZRLE 数据不完整");
    }
  }
}

// ---------- 会话 ----------

export type Endpoint = { reader: ByteReader; write: (b: Buffer) => void };
export type TranscodeOptions = {
  vnc: Endpoint;
  /** backlog：已经交给页面、还没发出去的字节数（WebSocket 的 bufferedAmount） */
  page: Endpoint & { backlog: () => number };
  creds: VncCreds;
  quality: DesktopQuality;
  /** VNC 服务在本机：要原始像素（见文件开头） */
  local: boolean;
  /** 两头都握手完了（之后就是正常收发画面） */
  onReady?: () => void;
};

/** 「流畅」档和本机的 VNC 服务之间用 16 位色（RGB565）：少一半数据，macOS 出图快三成；缩小、压 JPEG 后看不出来 */
function pixelFormat16(): Buffer {
  const b = Buffer.alloc(16);
  b[0] = 16;
  b[1] = 16;
  b[3] = 1;
  b.writeUInt16BE(31, 4);
  b.writeUInt16BE(63, 6);
  b.writeUInt16BE(31, 8);
  b[10] = 11;
  b[11] = 5;
  b[12] = 0;
  return b;
}

/** RGB565（小端）→ R G B X */
function expand565(src: Buffer, out: Buffer, n: number): void {
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const v = src[i * 2]! | (src[i * 2 + 1]! << 8);
    const r = v >> 11;
    const g = (v >> 5) & 63;
    const b = v & 31;
    out[o] = (r << 3) | (r >> 2);
    out[o + 1] = (g << 2) | (g >> 4);
    out[o + 2] = (b << 3) | (b >> 2);
  }
}

/** 我们和页面都用的像素格式：32 位、24 位色深、小端、真彩色，R G B 依次在低到高的字节 */
function pixelFormat(): Buffer {
  const b = Buffer.alloc(16);
  b[0] = 32;
  b[1] = 24;
  b[2] = 0;
  b[3] = 1;
  b.writeUInt16BE(255, 4);
  b.writeUInt16BE(255, 6);
  b.writeUInt16BE(255, 8);
  b[10] = 0;
  b[11] = 8;
  b[12] = 16;
  return b;
}

function rectHeader(x: number, y: number, w: number, h: number, enc: number): Buffer {
  const b = Buffer.alloc(12);
  b.writeUInt16BE(x, 0);
  b.writeUInt16BE(y, 2);
  b.writeUInt16BE(w, 4);
  b.writeUInt16BE(h, 6);
  b.writeInt32BE(enc, 8);
  return b;
}

/** Tight 的长度：每字节 7 位，高位为 1 表示后面还有，最多 3 字节 */
function compactLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x4000) return Buffer.from([(n & 0x7f) | 0x80, n >> 7]);
  return Buffer.from([(n & 0x7f) | 0x80, ((n >> 7) & 0x7f) | 0x80, n >> 14]);
}

type Cursor = { hotX: number; hotY: number; w: number; h: number; pixels: Buffer; mask: Buffer };

/** 光标跟着画面一起缩（最小缩到 16 像素），最近邻 */
function scaleCursor(c: Cursor, k: number): Cursor {
  const s = Math.min(1, Math.max(k, 16 / Math.max(c.w, c.h, 1)));
  if (s >= 1) return c;
  const w = Math.max(1, Math.round(c.w * s));
  const h = Math.max(1, Math.round(c.h * s));
  const srcStride = Math.ceil(c.w / 8);
  const stride = Math.ceil(w / 8);
  const pixels = Buffer.alloc(w * h * 4);
  const mask = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(c.h - 1, Math.floor(y / s));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(c.w - 1, Math.floor(x / s));
      c.pixels.copy(pixels, (y * w + x) * 4, (sy * c.w + sx) * 4, (sy * c.w + sx) * 4 + 4);
      if (c.mask[sy * srcStride + (sx >> 3)]! & (0x80 >> (sx & 7))) mask[y * stride + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  return { hotX: Math.min(w - 1, Math.round(c.hotX * s)), hotY: Math.min(h - 1, Math.round(c.hotY * s)), w, h, pixels, mask };
}

type Sharp = (typeof import("sharp"))["default"];
let sharpLoad: Promise<Sharp> | null = null;
/** sharp 是原生模块：用到时才加载，装不上时只影响转码（调用方退回原样转发） */
export function loadSharp(): Promise<Sharp> {
  sharpLoad ??= import("sharp").then((m) => m.default);
  sharpLoad.catch(() => (sharpLoad = null));
  return sharpLoad;
}

/**
 * 跑一个转码会话，直到哪一头断开。认证失败时已经按 VNC 的认证失败告诉页面了，再抛出来。
 */
export async function transcode(opts: TranscodeOptions): Promise<void> {
  const { vnc, page, creds } = opts;
  const preset = DESKTOP_QUALITIES[opts.quality];
  const sharp = await loadSharp();

  // 先和 VNC 服务登录、拿到画面大小；同时对页面走完不用认证的握手
  const login = (async () => {
    await vncLogin(vnc.reader, vnc.write, creds);
    // ClientInit：共享（别把别人踢下线）
    vnc.write(Buffer.from([1]));
    const init = await vnc.reader.read(24);
    const name = await vnc.reader.read(init.readUInt32BE(20));
    return { w: init.readUInt16BE(0), h: init.readUInt16BE(2), name };
  })();
  login.catch(() => {});
  await serveNoAuth(
    page.reader,
    page.write,
    login.then(() => {}),
  );
  const server = await login;
  const frame = new Frame(server.w, server.h, preset.edge);

  // 我们这头要的格式和编码
  const bpp = opts.local && opts.quality === "smooth" ? 2 : 4;
  vnc.write(Buffer.concat([Buffer.from([0, 0, 0, 0]), bpp === 2 ? pixelFormat16() : pixelFormat()]));
  // 光标形状按我们的像素格式发：16 位时不要（noVNC 会画一个小圆点）
  const encs = [
    ...(opts.local ? [ENC_RAW, ENC_COPYRECT] : [ENC_ZRLE, ENC_COPYRECT, ENC_RAW]),
    ENC_DESKTOP_SIZE,
    ...(bpp === 4 ? [ENC_CURSOR] : []),
  ];
  const se = Buffer.alloc(4 + encs.length * 4);
  se[0] = 2;
  se.writeUInt16BE(encs.length, 2);
  encs.forEach((e, i) => se.writeInt32BE(e, 4 + i * 4));
  vnc.write(se);

  // 页面的 ClientInit，回 ServerInit（缩小后的大小）
  await page.reader.read(1);
  const nameLen = Buffer.alloc(4);
  nameLen.writeUInt32BE(server.name.length);
  page.write(Buffer.concat([Buffer.from([frame.outW >> 8, frame.outW & 255, frame.outH >> 8, frame.outH & 255]), pixelFormat(), nameLen, server.name]));
  opts.onReady?.();

  // ---------- 状态 ----------
  let closed = false;
  /** 页面支持什么 */
  const pageEnc = { tight: false, cursor: false, desktopSize: false };
  /** 页面的像素格式和我们的一样（光标像素要按它的格式发） */
  let pageFormatOk = true;
  /** 页面在等下一帧 */
  let wanted = false;
  let sending = false;
  let sizeChanged = false;
  let cursor: Cursor | null = null;
  let cursorChanged = false;
  /** VNC 服务的第一帧到了：之前原画还是全黑，别发 */
  let gotFirst = false;

  const pump = (): void => {
    if (closed || !wanted || sending) return;
    if (!pageEnc.tight || !gotFirst) return;
    if (page.backlog() > HIGH_WATER) {
      setTimeout(pump, 30);
      return;
    }
    const sendCursor = cursorChanged && cursor && pageEnc.cursor && pageFormatOk;
    if (!frame.hasDirty && !sizeChanged && !sendCursor) return;
    wanted = false;
    sending = true;
    const parts: Buffer[] = [];
    let count = 0;
    if (sizeChanged && pageEnc.desktopSize) {
      parts.push(rectHeader(0, 0, frame.outW, frame.outH, ENC_DESKTOP_SIZE));
      count++;
    }
    sizeChanged = false;
    if (sendCursor) {
      const c = scaleCursor(cursor!, frame.outW / frame.srcW);
      parts.push(rectHeader(c.hotX, c.hotY, c.w, c.h, ENC_CURSOR), c.pixels, c.mask);
      count++;
    }
    cursorChanged = false;
    // 先同步把要发的像素拷出来，压 JPEG 时画面再变也不影响这一帧
    const rects = frame.takeDirty().map((r) => ({ r, raw: frame.region(r) }));
    void Promise.all(
      rects.map(({ r, raw }) =>
        sharp(raw, { raw: { width: r.w, height: r.h, channels: 4 } })
          .removeAlpha()
          .jpeg({ quality: preset.jpeg })
          .toBuffer(),
      ),
    ).then(
      (jpegs) => {
        sending = false;
        if (closed) return;
        rects.forEach(({ r }, i) => {
          parts.push(rectHeader(r.x, r.y, r.w, r.h, ENC_TIGHT), Buffer.from([0x90]), compactLength(jpegs[i]!.length), jpegs[i]!);
        });
        count += rects.length;
        const head = Buffer.alloc(4);
        head.writeUInt16BE(count, 2);
        page.write(Buffer.concat([head, ...parts]));
        // 发的这会儿里页面又要了（不太会）、画面又变了：接着发
        pump();
      },
      (err) => {
        sending = false;
        fail(err);
      },
    );
  };

  let lastRequest = 0;
  const requestVnc = (incremental: boolean): void => {
    if (closed) return;
    lastRequest = Date.now();
    const b = Buffer.alloc(10);
    b[0] = 3;
    b[1] = incremental ? 1 : 0;
    b.writeUInt16BE(frame.srcW, 6);
    b.writeUInt16BE(frame.srcH, 8);
    vnc.write(b);
  };

  let failure: ((err: unknown) => void) | null = null;
  const fail = (err: unknown): void => failure?.(err);
  const done = new Promise<void>((_resolve, reject) => {
    failure = (err) => {
      if (closed) return;
      closed = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };
  });

  // ---------- VNC 服务 → 我们 ----------
  /** 解码用的暂存：一帧整屏几十 MB，别每次都新分配 */
  let scratch = Buffer.alloc(0);
  const scratchOf = (n: number) => {
    if (scratch.length < n) scratch = Buffer.allocUnsafe(n);
    return scratch.subarray(0, n);
  };
  const fromVnc = async () => {
    const inflater = new Inflater();
    try {
      requestVnc(false);
      for (;;) {
        const type = (await vnc.reader.read(1))[0];
        if (type === 0) {
          const n = (await vnc.reader.read(3)).readUInt16BE(1);
          for (let i = 0; i < n; i++) {
            const hd = await vnc.reader.read(12);
            const x = hd.readUInt16BE(0);
            const y = hd.readUInt16BE(2);
            const w = hd.readUInt16BE(4);
            const h = hd.readUInt16BE(6);
            const enc = hd.readInt32BE(8);
            if (enc === ENC_DESKTOP_SIZE) {
              frame.resize(w, h);
              sizeChanged = true;
              continue;
            }
            if (enc === ENC_CURSOR) {
              const pixels = await vnc.reader.read(w * h * 4);
              const mask = await vnc.reader.read(Math.ceil(w / 8) * h);
              cursor = { hotX: x, hotY: y, w, h, pixels, mask };
              cursorChanged = true;
              continue;
            }
            if (x + w > frame.srcW || y + h > frame.srcH) throw new Error("VNC 服务发来的矩形超出了画面");
            if (enc === ENC_ZRLE) {
              const len = (await vnc.reader.read(4)).readUInt32BE(0);
              const px = scratchOf(w * h * 4);
              decodeZrle(await inflater.inflate(await vnc.reader.read(len)), px, w, h);
              frame.update(x, y, w, h, px);
            } else if (enc === ENC_RAW) {
              const data = await vnc.reader.read(w * h * bpp);
              if (bpp === 2) {
                const px = scratchOf(w * h * 4);
                expand565(data, px, w * h);
                frame.update(x, y, w, h, px);
              } else frame.update(x, y, w, h, data);
            } else if (enc === ENC_COPYRECT) {
              const s = await vnc.reader.read(4);
              const sx = s.readUInt16BE(0);
              const sy = s.readUInt16BE(2);
              const stride = frame.srcW * 4;
              // 往下挪时从下往上拷，免得覆盖还没拷的
              const rows = [...Array(h).keys()];
              if (y > sy) rows.reverse();
              for (const row of rows) {
                const from = (sy + row) * stride + sx * 4;
                frame.src.copyWithin((y + row) * stride + x * 4, from, from + w * 4);
              }
              frame.damage(x, y, w, h);
            } else throw new Error(`VNC 服务用了不认识的编码 ${enc}`);
          }
          gotFirst = true;
          pump();
          // 下一帧：本机的 VNC 服务会等到画面有变化才回
          setTimeout(() => requestVnc(true), Math.max(0, FRAME_MS - (Date.now() - lastRequest)));
        } else if (type === 1) {
          const n = (await vnc.reader.read(5)).readUInt16BE(3);
          await vnc.reader.read(n * 6);
        } else if (type === 2) {
          page.write(Buffer.from([2]));
        } else if (type === 3) {
          const head = await vnc.reader.read(7);
          const text = await vnc.reader.read(head.readUInt32BE(3));
          page.write(Buffer.concat([Buffer.from([3]), head, text]));
        } else throw new Error(`VNC 服务发来了不认识的消息 ${type}`);
      }
    } finally {
      inflater.close();
    }
  };

  // ---------- 页面 → 我们 ----------
  const fromPage = async () => {
    for (;;) {
      const type = (await page.reader.read(1))[0];
      if (type === 0) {
        const pf = (await page.reader.read(19)).subarray(3);
        pageFormatOk = pf[0] === 32 && pf[2] === 0 && pf[3] === 1 && pf[10] === 0 && pf[11] === 8 && pf[12] === 16;
      } else if (type === 2) {
        const n = (await page.reader.read(3)).readUInt16BE(1);
        const list = await page.reader.read(n * 4);
        const set = new Set(Array.from({ length: n }, (_, i) => list.readInt32BE(i * 4)));
        pageEnc.tight = set.has(ENC_TIGHT);
        pageEnc.cursor = set.has(ENC_CURSOR);
        pageEnc.desktopSize = set.has(ENC_DESKTOP_SIZE);
        if (!pageEnc.tight) throw new Error("页面不支持 Tight 编码");
        cursorChanged = !!cursor;
      } else if (type === 3) {
        const req = await page.reader.read(9);
        if (!req[0]) frame.markOut(req.readUInt16BE(1), req.readUInt16BE(3), req.readUInt16BE(5), req.readUInt16BE(7));
        wanted = true;
        pump();
      } else if (type === 4) {
        vnc.write(Buffer.concat([Buffer.from([4]), await page.reader.read(7)]));
      } else if (type === 5) {
        const ev = await page.reader.read(5);
        const [sx, sy] = frame.toSrc(ev.readUInt16BE(1), ev.readUInt16BE(3));
        const out = Buffer.alloc(6);
        out[0] = 5;
        out[1] = ev[0]!;
        out.writeUInt16BE(sx, 2);
        out.writeUInt16BE(sy, 4);
        vnc.write(out);
      } else if (type === 6) {
        const head = await page.reader.read(7);
        const text = await page.reader.read(head.readUInt32BE(3));
        vnc.write(Buffer.concat([Buffer.from([6]), head, text]));
      } else throw new Error(`页面发来了不认识的消息 ${type}`);
    }
  };

  fromVnc().catch(fail);
  fromPage().catch(fail);
  try {
    await done;
  } finally {
    closed = true;
  }
}
