import { fill, h, icon, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { closeMenu, modal, showPopover } from "../lib/overlay.js";
import { remoteTabs, S, ui } from "../state.js";

const ITEMS = [
  { id: "search", label: "搜索", icon: "search" },
  { id: "tasks", label: "定时任务", icon: "clock" },
  { id: "library", label: "资料库", icon: "library" },
  { id: "remote", label: "远程控制", icon: "monitor" },
  { id: "settings", label: "设置", icon: "gear" },
];
let actions = {};
let navSignature = "";
let hoverTimer = 0;
let pinned = false;

function configuredItems() {
  const seen = new Set();
  const items = [];
  for (const saved of S.sidebarNav ?? []) {
    const item = ITEMS.find((it) => it.id === saved.id);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push({ ...item, visible: saved.visible !== false });
  }
  return [...items, ...ITEMS.filter((it) => !seen.has(it.id)).map((it) => ({ ...it, visible: it.id !== "settings" }))];
}

const available = (item) => item.id !== "remote" || remoteTabs().length > 0;
const isActive = (item) => ["tasks", "library", "remote"].includes(item.id) && S.view === item.id;
const remoteLive = () => S.remoteLive.desktop || S.remoteLive.terminals > 0;

function navButton(item, inMenu = false) {
  return h(
    "button",
    {
      class: inMenu ? "pop-item side-nav-item" : `btn new-chat side-nav${item.id === "search" ? " search-nav" : ""}`,
      "data-nav": item.id,
      role: inMenu ? "menuitem" : null,
      onclick: () => {
        closeMenu();
        actions[item.id]?.();
      },
    },
    icon(item.icon),
    h("span", { class: "grow" }, item.label),
    item.id === "remote" ? h("span", { class: "live-dot", title: "在后台连着" }) : null,
  );
}

export function createSidebarNav(handlers) {
  actions = handlers;
  navSignature = "";
  ui.sidebarNav = h("nav", { class: "sidebar-nav", "aria-label": "侧边栏菜单" });
  syncSidebarNav();
  return ui.sidebarNav;
}

/** 会话重绘时只更新选中和连接状态，配置或权限变化时才重建入口。 */
export function syncSidebarNav() {
  if (!ui.sidebarNav) return;
  const items = configuredItems();
  const signature = JSON.stringify([items, remoteTabs().length > 0]);
  if (signature !== navSignature) {
    if (ui.menu?.dataset.for === "sidebar-more") closeMenu();
    clearTimeout(hoverTimer);
    navSignature = signature;
    const direct = items.filter((it) => it.visible && available(it)).map((it) => {
      const button = navButton(it);
      ui[`${it.id}Nav`] = button;
      return button;
    });
    const more = h(
      "button",
      {
        class: "btn new-chat side-nav side-more",
        id: "sidebar-more",
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        onclick: () => {
          clearTimeout(hoverTimer);
          if (ui.menu?.anchor === more) {
            if (!pinned) pinned = true;
            else closeMenu();
          } else openMore(more, true);
        },
        onpointerenter: (e) => {
          if (e.pointerType !== "mouse") return;
          clearTimeout(hoverTimer);
          if (ui.menu?.anchor !== more) hoverTimer = setTimeout(() => openMore(more, false), 200);
        },
        onpointerleave: (e) => e.pointerType === "mouse" && scheduleClose(),
        onkeydown: (e) => {
          if (e.key !== "ArrowDown") return;
          e.preventDefault();
          openMore(more, true);
          ui.menu?.querySelector("button")?.focus();
        },
      },
      icon("more"),
      h("span", { class: "grow" }, "更多"),
      h("span", { class: "live-dot", title: "远程控制在后台连着" }),
    );
    ui.sideMore = more;
    fill(ui.sidebarNav, ...direct, more);
  }
  for (const container of [ui.sidebarNav, ui.menu?.dataset.for === "sidebar-more" ? ui.menu : null]) {
    for (const button of container?.querySelectorAll("[data-nav]") ?? []) {
      button.classList.toggle("active", isActive({ id: button.dataset.nav }));
      button.classList.toggle("live", button.dataset.nav === "remote" && remoteLive());
    }
  }
  const folded = items.filter((it) => !it.visible && available(it));
  ui.sideMore.classList.toggle("active", folded.some(isActive));
  ui.sideMore.classList.toggle("live", folded.some((it) => it.id === "remote") && remoteLive());
}

function scheduleClose() {
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    if (!pinned && ui.menu?.dataset.for === "sidebar-more") closeMenu();
  }, 200);
}

