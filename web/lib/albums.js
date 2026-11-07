import { h, icon } from "./dom.js";
import { openImageViewer } from "./image-viewer.js";

// 相册只接收本地文件路径，沿用会话文件接口的授权、敏感路径检查；不接收远程地址或 HTML。
const MAX_ITEMS = 200;
const fileUrl = (key, path) => `/api/conversations/${encodeURIComponent(key)}/file?path=${encodeURIComponent(path)}`;
const localPath = (p) => typeof p === "string" && p.startsWith("/") && !p.startsWith("//") && !/[\0\r\n]/.test(p);
const text = (v) => typeof v === "string" ? v : "";

function parseAlbum(source) {
  let spec;
  try { spec = JSON.parse(source); } catch { return "相册格式不完整或 JSON 有误"; }
  if (!spec || !Array.isArray(spec.items) || spec.items.length > MAX_ITEMS) return `相册需要 items 列表，每次最多 ${MAX_ITEMS} 张`;
  const items = [];
  for (const item of spec.items) {
    if (!item || !localPath(item.src) || (item.preview !== undefined && !localPath(item.preview))) return "相册图片需要使用已下载的本地绝对路径";
    items.push({ src: item.src, preview: item.preview || item.src, name: text(item.name) || `照片 ${items.length + 1}`, date: text(item.date), caption: text(item.caption) });
  }
  return { title: text(spec.title) || "相册", items, total: Number.isSafeInteger(spec.total) && spec.total >= items.length ? spec.total : items.length };
}

/** 回复里的 ```album：流式输出先占位，块完整后再渲染；key 固定为这条消息所属的会话。 */
export function mountAlbums(root, key, final) {
  for (const code of root.querySelectorAll("pre > code.language-album")) {
    const pre = code.parentElement;
    if (!final) {
      pre.replaceWith(h("div", { class: "photo-album album-pending", role: "status" }, "正在整理相册…"));
      continue;
    }
    const spec = parseAlbum(code.textContent);
    if (typeof spec === "string") {
      pre.before(h("div", { class: "album-error", role: "status" }, spec));
      continue;
    }
    pre.replaceWith(renderAlbum(spec, key));
  }
}

