// Agent Loft 桌面端（macOS）。
//
// 一个窗口：左边一条窄的服务器栏（本地页面 shell/index.html），右边是当前服务器自己的
// Web 界面。每台服务器的页面常驻后台，WebSocket 一直连着；服务器推来的提醒由页面经
// preload 转给这里，弹 macOS 系统通知（桌面端收不到 Web Push）。菜单栏另有图标，
// 悬停显示各服务器的额度和待处理（见 tray.js）。
import { app, BaseWindow, dialog, ipcMain, Menu, Notification, WebContentsView } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { localUrl, readSetupToken } from "./local-server.js";
import {
  addUnread,
  applyAuth,
  callApi,
  clearUnread,
  dispose,
  pageOwner,
  probe,
  publicState,
  refreshAll,
  refreshQuota,
  reload,
  refreshServerVersion,
  rt,
  servers,
  setPageQuota,
  setPageState,
  trustCert,
  upgradeServer,
  viewFor,
} from "./servers.js";
import { loadStore, store } from "./store.js";
import { applyUpdate, checkUpdates, local, loginAgent, refreshLocal, scheduleUpdates, system, systemState } from "./system.js";
import { createTray, hidePopover, popoverHover, popoverResize, popoverWebContents, updateTray } from "./tray.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** 左侧服务器栏的宽度，和 shell/shell.css 里的 --rail 一致 */
const RAIL = 72;

/** @type {BaseWindow | null} */
let win = null;
/** @type {WebContentsView | null} */
let shellView = null;
/** @type {string | null} */
let activeId = null;
/** 侧栏正显示「服务器管理」面板（这时不挂服务器页面） */
let managing = false;
let quitting = false;

// 开发时用另一个配置目录，不碰日常在用的那份
if (process.env.AGENT_LOFT_DESKTOP_HOME) app.setPath("userData", path.resolve(process.env.AGENT_LOFT_DESKTOP_HOME));

if (!app.requestSingleInstanceLock()) app.quit();

// ---------- 状态 ----------

function snapshot() {
  return {
    servers: store.servers().map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      trusted: !!s.certFingerprint,
      authDomains: s.authDomains ?? [],
      // Secret 不出主进程，界面只知道有没有配
      serviceTokenId: s.serviceToken?.clientId ?? null,
      ...publicState(s.id),
    })),
    activeId,
    managing,
    prefs: store.prefs(),
    version: app.getVersion(),
    onboarded: store.onboarded(),
    localId: localServerId(),
    system: systemState(),
  };
}

/** 列表里代表本机服务端的那一项（地址是 127.0.0.1 / localhost 加本机端口） */
function localServerId() {
  const url = new URL(localUrl());
  const candidates = [url.origin, `http://localhost:${url.port}`];
  return store.servers().find((s) => candidates.includes(s.url))?.id ?? null;
}

/** 本机服务端还不在列表里就加上，叫「本机」 */
function ensureLocalServer() {
  const existing = localServerId();
  if (existing) return existing;
  const server = store.addServer("本机", localUrl());
  viewFor(server.id);
  broadcast();
  return server.id;
}

function broadcast() {
  const state = snapshot();
  for (const wc of [shellView?.webContents, popoverWebContents()]) {
    if (wc && !wc.isDestroyed()) wc.send("shell:state", state);
  }
  updateTray(state);
  const unread = state.servers.reduce((n, s) => n + s.unread, 0);
  app.dock?.setBadge(unread ? String(unread) : "");
  layout();
  rebuildMenu();
}

servers.on("change", broadcast);
system.on("change", broadcast);
system.on("show-update", () => showManage("update"));

// 原本在线的服务器要重新过网关验证（Cloudflare Access 会话过期）：后台页面收不到任何
// 消息了，得提醒一声
servers.on("access-expired", (id) => {
  const server = store.server(id);
  if (!server || !Notification.isSupported()) return;
  const kind = rt(id).access?.kind === "cloudflare" ? "Cloudflare Access" : "登录网关";
  const note = new Notification({
    title: `「${server.name}」需要重新验证`,
    body: `${kind}的登录已过期，验证之前收不到这台服务器的通知。点这里去验证。`,
  });
  const tag = `${id}:access`;
  liveNotices.get(tag)?.close();
  note.on("click", () => openTarget(id));
  note.on("close", () => liveNotices.get(tag) === note && liveNotices.delete(tag));
  liveNotices.set(tag, note);
  note.show();
  if (!(win?.isFocused() && activeId === id && !managing)) addUnread(id);
});

// ---------- 窗口 ----------