function openMore(anchor, pin) {
  if (!anchor.isConnected) return;
  clearTimeout(hoverTimer);
  const pop = showPopover(anchor);
  pop.classList.add("side-more-menu");
  pop.dataset.for = "sidebar-more";
  pop.setAttribute("role", "menu");
  pop.setAttribute("aria-label", "更多菜单");
  pinned = pin;
  anchor.setAttribute("aria-expanded", "true");
  pop.onMenuClose = () => {
    clearTimeout(hoverTimer);
    anchor.setAttribute("aria-expanded", "false");
  };
  pop.onpointerenter = () => clearTimeout(hoverTimer);
  pop.onpointerleave = (e) => e.pointerType === "mouse" && scheduleClose();
  pop.onkeydown = (e) => {
    const buttons = [...pop.querySelectorAll("button")];
    const i = buttons.indexOf(document.activeElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      anchor.focus();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  };
  const folded = configuredItems().filter((it) => !it.visible && available(it));
  fill(
    pop,
    ...folded.map((it) => navButton(it, true)),
    folded.length ? h("div", { class: "sep" }) : null,
    h("button", { class: "pop-item", role: "menuitem", onclick: () => (closeMenu(), editSidebar()) }, icon("edit"), "编辑侧边栏"),
  );
  syncSidebarNav();
  const r = anchor.getBoundingClientRect();
  const width = pop.offsetWidth;
  const side = innerWidth > 768 && r.right + width + 16 <= innerWidth;
  pop.style.left = `${Math.max(8, Math.min(side ? r.right + 8 : r.left, innerWidth - width - 8))}px`;
  pop.style.top = `${Math.max(8, Math.min(side ? r.top : r.bottom + 6, innerHeight - pop.offsetHeight - 8))}px`;
}

function editSidebar() {
  const draft = configuredItems();
  const list = h("div", { class: "sidebar-edit-list", role: "list", "aria-label": "菜单显示与顺序" });
  const rows = new Map();
  let saving = false;
  const move = (id, to) => {
    const from = draft.findIndex((it) => it.id === id);
    if (from === to || to < 0 || to >= draft.length) return;
    draft.splice(to, 0, ...draft.splice(from, 1));
    for (const it of draft) list.append(rows.get(it.id));
  };
  for (const item of draft) {
    const checkbox = h("input", {
      type: "checkbox",
      checked: item.visible,
      onchange: () => (item.visible = checkbox.checked),
    });
    let drag = null;
    const endDrag = () => {
      drag = null;
      row.classList.remove("dragging");
      if (handle.hasPointerCapture(dragPointer)) handle.releasePointerCapture(dragPointer);
    };
    let dragPointer = 0;
    const handle = h("button", {
      class: "sidebar-edit-grip",
      type: "button",
      title: "拖动排序，也可用上下方向键调整",
      "aria-label": `调整${item.label}顺序`,
      onpointerdown: (e) => {
        if (e.button !== 0 || saving) return;
        e.preventDefault();
        drag = { y: e.clientY };
        dragPointer = e.pointerId;
        handle.setPointerCapture(e.pointerId);
      },
      onpointermove: (e) => {
        if (!drag || Math.abs(e.clientY - drag.y) < 4) return;
        row.classList.add("dragging");
        const to = draft.filter((it) => it.id !== item.id).filter((it) => {
          const r = rows.get(it.id).getBoundingClientRect();
          return e.clientY > r.top + r.height / 2;
        }).length;
        move(item.id, to);
        handle.setPointerCapture(e.pointerId);
      },
      onpointerup: endDrag,
      onpointercancel: endDrag,
      onkeydown: (e) => {
        if (saving || !["ArrowUp", "ArrowDown"].includes(e.key)) return;
        e.preventDefault();
        move(item.id, draft.indexOf(item) + (e.key === "ArrowUp" ? -1 : 1));
        handle.focus();
      },
    }, "⋮⋮");
    const row = h(
      "div", { class: "sidebar-edit-row", role: "listitem", "data-nav": item.id },
      h("label", {}, checkbox, icon(item.icon), h("span", { class: "grow" }, item.label)),
      handle,
    );
    rows.set(item.id, row);
    list.append(row);
  }
  const body = h("div", { class: "modal-body" }, h("p", { class: "sidebar-edit-hint" }, "勾选的菜单直接显示，未勾选的收进「更多」。拖动右侧手柄调整顺序。"), list);
  const close = () => {
    if (saving) return;
    document.removeEventListener("keydown", onKey, true);
    dismiss();
    ui.sideMore?.focus();
  };
  const onKey = (e) => {
    if (e.key === "Tab") {
      const focusable = [...dialog.querySelectorAll("button:not(:disabled), input:not(:disabled)")];
      const edge = e.shiftKey ? focusable[0] : focusable.at(-1);
      if (document.activeElement === edge) {
        e.preventDefault();
        (e.shiftKey ? focusable.at(-1) : focusable[0])?.focus();
      }
      return;
    }
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const done = h("button", {
    class: "btn primary",
    onclick: async () => {
      if (saving) return;
      saving = true;
      done.disabled = true;
      done.textContent = "保存中…";
      list.inert = true;
      try {
        const items = draft.map(({ id, visible }) => ({ id, visible }));
        const result = await api("/api/ui/sidebar-nav", { method: "PUT", body: { items } });
        S.sidebarNav = result.items;
        syncSidebarNav();
        saving = false;
        close();
      } catch (err) {
        toast(`侧边栏保存失败：${err.message}`);
      } finally {
        saving = false;
        done.disabled = false;
        done.textContent = "完成";
        list.inert = false;
      }
    },
  }, "完成");
  const dismiss = modal({
    title: "编辑侧边栏",
    className: "sidebar-editor",
    body,
    foot: h("div", { class: "modal-foot" }, h("button", { class: "btn ghost", onclick: close }, "取消"), done),
    beforeClose: () => {
      if (saving) return false;
      close();
      return false;
    },
  });
  const dialog = body.closest(".modal");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "编辑侧边栏");
  dialog.querySelector(".modal-head .icon-btn").setAttribute("aria-label", "关闭");
  document.addEventListener("keydown", onKey, true);
  list.querySelector("input")?.focus();
}
