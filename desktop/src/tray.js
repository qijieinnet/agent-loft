// 菜单栏（右上角）图标：
//   - 图标旁常驻一个短标题：最高的 5 小时额度占用，有待处理时加上数量；
//   - 鼠标悬停弹出面板（各服务器的额度、待处理、运行中），移开自动收起；
//   - 点击弹出并固定，点别处收起；右键是菜单。
// 关掉「悬停时显示面板」后，悬停只显示系统的文字提示。
import { BrowserWindow, Menu, nativeImage, screen, Tray } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { store } from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(here, "../assets/trayTemplate.png");
const POPOVER_WIDTH = 340;
const HOVER_OPEN_MS = 250;
const HOVER_CLOSE_MS = 350;

/** @type {Tray | null} */
let tray = null;
/** @type {BrowserWindow | null} */
let popover = null;
/** 点开的（固定住，点别处才收）还是悬停弹出的（鼠标离开就收） */
let pinned = false;
let overTray = false;
let overPopover = false;
let openTimer = null;
let closeTimer = null;
let actions = null;

/**
 * @param {{ showMain: () => void, refresh: () => void, quit: () => void, setPref: (key: string, value: unknown) => void, onPopoverShown: () => void }} handlers
 */
export function createTray(handlers) {
  actions = handlers;
  const icon = nativeImage.createFromPath(ICON);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setIgnoreDoubleClickEvents(true);

  tray.on("click", () => {
    clearTimeout(openTimer);
    if (popover?.isVisible() && pinned) return hidePopover();
    showPopover(true);
  });
  tray.on("right-click", () => {
    hidePopover();
    tray.popUpContextMenu(contextMenu());
  });
  tray.on("mouse-enter", () => {
    overTray = true;
    clearTimeout(closeTimer);
    if (!store.prefs().hoverPopover || popover?.isVisible()) return;
    clearTimeout(openTimer);
    openTimer = setTimeout(() => overTray && showPopover(false), HOVER_OPEN_MS);
  });
  tray.on("mouse-leave", () => {
    overTray = false;
    clearTimeout(openTimer);
    scheduleClose();
  });
  return tray;
}

function contextMenu() {
  const prefs = store.prefs();
  return Menu.buildFromTemplate([
    { label: "打开 Agent Loft", click: () => actions.showMain() },
    { label: "刷新额度", click: () => actions.refresh() },
    { type: "separator" },
    {
      label: "悬停时显示面板",
      type: "checkbox",
      checked: prefs.hoverPopover,
      click: (item) => actions.setPref("hoverPopover", item.checked),
    },
    {
      label: "菜单栏显示额度",
      type: "checkbox",
      checked: prefs.trayTitle,
      click: (item) => actions.setPref("trayTitle", item.checked),
    },
    { type: "separator" },
    { label: "退出 Agent Loft", accelerator: "Command+Q", click: () => actions.quit() },
  ]);
}

function ensurePopover() {
  if (popover && !popover.isDestroyed()) return popover;
  popover = new BrowserWindow({
    width: POPOVER_WIDTH,
    height: 240,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hiddenInMissionControl: true,
    // NSPanel：悬停弹出时不抢焦点，不打断正在别的 App 里打字
    type: "panel",
    vibrancy: "popover",
    visualEffectState: "active",
    transparent: true,
    backgroundColor: "#00000000",
    roundedCorners: true,
    webPreferences: {
      preload: path.join(here, "preload-shell.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  popover.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  popover.on("blur", () => {
    if (pinned) hidePopover();
  });
  // 在面板里点了一下：说明要操作，固定住
  popover.on("focus", () => {
    pinned = true;
  });
  void popover.loadFile(path.join(here, "shell/popover.html"));
  return popover;
}

function place(win) {
  const trayBounds = tray.getBounds();
  const { height } = win.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const area = display.workArea;
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - POPOVER_WIDTH / 2);
  x = Math.max(area.x + 8, Math.min(x, area.x + area.width - POPOVER_WIDTH - 8));
  const y = Math.round(trayBounds.y + trayBounds.height + 4);
  win.setBounds({ x, y, width: POPOVER_WIDTH, height });
}

function showPopover(pin) {
  const win = ensurePopover();
  clearTimeout(closeTimer);
  pinned = pin;
  place(win);
  if (pin) {
    win.show();
    win.focus();
  } else {
    win.showInactive();
  }
  actions.onPopoverShown();
}

export function hidePopover() {
  clearTimeout(closeTimer);
  clearTimeout(openTimer);
  pinned = false;
  overPopover = false;
  if (popover && !popover.isDestroyed() && popover.isVisible()) popover.hide();
}

function scheduleClose() {
  if (pinned) return;
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    if (!overTray && !overPopover && !pinned) hidePopover();
  }, HOVER_CLOSE_MS);
}