function createWindow() {
  const saved = store.bounds();
  win = new BaseWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 820,
    ...(saved ? { x: saved.x, y: saved.y } : {}),
    minWidth: 760,
    minHeight: 500,
    show: false,
    title: "Agent Loft",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    vibrancy: "sidebar",
    backgroundColor: "#00000000",
  });

  shellView = new WebContentsView({
    webPreferences: {
      preload: path.join(here, "preload-shell.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      transparent: true,
    },
  });
  shellView.setBackgroundColor("#00000000");
  win.contentView.addChildView(shellView);
  void shellView.webContents.loadFile(path.join(here, "shell/index.html"));
  shellView.webContents.once("did-finish-load", () => {
    if (!app.getLoginItemSettings().wasOpenedAtLogin) win?.show();
  });

  win.on("resize", layout);
  for (const ev of ["resized", "moved"]) win.on(ev, saveBounds);
  win.on("focus", () => {
    if (activeId && !managing) {
      clearUnread(activeId);
      viewFor(activeId).webContents.focus();
    }
  });
  // 关窗口只是藏起来：页面在后台继续连着，菜单栏图标还在，通知照样弹
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
  });
  win.on("closed", () => {
    win = null;
    shellView = null;
  });
}

let boundsTimer = null;
function saveBounds() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isFullScreen()) store.setBounds(win.getNormalBounds());
  }, 500);
}

/** 右边挂当前服务器的页面；管理面板、连不上时只显示侧栏自己的内容 */
function layout() {
  if (!win || win.isDestroyed() || !shellView) return;
  const { width, height } = win.getContentBounds();
  shellView.setBounds({ x: 0, y: 0, width, height });
  const want = !managing && activeId && store.server(activeId) && !rt(activeId).loadFailed ? viewFor(activeId) : null;
  for (const child of win.contentView.children) {
    if (child !== shellView && child !== want) win.contentView.removeChildView(child);
  }
  if (want) {
    if (!win.contentView.children.includes(want)) win.contentView.addChildView(want);
    want.setBounds({ x: RAIL, y: 0, width: Math.max(0, width - RAIL), height });
  }
}

function showMain() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function select(id) {
  if (id && !store.server(id)) return;
  activeId = id;
  managing = !id;
  if (id) {
    store.setLastActive(id);
    clearUnread(id);
    if (rt(id).status !== "online") void probe(id);
  }
  broadcast();
  if (id && !rt(id).loadFailed) viewFor(id).webContents.focus();
}

function showManage(what = "manage") {
  showMain();
  managing = true;
  broadcast();
  shellView?.webContents.send("shell:show", what);
}

/** 跳到某台服务器的某条会话（点通知、点菜单栏里的待处理项） */
function openTarget(id, key) {
  if (!store.server(id)) return;
  hidePopover();
  showMain();
  select(id);
  if (key) viewFor(id).webContents.send("page:open", String(key));
}

// ---------- 菜单 ----------

let menuSignature = "";
function rebuildMenu() {
  const list = store.servers();
  const signature = JSON.stringify([list.map((s) => [s.id, s.name]), activeId, managing]);
  if (signature === menuSignature) return;
  menuSignature = signature;
  const activeWc = () => (activeId && !managing ? viewFor(activeId).webContents : shellView?.webContents);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        role: "appMenu",
        submenu: [
          { role: "about", label: "关于 Agent Loft" },
          {
            label: "检查更新…",
            click: () => {
              showManage("update");
              void checkUpdates({ manual: true });
            },
          },
          { type: "separator" },
          { label: "设置…", accelerator: "Command+,", click: () => showManage() },
          { type: "separator" },
          { role: "hide", label: "隐藏 Agent Loft" },
          { role: "hideOthers", label: "隐藏其他" },
          { role: "unhide", label: "全部显示" },
          { type: "separator" },
          { label: "退出 Agent Loft", accelerator: "Command+Q", click: quit },
        ],
      },
      { role: "editMenu", label: "编辑" },
      {
        label: "显示",
        submenu: [
          { label: "重新加载", accelerator: "Command+R", click: () => (activeId && !managing ? reload(activeId) : activeWc()?.reload()) },
          { label: "开发者工具", accelerator: "Alt+Command+I", click: () => activeWc()?.toggleDevTools() },
          { type: "separator" },
          { role: "resetZoom", label: "实际大小" },
          { role: "zoomIn", label: "放大" },
          { role: "zoomOut", label: "缩小" },
          { type: "separator" },
          { role: "togglefullscreen", label: "全屏" },
        ],
      },
      {
        label: "服务器",
        submenu: [
          ...list.map((s, i) => ({
            label: s.name,
            type: "radio",
            checked: s.id === activeId && !managing,
            accelerator: i < 9 ? `Command+${i + 1}` : undefined,
            click: () => select(s.id),
          })),
          ...(list.length ? [{ type: "separator" }] : []),
          { label: "添加服务器…", click: () => showManage("add") },
          { label: "刷新额度", click: () => refreshAll({ quota: true }) },
        ],
      },
      { role: "windowMenu", label: "窗口" },
    ]),
  );
}

