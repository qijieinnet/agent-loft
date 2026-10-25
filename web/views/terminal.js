import { Terminal } from "/vendor/xterm.js";
import { FitAddon } from "/vendor/xterm-fit.js";
import { fill, h, icon, isTouch, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { S, ui } from "../state.js";
import { showAuth } from "./auth.js";
import { renderSidebar } from "./sidebar.js";
import { baseName, currentCwd } from "./topbar.js";
import { leaveRemote, openRemote } from "./remote.js";
import { attachTermTouch } from "./terminal-touch.js";

// ---------- 网页终端 ----------
// shell 跑在服务端（core/terminals.ts），这里每个标签一条 /ws/term 连接。
// 两种摆法：放在远程控制页里（embed），或者对话下面的底部面板（dock，Ctrl+`）。是同一块面板，挪个地方而已。
// 离开远程控制页、关掉面板、刷新页面都不结束 shell，下次打开时按服务端的列表接上；点标签上的 × 才结束。

const T = {
  /** closed：藏起来（shell 照常跑）/ dock：底部面板 / embed：在远程控制页里 */
  mode: "closed",
  tabs: [],
  active: null,
  /** 手机上的 Ctrl / Alt 键：按一下，下一个字符变成 Ctrl+字符 / Alt+字符 */
  ctrl: false,
  alt: false,
  loaded: false,
};

const narrow = () => matchMedia("(max-width: 768px)").matches;
const dark = matchMedia("(prefers-color-scheme: dark)");

const THEMES = {
  light: {
    background: "#ffffff",
    foreground: "#1f2328",
    cursor: "#1f2328",
    selectionBackground: "#b6d6fd",
    black: "#24292f",
    red: "#cf222e",
    green: "#116329",
    yellow: "#9a6700",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#633c01",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#8c959f",
  },
  dark: {
    background: "#171717",
    foreground: "#e6e6e6",
    cursor: "#e6e6e6",
    selectionBackground: "#264f78",
    black: "#484f58",
    red: "#ff7b72",
    green: "#3fb950",
    yellow: "#d29922",
    blue: "#58a6ff",
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: "#b1bac4",
    brightBlack: "#6e7681",
    brightRed: "#ffa198",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#79c0ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",
    brightWhite: "#f0f6fc",
  },
};
const theme = () => (dark.matches ? THEMES.dark : THEMES.light);
dark.addEventListener("change", () => {
  for (const tab of T.tabs) tab.term.options.theme = theme();
});

// xterm 的样式：第一次用到终端时才加载
document.head.append(h("link", { rel: "stylesheet", href: "/vendor/xterm.css" }));

// ---------- 面板 ----------

/** 底部面板的高度，记在本机 */
const savedHeight = () => Number(localStorage.getItem("aim.termH")) || 0;

function ensureDock() {
  if (ui.termDock) return;
  ui.termTabs = h("div", { class: "term-tabs", role: "tablist" });
  ui.termPanes = h("div", { class: "term-panes" });
  ui.termKeys = isTouch ? keyRow() : null;
  ui.termDock = h(
    "section",
    { class: "term-dock", hidden: true, "aria-label": "终端" },
    h("div", { class: "term-resizer", title: "拖动调整高度，双击恢复默认", onpointerdown: startResize, ondblclick: () => setHeight(null) }),
    h(
      "div",
      { class: "term-head" },
      ui.termTabs,
      h("button", { class: "icon-btn term-act", title: "新建终端", onclick: () => void newTab() }, icon("plus")),
      h("span", { class: "grow" }),
      (ui.termMax = h("button", { class: "icon-btn term-act", onclick: () => (T.mode === "embed" ? toDock() : void openRemote("terminal")) })),
      (ui.termHide = h("button", { class: "icon-btn term-act", title: "收起（终端在后台继续运行）", onclick: () => hide() }, icon("down"))),
    ),
    ui.termPanes,
    ui.termKeys,
  );
  ui.main.append(ui.termDock);
  setHeight(savedHeight() || null);
  new ResizeObserver(() => fitActive()).observe(ui.termPanes);
}

function setHeight(px) {
  if (px) {
    localStorage.setItem("aim.termH", String(Math.round(px)));
    ui.termDock.style.setProperty("--term-h", `${Math.round(px)}px`);
  } else {
    localStorage.removeItem("aim.termH");
    ui.termDock.style.removeProperty("--term-h");
  }
}

function startResize(e) {
  if (T.mode !== "dock" || e.button !== 0) return;
  e.preventDefault();
  const startY = e.clientY;
  const startH = ui.termDock.getBoundingClientRect().height;
  const max = ui.main.getBoundingClientRect().height - 160;
  const move = (ev) => setHeight(Math.max(120, Math.min(max, startH + startY - ev.clientY)));
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.body.classList.remove("resizing-v");
  };
  document.body.classList.add("resizing-v");
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function renderHead() {
  fill(
    ui.termTabs,
    T.tabs.map((tab) =>
      h(
        "div",
        {
          class: `term-tab${tab === T.active ? " on" : ""}${tab.ended ? " ended" : ""}`,
          role: "tab",
          title: `${tab.cwd}${tab.ended ? `\n${tab.ended}` : ""}`,
          onclick: () => select(tab),
          onauxclick: (e) => e.button === 1 && void closeTab(tab),
        },
        h("span", { class: "term-tab-name" }, tab.title || baseName(tab.cwd) || "终端"),
        tab.state === "connecting" ? h("span", { class: "conv-spin", title: "正在连接" }) : null,
        h("button", { class: "term-tab-x", title: tab.ended ? "关闭" : "结束这个终端", onclick: (e) => (e.stopPropagation(), void closeTab(tab)) }, icon("x")),
      ),
    ),
  );
  const embed = T.mode === "embed";
  fill(ui.termMax, icon(embed ? "restore" : "maximize"));
  ui.termMax.title = embed ? "放到对话下面" : "放大（远程控制）";
  // 手机上没有底部面板
  ui.termMax.hidden = embed && narrow();
  ui.termHide.hidden = embed;
  S.remoteLive.terminals = T.tabs.filter((t) => !t.ended).length;
  renderSidebar();
}

function renderEmptyPane() {
  if (T.tabs.length) return;
  const status = S.remote?.terminal ?? {};
  fill(
    ui.termPanes,
    h(
      "div",
      { class: "term-empty" },
      status.available === false
        ? h("div", { class: "error-text" }, status.reason ?? "这台服务器上终端用不了")
        : [h("div", { class: "muted" }, "没有开着的终端"), h("button", { class: "btn", onclick: () => void newTab() }, icon("plus"), "新建终端")],
    ),
  );
}

/** 换摆法：dock / embed / closed。embed 时 host 是远程控制页里放终端的那块 */
function setMode(mode, host) {
  ensureDock();
  T.mode = mode;
  if (mode === "embed" && host && ui.termDock.parentNode !== host) host.append(ui.termDock);
  if (mode === "dock" && ui.termDock.parentNode !== ui.main) ui.main.append(ui.termDock);
  ui.termDock.classList.toggle("embedded", mode === "embed");
  ui.termDock.hidden = mode === "closed";
  renderHead();
  if (mode !== "closed") {
    fitActive();
    T.active?.term.focus();
  }
}

/** 远程控制页切到「终端」 */
export async function embedIn(host) {
  setMode("embed", host);
  await loadTabs();
}

/** 放到对话下面：先回到进远程控制之前的地方 */
function toDock() {
  if (narrow()) return;
  if (S.view === "remote") leaveRemote();
  setMode("dock");
}

/** Ctrl+`：底部面板开 / 关；手机上屏幕太小，打开远程控制里的终端 */
export async function toggleDock() {
  if (narrow()) return openRemote("terminal");
  if (T.mode === "dock") return hide();
  if (S.view === "remote") leaveRemote();
  setMode("dock");
  await loadTabs();
}

/** 收起底部面板，shell 留着 */
export function hide() {
  if (T.mode === "dock") setMode("closed");
}

// ---------- 标签 ----------

/** 按服务端的列表对一下：别的设备开的接上，已经结束的标出来 */
async function loadTabs() {
  let data;
  try {
    data = await api("/api/terminals");
  } catch (err) {
    toast(err.message);
    return;
  }
  if (S.remote) S.remote.terminal = { enabled: data.enabled, allowed: data.allowed, available: data.available, reason: data.reason, keepAliveMin: data.keepAliveMin };
  if (!data.allowed) return revoked();
  const ids = new Set(data.terminals.map((t) => t.id));
  for (const tab of T.tabs) if (!ids.has(tab.id) && !tab.ended) ended(tab, "已经结束了");
  for (const t of data.terminals) if (!T.tabs.some((tab) => tab.id === t.id)) addTab(t, false);
  // 第一次打开、一个都没有：直接开一个
  if (!T.loaded && T.tabs.length === 0 && data.available) {
    T.loaded = true;
    await newTab();
    return;
  }
  T.loaded = true;
  if (!T.active && T.tabs.length) select(T.tabs[T.tabs.length - 1]);
  renderHead();
  renderEmptyPane();
}

async function newTab() {
  ensureDock();
  // 先按面板现在的大小算好行列，shell 一开始就是对的宽度
  const probe = T.active?.fit.proposeDimensions();
  let info;
  try {
    info = await api("/api/terminals", { method: "POST", body: { cwd: currentCwd(), cols: probe?.cols, rows: probe?.rows } });
  } catch (err) {
    toast(err.message);
    return;
  }
  if (T.mode === "closed") {
    if (narrow()) return void openRemote("terminal");
    setMode("dock");
  }
  // 服务端推的 { t: "remote" } 可能先到、已经加上了
  select(T.tabs.find((t) => t.id === info.id) ?? addTab(info, true));
}

function addTab(info, focus) {
  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: narrow() ? 12 : 13,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: false,
    theme: theme(),
    macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const el = h("div", { class: "term-pane", hidden: true });
  const tab = { id: info.id, cwd: info.cwd, title: "", term, fit, el, sock: null, total: -1, state: "connecting", ended: "", backoff: 500, retry: 0, size: "" };
  T.tabs.push(tab);
  if (T.tabs.length === 1) fill(ui.termPanes);
  ui.termPanes.append(el);
  term.open(el);
  term.onData((d) => sendInput(tab, d));
  term.onBinary((d) => sendInput(tab, d));
  term.onTitleChange((title) => {
    tab.title = title.trim().slice(0, 40);
    renderHead();
  });
  term.attachCustomKeyEventHandler((e) => {
    // Ctrl+Shift+C / V：复制、粘贴（Ctrl+C 留给 shell 当中断）。交给浏览器，xterm 自己会处理 copy / paste 事件
    if (e.type === "keydown" && e.ctrlKey && e.shiftKey && (e.code === "KeyC" || e.code === "KeyV")) return false;
    // Ctrl+`：收起 / 打开面板
    if (e.type === "keydown" && e.ctrlKey && e.code === "Backquote") return false;
    return true;
  });
  // 手机：手指翻历史、长按选字
  if (isTouch) attachTermTouch(tab, (d) => sendInput(tab, d));
  connect(tab);
  if (focus) select(tab);
  else renderHead();
  return tab;
}

function select(tab) {
  T.active = tab;
  for (const t of T.tabs) t.el.hidden = t !== tab;
  renderHead();
  fitActive();
  if (T.mode !== "closed") tab.term.focus();
}

async function closeTab(tab) {
  if (!tab.ended) {
    try {
      await api(`/api/terminals/${encodeURIComponent(tab.id)}`, { method: "DELETE" });
    } catch (err) {
      if (err.status !== 404) return toast(err.message);
    }
  }
  removeTab(tab);
}

function removeTab(tab) {
  tab.ended ||= "已关闭";
  clearTimeout(tab.retry);
  tab.sock?.close();
  tab.term.dispose();
  tab.el.remove();
  const i = T.tabs.indexOf(tab);
  if (i >= 0) T.tabs.splice(i, 1);
  if (T.active === tab) {
    T.active = null;
    const next = T.tabs[Math.min(i, T.tabs.length - 1)];
    if (next) select(next);
  }
  // 底部面板里关掉最后一个：面板也收起来；远程控制页里留着「新建终端」
  if (!T.tabs.length && T.mode === "dock") setMode("closed");
  renderHead();
  renderEmptyPane();
}

function ended(tab, reason) {
  if (tab.ended) return;
  tab.ended = reason || "已结束";
  tab.state = "ended";
  clearTimeout(tab.retry);
  tab.term.write(`\r\n\x1b[2m[${tab.ended}]\x1b[0m\r\n`);
  renderHead();
}

/** 权限被收回：所有标签都关掉 */
function revoked() {
  for (const tab of [...T.tabs]) {
    tab.ended = "终端权限已被收回";
    removeTab(tab);
  }
  setMode("closed");
}

// ---------- 连接 ----------

function connect(tab) {
  if (tab.ended || (tab.sock && tab.sock.readyState <= 1)) return;
  clearTimeout(tab.retry);
  tab.state = "connecting";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const sock = new WebSocket(`${proto}://${location.host}/ws/term?${new URLSearchParams({ id: tab.id, since: String(tab.total) })}`);
  tab.sock = sock;
  sock.onopen = () => {
    tab.backoff = 500;
    tab.size = "";
    sendSize(tab);
  };
  sock.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.t === "o") {
      tab.term.write(msg.d);
      tab.total += msg.d.length;
    } else if (msg.t === "a") {
      if (msg.reset) tab.term.reset();
      tab.term.write(msg.d);
      tab.total = msg.total;
      tab.state = "open";
      renderHead();
    } else if (msg.t === "x") {
      ended(tab, msg.reason);
    }
  };
  sock.onclose = async (e) => {
    if (tab.sock !== sock || tab.ended) return;
    tab.state = "connecting";
    renderHead();
    if (e.code === 4000) return ended(tab, e.reason || "已结束");
    if (e.code === 4401) return showAuth();
    if (e.code === 4403) return revoked();
    // 握手被拒在浏览器里只表现为 1006：问一下服务端这个终端还在不在
    if (e.code === 1006) {
      try {
        const data = await api("/api/terminals");
        if (!data.allowed) return revoked();
        if (!data.terminals.some((t) => t.id === tab.id)) return ended(tab, "已经结束了");
      } catch {
        // 连不上服务端：照常重试
      }
    }
    tab.retry = setTimeout(() => connect(tab), tab.backoff);
    tab.backoff = Math.min(tab.backoff * 2, 10_000);
  };
}

