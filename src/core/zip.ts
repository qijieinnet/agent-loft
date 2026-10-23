// 最小的 zip 解包：上传技能包（.zip / .skill）用。只认最常见的两种：不压缩（stored）和 deflate，
// 加密的、zip64 的直接报错。不落盘，解到内存里交给调用方校验路径、大小后再写。
import zlib from "node:zlib";

export type ZipEntry = { path: string; data: Buffer };

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** maxTotal：解压后的总大小上限（防 zip 炸弹），超了就报错 */
export function readZip(buf: Buffer, maxTotal: number, maxEntries = 1000): ZipEntry[] {
  // 目录尾记录在最后 22 字节 + 最长 64KB 的注释里
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是 zip 文件");
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new Error("不支持 zip64 格式的压缩包");
  if (count > maxEntries) throw new Error(`压缩包里的文件太多（最多 ${maxEntries} 个）`);

  const out: ZipEntry[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_SIG) throw new Error("压缩包损坏");
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compressed = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const local = buf.readUInt32LE(offset + 42);
    // 第 11 位：文件名是 UTF-8。没标的多半也是（macOS / 新版 Windows），按 UTF-8 读
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    offset += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue; // 目录
    if (flags & 1) throw new Error("不支持加密的压缩包");
    if (size === 0xffffffff || compressed === 0xffffffff) throw new Error("不支持 zip64 格式的压缩包");
    total += size;
    if (total > maxTotal) throw new Error(`解压后太大（上限 ${Math.round(maxTotal / 1024 / 1024)}MB）`);
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL_SIG) throw new Error("压缩包损坏");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compressed);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
    else throw new Error(`不支持的压缩方式（${method}）`);
    if (data.length !== size) throw new Error("压缩包损坏");
    out.push({ path: name, data });
  }
  return out;
}

/** 测试和导出用：打一个不压缩的 zip */
export function writeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.path, "utf8");
    const crc = zlib.crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, e.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + e.data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD_SIG, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
