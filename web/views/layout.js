import { $app, fill, h, icon, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { desktop, desktopMenu, desktopQuota, desktopSettings, framed, remoteTabs, S, ui } from "../state.js";
import { clearAppNotifications, WS } from "../lib/ws.js";
import { showAuth } from "./auth.js";
import {
  applyBootstrap,
  bootstrapQuery,
  closeSide,
  marquee,
  botGroupId,
  moveSidebarGroup,
  sidebarGroups,
  renderSidebar,
  reportDesktop,
  resetSidebarGroupOrder,
  setSideWidth,
  startMarquee,
  startSideResize,
  stopMarquee,
} from "./sidebar.js";
import { applyDesktopQuota, loadQuota, renderQuota } from "./quota.js";
import { openBotConversations, openConvContextMenu, runDesktopMenu } from "./topbar.js";
import { syncDraftExpert } from "./experts.js";
import { confirmDialog, showMenu } from "../lib/overlay.js";
import { applyShellInfo, handleAllowEmbed, HOME, mountSwitcher, refreshShellPush, routeToServer, shellBooted, switchServer } from "../lib/shell.js";
import { bindScrollWatch, newDraft, openConversation, scrollToBottom } from "./messages.js";
import { bindFileDrop, renderComposer } from "./composer.js";
import { openSearch } from "./conv-search.js";
import { createNav } from "./msg-nav.js";
import { renameConv } from "./conv-actions.js";
import { clearCommandCache, preloadCommands } from "./slash.js";
import { releaseForeignPushSub } from "../lib/push.js";
import { createSidebarNav } from "./sidebar-nav.js";

// ---------- 主界面 ----------

/**
 * 设置页的代码占前端的三分之一，平时用不到：第一次打开设置时才加载。
 * 加载期间弹窗还没出来，连点 / 桌面端重复触发都会再开一层，所以加载中的再调用直接忽略。
 */
let settingsLoading = false;
/** tab：直接打开哪一页，如「技能」 */
export function openSettings(tab) {
  if (settingsLoading) return;
  settingsLoading = true;
  import("../settings/index.js").then(
    (m) => {
      settingsLoading = false;
      return m.openSettings(tab);
    },
    (err) => {
      settingsLoading = false;
      toast(`设置加载失败，刷新页面再试：${err.message}`);
    },
  );
}

/**
 * 远程控制（桌面 / 终端）：第一次用到时才加载（连 noVNC、xterm.js 一起）。
 * 加载过的模块记着：权限变了要告诉它们
 */
const loaded = {};
function lazy(name, load) {
  loaded[name] ??= load().catch((err) => {
    delete loaded[name];
    toast(`远程控制加载失败，刷新页面再试：${err.message}`);
    throw err;
  });
  return loaded[name];
}
/** 侧栏的「远程控制」；tab：desktop / terminal，不给就是上次看的 */
export function openRemoteView(tab) {
  if (remoteTabs().length) void lazy("remote", () => import("./remote.js")).then((m) => m.openRemote(tab));
}
/** Ctrl+`：对话下面的终端面板开 / 关 */
function toggleTerminalDock() {
  if (S.remote?.terminal?.allowed) void lazy("terminal", () => import("./terminal.js")).then((m) => m.toggleDock());
}

// 终端开了 / 关了、权限或设置变了：更新入口，已经加载了的让它们对一下
document.addEventListener("aim:remote", async () => {
  try {
    S.remote = await api("/api/remote");
  } catch {
    return;
  }
  renderSidebar();
  void loaded.terminal?.then((m) => m.syncTerminals());
  void loaded.remote?.then((m) => m.syncRemote());
});

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === "Backquote" && S.remote?.terminal?.allowed) {
    e.preventDefault();
    toggleTerminalDock();
  }
});

// 多服务器（lib/shell.js）：外壳让打开某条对话（点了这台的通知）、点了「管理服务器…」、切到别的服务器
document.addEventListener("aim:shell-open", (e) => {
  if (e.detail && e.detail !== S.current) void openConversation(e.detail);
});
document.addEventListener("aim:open-settings", (e) => openSettings(e.detail));
document.addEventListener("aim:server-leave", () => closeSide());

/**
 * 通知点开的地址：别的服务器的带着 srv=那台的 id（服务端 push.ts 的 relay），交给外壳切过去。
 * 返回 true 表示已经交出去了
 */
function routeNotice(url) {
  const srv = url.searchParams.get("srv");
  if (!srv || srv === HOME) return false;
  return routeToServer(srv, decodeURIComponent(url.hash.slice(1)));
}

