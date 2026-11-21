import { fill, h, icon } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { contentHash, isAdmin, ui } from "../state.js";
import { closeMenu, confirmDialog } from "../lib/overlay.js";
import { closeSide, renderSidebar } from "../views/sidebar.js";
import { syncDesktopMenu } from "../views/topbar.js";
import { WS } from "../lib/ws.js";
import { hasDirty, markDirty } from "./common.js";
import { directory, resolvePage, searchDirectory, sections } from "./tabs.js";

const settingsRoute = /^#(?:assistants|settings)(?:\/(.*))?$/;

// 旧入口仍可直接进入专家设置。
export function openAssistants() {
  return openSettings(undefined, "assistants");
}

export async function openSettings(requested, area = "settings") {
  closeMenu();
  closeSide();
  if (!requested && area === "assistants") requested = localStorage.getItem("aim.assistantTab") || "experts";
  if (ui.settings) return ui.settings.selectTab(requested);
  const pages = directory.filter(item => !item.admin || isAdmin());
  const mainPages = pages.filter(item => !item.parent);
  const groups = [...new Set(mainPages.map(item => item.group))];
  const previousFocus = document.activeElement;
  const previousHash = contentHash();
  const previousScroll = ui.messages?.scrollTop;
  const shelf = new Map();
  let active, page, pendingConfig, confirming, closing;
  let parentFromPage;
  let lastField;
  let lastUrl = location.href;
  let returnHash = previousHash;
  const isDirty = () => Boolean((page && hasDirty(page)) || document.querySelector(".settings-editor[data-edited], .settings-editor [data-dirty]"));
  async function leaveOk() {
    if (!isDirty()) return true;
    if (confirming) return false;
    confirming = true;
    try {
      return await confirmDialog({ title: "有修改还没保存", message: "离开后将丢弃当前表单的修改。", confirmText: "不保存", danger: true });
    } finally { confirming = false; }
  }
  function beforeUnload(event) {
    if (isDirty()) { event.preventDefault(); event.returnValue = true; }
  }

  const panel = h("div", { class: "settings-body" });
  const search = h("input", { type: "search", "aria-label": "搜索设置和工具", placeholder: "搜索设置和工具", oninput: drawNav });
  const status = h("span", { class: "settings-sr", role: "status" });
  const list = h("div", { class: "settings-links" });
  const nav = h("nav", { class: "settings-nav", "aria-label": "设置目录" }, h("label", { class: "settings-search" }, icon("search"), search), status, list);
  const primary = h("nav", { class: "settings-primary", "aria-label": "设置分类" });
  const secondary = h("nav", { class: "settings-secondary", "aria-label": "组内项目" });
  const toggle = h("button", { class: "icon-btn settings-find", "aria-label": "搜索设置", "aria-expanded": "false", onclick: () => setSearch(!pane.classList.contains("searching")) }, icon("search"));
  const pane = h("main", { class: "settings-view", "aria-label": "设置" },
    h("header", { class: "settings-header" },
      h("button", { class: "icon-btn", "aria-label": "返回原页面", onclick: () => parentFromPage ? select(parentFromPage) : close() }, icon("back")),
      h("h1", {}, "设置"), h("span", { class: "grow" }), toggle),
    primary, secondary, h("div", { class: "settings" }, nav, panel));
  function setSearch(on) {
    pane.classList.toggle("searching", on);
    toggle.setAttribute("aria-expanded", String(on));
    if (on) search.focus();
    else if (nav.contains(document.activeElement)) toggle.focus({ preventScroll: true });
  }
  search.onkeydown = event => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      search.value = "";
      drawNav();
      setSearch(false);
    }
    const hits = list.querySelectorAll("button");
    if (event.key === "ArrowDown") { event.preventDefault(); hits[0]?.focus(); }
    if (event.key === "Enter" && hits.length === 1) hits[0].click();
  };
  function drawNav() {
    const query = search.value.trim();
    const hits = query ? searchDirectory(pages, query) : mainPages.map(page => ({ page, label: page.label }));
    let group;
    const current = active?.parent || active?.id;
    const nodes = [];
    for (const { page: item, section, label } of hits) {
      if (!query && item.group !== group) nodes.push(h("h2", { class: "settings-group" }, item.group));
      group = item.group;
      nodes.push(h("button", { class: "settings-nav-link", "data-page": item.id, "aria-current": item.id === current && !query ? "page" : null,
        onclick: () => select(section ? item.id + "/" + section : item.id) }, icon(item.icon),
        h("span", {}, label, query ? h("small", {}, item.group + (item.label !== label ? " › " + item.label : "")) : null)));
    }
    fill(list, ...nodes, hits.length ? null : h("p", { class: "muted" }, "没有匹配项，试试其他关键词。"));
    status.textContent = query ? "找到 " + hits.length + " 项" : "";
  }
  function drawTabs() {
    const current = active.parent || active.id;
    fill(primary, groups.map(group => h("button", { "aria-pressed": String(group === active.group), onclick: () => {
      const saved = localStorage.getItem("aim.settingsGroup." + group);
      const items = mainPages.filter(item => item.group === group);
      select((items.find(item => item.id === saved) || items[0]).id);
    } }, group)));
    const items = mainPages.filter(item => item.group === active.group);
    secondary.hidden = items.length < 2;
    fill(secondary, items.map(item => h("button", { "data-page": item.id, "aria-current": item.id === current ? "page" : null, onclick: () => select(item.id) }, item.label)));
    secondary.querySelector('[aria-current]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    drawNav();
  }
  function reveal(key) {
    const target = key && page.querySelector('[data-section="' + key + '"]');
    if (!target) return false;
    for (let el = target; el; el = el.parentElement) if (el.tagName === "DETAILS") el.open = true;
    if (!target.matches("input,select,button,textarea")) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "nearest" });
    return true;
  }
  function route(id, section) {
    returnHash = contentHash();
    history.replaceState({ ...history.state, settingsReturnHash: returnHash }, "", "#settings/" + [id, section].filter(Boolean).join("/"));
    lastUrl = location.href;
  }
  async function select(name) {
    const [id, anchor] = (resolvePage(name || localStorage.getItem("aim.settingsTab"), isAdmin()) || "account").split("/");
    const item = pages.find(p => p.id === id) || mainPages[0];
    const section = sections[item.id]?.find(([key]) => key === anchor)?.[0];
    if (item === active && page && (!section || page.querySelector('[data-section="' + section + '"]'))) {
      setSearch(false);
      route(item.id, section);
      reveal(section);
      return;
    }
    if (!(await leaveOk()) || !pane.isConnected) {
      setSearch(false);
      if (lastField?.isConnected) lastField.focus({ preventScroll: true });
      return;
    }
    if (active) shelf.set(active.id, panel.scrollTop);
    parentFromPage = active?.id === item.parent ? item.parent : null;
    active = item;
    setSearch(false);
    route(item.id, section);
    localStorage.setItem("aim.settingsTab", item.id);
    localStorage.setItem("aim.settingsGroup." + item.group, item.parent || item.id);
    drawTabs();
    const heading = h("h2", { class: "settings-page-title", tabindex: "-1" }, item.label);
    const content = h("div", { class: "settings-page", "aria-busy": "true" }, h("span", { class: "spinner", role: "status", "aria-label": "加载设置" }));
    page = content;
    fill(panel, heading, content);
    heading.focus({ preventScroll: true });
    panel.scrollTop = 0;
    try {
      if (item.config) pendingConfig ??= api("/api/config").catch(err => { pendingConfig = null; throw err; });
      const [module, cfg] = await Promise.all([item.load(), item.config ? pendingConfig : null]);
      if (!content.isConnected) return;
      fill(content);
      if (item.config) await module[item.method](cfg, content, section);
      else await module[item.method](content, section);
      if (content.isConnected && !reveal(section)) panel.scrollTop = shelf.get(item.id) || 0;
    } catch (err) {
      if (content.isConnected) fill(content, h("p", { class: "error-text", role: "alert" }, err.message),
        h("button", { class: "btn", onclick: () => { active = null; select(name); } }, "重试"));
    } finally { content.removeAttribute("aria-busy"); }
  }

  function finish() {
    window.removeEventListener("beforeunload", beforeUnload);
    window.removeEventListener("popstate", onBack);
    pane.remove();
    ui.settings = null;
    syncDesktopMenu();
    renderSidebar();
    WS.presence();
    if (previousHash === returnHash && ui.messages) ui.messages.scrollTop = previousScroll;
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    closing?.(true);
    return true;
  }
  async function onBack() {
    if (settingsRoute.test(location.hash)) return;
    if (!closing) {
      const overlay = [...document.querySelectorAll("body > .overlay:not(.leaving)")].at(-1);
      if (overlay || parentFromPage || isDirty()) {
        // 浏览器已回到来源页；先恢复当前地址，再处理最上层的编辑/确认。
        history.pushState({ ...history.state, settingsEntry: true, settingsReturnHash: returnHash }, "", lastUrl);
        if (overlay) {
          if (!overlay.classList.contains("dialog-overlay")) overlay.dispatchEvent(new Event("settings-back"));
        } else if (parentFromPage) await select(parentFromPage);
        else await close();
        return;
      }
    }
    history.replaceState(history.state, "", returnHash || location.pathname + location.search);
    finish();
  }
  async function close() {
    if (closing || !(await leaveOk()) || !pane.isConnected) return false;
    returnHash = contentHash();
    return new Promise(resolve => { closing = resolve; history.back(); });
  }
  ui.settings = { area: "settings", close, selectTab: select, isDirty };
  ui.layout.append(pane);
  if (!history.state?.settingsEntry) {
    const base = { ...history.state };
    delete base.settingsReturnHash;
    history.replaceState(base, "", previousHash || location.pathname + location.search);
    history.pushState({ ...base, settingsEntry: true, settingsReturnHash: previousHash }, "", "#settings");
  }
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener("popstate", onBack);
  panel.addEventListener("focusin", e => { if (e.target.matches("input,select,textarea")) lastField = e.target; });
  for (const type of ["input", "change"]) panel.addEventListener(type, e => {
    if (!e.target.closest("[data-nodirty]")) markDirty(e.target.closest("[data-form]"));
  });
  renderSidebar();
  syncDesktopMenu();
  WS.presence();
  await select(requested);
}

window.addEventListener("popstate", () => {
  const match = settingsRoute.exec(location.hash);
  if (match && !ui.settings && ui.layout) void openSettings(match[1], location.hash.startsWith("#assistants") ? "assistants" : "settings");
});
