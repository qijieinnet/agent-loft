import { h, icon } from "./dom.js";

// 相册只接收本地文件路径，沿用会话文件接口的授权、敏感路径检查；不接收远程地址或 HTML。
const PAGE_SIZE = 12;
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
    items.push({ src: item.src, preview: item.preview || item.src, name: text(item.name) || item.src.split("/").pop(), date: text(item.date), caption: text(item.caption) });
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
  const box = h("section", { class: "photo-album", "aria-label": spec.title });
  const grid = h("div", { class: "album-grid" });
  const status = h("span", { class: "album-page", "aria-live": "polite" });
  let page = 0;
  const pages = Math.ceil(items.length / PAGE_SIZE);
  const prev = h("button", { class: "btn ghost", "aria-label": "相册上一页", onclick: () => showPage(page - 1) }, "上一页");
  const next = h("button", { class: "btn ghost", "aria-label": "相册下一页", onclick: () => showPage(page + 1) }, "下一页");
  const showPage = (n) => {
    page = Math.max(0, Math.min(n, pages - 1));
    grid.replaceChildren(...items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((item, offset) => {
      const index = page * PAGE_SIZE + offset;
      const img = h("img", { src: fileUrl(key, item.src), alt: item.name, loading: "lazy", decoding: "async", width: "240", height: "240" });
      const pic = h("span", { class: "album-pic" }, img);
      img.onerror = () => pic.replaceChildren(h("span", { class: "album-missing" }, "图片无法加载"));
      return h("button", {
        class: "album-tile", "aria-label": `查看第 ${index + 1} 张：${item.name}`, title: [item.name, item.date, item.caption].filter(Boolean).join("\n"),
        onclick: (e) => openPhoto(box, spec, key, index, e.currentTarget),
      }, pic, h("span", { class: "album-name" }, item.name), item.date ? h("span", { class: "album-date" }, item.date) : null);
    }));
    status.textContent = `第 ${page + 1} / ${pages} 页`;
    prev.disabled = page === 0;
    next.disabled = page >= pages - 1;
    // 切页后按钮仍然留在原位置，键盘焦点也留在原按钮上。
  };
  box.append(h("div", { class: "album-head" }, h("strong", {}, spec.title), h("span", {}, total > items.length ? `已载入 ${items.length} / 共 ${total} 张` : `共 ${items.length} 张`)));
  if (!items.length) box.append(h("div", { class: "album-empty" }, "没有照片"));
  else {
    box.append(grid);
    if (pages > 1) box.append(h("div", { class: "album-pager" }, prev, status, next));
    showPage(0);
  }
  return box;
}

function openPhoto(album, spec, key, start, trigger) {
  let index = start;
  const dialog = h("dialog", { class: "photo-viewer", "aria-label": "照片预览" });
  const image = h("img", { alt: "" });
  const stage = h("div", { class: "photo-stage" }, image);
  const name = h("strong", { class: "photo-name" });
  const detail = h("span", { class: "photo-detail" });
  const status = h("span", { class: "photo-status", role: "status" });
  const count = h("span", { class: "photo-count", "aria-live": "polite" });
  const open = h("a", { target: "_blank", rel: "noopener noreferrer" }, "打开图片");
  const close = () => dialog.close();
  const prev = h("button", { class: "btn ghost", "aria-label": "上一张照片", onclick: () => show(index - 1) }, "上一张");
  const next = h("button", { class: "btn ghost", "aria-label": "下一张照片", onclick: () => show(index + 1) }, "下一张");
  const show = (n) => {
    index = Math.max(0, Math.min(n, spec.items.length - 1));
    const item = spec.items[index];
    const thumb = fileUrl(key, item.src);
    const preview = fileUrl(key, item.preview);
    status.textContent = "";
    image.onerror = () => {
      if (image.getAttribute("src") !== thumb) {
        status.textContent = "预览不可用，显示缩略图";
        image.src = thumb;
      } else status.textContent = "图片无法加载，文件可能已被清理";
    };
    image.src = preview;
    image.alt = item.name;
    name.textContent = item.name;
    detail.textContent = [item.date, item.caption].filter(Boolean).join(" · ");
    count.textContent = `${index + 1} / ${spec.items.length}`;
    open.href = preview;
    prev.disabled = index === 0;
    next.disabled = index === spec.items.length - 1;
  };
  dialog.append(h("div", { class: "photo-panel" },
    h("div", { class: "photo-head" }, count, h("button", { class: "icon-btn", "aria-label": "关闭照片预览", onclick: close }, icon("x"))),
    stage,
    h("div", { class: "photo-info" }, name, detail, status),
    h("div", { class: "photo-controls" }, prev, open, next),
  ));
  dialog.addEventListener("click", (e) => { if (e.target === dialog) close(); });
  dialog.addEventListener("keydown", (e) => {
    if (["ArrowLeft", "ArrowRight", "Escape"].includes(e.key)) e.stopPropagation();
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      show(index + (e.key === "ArrowRight" ? 1 : -1));
    }
  });
  dialog.addEventListener("close", () => { dialog.remove(); if (trigger.isConnected) trigger.focus({ preventScroll: true }); });
  // dialog 随相册一起移除，切换会话、重画流式块时不会留下全局监听器或悬空弹层。
  album.append(dialog);
  show(index);
  dialog.showModal();
}
