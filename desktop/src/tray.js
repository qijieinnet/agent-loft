// 菜单栏（右上角）图标：只有图标，旁边不显示文字。
//   - 鼠标悬停：系统自带的文字提示，列出各服务器的额度、待处理、运行中；
//   - 点击：弹出面板（同样的内容，可以点进去），点别处收起；右键是菜单。
import { BrowserWindow, Menu, nativeImage, screen, Tray } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(here, "../assets/trayTemplate.png");
const POPOVER_WIDTH = 340;

/** @type {Tray | null} */
let tray = null;
/** @type {BrowserWindow | null} */
let popover = null;
let actions = null;

/**
 * @param {{ showMain: () => void, refresh: () => void, quit: () => void, onPopoverShown: () => void }} handlers
 */
export function createTray(handlers) {
  actions = handlers;
  const icon = nativeImage.createFromPath(ICON);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setIgnoreDoubleClickEvents(true);
  tray.setToolTip("Agent Loft");

  tray.on("click", () => {
    if (popover?.isVisible()) return hidePopover();
    showPopover();
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
    webPreferences: {
      preload: path.join(here, "preload-shell.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  popover.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  popover.on("blur", () => hidePopover());
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

function showPopover() {
  const win = ensurePopover();
  place(win);
  win.show();
  win.focus();
  actions.onPopoverShown();
}

export function hidePopover() {
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

// ---------- 悬停提示 ----------

function resetText(at) {
  if (!at) return "";
  const d = new Date(at);
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toDateString() === new Date().toDateString() ? `${hm} 重置` : `${d.getMonth() + 1}/${d.getDate()} ${hm} 重置`;
}

/** 10 格的进度条：▰▰▰▱▱▱▱▱▱▱ */
function bar(percent) {
  const n = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return "▰".repeat(n) + "▱".repeat(10 - n);
}

const STATUS = { online: "在线", login: "未登录", setup: "未设置密码", offline: "连不上", unknown: "连接中", access: "需要验证" };

/**
 * 悬停提示的文字。系统提示用的是比例字体，没法按列对齐，所以每个额度窗口单独一行，
 * 长度固定的进度条放在最前面，看起来就是齐的：
 *
 *   本机 · 在线
 *   Codex（plus）
 *       ▰▱▱▱▱▱▱▱▱▱   12%  5 小时 · 15:20 重置
 *       ▱▱▱▱▱▱▱▱▱▱    4%  7 天 · 10/27 重置
 *   2 个运行中 · 1 个待处理
 */
export function tooltipText(servers) {
  if (!servers.length) return "Agent Loft\n还没有添加服务器";
  const blocks = [];
  // 同一个账号登在好几台服务器上，额度一模一样：后面的只写一句
  const seen = new Map();
  for (const s of servers) {
    const lines = [`${s.name} · ${STATUS[s.status] ?? s.status}`];
    if (s.status === "online") {
      for (const q of s.quotas ?? []) {
        const sig = JSON.stringify([q.agent, (q.windows ?? []).map((w) => [w.short, Math.round(w.percent)])]);
        if (seen.has(sig)) {
          lines.push(`${q.label}：和「${seen.get(sig)}」是同一个账号`);
          continue;
        }
        seen.set(sig, s.name);
        lines.push(`${q.label}${q.plan ? `（${q.plan}）` : ""}${q.reached ? " · 已到上限" : ""}`);
        for (const w of q.windows ?? []) {
          const pct = Math.max(0, Math.min(100, Math.round(w.percent)));
          lines.push(`    ${bar(pct)}  ${String(pct).padStart(3, " ")}%  ${[w.label, resetText(w.resetsAt)].filter(Boolean).join(" · ")}`);
        }
      }
      if (!s.quotas?.length) lines.push(s.quotaAt ? "没有可显示的额度" : "正在读取额度…");
      const activity = [s.busy ? `${s.busy} 个运行中` : "", s.pending.length ? `${s.pending.length} 个待处理` : ""].filter(Boolean);
      if (activity.length) lines.push(activity.join(" · "));
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

/** @param {{ servers: any[] }} state */
export function updateTray(state) {
  if (!tray) return;
  tray.setToolTip(tooltipText(state.servers));
}