function send(tab, msg) {
  if (tab.sock?.readyState === 1) tab.sock.send(JSON.stringify(msg));
}

function sendInput(tab, d) {
  if (tab.ended) return;
  // 手机上点了 Ctrl：下一个字母变成控制字符；点了 Alt：前面加个 Esc（终端里 Alt 就是这么发的）
  if (T.ctrl && d.length === 1) {
    const c = d.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) d = String.fromCharCode(c & 31);
    setMod("ctrl", false);
  }
  if (T.alt && d.length >= 1) {
    d = `\x1b${d}`;
    setMod("alt", false);
  }
  send(tab, { t: "i", d });
}

function sendSize(tab) {
  const size = `${tab.term.cols}x${tab.term.rows}`;
  if (size === tab.size) return;
  tab.size = size;
  send(tab, { t: "r", c: tab.term.cols, r: tab.term.rows });
}

function fitActive() {
  const tab = T.active;
  if (!tab || T.mode === "closed" || tab.el.hidden) return;
  // 面板藏着（远程控制页切走了、在看桌面）时量出来是 0：别把 shell 压成 2 列，等露出来再量
  if (!ui.termPanes.clientWidth || !ui.termPanes.clientHeight) return;
  try {
    tab.fit.fit();
  } catch {
    // 面板还没显示出来，量不了
  }
  sendSize(tab);
}

