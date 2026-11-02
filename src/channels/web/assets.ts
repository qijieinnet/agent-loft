// 前端静态资源的版本前缀：/v/<指纹>/app.js。
//
// 没有构建步骤，文件名里没有内容哈希。以前全部 no-cache，每次打开都要把六十来个文件逐个确认一遍。
// 现在页面（每次都重新拿）把资源地址写成带指纹的，这些地址可以放心长缓存：
// - 模块之间都是相对路径 import，入口带上前缀，整棵依赖树自然都带上；
// - 文件一变指纹就变，刷新页面拿到的是新地址；
// - 指纹跟最新的不一致（升级后还开着的旧页面懒加载）：照样给当前的文件，但不让长缓存。
// 不带前缀的老地址继续能用，还是 no-cache。
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const VERSIONED = /^\/v\/([0-9a-f]{12})(\/.*)$/;

/** /v/<指纹>/xxx → 指纹和真正的路径；不是这个形式就 undefined */
export function parseVersioned(pathname: string): { token: string; pathname: string } | undefined {
  const m = VERSIONED.exec(pathname);
  return m ? { token: m[1]!, pathname: m[2]! } : undefined;
}

/** 页面里的样式和入口脚本写成带指纹的地址。图标、manifest、sw.js 地址要稳定，不动 */
export function stampIndex(html: string, token: string): string {
  return html.replace(/\b(href|src)="\/(css\/|vendor\/|app\.js)/g, `$1="/v/${token}/$2`);
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? listFiles(full) : Promise.resolve(e.isFile() ? [full] : []);
    }),
  );
  return nested.flat();
}

/**
 * 指纹：程序版本 + 前端目录和 extra 里每个文件的路径、大小、修改时间。
 * 只 stat 不读内容，打开页面时算一次也不费事；开发时改了前端文件，不重启、刷新就能拿到新的。
 */
export async function assetToken(version: string, webRoot: string, extra: string[]): Promise<string> {
  const files = [...(await listFiles(webRoot)), ...extra].sort();
  const stats = await Promise.all(
    files.map(async (file) => {
      const stat = await fs.stat(file).catch(() => null);
      return stat ? `${file}:${stat.size}:${stat.mtimeMs}` : `${file}:-`;
    }),
  );
  return createHash("sha256").update(version).update("\0").update(stats.join("\0")).digest("hex").slice(0, 12);
}
