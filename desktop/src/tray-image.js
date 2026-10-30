// macOS 菜单栏图标换成额度条：选的每一项一只小宠物，看外形就知道是谁（Claude 是带腿的像素小螃蟹，
// Codex 是两只方眼睛的胶囊）。宠物的身子是 5 小时额度条，下面的胶囊是 7 天（周）额度条；
// 默认实心部分是还剩多少（像电池），设置里可以换成实心是用掉多少，另一部分变淡。
// 图标上不写服务器名：按服务器选的项和「所有服务器」长得一样，顺序照设置里选的来。
// 画成黑色 + 透明的模板图，系统按菜单栏的深浅色自己着色，淡的部分就是半透明。
//
// 主进程没有 canvas：用一个不显示的小窗口画，画好拿 PNG 回来。
import { BrowserWindow, nativeImage } from "electron";

/** 菜单栏图标的高度（pt），按 2 倍图画 */
const HEIGHT = 22;
const SCALE = 2;

/** 有宠物外形的 agent（形状在 draw 里） */
const PETS = ["claude", "codex"];

/** 一台服务器上某个 agent 某个窗口（5h / 7d）的已用百分比。Claude 按模型分的窗口叫「7d Opus」之类，只要总的那个 */
function usedOf(server, agent, short) {
  let best;
  for (const q of server.quotas ?? []) {
    if (q.agent !== agent) continue;
    const w = q.windows?.find((x) => x.short === short);
    if (w && Number.isFinite(w.percent)) best = Math.max(best ?? 0, w.percent);
  }
  return best;
}

/** 这些服务器里用得最多的那个（0~100 的整数）；都没查到是 undefined */
function maxUsed(servers, agent, short) {
  let best;
  for (const s of servers) {
    const p = usedOf(s, agent, short);
    if (p !== undefined) best = Math.max(best ?? 0, p);
  }
  return best === undefined ? undefined : Math.round(Math.max(0, Math.min(100, best)));
}

/** 「serverId:agent」，serverId 是 * 表示所有服务器合起来 */
export const ALL_SERVERS = "*";

/**
 * 按设置里选的项（顺序照选的来）挑出要画的宠物，session / week 是条的实心比例（0~100）。
 *   「*:claude」：所有服务器的 Claude 取用得最多的（多半是同一个账号）：宁可提醒早一点。
 *   「<id>:claude」：只看那台服务器。
 * 还没查到 5 小时额度、服务器已经删了的项跳过；周额度没有就不画下面的胶囊。
 * @param {{ id: string, quotas?: { agent: string, windows?: { short: string, percent: number }[] }[] }[]} servers
 * @param {string[]} items
 * @param {"remaining" | "used"} mode 实心是剩余额度还是已用额度
 * @returns {{ agent: string, session: number, week?: number }[]}
 */