/** 面板页面报告鼠标进出 */
export function popoverHover(inside) {
  overPopover = inside;
  if (inside) clearTimeout(closeTimer);
  else scheduleClose();
}

/** 面板内容高度变了：窗口跟着变，顶边不动 */
export function popoverResize(height) {
  if (!popover || popover.isDestroyed()) return;
  const h = Math.max(120, Math.min(Math.round(height), screen.getPrimaryDisplay().workArea.height - 40));
  const b = popover.getBounds();
  if (b.height !== h) popover.setBounds({ ...b, height: h });
}

export function popoverWebContents() {
  return popover && !popover.isDestroyed() ? popover.webContents : null;
}

// ---------- 标题和文字提示 ----------

/** 最紧的那个 5 小时窗口（没有就取所有窗口里最高的） */
function headline(list) {
  let best = null;
  for (const s of list) {
    for (const q of s.quotas ?? []) {
      for (const w of q.windows ?? []) {
        const score = (w.short === "5h" ? 1000 : 0) + w.percent;
        if (!best || score > best.score) best = { score, percent: w.percent };
      }
    }
  }
  return best ? Math.round(best.percent) : null;
}

function resetText(at) {
  if (!at) return "";
  const d = new Date(at);
  const sameDay = d.toDateString() === new Date().toDateString();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `${hm} 重置` : `${d.getMonth() + 1}/${d.getDate()} ${hm} 重置`;
}

/** @param {{ servers: any[], prefs: any }} state */
export function updateTray(state) {
  if (!tray) return;
  const pending = state.servers.reduce((n, s) => n + s.pending.length, 0);
  const percent = headline(state.servers);
  const parts = [];
  if (pending) parts.push(`${pending} 待处理`);
  if (state.prefs.trayTitle && percent !== null) parts.push(`${percent}%`);
  tray.setTitle(parts.length ? ` ${parts.join(" · ")}` : "", { fontType: "monospacedDigit" });

  // 悬停面板开着时不要系统提示，不然两个叠在一起
  if (state.prefs.hoverPopover) {
    tray.setToolTip("");
    return;
  }
  const lines = [];
  for (const s of state.servers) {
    lines.push(`${s.name}${s.status === "online" ? "" : `（${statusText(s.status)}）`}`);
    for (const q of s.quotas ?? []) {
      const ws = (q.windows ?? []).map((w) => `${w.short} ${Math.round(w.percent)}%${w.resetsAt ? `（${resetText(w.resetsAt)}）` : ""}`);
      lines.push(`  ${q.label}  ${ws.join("  ")}`);
    }
    if (s.pending.length) lines.push(`  ${s.pending.length} 个待处理`);
    if (s.busy) lines.push(`  ${s.busy} 个运行中`);
  }
  tray.setToolTip(lines.join("\n") || "Agent Loft");
}

function statusText(status) {
  return { login: "未登录", setup: "未设置密码", offline: "连不上", unknown: "连接中", access: "需要验证" }[status] ?? status;
}
