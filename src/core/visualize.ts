// 回复里的 HTML：Codex 的 visualize 插件画的图表（回复里单独一行 visualize{"path":"…"}），
// 以及 agent 写出来的普通 HTML 文件。网页上放进沙箱 iframe 里显示。
//
// visualize 写的是 HTML 片段，要套上插件自带的样式和脚本（和插件的 scripts/render.py 一样）才是完整的页面。
// 插件装在本机 Codex 的目录里，找不到就用一份最小的样式兜底。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 和 visualize 插件约定的一样：图表只能从这几个 CDN 加载资源，不能联网请求别的 */
const RESOURCES = [
  "blob:",
  "data:",
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net",
  "https://esm.sh",
  "https://fonts.bunny.net",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
  "https://unpkg.com",
].join(" ");

/**
 * 沙箱（不带 allow-same-origin）：页面是个匿名的源，读不到本站的登录态、调不了本站接口；
 * connect-src 只给 blob / data，也就没法把东西发出去
 */
export const HTML_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${RESOURCES}`,
  `style-src 'unsafe-inline' ${RESOURCES}`,
  `img-src ${RESOURCES}`,
  `font-src ${RESOURCES}`,
  `media-src ${RESOURCES}`,
  "worker-src blob:",
  "connect-src blob: data:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

/** 太大的不显示（插件自己限制片段 1 MB） */
export const HTML_MAX = 2 * 1024 * 1024;

const FRAGMENT_PLACEHOLDER = "<!--__INLINE_VISUALIZATION_FRAGMENT__-->";
const DOCUMENT_MARKUP = /<!doctype\s|<\s*(?:html|head|body)(?:\s|>)/i;

/** 插件目录：$CODEX_HOME/plugins/cache/<来源>/visualize/<版本>/skills/visualize/assets，有多个版本取最新的 */
function findAssets(): string | undefined {
  const cache = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "plugins", "cache");
  const found: { dir: string; version: string }[] = [];
  try {
    for (const source of fs.readdirSync(cache)) {
      const base = path.join(cache, source, "visualize");
      let versions: string[] = [];
      try {
        versions = fs.readdirSync(base);
      } catch {
        continue;
      }
      for (const version of versions) {
        const dir = path.join(base, version, "skills", "visualize", "assets");
        if (fs.existsSync(path.join(dir, "visualize.css"))) found.push({ dir, version });
      }
    }
  } catch {
    return undefined;
  }
  found.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
  return found.at(-1)?.dir;
}

/** 没装插件时的兜底：插件约定的几个常用变量 */
const FALLBACK_CSS = `:root{color-scheme:light dark;--background:transparent;--foreground:light-dark(rgb(26 28 31),rgb(255 255 255));--muted-foreground:light-dark(rgb(26 28 31/50%),rgb(255 255 255/50%));--border:light-dark(rgb(0 0 0/10%),rgb(255 255 255/12%));--card:color-mix(in oklab,var(--foreground) 5%,transparent);--primary:light-dark(rgb(51 156 255),rgb(131 195 255));--viz-series-1:#339cff;--viz-series-2:#f59e0b;--viz-series-3:#10b981;--viz-series-4:#ef4444;--viz-series-5:#8b5cf6}
body{margin:0;font:14px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--foreground)}
.text-small{font-size:12px}.text-muted{color:var(--muted-foreground)}.tabular-nums{font-variant-numeric:tabular-nums}
.viz-row{display:flex;justify-content:space-between;gap:8px;align-items:baseline}`;

/** 把高度告诉外面的页面（iframe 跟着内容变高），见 web/views/file-preview.js */
const SIZE_REPORTER = `<script>(()=>{const post=()=>parent!==window&&parent.postMessage({type:"aloft-html-size",height:Math.ceil(document.documentElement.scrollHeight)},"*");new ResizeObserver(post).observe(document.documentElement);addEventListener("load",post);post()})()</script>`;

/**
 * 给网页显示用的完整 HTML。片段套上插件的外壳；本来就是完整页面的原样，只在末尾加上报高度的脚本。
 * 背景透明，和对话的底色融在一起
 */
export function htmlDocument(source: string, title: string): string {
  if (DOCUMENT_MARKUP.test(source)) {
    const at = source.search(/<\/body\s*>/i);
    return at >= 0 ? source.slice(0, at) + SIZE_REPORTER + source.slice(at) : source + SIZE_REPORTER;
  }
  const assets = findAssets();
  let css = FALLBACK_CSS;
  let body = source;
  if (assets) {
    try {
      css = fs.readFileSync(path.join(assets, "visualize.css"), "utf8");
      const kit = fs.readFileSync(path.join(assets, "visualize.html"), "utf8");
      body = kit.includes(FRAGMENT_PLACEHOLDER) ? kit.replace(FRAGMENT_PLACEHOLDER, () => source) : source + kit;
    } catch {
      css = FALLBACK_CSS;
      body = source;
    }
  }
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>${css}
:root{--color-background-primary:transparent;background:transparent!important}html>body{padding:0;margin:0}</style>
</head>
<body>
${body}
${SIZE_REPORTER}
</body>
</html>
`;
}
