// 注入到服务器页面（agent-loft 的 Web 界面）里的桥。页面检测到 window.agentLoftDesktop
// 就把系统通知、待处理数、额度交给桌面端。只暴露这几个函数，页面拿不到 Node / ipcRenderer。
const { contextBridge, ipcRenderer } = require("electron");

let openHandler = null;
ipcRenderer.on("page:open", (_e, key) => openHandler?.(key));

contextBridge.exposeInMainWorld("agentLoftDesktop", {
  version: 1,
  /** @param {{ key: string, title: string, body: string, tag: string }} notice */
  notify: (notice) => ipcRenderer.send("page:notify", notice),
  /** @param {{ pending: { id: string, key: string, title: string, conv: string }[], busy: number }} state */
  setState: (state) => ipcRenderer.send("page:state", state),
  setQuota: (quotas) => ipcRenderer.send("page:quota", quotas),
  /** 点了通知 / 菜单栏里的待处理项时，跳到哪条会话。重复注册只保留最后一个。 */
  onOpen: (handler) => {
    openHandler = typeof handler === "function" ? handler : null;
  },
});
