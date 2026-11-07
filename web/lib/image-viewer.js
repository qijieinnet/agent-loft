import { h } from "./dom.js";

/** 图片与图表共用预览：SVG 保持图片隔离，普通图片沿用同一套缩放与拖动。 */
export function openImageViewer(owner, src, title, trigger, { kind = "图表", download, gallery, start = 0, onIndexChange } = {}) {
  owner._closePreview?.();
  const dialog = h("dialog", { class: `diagram-viewer${gallery ? " photo-viewer" : ""}`, "aria-label": `${kind}预览` });
  const image = h("img", { alt: title, draggable: "false" });
  const status = h("div", { class: "diagram-viewer-status photo-status", role: "status" });
  const stage = h("div", { class: `diagram-stage${gallery ? " photo-stage" : ""}`, "aria-label": "拖动查看，滚轮或双指缩放" }, image, status);
  const heading = h("strong", { class: "photo-name" }, title);
  const detail = h("div", { class: "photo-detail" });
  const count = h("span", { class: "photo-count", "aria-live": "polite" });
  const previous = h("button", { class: "btn ghost", "aria-label": "上一张照片", onclick: () => show(index - 1) }, "上一张");
  const next = h("button", { class: "btn ghost", "aria-label": "下一张照片", onclick: () => show(index + 1) }, "下一张");
  let index = start, fallback = "", notice = "", swipe;
  function show(n) {
    n = Math.max(0, Math.min(n, gallery.length - 1));
    if (n === index && width) return;
    index = n;
    const item = gallery[index];
    width = height = 0;
    image.style.visibility = "hidden";
    notice = status.textContent = "";
    fallback = item.fallback;
    image.alt = heading.textContent = item.title;
    detail.textContent = item.detail;
    count.textContent = `${index + 1} / ${gallery.length}`;
    previous.disabled = index === 0;
    next.disabled = index === gallery.length - 1;
    image.src = item.src;
    onIndexChange?.(index);
  }
  const percent = h("output", { class: "diagram-scale", "aria-label": "缩放比例" });
  let width = 0, height = 0, scale = 1, x = 0, y = 0, closed = false;
  const pointers = new Map();
  const paint = () => {
    image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    percent.textContent = `${Math.round(scale * 100)}%`;
  };
  const fitScale = () => Math.min(1, stage.clientWidth / width, stage.clientHeight / height);
  const center = (s) => {
    if (!width) return;
    scale = s;
    x = (stage.clientWidth - width * scale) / 2;
    y = (stage.clientHeight - height * scale) / 2;
    paint();
  };
  const fit = () => center(fitScale());
  const zoom = (next, cx = stage.clientWidth / 2, cy = stage.clientHeight / 2) => {
    if (!width) return;
    next = Math.max(Math.min(fitScale(), 0.1), Math.min(16, next));
    const ratio = next / scale;
    x = cx - (cx - x) * ratio;
    y = cy - (cy - y) * ratio;
    scale = next;
    paint();
  };
  const control = (label, text, onclick) => h("button", { class: "btn ghost", "aria-label": label, title: label, onclick }, text);
  const close = () => {
    if (closed) return;
    closed = true;
    resize.disconnect();
    if (dialog.open) dialog.close();
    dialog.remove();
    if (owner._closePreview === close) delete owner._closePreview;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  };
  dialog.append(
    h("div", { class: "diagram-viewer-head" }, heading, control(`关闭${kind}预览`, "关闭", close)),
    stage,
    gallery ? detail : null,
    gallery ? h("div", { class: "photo-navigation" }, previous, count, next) : null,
    h("div", { class: "diagram-viewer-controls" },
      control(`缩小${kind}`, "−", () => zoom(scale / 1.25)), percent,
      control(`放大${kind}`, "+", () => zoom(scale * 1.25)),
      control("适应窗口", "适应窗口", fit), control("原始大小", "原始大小", () => center(1)),
      download ? h("a", { class: "btn ghost", href: download, download: title }, "下载") : null),
    h("div", { class: "diagram-viewer-hint" }, gallery ? "左右滑动切换 · 双指 / 滚轮缩放 · 放大后拖动 · Esc 关闭" : "滚轮 / 双指缩放 · 拖动查看 · Esc 关闭"),
  );
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.clientHeight : 1);
    zoom(scale * Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.002), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });
  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || pointers.size >= 2) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    swipe = gallery && pointers.size === 1 && width && scale <= fitScale() * 1.01 ? { x: e.clientX, y: e.clientY } : null;
    stage.setPointerCapture(e.pointerId);
    stage.classList.add("dragging");
  });
  stage.addEventListener("pointermove", (e) => {
    const old = pointers.get(e.pointerId);
    if (!old) return;
    const other = [...pointers.entries()].find(([id]) => id !== e.pointerId)?.[1];
    if (swipe && !other) return;
    if (other) {
      const before = Math.hypot(old.x - other.x, old.y - other.y);
      const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      const rect = stage.getBoundingClientRect();
      if (before > 0) zoom(scale * after / before, (old.x + other.x) / 2 - rect.left, (old.y + other.y) / 2 - rect.top);
      x += (e.clientX - old.x) / 2;
      y += (e.clientY - old.y) / 2;
    } else {
      x += e.clientX - old.x;
      y += e.clientY - old.y;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    paint();
  });
  const release = (e) => {
    if (swipe && e.type === "pointerup") {
      const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) show(index + (dx < 0 ? 1 : -1));
    }
    swipe = null;
    pointers.delete(e.pointerId);
    if (!pointers.size) stage.classList.remove("dragging");
  };
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) stage.addEventListener(event, release);
  dialog.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (gallery && ["ArrowLeft", "ArrowRight"].includes(e.key)) {
      e.preventDefault();
      show(index + (e.key === "ArrowRight" ? 1 : -1));
    }
    if (["+", "=", "-", "0"].includes(e.key)) {
      e.preventDefault();
      if (e.key === "0") fit();
      else zoom(scale * (e.key === "-" ? 0.8 : 1.25));
    }
  });
  dialog.addEventListener("click", (e) => { if (e.target === dialog) close(); });
  dialog.addEventListener("close", close);
  const resize = new ResizeObserver(() => {
    if (!dialog.isConnected) close();
    else fit();
  });
  image.addEventListener("load", () => {
    status.textContent = notice;
    image.style.visibility = "";
    width = image.naturalWidth;
    height = image.naturalHeight;
    image.style.width = `${width}px`;
    image.style.height = `${height}px`;
    fit();
  });
  image.addEventListener("error", () => {
    if (fallback && image.getAttribute("src") !== fallback) {
      notice = status.textContent = "预览不可用，显示缩略图";
      image.src = fallback;
    } else status.textContent = `${kind}无法加载`;
  });
  // 随消息销毁；关闭时释放观察器并恢复键盘焦点。
  owner._closePreview = close;
  owner.append(dialog);
  dialog.showModal();
  if (gallery) show(start);
  else image.src = src;
  resize.observe(stage);
}
