// ---------- 状态 ----------

export const S = {
  agents: [],
  bots: [],
  convs: new Map(),
  pending: new Map(),
  current: null,
  draftAgent: localStorage.getItem("aim.agent") || null,
  /** 新对话用聊天模式还是工作模式，记住上次的选择 */
  draftMode: localStorage.getItem("aim.mode") === "chat" ? "chat" : "work",
  /** 新对话（还没发消息）选的工作目录，null 表示工作区根目录。开新对话时沿用上次选的 */
  draftCwd: null,
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
};

export const isAdmin = () => S.user?.role === "admin";

export const ui = {};

/**
 * 运行在 macOS 桌面端（agent-loft-desktop）里时，由它的 preload 注入。
 * 桌面端收不到 Web Push，系统通知、Dock 角标、菜单栏的待处理数都交给它。
 */
export const desktop = window.agentLoftDesktop ?? null;
/** 新版桌面端：额度由它统一查好推过来，页面自己不查（老版本桌面端没有 onQuota，照旧自己查） */
export const desktopQuota = typeof desktop?.onQuota === "function";
// 桌面端里：顶栏、侧栏顶部可以按住拖动窗口（样式见 css/topbar.css 的 .in-desktop）
if (desktop) document.documentElement.classList.add("in-desktop");
/**
 * 新版桌面端顶栏的「更多」里能打开每台服务器的设置：侧栏底部的设置按钮就不显示了（额度照常显示，数据由桌面端推）。
 * 老版本桌面端没有这个入口，照旧显示，免得设置打不开。
 */
export const desktopSettings = typeof desktop?.onOpenSettings === "function";
if (desktopSettings) document.documentElement.classList.add("desktop-settings");
