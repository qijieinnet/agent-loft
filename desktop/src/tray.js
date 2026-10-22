// 菜单栏（右上角）图标：只有图标，旁边不显示文字。
//   - 鼠标移上去：弹出面板（不抢焦点），列出各服务器的额度、待处理、运行中；鼠标离开图标和面板就收起；
//   - 点击：面板固定住（拿到焦点，可以点里面的东西），点别处收起；
//   - 双击：打开主窗口（面板收起）；右键是菜单（打开主窗口、刷新额度、退出）。
// 系统自带的悬停文字提示在菜单栏里经常不出来，而且没法排版，所以不用。
//
// Windows 的托盘：没有悬停弹出，点一下弹出面板（任务栏在下面时面板在图标上方），再点或点别处收起；
// 双击、右键和 macOS 一样。
// Linux 的托盘（AppIndicator）不给点击事件，只能挂菜单：菜单里「额度和待处理」把面板弹在屏幕右上角。
import { BrowserWindow, Menu, nativeImage, nativeTheme, screen, Tray } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAC = process.platform === "darwin";
const LINUX = process.platform === "linux";
const ICON = path.join(here, "../assets/trayTemplate.png");
const APP_ICON = path.join(here, "../assets/icon.png");
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
/** 面板在图标上方（任务栏在屏幕下边）：内容变高时底边不动 */
let anchorBottom = false;
/** 上次收起的时间：Windows 上点托盘图标会先让面板失焦收起，紧接着的那次点击不该再把它打开 */
let hiddenAt = 0;

/** macOS：黑白模板图（系统按深浅色着色）；其他平台：彩色 App 图标，裁掉四周的留白再缩小 */
function trayIcon() {
  if (MAC) {
    const icon = nativeImage.createFromPath(ICON);
    icon.setTemplateImage(true);
    return icon;
  }
  const full = nativeImage.createFromPath(APP_ICON);
  const { width } = full.getSize();
  // 图标按 macOS 的网格画，主体占 824/1024，四周是透明留白和投影
  const pad = Math.round((width * 100) / 1024);
  const body = full.crop({ x: pad, y: pad, width: width - 2 * pad, height: width - 2 * pad });
  if (LINUX) return body.resize({ width: 32, height: 32, quality: "best" });
  const icon = nativeImage.createEmpty();
  for (const [scaleFactor, px] of [[1, 16], [1.25, 20], [1.5, 24], [2, 32]]) {
    icon.addRepresentation({ scaleFactor, buffer: body.resize({ width: px, height: px, quality: "best" }).toPNG() });
  }
  return icon;
}

/** 托盘的右键菜单（Linux 上是唯一的入口，所以多一项弹出面板） */
function contextMenu() {
  return Menu.buildFromTemplate([
    { label: "打开 Agent Loft", click: () => actions.showMain() },
    // 开关：面板可能拿不到焦点（桌面的防抢焦点），失焦收起就不灵了，这里也得能收起
    ...(LINUX ? [{ label: popover?.isVisible() ? "收起额度面板" : "额度和待处理…", click: () => (popover?.isVisible() ? hidePopover() : showPopover({ peek: false })) }] : []),
    { label: "刷新额度", click: () => actions.refresh() },
    { type: "separator" },
    // 快捷键只是显示用；Linux 的托盘菜单不支持，带上会报 GTK 警告
    { label: "退出 Agent Loft", accelerator: MAC ? "Command+Q" : undefined, click: () => actions.quit() },
  ]);
}

/**
 * @param {{ showMain: () => void, refresh: () => void, quit: () => void, onPopoverShown: () => void }} handlers
 */
export function createTray(handlers) {
  actions = handlers;
  tray = new Tray(trayIcon());
  if (!MAC) tray.setToolTip("Agent Loft");

  if (LINUX) {
    tray.setContextMenu(contextMenu());
    // 少数不走 AppIndicator 的托盘会给点击：直接打开主窗口
    tray.on("click", () => actions.showMain());
    return tray;
  }
  if (!MAC) {
    tray.on("click", () => {
      if (popover?.isVisible()) return hidePopover();
      if (Date.now() - hiddenAt < 300) return;
      showPopover({ peek: false });
    });
    tray.on("double-click", () => {
      hidePopover();
      actions.showMain();
    });
    tray.on("right-click", () => {
      hidePopover();
      tray.popUpContextMenu(contextMenu());
    });
    return tray;
  }

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
  // 双击的第一下已经按单击把面板固定出来了，这里收起面板、打开主窗口
  tray.on("double-click", () => {
    clearTimeout(peekTimer);
    hidePopover();
    actions.showMain();
  });
  tray.on("right-click", () => {
    hidePopover();
    tray.popUpContextMenu(contextMenu());
  });
  return tray;
}

