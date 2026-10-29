// 响应压缩：静态文件（前端和 vendor）、接口返回的 JSON。
//
// - 只压文本：图片、视频、压缩包本来就压过了，用户的文件（回复附件、上传）也不走这里。
// - 静态文件压一次存在内存里（按路径 + 修改时间 + 编码），之后直接给；同一个文件同时被要好几次也只压一次。
// - JSON 每次现压，太小的不压（省不了几个字节，白花 CPU）。
// - 都用 zlib 的异步接口（在线程池里跑），不卡事件循环。brotli 用中等档：最高档压 mermaid（5 MB）要好几秒。
// - WebSocket 不压：流式输出、终端都是又小又密的消息，每条连接一份压缩上下文不划算。
import zlib from "node:zlib";
import type { IncomingHttpHeaders } from "node:http";

export type Encoding = "br" | "gzip";

/** 比这小的不压 */
export const MIN_SIZE = 1024;

const TEXT_EXT = new Set([".js", ".mjs", ".css", ".html", ".svg", ".json", ".webmanifest", ".txt", ".map"]);

export function compressibleExt(ext: string): boolean {
  return TEXT_EXT.has(ext.toLowerCase());
}

/** 按 Accept-Encoding 挑：br 优先，其次 gzip；q=0 表示不要 */
export function pickEncoding(headers: IncomingHttpHeaders): Encoding | undefined {
  const raw = headers["accept-encoding"];
  if (!raw) return undefined;
  const accepted = new Map<string, number>();
  for (const part of String(raw).split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
    accepted.set(name, q === undefined ? 1 : Number(q));
  }
  const ok = (name: string) => (accepted.get(name) ?? accepted.get("*") ?? 0) > 0;
  if (ok("br")) return "br";
  if (ok("gzip")) return "gzip";
  return undefined;
}

function compress(data: Buffer, encoding: Encoding, level: "file" | "live"): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, out: Buffer) => (err ? reject(err) : resolve(out));
    if (encoding === "br") {
      const params = {
        [zlib.constants.BROTLI_PARAM_QUALITY]: level === "file" ? 6 : 4,
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
      };
      zlib.brotliCompress(data, { params }, done);
    } else zlib.gzip(data, { level: 6 }, done);
  });
}

// ---------- 静态文件 ----------

/** 内存里最多存这么多压好的文件（全部前端 + vendor 压完不到 10 MB） */
const CACHE_MAX = 48 * 1024 * 1024;
const cache = new Map<string, Promise<Buffer>>();
const sizes = new Map<string, number>();
let cached = 0;

function evict(): void {
  // Map 按插入顺序：最早放进去的先扔（用到时会挪到最后）
  for (const key of cache.keys()) {
    if (cached <= CACHE_MAX) return;
    cached -= sizes.get(key) ?? 0;
    sizes.delete(key);
    cache.delete(key);
  }
}

/** 压好的静态文件。文件改了（mtime / 大小变了）就是新的键，旧的慢慢被挤掉 */
export function compressedFile(file: string, mtimeMs: number, size: number, encoding: Encoding, read: () => Promise<Buffer>): Promise<Buffer> {
  const key = `${encoding}:${mtimeMs}:${size}:${file}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const job = read().then((data) => compress(data, encoding, "file"));
  cache.set(key, job);
  job.then(
    (out) => {
      if (cache.get(key) !== job) return;
      sizes.set(key, out.length);
      cached += out.length;
      evict();
    },
    () => cache.delete(key), // 失败了别记着，下次再试
  );
  return job;
}

/** 测试用 */
export function clearCompressCache(): void {
  cache.clear();
  sizes.clear();
  cached = 0;
}

// ---------- 接口 JSON ----------

/** 现压一段文本；不值得压（太小、对方不收）就 undefined */
export async function compressLive(data: string, encoding: Encoding | undefined): Promise<Buffer | undefined> {
  if (!encoding || Buffer.byteLength(data) < MIN_SIZE) return undefined;
  return compress(Buffer.from(data), encoding, "live");
}