/** 定时任务页：第一次打开时才加载 */
export function openTasksView() {
  import("./tasks.js").then(
    (m) => m.openTasks(),
    (err) => toast(`定时任务页加载失败，刷新页面再试：${err.message}`),
  );
}

/** 资料库页：第一次打开时才加载 */
export function openLibraryView() {
  import("./library.js").then(
    (m) => m.openLibrary(),
    (err) => toast(`资料库加载失败，刷新页面再试：${err.message}`),
  );
}

export async function boot() {
  const me = await api("/api/me");
  if (!me.authed) return showAuth();
  clearCommandCache();
  WS.stopped = false;
  WS.epoch = null;
  WS.hellos = 0;
  const data = await api(`/api/bootstrap${bootstrapQuery()}`);
  S.user = data.user ?? me.user ?? null;
  S.agents = data.agents;
  S.bots = data.bots;
  S.workspaceRoot = data.workspaceRoot;
  S.quotaRefreshMin = data.quotaRefreshMin ?? 10;
  S.quotaEnabled = data.quotaEnabled !== false;
  S.remote = data.remote ?? null;
  // 通知优先；刷新保留当前历史记录里的服务器；新打开的本机会话链接显示本机。
  const landing = new URL(location.href);
  const srv = landing.searchParams.get("srv");
  if (srv) {
    landing.searchParams.delete("srv");
    history.replaceState(history.state, "", `${landing.pathname}${landing.search}${srv === HOME ? landing.hash : ""}`);
  }
  applyShellInfo(data.servers, srv || history.state?.loftServer || (location.hash.length > 1 ? HOME : undefined));
  applyBootstrap(data);
  S.pending = new Map(data.pending.map((i) => [i.id, i]));
  S.experts = data.experts ?? [];
  syncDraftExpert();
  renderLayout();
  reportDesktop();
  WS.connect();
  if (desktopQuota) desktop.onQuota(applyDesktopQuota);
  else void loadQuota();
  if (srv && srv !== HOME) routeToServer(srv, decodeURIComponent(landing.hash.slice(1)));
  const fromHash = decodeURIComponent(location.hash.slice(1));
  // 地址里带了会话就打开它；否则打开「最近」里最近活跃的那个对话，一个都没有才进新对话页
  const latest = [...S.convs.values()].filter((c) => !c.hidden).sort((a, b) => b.activeAt - a.activeAt)[0];
  if (fromHash === "tasks") openTasksView();
  else if (fromHash === "library") openLibraryView();
  else if (fromHash.startsWith("remote") && remoteTabs().length) {
    // 刷新前在远程控制里：底下先放上最近的对话，切回对话时就是它
    if (latest) await openConversation(latest.key);
    else newDraft();
    openRemoteView(fromHash.split("/")[1]);
  }
  else if (fromHash && S.convs.has(fromHash)) await openConversation(fromHash);
  else if (latest) await openConversation(latest.key);
  else newDraft();
  preloadCommands();
  // 以前的技能页地址：技能现在在设置里
  if (fromHash === "skills") openSettings("技能");
  // 点了桌面端的系统通知 / 菜单栏里的待处理项：跳到对应会话
  desktop?.onOpen((key) => {
    // 不要求在 S.convs 里：侧栏分页，那条可能还没拉到；openConversation 会去服务端拿
    if (key && key !== S.current) void openConversation(key);
  });
  // 页面的「更多」菜单在桌面端顶栏的「更多」里：点了哪项
  if (desktopMenu) desktop.onMenu(runDesktopMenu);
  // 桌面端「更多」里点了这台服务器的设置；已经开着就不再叠一层
  if (desktopSettings) {
    desktop.onOpenSettings(() => {
      if (!document.querySelector(".overlay .settings")) void openSettings();
    });
  }
  // 被嵌在别的服务器的页面里时，通知、角标都归外壳管
  if ("serviceWorker" in navigator && !framed) {
    navigator.serviceWorker.register("/sw.js").then(() => clearAppNotifications()).catch(() => {});
    void releaseForeignPushSub()
      .catch(() => {})
      .then(() => WS.refreshPushPresence())
      .then(() => refreshShellPush());
    // 点了系统通知、页面本来就开着：跳到通知对应的会话
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.type !== "open") return;
      const url = new URL(e.data.url, location.origin);
      if (routeNotice(url)) return;
      // 这台自己的通知：外壳正显示着别的服务器的话切回来
      switchServer(HOME);
      const key = decodeURIComponent(url.hash.slice(1));
      if (key && key !== S.current) void openConversation(key);
    });
  }
  shellBooted();
  void handleAllowEmbed(confirmDialog, toast);
}

