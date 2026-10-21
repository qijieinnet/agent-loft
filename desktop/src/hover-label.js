// 左侧服务器栏的悬停名称。服务器页面是叠在侧栏页面上面的原生视图，名称要是画在侧栏页面里，
// 一越过侧栏就被它挡住；所以用一个透明、点不到（鼠标穿透）的小子窗口贴在图标右边。
import { BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const WIDTH = 280;
const HEIGHT = 60;

/** @type {BrowserWindow | null} */
let label = null;
let ready = null;

function ensure(parent) {
  if (label && !label.isDestroyed()) return label;
  label = new BrowserWindow({
    parent,
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(here, "preload-shell.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  label.setIgnoreMouseEvents(true);
  ready = label.loadFile(path.join(here, "shell/label.html"));
  return label;
}

/**
 * @param {Electron.BaseWindow} parent 主窗口
 * @param {{ rect: { top: number, right: number, height: number }, name: string, detail: string, tone: string } | null} info
 *   rect 是图标在侧栏页面里的位置（页面坐标 = 窗口内容区坐标）
 */
export async function showHoverLabel(parent, info) {
  if (!info) return hideHoverLabel();
  const win = ensure(parent);
  await ready;
  if (win.isDestroyed()) return;
  win.webContents.send("label:show", { name: info.name, detail: info.detail, tone: info.tone });
  const content = parent.getContentBounds();
  win.setBounds({
    x: Math.round(content.x + info.rect.right + 6),
    y: Math.round(content.y + info.rect.top + info.rect.height / 2 - HEIGHT / 2),
    width: WIDTH,
    height: HEIGHT,
  });
  if (!win.isVisible()) win.showInactive();
}

export function hideHoverLabel() {
  if (label && !label.isDestroyed() && label.isVisible()) label.hide();
}

/** 侧栏页面发来的「显示 / 隐藏」，只认这个窗口 */
export function isHoverLabel(wc) {
  return !!label && !label.isDestroyed() && label.webContents === wc;
}
