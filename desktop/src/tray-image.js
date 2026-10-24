// macOS 菜单栏图标换成额度读数：选的每一项一栏，上面大字是 5 小时窗口的已用百分比，下面小字是 agent 名
// （按服务器选的还带上服务器名），
// 栏与栏之间一条竖线（样子像 iStat Menus 的「17% CPU | 76% MEM」）。
// 画成黑色 + 透明的模板图，系统按菜单栏的深浅色自己着色。
//
// 主进程没有 canvas：用一个不显示的小窗口画，画好拿 PNG 回来。
import { BrowserWindow, nativeImage } from "electron";

/** 菜单栏图标的高度（pt），按 2 倍图画 */
const HEIGHT = 22;
const SCALE = 2;

/** 下面那行小字：只要品牌名，不要「Claude Code」这种全称 */
const NAMES = { claude: "Claude", codex: "Codex" };
export const agentName = (id) => NAMES[id] ?? id;

/** 「serverId:agent」，serverId 是 * 表示所有服务器合起来 */
export const ALL_SERVERS = "*";

/** 服务器名放进小字里：菜单栏地方小（刘海屏更挤），超过 4 个字截掉 */
function shortServer(name) {
  const chars = [...String(name ?? "").trim()];
  return chars.length > 4 ? `${chars.slice(0, 3).join("")}…` : chars.join("");
}

/** 一台服务器上某个 agent 的 5 小时已用百分比。Claude 按模型分的窗口叫「5h Opus」之类，只要总的那个 */
function fiveHourOf(server, agent) {
  let best;
  for (const q of server.quotas ?? []) {
    if (q.agent !== agent) continue;
    const w = q.windows?.find((x) => x.short === "5h");
    if (w && Number.isFinite(w.percent)) best = Math.max(best ?? 0, w.percent);
  }
  return best;
}

/**
 * 按设置里选的项（顺序照选的来）挑出要画的读数。
 *   「*:claude」：所有服务器的 Claude 取最大的（多半是同一个账号）：宁可提醒早一点；小字只写 agent 名。
 *   「<id>:claude」：只看那台服务器；小字带上服务器名。
 * 还没查到额度、服务器已经删了的项跳过。
 * @param {{ id: string, name: string, quotas?: { agent: string, windows?: { short: string, percent: number }[] }[] }[]} servers
 * @param {string[]} items
 */
export function fiveHourPercents(servers, items) {
  const out = [];
  for (const item of items) {
    const i = item.lastIndexOf(":");
    const sid = item.slice(0, i);
    const agent = item.slice(i + 1);
    const pool = sid === ALL_SERVERS ? servers : servers.filter((s) => s.id === sid);
    if (pool.length === 0) continue;
    let best;
    for (const s of pool) {
      const p = fiveHourOf(s, agent);
      if (p !== undefined) best = Math.max(best ?? 0, p);
    }
    if (best === undefined) continue;
    const name = sid === ALL_SERVERS ? agentName(agent) : `${shortServer(pool[0].name)} ${agentName(agent)}`;
    out.push({ name, percent: Math.round(best) });
  }
  return out;
}

let painter = null;

function ensurePainter() {
  if (painter && !painter.isDestroyed()) return painter;
  painter = new BrowserWindow({
    show: false,
    width: 100,
    height: 100,
    skipTaskbar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  void painter.loadURL("data:text/html,<meta charset=utf-8>");
  return painter;
}

/** 在画图窗口里跑的：量好每栏宽度，画字和竖线，返回 PNG 的 data URL 和逻辑宽度 */
function draw(cols, height, scale) {
  const PCT_FONT = `600 ${12.5 * scale}px -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif`;
  const NAME_FONT = `500 ${7.5 * scale}px -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif`;
  const PAD = 3 * scale;
  const GAP = 7 * scale;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const widths = cols.map((c) => {
    ctx.font = PCT_FONT;
    const a = ctx.measureText(`${c.percent}%`).width;
    ctx.font = NAME_FONT;
    const b = ctx.measureText(c.name).width;
    return Math.ceil(Math.max(a, b));
  });
  const total = widths.reduce((s, w) => s + w, 0) + GAP * 2 * (cols.length - 1) + PAD * 2;
  canvas.width = total;
  canvas.height = height * scale;
  ctx.fillStyle = "#000";
  ctx.strokeStyle = "#000";
  ctx.textAlign = "center";
  let x = PAD;
  cols.forEach((c, i) => {
    const mid = x + widths[i] / 2;
    ctx.font = PCT_FONT;
    ctx.fillText(`${c.percent}%`, mid, 12.5 * scale);
    ctx.font = NAME_FONT;
    ctx.fillText(c.name, mid, 20 * scale);
    x += widths[i];
    if (i < cols.length - 1) {
      x += GAP;
      ctx.lineWidth = scale;
      ctx.beginPath();
      ctx.moveTo(x, 4 * scale);
      ctx.lineTo(x, (height - 3) * scale);
      ctx.stroke();
      x += GAP;
    }
  });
  return { url: canvas.toDataURL("image/png"), width: canvas.width / scale };
}

let queue = Promise.resolve();

/**
 * 画出菜单栏用的模板图。画不出来（窗口还没准备好之类）返回 null，调用方继续用原来的图标。
 * @param {{ name: string, percent: number }[]} cols
 * @returns {Promise<Electron.NativeImage | null>}
 */
export function renderQuotaImage(cols) {
  // 一次只画一张，免得几次状态变化同时往窗口里塞脚本
  const job = queue.then(async () => {
    try {
      const win = ensurePainter();
      if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once("did-finish-load", r));
      const { url, width } = await win.webContents.executeJavaScript(`(${draw})(${JSON.stringify(cols)}, ${HEIGHT}, ${SCALE})`);
      const image = nativeImage.createEmpty();
      image.addRepresentation({ scaleFactor: SCALE, width, height: HEIGHT, dataURL: url });
      image.setTemplateImage(true);
      return image;
    } catch (err) {
      console.warn("[tray] 画额度图标失败:", err instanceof Error ? err.message : err);
      return null;
    }
  });
  queue = job.then(() => undefined);
  return job;
}
