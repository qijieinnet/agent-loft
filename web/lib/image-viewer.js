import { fill, h, icon } from "./dom.js";

/** 图片与图表共用预览：SVG 保持图片隔离，普通图片沿用同一套缩放与拖动。 */
export function openImageViewer(owner, src, title, trigger, { kind = "图表", download, gallery, start = 0, onIndexChange } = {}) {
  owner._closePreview?.();
  const dialog = h("dialog", { class: `diagram-viewer${gallery ? " photo-viewer" : ""}`, "aria-label": `${kind}预览` });
  const image = h("img", { alt: title, draggable: "false" });
  const status = h("div", { class: "diagram-viewer-status photo-status", role: "status" });
  const stage = h("div", { class: `diagram-stage${gallery ? " photo-stage" : ""}`, "aria-label": "拖动查看，滚轮或双指缩放" }, image, status);
  const heading = h("strong", { class: "photo-name", title }, title);
  const detail = h("div", { class: "photo-detail" });
  const count = h("span", { class: "photo-count", "aria-live": "polite" });
  const previous = h("button", { class: "viewer-button viewer-prev", "aria-label": "上一张照片", title: "上一张照片", onclick: () => show(index - 1) }, icon("back"));
  const next = h("button", { class: "viewer-button viewer-next", "aria-label": "下一张照片", title: "下一张照片", onclick: () => show(index + 1) }, icon("back"));
  let index = start, fallback = "", notice = "", swipe;
  function show(n) {
    n = Math.max(0, Math.min(n, gallery.length - 1));
    if (n === index && width) return;
    index = n;
    const item = gallery[index];
    width = height = 0;
    image.style.visibility = "hidden";
    stage.dataset.loading = "true";
    notice = status.textContent = "";
    fallback = item.fallback;
    image.alt = heading.textContent = item.title;
    heading.title = item.title;
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
  // 图表是矢量图，打开时充分利用画布；照片保留原始分辨率上限。
  const fitScale = () => Math.min(kind === "图表" ? 16 : 1, stage.clientWidth / width, stage.clientHeight / height);
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
  const control = (label, content, onclick, className = "") => h("button", { class: `viewer-button ${className}`, "aria-label": label, title: label, onclick }, content);
  const close = () => {
    if (closed) return;
    closed = true;
    resize.disconnect();
    if (dialog.open) dialog.close();
    dialog.remove();
    if (owner._closePreview === close) delete owner._closePreview;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  };
  fill(dialog,
    h("div", { class: "diagram-viewer-head" },
      h("div", { class: "viewer-meta" }, heading, gallery ? detail : null),
      gallery ? count : null,
      h("div", { class: "viewer-actions" },
        download ? h("a", { class: "viewer-button", href: download, download: title, "aria-label": "下载", title: "下载" },
          h("span", { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/></svg>' })) : null,
        control(`关闭${kind}预览`, icon("x"), close, "viewer-close"))),
    stage,
    gallery ? [previous, next] : null,
    h("div", { class: "diagram-viewer-controls", role: "toolbar", "aria-label": "缩放控制" },
      control(`缩小${kind}`, icon("minus"), () => zoom(scale / 1.25)),
      control("原始大小", percent, () => center(1), "viewer-original"),
      control(`放大${kind}`, icon("plus"), () => zoom(scale * 1.25)),
      h("span", { class: "viewer-divider", "aria-hidden": "true" }),
      control("适应窗口", icon("expand"), fit)),
  );
  stage.addEventListener("dblclick", () => {
    if (width) Math.abs(scale - fitScale()) < 0.001 ? center(1) : fit();
  });
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
    delete stage.dataset.loading;
    status.textContent = notice;
    image.style.visibility = "";
    width = image.naturalWidth;
    height = image.naturalHeight;
    image.style.width = `${width}px`;
    image.style.height = `${height}px`;
    fit();
  });
  image.addEventListener("error", () => {
    delete stage.dataset.loading;
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