// ---------- 页面发来的（经 preload-page.cjs） ----------

const str = (v, max) => String(v ?? "").slice(0, max);
/** 通知对象要留着引用，否则被回收后点击没反应；同一个 tag 只留最新一条 */
const liveNotices = new Map();

ipcMain.on("page:notify", (e, notice) => {
  const id = pageOwner(e);
  const server = id && store.server(id);
  if (!server) return;
  const key = str(notice?.key, 300);
  const tag = `${id}:${str(notice?.tag, 200)}`;
  const lookingHere = win?.isFocused() && activeId === id && !managing;
  if (!lookingHere) addUnread(id);
  if (!Notification.isSupported()) return;
  liveNotices.get(tag)?.close();
  const note = new Notification({
    title: str(notice?.title, 120) || "Agent Loft",
    subtitle: store.servers().length > 1 ? server.name : undefined,
    body: str(notice?.body, 300),
  });
  note.on("click", () => openTarget(id, key));
  note.on("close", () => liveNotices.get(tag) === note && liveNotices.delete(tag));
  liveNotices.set(tag, note);
  note.show();
});

ipcMain.on("page:state", (e, state) => {
  const id = pageOwner(e);
  if (id) setPageState(id, state);
});

ipcMain.on("page:quota", (e, quotas) => {
  const id = pageOwner(e);
  if (id) setPageQuota(id, quotas);
});

// ---------- 侧栏和菜单栏面板发来的（经 preload-shell.cjs） ----------

/** 只接受桌面端自己的本地页面 */
function fromShell(e) {
  const wc = e.sender;
  return (wc === shellView?.webContents || wc === popoverWebContents()) && e.senderFrame?.url.startsWith("file://");
}

