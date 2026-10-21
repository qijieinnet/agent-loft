// 菜单栏（右上角）图标：只有图标，旁边不显示文字。
//   - 鼠标移上去：弹出面板（不抢焦点），列出各服务器的额度、待处理、运行中；鼠标离开图标和面板就收起；
//   - 点击：面板固定住（拿到焦点，可以点里面的东西），点别处收起；右键是菜单。
// 系统自带的悬停文字提示在菜单栏里经常不出来，而且没法排版，所以不用。
import { BrowserWindow, Menu, nativeImage, screen, Tray } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(here, "../assets/trayTemplate.png");
const POPOVER_WIDTH = 360;
/** 鼠标停在图标上多久弹出、离开多久收起 */
const PEEK_DELAY = 150;
const LEAVE_DELAY = 300;

/** @type {Tray | null} */
let tray = null;
/** @type {BrowserWindow | null} */
let popover = null;
let actions = null;
/** 面板是鼠标悬停弹出来的（还没点过）：鼠标一离开就收 */
let peeking = false;
let peekTimer = null;
let watchTimer = null;

/**
 * @param {{ showMain: () => void, refresh: () => void, quit: () => void, onPopoverShown: () => void }} handlers
 */
export function createTray(handlers) {
  actions = handlers;
  const icon = nativeImage.createFromPath(ICON);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setIgnoreDoubleClickEvents(true);

  tray.on("mouse-enter", () => {
    if (popover?.isVisible()) return;
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => showPopover({ peek: true }), PEEK_DELAY);
  });
  tray.on("mouse-leave", () => clearTimeout(peekTimer));
  tray.on("click", () => {
    clearTimeout(peekTimer);
    // 悬停弹出来的：点一下就固定住；已经固定的：再点收起
    if (popover?.isVisible() && !peeking) return hidePopover();
    showPopover({ peek: false });
  });
  tray.on("right-click", () => {
    hidePopover();
    tray.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: "打开 Agent Loft", click: () => actions.showMain() },
        { label: "刷新额度", click: () => actions.refresh() },
        { type: "separator" },
        { label: "退出 Agent Loft", accelerator: "Command+Q", click: () => actions.quit() },
      ]),
    );
  });
  return tray;
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
    vibrancy: "popover",
    visualEffectState: "active",
    transparent: true,
    backgroundColor: "#00000000",
    roundedCorners: true,
    // 悬停弹出时面板没有焦点：第一下点击也要算数
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(here, "preload-shell.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  popover.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 点进悬停弹出来的面板，它拿到焦点，就算固定住了
  popover.on("focus", () => {
    peeking = false;
    clearInterval(watchTimer);
  });
  popover.on("blur", () => {
    if (!peeking) hidePopover();
  });
  void popover.loadFile(path.join(here, "shell/popover.html"));
  return popover;
}

function place(win) {
  const trayBounds = tray.getBounds();
  const { height } = win.getBounds();
  const area = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y }).workArea;
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - POPOVER_WIDTH / 2);
  x = Math.max(area.x + 8, Math.min(x, area.x + area.width - POPOVER_WIDTH - 8));
  win.setBounds({ x, y: Math.round(trayBounds.y + trayBounds.height + 4), width: POPOVER_WIDTH, height });
}

/** @param {{ peek: boolean }} opts peek：悬停弹出，不抢焦点 */
function showPopover({ peek }) {
  const win = ensurePopover();
  const wasVisible = win.isVisible();
  peeking = peek;
  clearInterval(watchTimer);
  if (!wasVisible) place(win);
  if (peek) {
    win.showInactive();
    watchLeave();
  } else {
    win.show();
    win.focus();
  }
  if (!wasVisible) actions.onPopoverShown();
}

/**
 * 悬停弹出时盯着鼠标：离开图标和面板（中间那几像素的缝也算在内）一小会儿就收起。
 * 面板没有焦点时页面里的鼠标事件不一定可靠，直接问系统鼠标在哪。
 */
function watchLeave() {
  let outSince = 0;
  watchTimer = setInterval(() => {
    if (!peeking || !popover || popover.isDestroyed() || !popover.isVisible()) return clearInterval(watchTimer);
    const p = screen.getCursorScreenPoint();
    const t = tray.getBounds();
    const b = popover.getBounds();
    const inside = (r, pad) => p.x >= r.x - pad && p.x <= r.x + r.width + pad && p.y >= r.y - pad && p.y <= r.y + r.height + pad;
    // 图标和面板之间的竖条
    const bridge = { x: Math.min(t.x, b.x), y: t.y, width: Math.max(t.width, b.width), height: b.y - t.y };
    if (inside(t, 2) || inside(b, 4) || (inside(bridge, 0) && p.x >= t.x - 8 && p.x <= t.x + t.width + 8)) {
      outSince = 0;
      return;
    }
    if (!outSince) outSince = Date.now();
    else if (Date.now() - outSince >= LEAVE_DELAY) hidePopover();
  }, 80);
}

export function hidePopover() {
  clearInterval(watchTimer);
  peeking = false;
  if (popover && !popover.isDestroyed() && popover.isVisible()) popover.hide();
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

/** 冒烟测试用：建好菜单栏面板（不显示），返回它的页面 */
export function openPopoverForTest() {
  return ensurePopover().webContents;
}
