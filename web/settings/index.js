import { fill, h, icon } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { contentHash, isAdmin, ui } from "../state.js";
import { closeMenu, confirmDialog } from "../lib/overlay.js";
import { closeSide, openSide, renderSidebar } from "../views/sidebar.js";
import { syncDesktopMenu } from "../views/topbar.js";
import { WS } from "../lib/ws.js";
import { hasDirty, markDirty } from "./common.js";

// ---------- 设置 ----------
// 按「谁的、管什么」分组：我的（每个人自己的）、Agent、连接（飞书、远程控制）、管理。
// 普通成员可管理自己的资料和内置 Agent 默认项（在「专家」里）；管理员另有运行环境和服务器设置。

const LAST_TAB = "aim.settingsTab";

/** 以前的标签名：外面（地址、别处的按钮）传进来的旧名字照样能打开对应的页 */
const RENAMED = { 通用: "对话", 授权: "对话", 飞书机器人: "飞书", 我的账号: "账号", 通知: "系统" };
/** 成员没有 Agent 页了：以前记住的 / 外面传进来的「Agent」打开专家页 */
const MEMBER_RENAMED = { Agent: "专家" };

function warnBeforeUnload(event) {
  if (!ui.settings?.isDirty()) return;
  event.preventDefault();
  event.returnValue = true;
}

/** tab：直接打开哪一页（标签名，如「技能」），不给就是上次看的那页 */
export async function openSettings(tab) {
  closeSide();
  closeMenu();
  if (ui.settings) {
    return tab && ui.settings.selectTab(tab);
  }
  const nav = h("nav", { class: "settings-nav", "aria-label": "设置分类" });
  const panel = h("div", { class: "settings-body" }, h("span", { class: "spinner", role: "status", "aria-label": "加载设置" }));
  let page = null;
  const isDirty = () => page?.isConnected && hasDirty(page);
  let confirming = false;
  const leaveOk = async () => {
    if (!isDirty()) return true;
    if (confirming) return false;
    confirming = true;
    try {
      return await confirmDialog({ title: "有修改还没保存", message: "现在离开，这一页刚才改的内容不会保存。", confirmText: "不保存", danger: true });
    } finally {
      confirming = false;
    }
  };
  const previousHash = contentHash();
  const previousFocus = document.activeElement;
  const scrollTop = ui.messages?.scrollTop;
  const close = async () => {
    if (!(await leaveOk()) || ui.settings !== settings) return false;
    window.removeEventListener("beforeunload", warnBeforeUnload);
    pane.remove();
    ui.settings = null;
    const returnHash = contentHash();
    const { settingsReturnHash, ...state } = history.state ?? {};
    history.replaceState(state, "", location.pathname + location.search + returnHash);
    syncDesktopMenu();
    renderSidebar();
    WS.presence();
    if (ui.messages && previousHash === returnHash) ui.messages.scrollTop = scrollTop;
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    return true;
  };
  const title = h("h1", { tabindex: "-1" }, "设置");
  const pane = h("main", { class: "settings-view", "aria-label": "设置" },
    h("header", { class: "settings-header" },
      h("button", { class: "icon-btn menu-btn", onclick: openSide, title: "会话列表" }, icon("menu")),
      title,
    ),
    h("div", { class: "settings" }, nav, panel),
  );
  const settings = { close, isDirty, selectTab: (name) => { tab = name; } };
  ui.settings = settings;
  window.addEventListener("beforeunload", warnBeforeUnload);
  ui.layout.append(pane);
  history.replaceState({ ...history.state, settingsReturnHash: previousHash }, "", "#settings");
  syncDesktopMenu();
  renderSidebar();
  WS.presence();
  title.focus({ preventScroll: true });

  // 带 data-form 的表单里改了东西：标成没保存（common.js 的 saveButton）
  const onEdit = (e) => {
    if (e.target.closest("[data-nodirty]")) return;
    const form = e.target.closest("[data-form]");
    if (form && !form.dataset.dirty) markDirty(form);
  };
  panel.addEventListener("input", onEdit);
  panel.addEventListener("change", onEdit);

  let cfg, groups;
  try {
    const [module, config] = await Promise.all([import("./tabs.js"), isAdmin() ? api("/api/config") : null]);
    if (!pane.isConnected) return;
    cfg = config;
    groups = module.groupsFor(cfg);
  } catch (err) {
    fill(panel, h("div", { class: "error-text" }, err.message));
    return;
  }
  const tabs = groups.flatMap((g) => g.tabs);
  const buttons = [];
  let current = -1;

  const select = async (i) => {
    if (i === current || !(await leaveOk()) || !pane.isConnected) return;
    current = i;
    buttons.forEach((b, j) => b.classList.toggle("on", i === j));
    buttons[i].scrollIntoView({ block: "nearest", inline: "nearest" });
    localStorage.setItem(LAST_TAB, tabs[i][0]);
    // 每页一个新容器：慢的页还在等接口时切走了，它回来后写进的是已经不在页面上的旧容器，不会串到新页里
    const content = h("div", { class: "settings-page" });
    page = content;
    fill(panel, page);
    panel.scrollTop = 0;
    try {
      await tabs[i][1](content);
    } catch (err) {
      if (content.isConnected) fill(content, h("div", { class: "error-text" }, err.message));
    }
  };

  for (const g of groups) {
    // 只有一组时不用标题
    if (groups.length > 1) nav.append(h("div", { class: "settings-group" }, g.name));
    for (const [name] of g.tabs) {
      const i = buttons.length;
      const b = h("button", { onclick: () => void select(i) }, name);
      buttons.push(b);
      nav.append(b);
    }
  }
  settings.selectTab = (requested) => {
    const want = (cfg ? undefined : MEMBER_RENAMED[requested]) ?? RENAMED[requested] ?? requested;
    return select(Math.max(0, tabs.findIndex(([name]) => name === want)));
  };
  await settings.selectTab(tab || localStorage.getItem(LAST_TAB));
}
