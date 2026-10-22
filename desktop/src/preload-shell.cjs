// 桌面端自己的界面（主窗口顶栏和面板、菜单栏面板）用的桥。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("loft", {
  /** darwin / win32 / linux：界面按平台换说法和样式 */
  platform: process.platform,
  state: () => ipcRenderer.invoke("shell:state"),
  onState: (handler) => ipcRenderer.on("shell:state", (_e, state) => handler(state)),
  /** 让主窗口切到某个面板（菜单里的「添加服务器」「设置」） */
  onShow: (handler) => ipcRenderer.on("shell:show", (_e, what) => handler(what)),
  call: (method, ...args) => ipcRenderer.invoke("shell:call", method, ...args),
});
