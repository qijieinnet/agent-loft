import { h, icon } from "./dom.js";
import { ui } from "../state.js";

export function showMenu(anchor, items) {
  closeMenu();
  const menu = h(
    "div",
    { class: "menu" },
    items.map((it) =>
      it === "sep"
        ? h("div", { class: "sep" })
        : h(
            "button",
            {
              class: [it.danger ? "danger" : "", it.class ?? ""].join(" ").trim(),
              onclick: () => {
                closeMenu();
                it.onclick();
              },
            },
            it.label,
          ),
    ),
  );
  document.body.append(menu);
  // anchor 可以是元素（贴着它下沿弹出），也可以是 {x, y}（右键菜单，贴着鼠标弹出）
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y };
  const w = menu.offsetWidth;
  menu.style.top = `${Math.max(8, Math.min(r.bottom + (anchor instanceof Element ? 4 : 0), innerHeight - menu.offsetHeight - 8))}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  ui.menu = menu;
  setTimeout(() => {
    document.addEventListener("pointerdown", onOutsideMenu);
    document.addEventListener("keydown", onMenuKey);
    addEventListener("blur", closeMenu);
  }, 0);
}

function onMenuKey(e) {
  if (e.key === "Escape") closeMenu();
}

function onOutsideMenu(e) {
  // 点的是打开它的那个按钮：交给按钮自己的 onclick 去收起，免得先关再开
  if (ui.menu && !ui.menu.contains(e.target) && !ui.menu.anchor?.contains(e.target)) closeMenu();
}

export function closeMenu() {
  ui.menu?.onMenuClose?.();
  ui.menu?.remove();
  ui.menu = null;
  document.removeEventListener("pointerdown", onOutsideMenu);
  document.removeEventListener("keydown", onMenuKey);
  removeEventListener("blur", closeMenu);
}

/** beforeClose：点 × 或点外面关闭前先问它，返回（或 resolve 成）false 就不关。返回的 close 不问，直接关 */
export function modal({ title, body, foot, wide, tall, className = "", beforeClose }) {
  const close = () => overlay.remove();
  const tryClose = async () => {
    if (!beforeClose || (await beforeClose()) !== false) close();
  };
  const overlay = h(
    "div",
    { class: "overlay", onclick: (e) => e.target === overlay && void tryClose() },
    h(
      "div",
      { class: `modal${wide ? " wide" : ""}${tall ? " tall" : ""}${className ? ` ${className}` : ""}` },
      h("div", { class: "modal-head" }, h("h3", {}, title), h("button", { class: "icon-btn", onclick: () => void tryClose() }, icon("x"))),
      body,
      foot ?? null,
    ),
  );
  document.body.append(overlay);
  return close;
}

/** 贴着按钮弹出的小面板（默认在按钮上方、右对齐），点外面关闭。复用 .menu 的关闭逻辑 */
export function showPopover(anchor, { place = "above", align = "right" } = {}) {
  closeMenu();
  const pop = h("div", { class: "menu popover" });
  pop.anchor = anchor;
  pop.dataset.place = place;
  pop.dataset.align = align;
  document.body.append(pop);
  ui.menu = pop;
  setTimeout(() => {
    if (ui.menu !== pop) return;
    document.addEventListener("pointerdown", onOutsideMenu);
    document.addEventListener("keydown", onMenuKey);
    addEventListener("blur", closeMenu);
  }, 0);
  return pop;
}

export function placePopover(pop, anchor) {
  if (!pop.isConnected || !anchor.isConnected) return;
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const left = pop.dataset.align === "left" ? r.left : r.right - w;
  pop.style.left = `${Math.max(8, Math.min(left, innerWidth - w - 8))}px`;
  if (pop.dataset.place === "below") {
    pop.style.top = `${Math.min(r.bottom + 6, innerHeight - pop.offsetHeight - 8)}px`;
    pop.style.bottom = "";
  } else {
    pop.style.bottom = `${innerHeight - r.top + 6}px`;
    pop.style.top = "";
  }
}

/**
 * 确认弹窗（替代浏览器自带的 confirm），样式和重命名弹窗一致。
 * 回车确认、Esc / 点外面取消；resolve 成 true / false
 */
/** altText：给了就多一个按钮，点它返回 "alt"（确定返回 true，取消返回 false） */
export function confirmDialog({ title, message, sub, confirmText = "确定", danger = false, altText }) {
  return new Promise((resolve) => {
    const ok = h("button", { class: `btn ${danger ? "danger-fill" : "primary"}` }, confirmText);
    const cancel = h("button", { class: "btn ghost" }, "取消");
    const alt = altText ? h("button", { class: "btn", onclick: () => done("alt") }, altText) : null;
    const done = (v) => {
      overlay.classList.add("leaving");
      setTimeout(() => overlay.remove(), 120);
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        done(false);
      } else if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        done(true);
      }
    };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    const overlay = h(
      "div",
      { class: "overlay dialog-overlay", onclick: (e) => e.target === overlay && done(false) },
      h(
        "div",
        { class: "dialog confirm-dialog" },
        h("h3", {}, title),
        sub ? h("p", { class: "dialog-sub" }, sub) : null,
        message ? h("p", { class: "dialog-msg" }, message) : null,
        h("div", { class: "dialog-foot" }, cancel, alt, ok),
      ),
    );
    document.body.append(overlay);
    document.addEventListener("keydown", onKey, true);
    ok.focus();
  });
}
