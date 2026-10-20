// 最小的 Service Worker：让页面能「添加到主屏幕」像 App 一样打开，外加系统通知。
// 不缓存任何东西 —— 这是一个实时操作本机的工具，离线时显示旧页面只会误导人。
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

// 服务端推来的通知（回复完成、需要授权）。iOS 要求每条推送都必须弹出通知，否则会收回推送权限
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "IM Agent", {
      body: data.body || "",
      tag: data.tag,
      icon: "/apple-touch-icon.png",
      badge: "/apple-touch-icon.png",
      data: { url: data.url || "/" },
    }),
  );
});

// 点通知：已经开着页面就切过去并跳到那条会话，没开就新开一个
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (existing) {
        await existing.focus().catch(() => {});
        existing.postMessage({ type: "open", url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