function renderAlbum(spec, key) {
  const { items, total } = spec;
  const box = h("section", { class: "photo-album", "aria-label": spec.title, "aria-roledescription": "轮播相册" });
  box.append(h("div", { class: "album-head" },
    h("div", {}, h("span", { class: "album-eyebrow" }, "PHOTO COLLECTION"), h("strong", {}, spec.title)),
    h("span", { class: "album-total" }, total > items.length ? `已载入 ${items.length} / 共 ${total} 张` : `共 ${items.length} 张`)));
  if (!items.length) {
    box.append(h("div", { class: "album-empty" }, "没有照片"));
    return box;
  }
  let index = 0;
  let trackWidth = 0, target = null;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const track = h("div", { class: "album-track", tabindex: "0", "aria-label": "左右滑动切换照片" });
  const strip = h("div", { class: "album-filmstrip", "aria-label": "选择照片" });
  const count = h("span", { class: "album-count", "aria-live": "polite", "aria-atomic": "true" });
  const date = h("span", { class: "album-date" });
  const caption = h("span", { class: "album-caption" });
  const gallery = items.map((item) => ({ src: fileUrl(key, item.preview), fallback: fileUrl(key, item.src), title: item.name, detail: [item.date, item.caption].filter(Boolean).join(" · ") }));
  const open = (trigger) => openImageViewer(box, gallery[index].src, items[index].name, trigger, {
    kind: "照片", gallery, start: index, onIndexChange: (n) => select(n, false),
  });
  const slides = items.map((item, i) => h("button", {
    class: "album-slide", tabindex: i === 0 ? "0" : "-1", "aria-label": `放大第 ${i + 1} 张：${item.name}`,
    onclick: (e) => { if (i !== index) select(i, false); open(e.currentTarget); },
  }, h("span", { class: "album-slide-hint" }, icon("expand"), "放大查看")));
  const thumbs = items.map((item, i) => h("button", {
    class: "album-thumb", "aria-label": `查看第 ${i + 1} 张：${item.name}`, "aria-pressed": "false",
    onclick: () => select(i), title: [item.date, item.caption || item.name].filter(Boolean).join(" · "),
  }, h("img", { src: fileUrl(key, item.src), alt: "", loading: "lazy", decoding: "async", width: "64", height: "64" })));
  const prev = h("button", { class: "album-arrow", "aria-label": "上一张照片", onclick: () => select(index - 1) }, icon("back"));
  const next = h("button", { class: "album-arrow", "aria-label": "下一张照片", onclick: () => select(index + 1) }, icon("back"));
  function select(n, smooth = true, scroll = true) {
    index = Math.max(0, Math.min(n, items.length - 1));
    count.textContent = `${index + 1} / ${items.length}`;
    date.textContent = items[index].date || items[index].name;
    caption.textContent = items[index].caption;
    prev.disabled = index === 0;
    next.disabled = index === items.length - 1;
    slides.forEach((slide, i) => {
      slide.tabIndex = i === index ? 0 : -1;
      thumbs[i].setAttribute("aria-pressed", String(i === index));
      if (Math.abs(i - index) > 1 || slide.querySelector("img, .album-missing")) return;
      const img = h("img", { src: gallery[i].src, alt: items[i].name, decoding: "async", draggable: "false" });
      img.onerror = () => {
        if (img.getAttribute("src") !== gallery[i].fallback) img.src = gallery[i].fallback;
        else img.replaceWith(h("span", { class: "album-missing" }, "图片无法加载，仍可切换其他照片"));
      };
      slide.prepend(img);
    });
    const behavior = smooth && !reduced.matches ? "smooth" : "instant";
    if (scroll) {
      target = smooth && !reduced.matches ? index : null;
      track.scrollTo({ left: index * track.clientWidth, behavior });
    }
    const thumb = thumbs[index];
    // 只滚动缩略图条，不让聊天页面跟着 scrollIntoView 跳动。
    strip.scrollTo({ left: thumb.offsetLeft - (strip.clientWidth - thumb.offsetWidth) / 2, behavior });
  }
  // 原生横向滚动保留手机滑动、触控板惯性和浏览器的手势处理。
  let frame = 0;
  track.addEventListener("scroll", () => {
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0;
      if (!track.clientWidth || track.clientWidth !== trackWidth) return;
      if (target !== null && Math.abs(track.scrollLeft - target * trackWidth) > 1) return;
      target = null;
      const n = Math.round(track.scrollLeft / track.clientWidth);
      if (n !== index) select(n, false, false);
    });
  });
  for (const event of ["pointerdown", "wheel"]) track.addEventListener(event, () => { target = null; }, { passive: true });
  track.addEventListener("scrollend", () => {
    target = null;
    if (trackWidth && trackWidth === track.clientWidth) select(Math.round(track.scrollLeft / trackWidth), false, false);
  });
  track.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    select(e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : index + (e.key === "ArrowRight" ? 1 : -1));
  });
  track.append(...slides);
  strip.append(...thumbs);
  box.append(h("div", { class: "album-hero" }, track, h("div", { class: "album-nav" }, prev, next), count),
    h("div", { class: "album-info" }, date, caption), strip,
    h("div", { class: "album-footer" }, "左右滑动，重温每个瞬间", h("button", { class: "album-open", onclick: (e) => open(e.currentTarget) }, "放大查看", icon("expand"))));
  select(0, false);
  const resize = new ResizeObserver(() => {
    if (!box.isConnected) {
      resize.disconnect();
      cancelAnimationFrame(frame);
      return;
    }
    if (track.clientWidth && track.clientWidth !== trackWidth) {
      trackWidth = track.clientWidth;
      select(index, false);
    }
  });
  resize.observe(track);
  return box;
}