export function quotaBars(servers, items, mode = "remaining") {
  const fill = (used) => (used === undefined || mode === "used" ? used : 100 - used);
  const out = [];
  for (const item of items) {
    const i = item.lastIndexOf(":");
    const sid = item.slice(0, i);
    const agent = item.slice(i + 1);
    if (!PETS.includes(agent)) continue;
    const pool = sid === ALL_SERVERS ? servers : servers.filter((s) => s.id === sid);
    const session = fill(maxUsed(pool, agent, "5h"));
    if (session === undefined) continue;
    const week = fill(maxUsed(pool, agent, "7d"));
    out.push({ agent, session, ...(week === undefined ? {} : { week }) });
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

/** 在画图窗口里跑的：一只宠物一栏，返回 PNG 的 data URL 和逻辑宽度。坐标都按 pt 的像素格子来 */
function draw(bars, height, scale) {
  const W = 18;
  const GAP = 12;
  const PAD = 2;
  /** 用掉的部分留多少不透明度 */
  const DIM = 0.3;
  // 每只宠物：body 是 5 小时条的形状，holes 是眼睛（挖空），legs 不算进条里、一直是实的。
  // fill 是百分比按哪段宽度算，span 是整条的左右范围（默认和 fill 一样）。Claude 两侧的耳朵不算进百分比：
  // 算进去的话剩 10% 时只有左耳是实的，身子全淡，看着像用完了；左耳有剩就实、右耳满了才实
  const PETS = {
    claude: {
      body: [
        [2, 4, 14, 6],
        [0, 6, 2, 2],
        [16, 6, 2, 2],
      ],
      holes: [
        [5, 5, 1, 2],
        [12, 5, 1, 2],
      ],
      legs: [
        [3, 10, 1, 2],
        [5, 10, 1, 2],
        [12, 10, 1, 2],
        [14, 10, 1, 2],
      ],
      fill: [2, 16],
      span: [0, 18],
    },
    codex: {
      pill: [1, 4, 16, 6],
      holes: [
        [5, 6, 2, 2],
        [11, 6, 2, 2],
      ],
      legs: [],
      fill: [1, 17],
    },
  };
  const BODY_Y = [4, 10];
  const WEEK = [2, 14, 14, 4];

  const canvas = document.createElement("canvas");
  canvas.width = (PAD * 2 + W * bars.length + GAP * (bars.length - 1)) * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  const px = (v) => v * scale;
  const rect = (x0, [x, y, w, h]) => ctx.fillRect(px(x0 + x), px(y), px(w), px(h));
  const pill = (x0, [x, y, w, h]) => {
    ctx.beginPath();
    ctx.roundRect(px(x0 + x), px(y), px(w), px(h), px(h / 2));
    ctx.fill();
  };
  // 条的右边（实心以外的部分）擦淡：left / right 是百分比按哪段算，filled 是实心的百分比，
  // [from, to] 是整条的范围（两头可能比 left / right 宽）：0% 时整条都淡，100% 时整条都实
  const dim = (x0, left, right, top, bottom, filled, [from, to] = [left, right]) => {
    if (filled >= 100) return;
    const cut = filled <= 0 ? px(x0 + from) : px(x0 + left) + Math.round(((right - left) * scale * filled) / 100);
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = `rgba(0,0,0,${1 - DIM})`;
    ctx.fillRect(cut, px(top), px(x0 + to) - cut, px(bottom - top));
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#000";
  };

  ctx.fillStyle = "#000";
  bars.forEach((b, i) => {
    const x0 = PAD + i * (W + GAP);
    const pet = PETS[b.agent];
    if (pet.pill) pill(x0, pet.pill);
    for (const r of pet.body ?? []) rect(x0, r);
    for (const [x, y, w, h] of pet.holes) ctx.clearRect(px(x0 + x), px(y), px(w), px(h));
    dim(x0, pet.fill[0], pet.fill[1], BODY_Y[0], BODY_Y[1], b.session, pet.span);
    for (const r of pet.legs) rect(x0, r);
    if (b.week !== undefined) {
      pill(x0, WEEK);
      dim(x0, WEEK[0], WEEK[0] + WEEK[2], WEEK[1], WEEK[1] + WEEK[3], b.week);
    }
  });
  return { url: canvas.toDataURL("image/png"), width: canvas.width / scale };
}

let queue = Promise.resolve();

/**
 * 画出菜单栏用的模板图。画不出来（窗口还没准备好之类）返回 null，调用方继续用原来的图标。
 * @param {{ agent: string, session: number, week?: number }[]} bars
 * @returns {Promise<Electron.NativeImage | null>}
 */
export function renderQuotaImage(bars) {
  // 一次只画一张，免得几次状态变化同时往窗口里塞脚本
  const job = queue.then(async () => {
    try {
      const win = ensurePainter();
      if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once("did-finish-load", r));
      const { url, width } = await win.webContents.executeJavaScript(`(${draw})(${JSON.stringify(bars)}, ${HEIGHT}, ${SCALE})`);
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