const calls = {
  select: (id) => select(id ?? null),
  manage: () => {
    hidePopover();
    showManage();
  },
  showMain: () => {
    hidePopover();
    showMain();
  },
  open: (id, key) => openTarget(id, key),

  addServer: (name, url, auth) => {
    const server = store.addServer(name, url);
    // 认证设置要在页面第一次加载前就位，不然第一下就被网关拦住
    if (auth) {
      try {
        store.updateAuth(server.id, auth);
      } catch (err) {
        store.removeServer(server.id);
        throw err;
      }
    }
    viewFor(server.id);
    select(server.id);
    return server.id;
  },
  updateServer: (id, values, auth) => {
    const { urlChanged } = store.updateServer(id, { name: values?.name, url: values?.url });
    const authChanged = auth ? store.updateAuth(id, auth) : false;
    if (urlChanged) {
      dispose(id);
      viewFor(id);
    } else if (authChanged) {
      void applyAuth(id);
    }
    broadcast();
  },
  removeServer: async (id) => {
    const server = store.server(id);
    if (!server) return false;
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      message: `移除「${server.name}」？`,
      detail: "会同时清掉这台服务器在桌面端的登录状态。服务器本身和上面的会话不受影响。",
      buttons: ["移除", "取消"],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return false;
    dispose(id, { clearData: true });
    store.removeServer(id);
    if (activeId === id) activeId = null;
    managing = !activeId;
    broadcast();
    return true;
  },
  moveServer: (id, delta) => {
    store.moveServer(id, delta === 1 ? 1 : -1);
    broadcast();
  },
  reload: (id) => reload(id),
  trustCert: (id) => trustCert(id),
  refresh: () => refreshAll({ quota: true }),

  setPref: (key, value) => {
    store.setPref(key, value);
    if (key === "openAtLogin") app.setLoginItemSettings({ openAtLogin: value });
    if (key === "quotaRefreshMin") scheduleQuota();
    if (key === "autoUpdate" || key === "updateCheckHours") scheduleUpdates();
    broadcast();
  },

  // ---- 首次启动向导、本机服务端 ----
  finishOnboarding: (selectId) => {
    store.setOnboarded();
    if (selectId && store.server(selectId)) select(selectId);
    else broadcast();
  },
  localRefresh: () => refreshLocal(),
  /** 一键安装本机服务端：在终端里装（npm + launchd），装好后自动加进列表 */
  localInstall: async () => {
    await local.install();
    const status = await refreshLocal();
    return { id: ensureLocalServer(), needsSetup: status.needsSetup };
  },
  /** 本机已经有服务端在跑：直接加进列表 */
  localConnect: async () => {
    const status = await refreshLocal();
    if (!status.running) throw new Error("本机的服务端没有在运行");
    return { id: ensureLocalServer(), needsSetup: status.needsSetup };
  },
  /** 首次设置登录密码：设置码直接从 ~/.agent-loft 里读，用户不用去翻日志 */
  localSetup: async (password) => {
    const token = readSetupToken();
    if (!token) throw new Error("没找到设置码：服务端可能已经设置过密码了，直接在页面上登录就行");
    const id = ensureLocalServer();
    await callApi(id, "/api/setup", { method: "POST", body: { token, password: String(password ?? "") } });
    await refreshLocal();
    reload(id);
    return { id };
  },
  localRestart: () => local.restart(),
  localUninstall: async () => {
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      message: "停止本机服务端并取消开机自启？",
      detail: "和 agent-loft service uninstall 一样：停掉这台 Mac 上的 agent-loft。~/.agent-loft 里的配置和会话都保留，npm 装的程序也还在，以后点「启动」或执行 agent-loft service install 就能恢复。",
      buttons: ["停止", "取消"],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return false;
    await local.uninstall();
    return true;
  },
  localLogs: () => local.logs(),

  // ---- Agent 环境（任意服务器） ----
  agentHealth: (id, refresh) => callApi(id, `/api/agents/health${refresh ? "?refresh=1" : ""}`),
  /** 在服务器上装 Codex：服务端自己执行（Homebrew 或 npm），本机、远程都行 */
  installCodex: (id) => callApi(id, "/api/agents/codex/install", { method: "POST", timeoutMs: 11 * 60_000 }),
  /** 登录要在浏览器里点，只能在本机：打开终端 */
  loginAgent: async (agent) => {
    const id = localServerId();
    let sdkClaude = null;
    if (agent === "claude" && id) {
      // 系统里没装 Claude Code 时，用服务端 SDK 自带的那个 claude 登录（同一个程序）
      const health = await callApi(id, "/api/agents/health").catch(() => null);
      const cmd = health?.agents?.find((a) => a.id === "claude")?.fix?.commands?.[0];
      if (cmd) sdkClaude = cmd.replace(/^"(.*)"$/, "$1").replace(/\\(["\\$`])/g, "$1");
    }
    await loginAgent(agent, sdkClaude);
  },

  // ---- 服务端版本 ----
  checkServerVersion: (id) => refreshServerVersion(id, true),
  upgradeServer: (id) => upgradeServer(id),

  // ---- 更新 ----
  checkUpdates: () => checkUpdates({ manual: true }),
  applyUpdate: () => applyUpdate(quit),

  popoverHover: (inside) => popoverHover(!!inside),
  popoverResize: (height) => popoverResize(Number(height) || 0),
  quit: () => quit(),
};

ipcMain.handle("shell:state", (e) => (fromShell(e) ? snapshot() : null));
ipcMain.handle("shell:call", async (e, method, ...args) => {
  if (!fromShell(e) || !Object.hasOwn(calls, method)) throw new Error("不支持的操作");
  return calls[method](...args);
});

// ---------- 定时刷新 ----------

let quotaTimer = null;
function scheduleQuota() {
  clearInterval(quotaTimer);
  quotaTimer = setInterval(() => refreshAll({ quota: true }), store.prefs().quotaRefreshMin * 60_000);
}

// ---------- 启动和退出 ----------

function quit() {
  quitting = true;
  app.quit();
}

app.on("before-quit", () => {
  quitting = true;
});
app.on("second-instance", showMain);
app.on("activate", showMain);
// 窗口全关了也不退出：菜单栏图标还在
app.on("window-all-closed", () => {});

app.whenReady().then(() => {
  app.setName("Agent Loft");
  loadStore();
  void refreshLocal();

  createTray({
    showMain,
    refresh: () => refreshAll({ quota: true }),
    quit,
    setPref: (key, value) => calls.setPref(key, value),
    onPopoverShown: () => {
      // 面板打开时，过时超过一分钟的额度顺手刷一下
      for (const s of store.servers()) {
        const r = rt(s.id);
        if (r.status === "online" && Date.now() - (r.quotaAt ?? 0) > 60_000) void refreshQuota(s.id);
      }
    },
  });

  // 所有服务器的页面一启动就在后台加载好：没点开过的服务器也能收到通知
  for (const s of store.servers()) viewFor(s.id);
  const last = store.lastActive();
  activeId = last && store.server(last) ? last : (store.servers()[0]?.id ?? null);
  // 还没走过首次启动向导：侧栏显示向导
  managing = !activeId || !store.onboarded();

  createWindow();
  broadcast();
  refreshAll();
  scheduleQuota();
  // 在线状态每分钟看一次（只打公开的 /api/me）
  setInterval(() => refreshAll(), 60_000);
  scheduleUpdates();
  if (app.isPackaged && store.prefs().autoUpdate) setTimeout(() => void checkUpdates(), 15_000);
});