/** 未读数：macOS 在 Dock 角标上（main.js），其他平台放进托盘的悬停提示 */
export function setTrayUnread(n) {
  if (MAC || !tray || tray.isDestroyed()) return;
  tray.setToolTip(n ? `Agent Loft · ${n} 条未读` : "Agent Loft");
}

function ensurePopover() {
  if (popover && !popover.isDestroyed()) return popover;
  popover = new BrowserWindow({
    ...(MAC
      ? {
          // NSPanel：本来就能浮在全屏应用上面，不用为此把整个 App 切成菜单栏应用（见下面 setVisibleOnAllWorkspaces）
          type: "panel",
          hiddenInMissionControl: true,
          vibrancy: "popover",
          visualEffectState: "active",
          transparent: true,
          backgroundColor: "#00000000",
          roundedCorners: true,
          // 悬停弹出时面板没有焦点：第一下点击也要算数
          acceptFirstMouse: true,
        }
      : {
          // 没有毛玻璃：不透明，底色和 popover.css 里的 --bg-2 一致
          backgroundColor: nativeTheme.shouldUseDarkColors ? "#2c2c2e" : "#f5f5f7",
        }),
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
    webPreferences: {
      preload: path.join(here, "preload-shell.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // skipTransformProcessType 必须带：不带的话 Electron 会把整个 App 先切成菜单栏应用再切回来，
  // 结果顶部菜单栏变空、Dock 上的图标认不出 App 在运行（不显示小点）
  if (MAC) popover.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  // Windows / Linux 上应用菜单会挂到每个窗口上，面板不要
  else popover.removeMenu();
  // 点进悬停弹出来的面板，它拿到焦点，就算固定住了
  popover.on("focus", () => {
    peeking = false;
    clearInterval(watchTimer);
  });
  popover.on("blur", () => {
    if (!peeking) hidePopover();
  });
  // Esc 收起
  popover.webContents.on("before-input-event", (_e, input) => {
    if (input.type === "keyDown" && input.key === "Escape") hidePopover();
  });
  // Linux 的托盘菜单要跟着面板开关换文字
  if (LINUX) for (const ev of ["show", "hide"]) popover.on(ev, () => tray?.setContextMenu(contextMenu()));
  void popover.loadFile(path.join(here, "shell/popover.html"));
  return popover;
}

function place(win) {
  const trayBounds = tray.getBounds();
  const { height } = win.getBounds();
  // Linux 拿不到图标的位置（全是 0）：放在鼠标所在屏幕的右上角
  if (!trayBounds.width) {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    anchorBottom = false;
    win.setBounds({ x: area.x + area.width - POPOVER_WIDTH - 8, y: area.y + 8, width: POPOVER_WIDTH, height });
    return;
  }
  const area = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y }).workArea;
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - POPOVER_WIDTH / 2);
  x = Math.max(area.x + 8, Math.min(x, area.x + area.width - POPOVER_WIDTH - 8));
  // 图标在屏幕下半边（Windows 的任务栏）：面板放在图标上方
  anchorBottom = trayBounds.y > area.y + area.height / 2;
  const y = anchorBottom ? Math.min(trayBounds.y, area.y + area.height) - height - 8 : trayBounds.y + trayBounds.height + 4;
  win.setBounds({ x, y: Math.round(y), width: POPOVER_WIDTH, height });
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
  if (popover && !popover.isDestroyed() && popover.isVisible()) {
    popover.hide();
    hiddenAt = Date.now();
  }
}

/** 面板内容高度变了：窗口跟着变，顶边不动 */
export function popoverResize(height) {
  if (!popover || popover.isDestroyed()) return;
  const h = Math.max(120, Math.min(Math.round(height), screen.getPrimaryDisplay().workArea.height - 40));
  const b = popover.getBounds();
  if (b.height === h) return;
  // 在图标上方时底边不动，往上长
  popover.setBounds({ ...b, y: anchorBottom ? b.y + b.height - h : b.y, height: h });
}

export function popoverWebContents() {
  return popover && !popover.isDestroyed() ? popover.webContents : null;
}

/** 冒烟测试用：建好菜单栏面板（不显示），返回它的页面 */
export function openPopoverForTest() {
  return ensurePopover().webContents;
}
