// ---------- 状态 ----------

export const S = {
  agents: [],
  bots: [],
  convs: new Map(),
  pending: new Map(),
  current: null,
  /** 新对话的引擎（claude / codex），跟着选的专家走 */
  draftAgent: localStorage.getItem("aim.agent") || null,
  /** 新对话选的专家：内置的就是 claude / codex，自定义的是专家 id。记住上次的选择 */
  draftExpert: localStorage.getItem("aim.expert") || null,
  /** 自己的专家（bootstrap 里给，设置里改了重新拉） */
  experts: [],
  /** 新对话（还没发消息）选的工作目录，null 表示工作区根目录。开新对话时沿用上次选的 */
  draftCwd: null,
  /** 这个新对话的目录是自己选的：换专家时不再改成专家的默认目录。建好会话后清掉 */
  draftCwdPicked: false,
  items: [],
  turnAi: null,
  seq: new Map(),
  uploads: [],
  busy: false,
  allowedAgents: [],
  search: "",
  loadToken: 0,
  /** 登录的用户 { id, name, role } */
  user: null,
  /** 远程控制能用什么：{ allowed, terminal: {…}, desktop: {…} }，见 /api/remote */
  remote: null,
  /** 远程控制在后台连着的：桌面连着没、开着几个终端（侧栏「远程控制」上的小绿点） */
  remoteLive: { desktop: false, terminals: 0 },
  /** 主区域在显示什么：null 是对话（或新对话），"tasks" 是定时任务页，"remote" 是远程控制 */
  view: null,
};

export const isAdmin = () => S.user?.role === "admin";

/** 远程控制里能切到哪几页：桌面要这台机器有桌面才有；都没有就不显示入口 */
export function remoteTabs() {
  const r = S.remote;
  if (!r?.allowed) return [];
  return [r.desktop?.allowed && r.desktop.available ? "desktop" : null, r.terminal?.allowed ? "terminal" : null].filter(Boolean);
}

export const ui = {};

/**
 * 运行在 macOS 桌面端（agent-loft-desktop）里时，由它的 preload 注入。
 * 桌面端收不到 Web Push，系统通知、Dock 角标、菜单栏的待处理数都交给它。
 */
export const desktop = window.agentLoftDesktop ?? null;
/** 被别的 agent-loft 嵌在 iframe 里（多服务器，见 lib/shell.js）。只有服务端允许了的地址嵌得进来 */
export const framed = !desktop && window.parent !== window;
/** 新版桌面端：额度由它统一查好推过来，页面自己不查（老版本桌面端没有 onQuota，照旧自己查） */
export const desktopQuota = typeof desktop?.onQuota === "function";
// 桌面端里：顶栏、侧栏顶部可以按住拖动窗口（样式见 css/topbar.css 的 .in-desktop）
if (desktop) document.documentElement.classList.add("in-desktop");
/**
 * 新版桌面端顶栏能打开每台服务器的设置（0.1.18 起在设置按钮的菜单里，之前在「更多」里）：页面「更多」里的设置就不放了。
 * 老版本桌面端没有这个入口，照旧放，免得设置打不开。
 */
export const desktopSettings = typeof desktop?.onOpenSettings === "function";
/**
 * 桌面端 0.1.9 ~ 0.1.17：页面右上角的「更多」整个交给桌面端顶栏的「更多」（排在最上面），页面上不显示这个按钮。
 * 0.1.18 起桌面端去掉了自己的「更多」，不再给 setMenu，页面照常显示
 */
export const desktopMenu = typeof desktop?.setMenu === "function";
