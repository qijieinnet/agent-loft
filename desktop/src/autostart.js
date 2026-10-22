// 登录时自动启动。macOS / Windows 用 Electron 自带的登录项；Linux 没有，按 XDG 规范在
// ~/.config/autostart 里放一个 .desktop 文件（GNOME、KDE、Xfce 等桌面都认）。
// 开机自己起来的那次只待在菜单栏 / 托盘里，不弹窗口：macOS 看 wasOpenedAtLogin，其他平台带 --hidden 参数。
import { app } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HIDDEN_FLAG = "--hidden";
const desktopFile = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "autostart", "agent-loft-desktop.desktop");

/**
 * .desktop 文件 Exec 里的一个参数：加双引号，里面的 " ` $ \ 先按引号规则转义；
 * 整个值还要再按字符串规则过一遍（反斜杠再翻倍），% 写成 %%（Exec 里 % 开头是占位符）
 */
const quote = (s) => `"${String(s).replace(/(["`$\\])/g, "\\$1")}"`.replace(/\\/g, "\\\\").replace(/%/g, "%%");

function linuxEntry() {
  // AppImage 跑起来时 execPath 在临时挂载点里，要用 AppImage 文件本身的路径；开发时还得带上 App 目录
  const exec = [process.env.APPIMAGE || process.execPath, ...(app.isPackaged ? [] : [app.getAppPath()]), HIDDEN_FLAG];
  return `[Desktop Entry]
Type=Application
Name=Agent Loft
Comment=Agent Loft 桌面端
Exec=${exec.map(quote).join(" ")}
Icon=agent-loft-desktop
Terminal=false
X-GNOME-Autostart-enabled=true
`;
}

/** @param {boolean} on */
export function setOpenAtLogin(on) {
  if (process.platform === "linux") {
    try {
      if (on) {
        fs.mkdirSync(path.dirname(desktopFile), { recursive: true });
        fs.writeFileSync(desktopFile, linuxEntry());
      } else {
        fs.rmSync(desktopFile, { force: true });
      }
    } catch (err) {
      console.error("[自启] 写 autostart 文件失败:", err);
    }
    return;
  }
  app.setLoginItemSettings(process.platform === "win32" ? { openAtLogin: on, args: [HIDDEN_FLAG] } : { openAtLogin: on });
}

/** 启动时调用：Linux 上 AppImage 可能被挪了地方，开着自启就按现在的路径重写一遍 */
export function syncOpenAtLogin(on) {
  // 开发版不改：免得把自启指到开发用的 electron 上
  if (process.platform === "linux" && on && app.isPackaged) setOpenAtLogin(true);
}

/** 这次是不是开机自己起来的（是的话不弹主窗口） */
export function openedAtLogin() {
  if (process.platform === "darwin") return app.getLoginItemSettings().wasOpenedAtLogin;
  return process.argv.includes(HIDDEN_FLAG);
}
