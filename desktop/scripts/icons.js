// 生成图标：npm run icons（用 Electron 自己把 SVG 画成 PNG，不需要额外的工具）。
//   assets/trayTemplate.png / @2x  菜单栏模板图标（只看透明度，系统按深浅色自动着色）
//   build/icon.png                 1024×1024 的 App 图标，electron-builder 打包时转成 icns
// 图形和颜色统一取自 web/icon.svg。
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP, TRAY } from "./icon-source.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function render(win, svg, size) {
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`)};
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = ${size};
    c.getContext("2d").drawImage(img, 0, 0, ${size}, ${size});
    return c.toDataURL("image/png");
  })()`);
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL("about:blank");
  const out = [
    ["assets/trayTemplate.png", TRAY, 18],
    ["assets/trayTemplate@2x.png", TRAY, 36],
    ["build/icon.png", APP, 1024],
    ["assets/icon.png", APP, 256],
  ];
  for (const [file, svg, size] of out) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, await render(win, svg, size));
    console.log(`已生成 ${file}（${size}×${size}）`);
  }
  app.quit();
});