function renderLayout() {
  ui.convList = h("div", { class: "conv-list" });
  // 双击重命名。第一下单击会打开会话、侧栏整体重绘，元素已经换了，浏览器自己的 dblclick
  // 不一定触发；所以按 data-key 自己判断「同一条、两次按下间隔很短」
  let lastDown = { key: null, at: 0 };
  ui.convList.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const key = e.target.closest?.("[data-key]")?.dataset.key;
    const now = Date.now();
    if (key && key === lastDown.key && now - lastDown.at < 400) {
      lastDown = { key: null, at: 0 };
      e.preventDefault();
      renameConv(key);
      return;
    }
    lastDown = { key, at: now };
  });
  ui.convList.addEventListener("contextmenu", (e) => {
    // 项目和飞书共用移动菜单；触屏也可以通过长按调整混合顺序。
    const bot = e.target.closest?.("[data-bot]")?.dataset.bot;
    const dir = e.target.closest?.("[data-dir]")?.dataset.dir;
    const group = bot ? botGroupId(bot) : dir;
    if (group) {
      const i = sidebarGroups.indexOf(group);
      const moves = [
        ...(i > 0 ? [{ label: "置顶", onclick: () => moveSidebarGroup(group, null) }, { label: "上移", onclick: () => moveSidebarGroup(group, sidebarGroups[i - 1]) }] : []),
        ...(i >= 0 && i < sidebarGroups.length - 1 ? [{ label: "下移", onclick: () => moveSidebarGroup(group, sidebarGroups[i + 1], true) }] : []),
      ];
      const reset = sidebarGroups.length > 1 ? [{ label: "按最近活跃重排", onclick: resetSidebarGroupOrder }] : [];
      const items = moves.length && reset.length ? [...moves, "sep", ...reset] : [...moves, ...reset];
      if (bot) items.push(...(items.length ? ["sep"] : []), { label: "历史会话…", onclick: () => openBotConversations(bot) });
      if (!items.length) return;
      e.preventDefault();
      showMenu({ x: e.clientX, y: e.clientY }, items);
      return;
    }
    const key = e.target.closest?.("[data-key]")?.dataset.key;
    if (!key || !S.convs.has(key)) return;
    e.preventDefault();
    openConvContextMenu(key, { x: e.clientX, y: e.clientY });
  });
  ui.convList.addEventListener("pointerover", (e) => {
    const title = e.target.closest?.(".conv-item")?.querySelector(".title");
    if (title && title !== marquee.el) startMarquee(title);
  });
  ui.convList.addEventListener("pointerout", (e) => {
    const item = e.target.closest?.(".conv-item");
    if (item && !item.contains(e.relatedTarget)) stopMarquee();
  });
  ui.sidebar = h(
    "aside",
    { class: "sidebar" },
    // 左上角切换服务器（lib/shell.js），没有别的服务器时藏着
    mountSwitcher("sidebar", h("div", { class: "side-switch", hidden: true })),
    h(
      "div",
      { class: "side-top" },
      h("button", { class: "btn new-chat", onclick: () => (newDraft(), closeSide()) }, icon("plus"), "新建"),
    ),
    createSidebarNav({ search: openSearch, tasks: openTasksView, library: openLibraryView, remote: openRemoteView, settings: openSettings }),
    ui.convList,
    // 底部只有额度：没有额度可显示（关了查询、还没查到）时整块藏起来，连分隔线一起
    (ui.sideBottom = h(
      "div",
      { class: "side-bottom", hidden: true },
      (ui.quota = h("div", { class: "quota", onpointerenter: () => renderQuota() })),
    )),
    h("div", { class: "side-resizer", title: "拖动调整宽度，双击恢复默认", onpointerdown: startSideResize, ondblclick: () => setSideWidth(null) }),
  );
  ui.topbar = h("div", { class: "topbar" });
  ui.msgInner = h("div", { class: "messages-inner" });
  ui.spacer = h("div", { class: "messages-spacer", "aria-hidden": "true" });
  ui.messages = h("div", { class: "messages", tabindex: "-1" }, ui.msgInner, ui.spacer);
  ui.toBottom = h("button", { class: "to-bottom", title: "回到底部", hidden: true, onclick: () => scrollToBottom() }, icon("down"));
  ui.follow = true;
  bindScrollWatch();
  ui.composerWrap = h("div", { class: "composer-wrap" });
  ui.main = h("main", { class: "main" }, ui.topbar, ui.messages, createNav(), ui.composerWrap);
  bindFileDrop(ui.main);
  ui.layout = h("div", { class: "layout" }, ui.sidebar, h("div", { class: "scrim", onclick: closeSide }), ui.main);
  fill($app, ui.layout, h("div", { class: "edge-strip", "aria-hidden": "true" }));
  renderComposer();
  renderSidebar();
}
