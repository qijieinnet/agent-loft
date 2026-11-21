import { fill, h, icon } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { contentHash, isAdmin, ui } from "../state.js";
import { closeMenu, confirmDialog } from "../lib/overlay.js";
import { closeSide, openSide, renderSidebar } from "../views/sidebar.js";
import { syncDesktopMenu } from "../views/topbar.js";
import { WS } from "../lib/ws.js";
import { hasDirty, markDirty } from "./common.js";
import { directory, resolvePage, searchDirectory, sections } from "./tabs.js";

const areas = { settings: "设置", assistants: "助手中心" };
const storageKeys = { settings: "aim.settingsTab", assistants: "aim.assistantTab" };
const narrow = matchMedia("(max-width: 768px)");

function beforeUnload(event) {
  if (ui.settings?.isDirty()) {
    event.preventDefault();
    event.returnValue = true;
  }
}

export function openAssistants() {
  return openSettings(undefined, "assistants");
}

export async function openSettings(requested, area = "settings") {
  closeSide();
  closeMenu();
  if (ui.settings) return ui.settings.selectTab(requested, area);
  const pages = directory.filter(p => !p.admin || isAdmin());
  const previousHash = contentHash();
  const previousFocus = document.activeElement;
  const scrollTop = ui.messages?.scrollTop;
  let active, page, pendingConfig, editFocus;
  let confirming = false;
  let navScroll = 0;

  const isDirty = () => Boolean(page?.isConnected && hasDirty(page));
  async function leaveOk() {
    if (!isDirty()) return true;
    if (confirming) return false;
    confirming = true;
    try {
      return await confirmDialog({ title: "有修改还没保存", message: "现在离开，这一页刚才改的内容不会保存。", confirmText: "不保存", danger: true });
    } finally {
      confirming = false;
    }
  }
  async function close() {
    if (!(await leaveOk()) || ui.settings !== settings) return false;
    window.removeEventListener("beforeunload", beforeUnload);
    narrow.removeEventListener("change", resize);
    const returnHash = contentHash();
    const { settingsReturnHash, ...state } = history.state ?? {};
    history.replaceState(state, "", location.pathname + location.search + returnHash);
    pane.remove();
    ui.settings = null;
    syncDesktopMenu();
    renderSidebar();
    WS.presence();
    if (ui.messages && previousHash === returnHash) ui.messages.scrollTop = scrollTop;
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    return true;
  }

  const title = h("h1", { tabindex: "-1" });
  const back = h("button", { class: "btn settings-directory-back", onclick: showDirectory }, icon("back"), "目录");
  const search = h("input", { type: "search", autocomplete: "off", "aria-label": "搜索设置和工具", placeholder: "搜索设置和工具", oninput: drawNav });
  const status = h("span", { class: "settings-sr", role: "status" });
  const list = h("div", { class: "settings-links" });
  search.addEventListener("keydown", event => {
    if (event.isComposing || !search.value.trim()) return;
    const results = list.querySelectorAll("button");
    if (event.key === "Escape") {
      event.preventDefault();
      search.value = "";
      drawNav();
    } else if (event.key === "ArrowDown" && results.length) {
      event.preventDefault();
      results[0].focus();
    } else if (event.key === "Enter" && results.length === 1) {
      event.preventDefault();
      results[0].click();
    }
  });
  const nav = h("nav", { class: "settings-nav" }, h("label", { class: "settings-search" }, icon("search"), search), status, list);
  const panel = h("div", { class: "settings-body" });
  const pane = h("main", { class: "settings-view" },
    h("header", { class: "settings-header" },
      h("button", { class: "icon-btn menu-btn", onclick: openSide, title: "会话列表" }, icon("menu")),
      back, title, h("span", { class: "grow" }),
      h("button", { class: "icon-btn", onclick: close, "aria-label": "返回原页面", title: "返回原页面" }, icon("x"))),
    h("div", { class: "settings" }, nav, panel));
  const settings = { area, close, isDirty, selectTab: select };
  ui.settings = settings;
  ui.layout.append(pane);
  window.addEventListener("beforeunload", beforeUnload);
  narrow.addEventListener("change", resize);
  for (const type of ["input", "change"]) panel.addEventListener(type, e => {
    if (!e.target.closest("[data-nodirty]")) markDirty(e.target.closest("[data-form]"));
  });
  function resize() {
    if (!narrow.matches && pane.classList.contains("at-directory")) {
      void select(active?.id || pages.find(p => p.area === settings.area).id);
    }
  }
  function drawNav() {
    const query = search.value.trim();
    const available = pages.filter(p => p.area === settings.area);
    const results = query ? searchDirectory(settings.area === "settings" ? pages : available, query) : available.map(page => ({ page, label: page.label }));
    const nodes = [];
    let lastGroup;
    for (const { page: item, section, label } of results) {
      if (!query && item.group !== lastGroup && settings.area !== "assistants") nodes.push(h("h2", { class: "settings-group" }, item.group));
      lastGroup = item.group;
      nodes.push(h("button", {
        class: "settings-nav-link", "data-page": item.id, "aria-current": item === active && !query ? "page" : null,
        onclick: () => select([item.id, section].filter(Boolean).join("/")),
      }, icon(item.icon), h("span", {}, label, query ? h("small", {}, [item.group, item.label === label ? "" : item.label].filter(Boolean).join(" › ")) : null)));
    }
    fill(list, ...nodes, results.length ? null : h("p", { class: "muted" }, "没有匹配项，试试其他关键词。"));
    status.textContent = query ? `找到 ${results.length} 项` : "";
  }

  function setRoute(route) {
    history.replaceState({ ...history.state, settingsReturnHash: contentHash() }, "", "#" + route);
  }
  function setArea(next) {
    if (next !== settings.area) { search.value = ""; navScroll = 0; }
    settings.area = next;
    title.textContent = areas[next];
    nav.setAttribute("aria-label", areas[next] + "目录");
    pane.setAttribute("aria-label", areas[next]);
    renderSidebar();
    syncDesktopMenu();
  }
  function showDirectory() {
    if (panel.contains(document.activeElement)) editFocus = document.activeElement;
    pane.classList.add("at-directory");
    setRoute(settings.area);
    drawNav();
    nav.scrollTop = navScroll;
    (list.querySelector('[aria-current="page"]') || search).focus({ preventScroll: true });
  }
  function revealSection(content, key) {
    if (!key || pane.classList.contains("at-directory")) return false;
    const target = content.querySelector(`[data-section="${key}"]`);
    if (!target) return false;
    const disclosure = target.closest("details");
    if (disclosure) disclosure.open = true;
    if (!target.matches("input,select,button,textarea")) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "nearest" });
    return true;
  }
  function showActivePage() {
    if (pane.classList.contains("at-directory")) navScroll = nav.scrollTop;
    pane.classList.remove("at-directory");
    setRoute([active.area, active.id, page.dataset.section].filter(Boolean).join("/"));
    (editFocus?.isConnected ? editFocus : panel.querySelector("h2"))?.focus({ preventScroll: true });
  }
  async function select(name, preferredArea = "settings") {
    const implicit = !name;
    const stored = localStorage.getItem(storageKeys[preferredArea]);
    const route = resolvePage(name || stored, isAdmin()) || "";
    const [id, anchor] = route.split("/");
    const item = pages.find(p => p.id === id) || pages.find(p => p.area === preferredArea);
    const section = sections[item.id]?.find(([key]) => key === anchor)?.[0];
    if (implicit && stored && preferredArea !== item.area) localStorage.removeItem(storageKeys[preferredArea]);
    if (implicit && narrow.matches && item.area === "settings" && (!stored || stored === id)) {
      if (settings.area !== item.area) {
        if (!(await leaveOk()) || !pane.isConnected) return;
        page = null;
        fill(panel);
      }
      setArea(item.area);
      active = page ? active : item;
      return showDirectory();
    }
    const target = section && page?.querySelector(`[data-section="${section}"]`);
    if (active === item && page && (!section || target)) {
      if (section) page.dataset.section = section;
      showActivePage();
      revealSection(page, section);
      return;
    }
    if (!(await leaveOk()) || !pane.isConnected) {
      if (pane.isConnected && pane.classList.contains("at-directory") && page) showActivePage();
      return;
    }
    if (pane.classList.contains("at-directory")) navScroll = nav.scrollTop;
    setArea(item.area);
    active = item;
    localStorage.setItem(storageKeys[item.area], item.id);
    pane.classList.remove("at-directory");
    const routeId = [item.area, item.id, section].filter(Boolean).join("/");
    setRoute(routeId);
    drawNav();
    const heading = h("h2", { class: "settings-page-title", tabindex: "-1" }, item.label);
    const content = h("div", { class: "settings-page", "aria-busy": "true" }, h("span", { class: "spinner", role: "status", "aria-label": "加载设置" }));
    editFocus = null;
    page = content;
    if (section) content.dataset.section = section;
    fill(panel, heading, content);
    panel.scrollTop = 0;
    heading.focus({ preventScroll: true });
    try {
      if (item.config) pendingConfig ??= api("/api/config").catch(err => { pendingConfig = null; throw err; });
      const [module, cfg] = await Promise.all([item.load(), item.config ? pendingConfig : null]);
      if (!content.isConnected) return;
      fill(content);
      if (item.config) await module[item.method](cfg, content, section);
      else await module[item.method](content, section);
      if (content.isConnected) revealSection(content, content.dataset.section);
    } catch (err) {
      if (content.isConnected) fill(content, h("p", { class: "error-text", role: "alert" }, err.message),
        h("button", { class: "btn", onclick: () => { active = null; void select(routeId.split("/").slice(1).join("/")); } }, "重试"));
    } finally {
      content.removeAttribute("aria-busy");
    }
  }
  WS.presence();
  await select(requested, area);
}