// 手机切到后台再回来、网络恢复：马上重连，别等退避
const reconnectAll = () => {
  for (const tab of T.tabs) if (tab.state === "connecting") connect(tab);
};
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && reconnectAll());
window.addEventListener("online", reconnectAll);

/** 服务端说终端列表变了（别的设备开了 / 关了、权限变了） */
export function syncTerminals() {
  if (T.loaded) void loadTabs();
}

// ---------- 手机上的快捷键 ----------

/** 方向键：程序开了「应用光标键」模式（vim、less…）时发 ESC O 那种 */
const arrow = (k) => () => (T.active?.term.modes.applicationCursorKeysMode ? `\x1bO${k}` : `\x1b[${k}`);

const KEYS = [
  ["Esc", "\x1b"],
  ["Tab", "\t"],
  ["Ctrl", "ctrl"],
  ["Alt", "alt"],
  ["←", arrow("D")],
  ["↑", arrow("A")],
  ["↓", arrow("B")],
  ["→", arrow("C")],
  ["Home", "\x1b[H"],
  ["End", "\x1b[F"],
  ["PgUp", "\x1b[5~"],
  ["PgDn", "\x1b[6~"],
  ["|", "|"],
  ["/", "/"],
  ["-", "-"],
  ["~", "~"],
  ["粘贴", "paste"],
];

function setMod(name, on) {
  T[name] = on;
  ui.termKeys?.querySelector(`[data-mod="${name}"]`)?.classList.toggle("on", on);
}

/** 粘贴：要浏览器允许读剪贴板（HTTPS，第一次会问） */
async function pasteInto(tab) {
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return toast("浏览器不让读剪贴板（要 HTTPS 并允许访问）");
  }
  // term.paste 会照顾「括号粘贴」模式，多行文字不会被一行行当命令执行
  if (text) tab.term.paste(text);
}

function keyRow() {
  return h(
    "div",
    { class: "term-keys" },
    KEYS.map(([label, key]) =>
      h(
        "button",
        {
          class: "term-key",
          "data-mod": key === "ctrl" || key === "alt" ? key : undefined,
          // 按下时别抢走焦点，不然软键盘会收起来
          onpointerdown: (e) => e.preventDefault(),
          onclick: () => {
            const tab = T.active;
            if (!tab) return;
            if (key === "ctrl" || key === "alt") setMod(key, !T[key]);
            else if (key === "paste") void pasteInto(tab);
            else sendInput(tab, typeof key === "function" ? key() : key);
            tab.term.focus();
          },
        },
        label,
      ),
    ),
  );
}
