import { $app, fill, h, icon, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { desktop, desktopQuota, desktopSettings, S, ui } from "../state.js";
import { clearAppBadge, WS } from "../lib/ws.js";
import { showAuth } from "./auth.js";
import {
  closeSide,
  marquee,
  moveProjectDir,
  projDirs,
  renderSidebar,
  reportDesktop,
  resetProjectOrder,
  setSideWidth,
  sideState,
  startMarquee,
  startSideResize,
  stopMarquee,
} from "./sidebar.js";
import { applyDesktopQuota, loadQuota, renderQuota } from "./quota.js";
import { openBotConversations, openConvContextMenu, usableAgents } from "./topbar.js";
import { showMenu } from "../lib/overlay.js";
import { bindScrollWatch, newDraft, openConversation, scrollToBottom } from "./messages.js";
import { renderComposer } from "./composer.js";
import { renameConv } from "./conv-actions.js";
import { releaseForeignPushSub } from "../lib/push.js";

// ---------- 主界面 ----------

/**
 * 设置页的代码占前端的三分之一，平时用不到：第一次打开设置时才加载。
 * 加载期间弹窗还没出来，连点 / 桌面端重复触发都会再开一层，所以加载中的再调用直接忽略。
 */
let settingsLoading = false;
function openSettings() {
  if (settingsLoading) return;
  settingsLoading = true;
  import("../settings/index.js").then(
    (m) => {
      settingsLoading = false;
      return m.openSettings();
    },
    (err) => {
      settingsLoading = false;
      toast(`设置加载失败，刷新页面再试：${err.message}`);
    },
  );
}

/** 技能页：第一次打开时才加载 */
export function openSkillsView() {
  import("./skills.js").then(
    (m) => m.openSkills(),
    (err) => toast(`技能页加载失败，刷新页面再试：${err.message}`),
  );
}

/** 定时任务页：第一次打开时才加载 */
export function openTasksView() {
  import("./tasks.js").then(
    (m) => m.openTasks(),
    (err) => toast(`定时任务页加载失败，刷新页面再试：${err.message}`),
  );
}

export async function boot() {
  const me = await api("/api/me");
  if (!me.authed) return showAuth();
  WS.stopped = false;
  WS.epoch = null;
  WS.hellos = 0;
  const data = await api("/api/bootstrap");
  S.user = data.user ?? me.user ?? null;
  S.agents = data.agents;
  S.bots = data.bots;
  S.workspaceRoot = data.workspaceRoot;
  S.quotaRefreshMin = data.quotaRefreshMin ?? 10;
  S.quotaEnabled = data.quotaEnabled !== false;
  S.convs = new Map(data.conversations.map((c) => [c.key, c]));
  S.pending = new Map(data.pending.map((i) => [i.id, i]));
  const enabled = usableAgents().map((a) => a.id);
  if (!S.draftAgent || !enabled.includes(S.draftAgent)) S.draftAgent = enabled[0] ?? null;
  renderLayout();
  reportDesktop();
  WS.connect();
  if (desktopQuota) desktop.onQuota(applyDesktopQuota);
  else void loadQuota();
  const fromHash = decodeURIComponent(location.hash.slice(1));
  // 地址里带了会话就打开它；否则打开「最近」里最近活跃的那个对话，一个都没有才进新对话页
  const latest = [...S.convs.values()].filter((c) => !c.hidden).sort((a, b) => b.activeAt - a.activeAt)[0];
  if (fromHash === "tasks") openTasksView();
  else if (fromHash === "skills") openSkillsView();
  else if (fromHash && S.convs.has(fromHash)) await openConversation(fromHash);
  else if (latest) await openConversation(latest.key);
  else newDraft();
  // 点了桌面端的系统通知 / 菜单栏里的待处理项：跳到对应会话
  desktop?.onOpen((key) => {
    if (key && S.convs.has(key) && key !== S.current) void openConversation(key);
  });
  // 桌面端「更多」里点了这台服务器的设置；已经开着就不再叠一层
  if (desktopSettings) {
    desktop.onOpenSettings(() => {
      if (!document.querySelector(".overlay .settings")) void openSettings();
    });
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
    clearAppBadge();
    void releaseForeignPushSub().catch(() => {});
    // 点了系统通知、页面本来就开着：跳到通知对应的会话
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.type !== "open") return;
      const key = decodeURIComponent(new URL(e.data.url, location.origin).hash.slice(1));
      if (key && S.convs.has(key) && key !== S.current) void openConversation(key);
    });
  }
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
    // 飞书机器人那一行：右键看这个机器人的所有聊天
    const bot = e.target.closest?.("[data-bot]")?.dataset.bot;
    if (bot) {
      e.preventDefault();
      showMenu({ x: e.clientX, y: e.clientY }, [{ label: "历史会话…", onclick: () => openBotConversations(bot) }]);
      return;
    }
    // 项目目录那一行：调整顺序（触屏上拖不动，靠这个菜单）
    const dir = e.target.closest?.("[data-dir]")?.dataset.dir;
    if (dir) {
      const i = projDirs.indexOf(dir);
      const moves = [
        ...(i > 0 ? [{ label: "置顶", onclick: () => moveProjectDir(dir, null) }, { label: "上移", onclick: () => moveProjectDir(dir, projDirs[i - 1]) }] : []),
        ...(i >= 0 && i < projDirs.length - 1 ? [{ label: "下移", onclick: () => moveProjectDir(dir, projDirs[i + 1], true) }] : []),
      ];
      const reset = sideState.order.length ? [{ label: "恢复按最近活跃排序", onclick: resetProjectOrder }] : [];
      const items = moves.length && reset.length ? [...moves, "sep", ...reset] : [...moves, ...reset];
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
    h(
      "div",
      { class: "side-top" },
      h("button", { class: "btn new-chat", onclick: () => (newDraft(), closeSide()) }, icon("compose"), "新聊天"),
    ),
    // 「最近」上面的入口，像 ChatGPT 的 Tasks。当前在任务页时高亮（renderSidebar 里切换）
    (ui.tasksNav = h("button", { class: "btn new-chat side-nav", onclick: () => openTasksView() }, icon("clock"), "定时任务")),
    (ui.skillsNav = h("button", { class: "btn new-chat side-nav", onclick: () => openSkillsView() }, icon("spark"), "技能")),
    ui.convList,
    h(
      "div",
      { class: "side-bottom" },
      (ui.quota = h("div", { class: "quota", onpointerenter: () => renderQuota() })),
      h("button", { class: "icon-btn side-gear", title: "设置", onclick: () => (openSettings(), closeSide()) }, icon("gear")),
    ),
    h("div", { class: "side-resizer", title: "拖动调整宽度，双击恢复默认", onpointerdown: startSideResize, ondblclick: () => setSideWidth(null) }),
  );
  ui.topbar = h("div", { class: "topbar" });
  // 聊天 / 工作切换在顶栏右上角；先建好，renderTopbar 每次把它放回去
  ui.modeSlot = h("span", { class: "mode-slot" });
  ui.msgInner = h("div", { class: "messages-inner" });
  ui.spacer = h("div", { class: "messages-spacer", "aria-hidden": "true" });
  ui.messages = h("div", { class: "messages", tabindex: "-1" }, ui.msgInner, ui.spacer);
  ui.toBottom = h("button", { class: "to-bottom", title: "回到底部", hidden: true, onclick: () => scrollToBottom() }, icon("down"));
  ui.follow = true;
  bindScrollWatch();
  ui.composerWrap = h("div", { class: "composer-wrap" });
  ui.main = h("main", { class: "main" }, ui.topbar, ui.messages, ui.composerWrap);
  ui.layout = h("div", { class: "layout" }, ui.sidebar, h("div", { class: "scrim", onclick: closeSide }), ui.main);
  fill($app, ui.layout, h("div", { class: "edge-strip", "aria-hidden": "true" }));
  renderComposer();
  renderSidebar();
}
