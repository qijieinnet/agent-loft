import { fill, h, icon, isTouch, toast } from "../lib/dom.js";
import { remoteTabs, S, ui } from "../state.js";
import { WS } from "../lib/ws.js";
import { closeSide, renderSidebar } from "./sidebar.js";
import { renderTopbar } from "./topbar.js";
import { openLibraryView, openTasksView } from "./layout.js";

// ---------- 远程控制 ----------
// 侧栏「定时任务」下面的入口：上面切「桌面 / 终端」，下面是对应的那一块。
// 切回对话时这一页只是藏起来：桌面、终端的连接都在后台留着，再进来接着用。
// 这台机器没有桌面时只有终端（不显示切换）。

const TABS = { desktop: { label: "桌面", icon: "monitor" }, terminal: { label: "终端", icon: "terminal" } };

const R = {
  tab: localStorage.getItem("aim.remoteTab") || "desktop",
  /** 进来之前在看什么：「放到对话下面」时回去 */
  before: null,
};

function ensurePane() {
  if (ui.remote) return;
  ui.remoteSwitch = h("div", { class: "remote-switch", role: "tablist" });
  ui.remoteTools = h("div", { class: "remote-tools" });
  ui.remoteDesk = h("div", { class: "remote-body", hidden: true });
  ui.remoteTerm = h("div", { class: "remote-body", hidden: true });
  ui.remote = h(
    "section",
    { class: "remote-pane", hidden: true, "aria-label": "远程控制" },
    h("div", { class: "remote-head" }, ui.remoteSwitch, h("span", { class: "grow" }), ui.remoteTools),
    ui.remoteDesk,
    ui.remoteTerm,
  );
  ui.main.append(ui.remote);
}

function renderSwitch() {
  const tabs = remoteTabs();
  fill(
    ui.remoteSwitch,
    tabs.length > 1
      ? tabs.map((t) =>
          h(
            "button",
            { class: `remote-tab${t === R.tab ? " on" : ""}`, role: "tab", title: TABS[t].label, "aria-selected": String(t === R.tab), onclick: () => void select(t) },
            icon(TABS[t].icon),
            h("span", {}, TABS[t].label),
          ),
        )
      : null,
  );
}

/** 打开远程控制；tab 不给就是上次看的那页 */
export async function openRemote(tab) {
  const tabs = remoteTabs();
  if (!tabs.length) return toast("没有可用的远程控制");
  ensurePane();
  if (S.view !== "remote") {
    R.before = S.view;
    R.scroll = ui.messages.scrollTop;
  }
  S.view = "remote";
  ui.main.classList.add("remote-view");
  ui.remote.hidden = false;
  closeSide();
  renderTopbar();
  renderSidebar();
  WS.presence();
  await select(tabs.includes(tab) ? tab : tabs.includes(R.tab) ? R.tab : tabs[0]);
}

async function select(tab) {
  R.tab = tab;
  localStorage.setItem("aim.remoteTab", tab);
  history.replaceState(history.state, "", `#remote/${tab}`);
  renderSwitch();
  ui.remoteDesk.hidden = tab !== "desktop";
  ui.remoteTerm.hidden = tab !== "terminal";
  fill(ui.remoteTools);
  if (tab === "terminal") (await import("./terminal.js")).embedIn(ui.remoteTerm);
  else (await import("./desktop.js")).showDesktop(ui.remoteDesk, ui.remoteTools);
}

/** 藏起这一页（连接不断） */
function hidePane() {
  if (!ui.remote) return;
  ui.remote.hidden = true;
  ui.main.classList.remove("remote-view");
}

/** 回到进来之前在看的（对话没动过，直接露出来） */
export function leaveRemote() {
  if (S.view !== "remote") return;
  S.view = null;
  hidePane();
  const before = R.before;
  R.before = null;
  if (before === "tasks") return openTasksView();
  if (before === "library") return openLibraryView();
  history.replaceState(history.state, "", S.current ? `#${encodeURIComponent(S.current)}` : location.pathname);
  // 对话区藏着的时候滚动位置没了：放回原处
  ui.messages.scrollTop = R.scroll ?? ui.messages.scrollTop;
  renderTopbar();
  renderSidebar();
  WS.presence();
}

// iOS 弹出软键盘时页面不会变矮（不认 interactive-widget），键盘会盖住下面那排快捷键：
// 量出被盖住的高度，远程控制页和对话下面的终端面板垫高这么多（css/remote.css 的 --kb-inset）
// 只在触屏设备上算：电脑上双指缩放网页、出了滚动条时 visualViewport 也会变小，不是键盘
const vv = window.visualViewport;
if (vv && isTouch) {
  let last = 0;
  const inset = () => {
    const covered = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty("--kb-inset", `${covered}px`);
    // 键盘弹出时 iOS 会把页面（和溢出隐藏的容器）往上推，收起后不一定推回来：
    // 横屏全屏时整页只剩顶上露一截按键。键盘收起时统统滚回原位
    if (last > 0 && covered === 0) {
      window.scrollTo(0, 0);
      for (const el of [document.scrollingElement, ...document.querySelectorAll("#app, .layout, .main, .remote-pane, .remote-body")]) {
        if (el && el.scrollTop) el.scrollTop = 0;
      }
    }
    last = covered;
  };
  vv.addEventListener("resize", inset);
  vv.addEventListener("scroll", inset);
  inset();
}

// 打开了对话、新聊天、定时任务：这一页让开，连接留着
document.addEventListener("aim:leave-view", () => {
  hidePane();
  R.before = null;
});

/** 权限、设置变了：能切的页变了就重画；一页都没了就退出 */
export function syncRemote() {
  if (!ui.remote) return;
  const tabs = remoteTabs();
  if (S.view !== "remote") return;
  if (!tabs.length) return leaveRemote();
  if (!tabs.includes(R.tab)) return void select(tabs[0]);
  renderSwitch();
}
