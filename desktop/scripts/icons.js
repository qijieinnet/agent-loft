// 生成图标：npm run icons（用 Electron 自己把 SVG 画成 PNG，不需要额外的工具）。
//   assets/trayTemplate.png / @2x  菜单栏模板图标（只看透明度，系统按深浅色自动着色）
//   build/icon.png                 1024×1024 的 App 图标，electron-builder 打包时转成 icns
// 图形取自 web/icon.svg：一大两小三颗星站在台面上。
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SHAPES = `
  <path d="M256 296L404 364L256 432L108 364Z" fill-opacity=".3"/>
  <path d="M256 252L404 320L256 388L108 320Z"/>
  <path d="M256 82C268.92 145.08 268.92 145.08 332 158C268.92 170.92 268.92 170.92 256 234C243.08 170.92 243.08 170.92 180 158C243.08 145.08 243.08 145.08 256 82Z"/>
  <path d="M152 186C158.46 217.54 158.46 217.54 190 224C158.46 230.46 158.46 230.46 152 262C145.54 230.46 145.54 230.46 114 224C145.54 217.54 145.54 217.54 152 186Z" fill-opacity=".85"/>
  <path d="M360 186C366.46 217.54 366.46 217.54 398 224C366.46 230.46 366.46 230.46 360 262C353.54 230.46 353.54 230.46 322 224C353.54 217.54 353.54 217.54 360 186Z" fill-opacity=".85"/>`;

/** 菜单栏：纯黑 + 透明，裁到图形本身，台面阴影那层去掉（16pt 下糊成一片） */
const TRAY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="96 76 320 320"><g fill="#000">${SHAPES.replace(/<path[^>]*fill-opacity="\.3"\/>/, "")}</g></svg>`;

/** App 图标：按 macOS 的网格，主体 824×824 居中，带一点投影 */
const APP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="104" y1="104" x2="408" y2="408"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#06b6d4"/></linearGradient>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eef3fb"/></linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#0b1f44" flood-opacity=".22"/></filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)" filter="url(#shadow)"/>
  <g transform="translate(100 100) scale(1.609375)" fill="url(#g)">${SHAPES}</g>
</svg>`;

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
