// 注入到服务器页面（agent-loft 的 Web 界面）里的桥。页面检测到 window.agentLoftDesktop
// 就把系统通知、待处理数交给桌面端，额度改由桌面端统一查好推过来。只暴露这几个函数，
// 页面拿不到 Node / ipcRenderer。
const { contextBridge, ipcRenderer } = require("electron");

let openHandler = null;
ipcRenderer.on("page:open", (_e, key) => openHandler?.(key));

let quotaHandler = null;
ipcRenderer.on("page:quota-update", (_e, payload) => quotaHandler?.(payload));

contextBridge.exposeInMainWorld("agentLoftDesktop", {
  /** 2：额度由桌面端查（onQuota / refreshQuota） */
  version: 2,
  /** @param {{ key: string, title: string, body: string, tag: string }} notice */
  notify: (notice) => ipcRenderer.send("page:notify", notice),
  /** @param {{ pending: { id: string, key: string, title: string, conv: string }[], busy: number }} state */
  setState: (state) => ipcRenderer.send("page:state", state),
  /** 老版本页面自己查了额度报上来用的；新版页面用 onQuota */
  setQuota: (quotas) => ipcRenderer.send("page:quota", quotas),
  /**
   * 接收桌面端推来的额度：{ quotas, at, error }。注册时桌面端会立刻推一次当前的（还没有就去查）。
   * 重复注册只保留最后一个。
   */
  onQuota: (handler) => {
    quotaHandler = typeof handler === "function" ? handler : null;
    if (quotaHandler) ipcRenderer.send("page:quota-want");
  },
  /** 请桌面端马上重新查这台服务器的额度，查完经 onQuota 推回来 */
  refreshQuota: () => ipcRenderer.send("page:quota-refresh"),
  /** 点了通知 / 菜单栏里的待处理项时，跳到哪条会话。重复注册只保留最后一个。 */
  onOpen: (handler) => {
    openHandler = typeof handler === "function" ? handler : null;
  },
});
