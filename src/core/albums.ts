// 回复里的 ```album：网页显示为相册；飞书降级为摘要。JSON 里的文件路径也算显式引用。
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*album[ \t]*\r?\n([\s\S]*?)\r?\n {0,3}\1[ \t]*$/gim;
type Photo = { src: string; preview?: string; name?: string; date?: string; caption?: string };
type Album = { title?: string; total: number; items: Photo[] };
const localPath = (p: unknown): p is string => typeof p === "string" && p.startsWith("/") && !p.startsWith("//") && !/[\0\r\n]/.test(p);
const str = (v: unknown): string | undefined => typeof v === "string" ? v : undefined;

function parseAlbum(json: string): Album | undefined {
  try {
    const raw = JSON.parse(json);
    if (!raw || !Array.isArray(raw.items) || raw.items.length > 200) return;
    const items: Photo[] = [];
    for (const item of raw.items) {
      if (!item || !localPath(item.src) || (item.preview !== undefined && !localPath(item.preview))) return;
      items.push({ src: item.src, preview: item.preview, name: str(item.name), date: str(item.date), caption: str(item.caption) });
    }
    return { title: str(raw.title), total: Number.isSafeInteger(raw.total) && raw.total >= items.length ? raw.total : items.length, items };
  } catch { return; }
}

/** JSON 转义过的中文、反斜杠等路径也能匹配；不放宽原有的会话文件权限。 */
export function albumReferences(text: string): { text: string; paths: string[] } {
  const paths: string[] = [];
  if (!/album/i.test(text)) return { text, paths };
  const rest = text.replace(FENCE, (whole, _fence: string, json: string) => {
    const album = parseAlbum(json);
    if (!album) return whole;
    for (const item of album.items) paths.push(item.src, ...(item.preview ? [item.preview] : []));
    return "";
  });
  return { text: rest, paths };
}

const plain = (s: string) => s.replace(/[\r\n]/g, " ").replace(/[\\`*_{}[\]()<>!|#]/g, "\\$&").slice(0, 200);

/** 飞书不展示整段 JSON、服务器路径或数百条图片，只保留相册概况。 */
export function albumsToText(text: string): string {
  if (!/album/i.test(text)) return text;
  return text.replace(FENCE, (whole, _fence: string, json: string) => {
    const album = parseAlbum(json);
    if (!album) return whole;
    const { items, total } = album;
    const lines = [`**${plain(album.title || "相册")}** · 共 ${total} 张${total > items.length ? `（已载入 ${items.length} 张）` : ""}`];
    for (const [i, item] of items.slice(0, 12).entries()) lines.push(`${i + 1}. ${[item.name || `照片 ${i + 1}`, item.date, item.caption].filter(Boolean).map((v) => plain(v!)).join(" · ")}`);
    if (items.length > 12) lines.push(`还有 ${items.length - 12} 张。`);
    lines.push(items.length ? "请在 Web 中打开相册查看照片。" : "没有照片。");
    return lines.join("\n");
  });
}
