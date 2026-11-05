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
        : it.children
          ? submenuButton(it, { class: it.class ?? "" }, it.label)
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

/** 离开后留一点时间，鼠标从菜单项斜着移到子菜单时不会收起来 */
const SUBMENU_LEAVE_MS = 200;

/**
 * 带子菜单的一项：it.children 是 { label, leading?, onclick }。鼠标悬停展开，点击也能展开（触屏没有悬停）。
 * it.disabled 时只显示不能点。children 里的项点了之后关掉整个菜单。
 */
export function submenuButton(it, attrs, ...content) {
  let timer = null;
  let hovering = false;
  const isOpen = () => ui.submenu?.trigger === button;
  const cancelLeave = () => clearTimeout(timer);
  const leaveSoon = () => {
    cancelLeave();
    timer = setTimeout(() => {
      hovering = false;
      if (isOpen()) closeSubmenu();
    }, SUBMENU_LEAVE_MS);
  };
  const open = () => {
    cancelLeave();
    if (isOpen()) return;
    closeSubmenu();
    const sub = h(
      "div",
      { class: "menu submenu", role: "menu", onpointerenter: cancelLeave, onpointerleave: (e) => e.pointerType === "mouse" && leaveSoon() },
      it.children.map((c) =>
        h(
          "button",
          {
            role: "menuitem",
            onclick: () => {
              closeMenu();
              c.onclick();
            },
          },
          c.leading ?? null,
          h("span", { class: "grow" }, c.label),
        ),
      ),
    );
    sub.trigger = button;
    document.body.append(sub);
    ui.submenu = sub;
    button.setAttribute("aria-expanded", "true");
    const r = button.getBoundingClientRect();
    const w = sub.offsetWidth;
    const subH = sub.offsetHeight;
    const clampTop = (y) => Math.max(8, Math.min(y, innerHeight - subH - 8));
    const right = r.right + 4;
    const left = r.left - w - 4;
    if (right + w <= innerWidth - 8) {
      sub.style.left = `${right}px`;
      sub.style.top = `${clampTop(r.top - 6)}px`;
    } else if (left >= 8) {
      sub.style.left = `${left}px`;
      sub.style.top = `${clampTop(r.top - 6)}px`;
    } else {
      // 手机上两边都放不下：放在这一项的下方（放不下就上方），不能盖住它，要留着点它收起
      sub.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
      sub.style.top = `${clampTop(r.bottom + subH + 12 <= innerHeight ? r.bottom + 4 : r.top - subH - 4)}px`;
    }
  };
  const button = h(
    "button",
    {
      ...attrs,
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      disabled: it.disabled ? true : null,
      title: it.disabled ? it.disabledReason : null,
      onpointerenter: (e) => {
        if (e.pointerType !== "mouse") return;
        hovering = true;
        open();
      },
      onpointerleave: (e) => e.pointerType === "mouse" && leaveSoon(),
      onclick: (e) => {
        e.stopPropagation();
        // 悬停已经打开了：这次点击不收起。触屏和键盘再点一次才收起
        if (isOpen() && !hovering) return closeSubmenu();
        open();
        // 键盘按回车打开的（detail 是 0）：焦点移进子菜单
        if (e.detail === 0) ui.submenu?.querySelector("button")?.focus();
      },
    },
    ...content,
    h("span", { class: "submenu-arrow", "aria-hidden": "true" }, "›"),
  );
  return button;
}

function closeSubmenu() {
  ui.submenu?.trigger?.setAttribute("aria-expanded", "false");
  ui.submenu?.remove();
  ui.submenu = null;
}

function onMenuKey(e) {
  if (e.key === "Escape") closeMenu();
}

function onOutsideMenu(e) {
  // 点的是打开它的那个按钮：交给按钮自己的 onclick 去收起，免得先关再开
  if (ui.menu && !ui.menu.contains(e.target) && !ui.submenu?.contains(e.target) && !ui.menu.anchor?.contains(e.target)) closeMenu();
}

export function closeMenu() {
  closeSubmenu();
  ui.menu?.onMenuClose?.();
  ui.menu?.remove();
  ui.menu = null;
  document.removeEventListener("pointerdown", onOutsideMenu);
  document.removeEventListener("keydown", onMenuKey);
  removeEventListener("blur", closeMenu);
}

/** 弹窗只通过按钮关闭，点击遮罩不关闭。beforeClose：点 × 前先问它，false 就不关。返回的 close 直接关 */
export function modal({ title, body, foot, wide, tall, className = "", beforeClose }) {
  const close = () => overlay.remove();
  const tryClose = async () => {
    if (!beforeClose || (await beforeClose()) !== false) close();
  };
  const overlay = h(
    "div",
    { class: "overlay" },
    h(
      "div",
      { class: `modal${wide ? " wide" : ""}${tall ? " tall" : ""}${className ? ` ${className}` : ""}` },
      h("div", { class: "modal-head" }, h("h3", {}, title), h("button", { class: "icon-btn", "aria-label": "关闭", onclick: () => void tryClose() }, icon("x"))),
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
 * 回车确认，点击取消按钮取消；resolve 成 true / false
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
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        done(true);
      }
    };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    const overlay = h(
      "div",
      { class: "overlay dialog-overlay" },
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
