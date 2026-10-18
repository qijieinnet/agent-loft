// 最小的 Service Worker：只为让页面能「添加到主屏幕」像 App 一样打开。
// 不缓存任何东西 —— 这是一个实时操作本机的工具，离线时显示旧页面只会误导人。
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
