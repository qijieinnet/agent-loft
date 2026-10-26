import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { ByteReader } from "../src/core/vnc-auth.js";
import { decodeZrle, Frame, transcode } from "../src/core/vnc-transcode.js";

const px = (fb: Uint8Array, w: number, x: number, y: number) => [...fb.subarray((y * w + x) * 4, (y * w + x) * 4 + 3)];

test("ZRLE：原始、纯色、调色板、游程、调色板游程几种子编码都解得对", () => {
  // 一个 4×2 的矩形当一个块，挨个试
  const R = [255, 0, 0];
  const G = [0, 255, 0];
  const B = [0, 0, 255];
  const cases: [string, number[], number[][]][] = [
    ["原始", [0, ...R, ...G, ...B, ...R, ...G, ...B, ...R, ...G], [R, G, B, R, G, B, R, G]],
    ["纯色", [1, ...B], Array(8).fill(B)],
    // 两色调色板、每像素 1 位、每行补齐到整字节：第一行 1010，第二行 0110
    ["调色板", [2, ...R, ...G, 0b10100000, 0b01100000], [G, R, G, R, R, G, G, R]],
    // 红 3 个、绿 5 个：长度减 1 写进去
    ["游程", [128, ...R, 2, ...G, 4], [R, R, R, G, G, G, G, G]],
    // 调色板游程：索引 0 单个，索引 1 带长度 6，索引 0 单个
    ["调色板游程", [130, ...R, ...B, 0, 0x81, 5, 0], [R, B, B, B, B, B, B, R]],
  ];
  for (const [name, data, want] of cases) {
    const fb = new Uint8Array(4 * 2 * 4);
    decodeZrle(Buffer.from(data), fb, 4, 2);
    const got = Array.from({ length: 8 }, (_, i) => px(fb, 4, i % 4, Math.floor(i / 4)));
    assert.deepEqual(got, want, name);
  }
});

test("画面：没变的不记脏，变了的按格子记；缩小按面积平均，鼠标坐标按比例放大回去", () => {
  const f = new Frame(256, 128, 128);
  assert.equal(f.outW, 128);
  assert.equal(f.outH, 64);
  f.takeDirty();
  const same = Buffer.alloc(256 * 128 * 4);
  assert.equal(f.update(0, 0, 256, 128, same), 0);
  assert.equal(f.hasDirty, false);
  // 右下角一个 2×2 的白块：缩小一半后是一个灰白像素
  const img = Buffer.alloc(256 * 128 * 4);
  for (const [x, y] of [[254, 126], [255, 126], [254, 127], [255, 127]]) img.fill(255, (y! * 256 + x!) * 4, (y! * 256 + x!) * 4 + 3);
  img.fill(255, (126 * 256 + 252) * 4, (126 * 256 + 252) * 4 + 3);
  assert.equal(f.update(0, 0, 256, 128, img), 1);
  assert.deepEqual(f.takeDirty(), [{ x: 64, y: 0, w: 64, h: 64 }]);
  assert.deepEqual(px(f.out, 128, 127, 63), [255, 255, 255]);
  // 252,126 那一个白点：(252..253)×(126..127) 四个里一个白 → 64
  assert.deepEqual(px(f.out, 128, 126, 63), [64, 64, 64]);
  assert.deepEqual(f.toSrc(127, 63), [255, 127]);
  assert.deepEqual(f.toSrc(0, 0), [1, 1]);
  // 页面要整屏：全记脏，宽的段上下并起来
  f.markOut(0, 0, 128, 64);
  assert.deepEqual(f.takeDirty(), [{ x: 0, y: 0, w: 128, h: 64 }]);
});

/** 一个不用认证、只发原始像素的 VNC 服务：整屏一个颜色，按要的像素格式（32 位或 RGB565）发 */
async function fakeVnc(r: ByteReader, write: (b: Buffer) => void, w: number, h: number, color: number[], got: Buffer[]) {
  write(Buffer.from("RFB 003.008\n"));
  await r.read(12);
  write(Buffer.from([1, 1]));
  assert.equal((await r.read(1))[0], 1);
  write(Buffer.from([0, 0, 0, 0]));
  assert.equal((await r.read(1))[0], 1);
  const init = Buffer.alloc(24);
  init.writeUInt16BE(w, 0);
  init.writeUInt16BE(h, 2);
  init[4] = 32;
  init.writeUInt32BE(4, 20);
  write(Buffer.concat([init, Buffer.from("test")]));
  let bpp = 4;
  for (;;) {
    const type = (await r.read(1))[0];
    if (type === 0) bpp = (await r.read(19))[3]! / 8;
    else if (type === 2) await r.read((await r.read(3)).readUInt16BE(1) * 4);
    else if (type === 3) {
      // 画面不变：只回整屏请求，增量请求一直挂着（和真的 VNC 服务一样）
      if ((await r.read(9))[0]) continue;
      const head = Buffer.from([0, 0, 0, 1, 0, 0, 0, 0, w >> 8, w & 255, h >> 8, h & 255, 0, 0, 0, 0]);
      const data = Buffer.alloc(w * h * bpp);
      const v565 = ((color[0]! >> 3) << 11) | ((color[1]! >> 2) << 5) | (color[2]! >> 3);
      for (let i = 0; i < w * h; i++) {
        if (bpp === 2) data.writeUInt16LE(v565, i * 2);
        else data.set(color, i * 4);
      }
      write(Buffer.concat([head, data]));
    } else {
      const rest = await r.read(type === 5 ? 5 : 7);
      got.push(Buffer.concat([Buffer.from([type!]), rest]));
    }
  }
}

test("转码会话：对页面是不用认证、只发 Tight JPEG 的 VNC，画面缩小，鼠标坐标放大回原画", async () => {
  const vncIn = new ByteReader();
  const vncOut = new ByteReader();
  const pageIn = new ByteReader();
  const pageOut = new ByteReader();
  const forwarded: Buffer[] = [];
  // 原画 4000×2000，「流畅」缩到 1280×640
  void fakeVnc(vncOut, (b) => vncIn.push(b), 4000, 2000, [200, 40, 40], forwarded).catch(() => {});
  const session = transcode({
    vnc: { reader: vncIn, write: (b) => vncOut.push(b) },
    page: { reader: pageIn, write: (b) => pageOut.push(b), backlog: () => 0 },
    creds: { password: "" },
    quality: "smooth",
    local: true,
  });
  session.catch(() => {});
  const send = (b: Buffer) => pageIn.push(b);
  assert.equal((await pageOut.read(12)).toString(), "RFB 003.008\n");
  send(Buffer.from("RFB 003.008\n"));
  assert.deepEqual([...(await pageOut.read(2))], [1, 1]);
  send(Buffer.from([1]));
  assert.equal((await pageOut.read(4)).readUInt32BE(0), 0);
  send(Buffer.from([1]));
  const init = await pageOut.read(24);
  assert.equal(init.readUInt16BE(0), 1280);
  assert.equal(init.readUInt16BE(2), 640);
  assert.equal((await pageOut.read(init.readUInt32BE(20))).toString(), "test");
  const se = Buffer.alloc(8);
  se[0] = 2;
  se.writeUInt16BE(1, 2);
  se.writeInt32BE(7, 4);
  send(se);
  const req = Buffer.from([3, 0, 0, 0, 0, 0, 1280 >> 8, 1280 & 255, 640 >> 8, 640 & 255]);
  send(req);
  assert.equal((await pageOut.read(1))[0], 0);
  const n = (await pageOut.read(3)).readUInt16BE(1);
  assert.ok(n >= 1);
  let area = 0;
  for (let i = 0; i < n; i++) {
    const h = await pageOut.read(12);
    assert.equal(h.readInt32BE(8), 7);
    area += h.readUInt16BE(4) * h.readUInt16BE(6);
    assert.equal((await pageOut.read(1))[0], 0x90);
    let len = 0;
    for (let k = 0, shift = 0; k < 3; k++, shift += 7) {
      const b = (await pageOut.read(1))[0]!;
      len |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
    }
    const { data } = await sharp(await pageOut.read(len)).raw().toBuffer({ resolveWithObject: true });
    assert.ok(Math.abs(data[0]! - 200) < 8 && Math.abs(data[1]! - 40) < 8, `JPEG 颜色 ${[...data.subarray(0, 3)]}`);
  }
  assert.equal(area, 1280 * 640);
  // 鼠标：页面上的 (640, 320) → 原画的 (2001, 1001) 附近
  send(Buffer.from([5, 1, 640 >> 8, 640 & 255, 320 >> 8, 320 & 255]));
  // 按键原样转发
  send(Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]));
  while (forwarded.length < 2) await new Promise((r) => setTimeout(r, 10));
  const pointer = forwarded[0]!;
  assert.equal(pointer[0], 5);
  assert.equal(pointer[1], 1);
  assert.ok(Math.abs(pointer.readUInt16BE(2) - 2001) <= 2 && Math.abs(pointer.readUInt16BE(4) - 1001) <= 2, `鼠标 ${pointer.readUInt16BE(2)},${pointer.readUInt16BE(4)}`);
  assert.deepEqual([...forwarded[1]!], [4, 1, 0, 0, 0, 0, 0, 0x61]);
  pageIn.fail(new Error("页面断开了"));
  await assert.rejects(session, /页面断开了/);
  vncIn.fail(new Error("结束"));
  vncOut.fail(new Error("结束"));
});
