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
    Promise.all([
      self.registration.showNotification(data.title || "IM Agent", {
        body: data.body || "",
        tag: data.tag,
        icon: "/apple-touch-icon.png",
        badge: "/apple-touch-icon.png",
        data: { url: data.url || "/" },
      }),
      bumpBadge(data.tag).catch(() => {}),
    ]),
  );
});

// ---------- 桌面图标角标（Badging API） ----------
// 支持：桌面 Chrome / Edge 安装的 PWA、iOS 16.4+ 主屏 App（要有通知权限）。
// Android Chrome 没有这个 API，桌面红点由启动器根据通知自己显示。
// 角标数 = 还没看过的通知条数，同一 tag 的通知会互相替换，只算一条；打开页面时由页面清零。
// Service Worker 里没有 localStorage，计数放在 Cache Storage 里（只存这一个计数，不缓存页面）。

const BADGE_CACHE = "aim-badge";
const BADGE_URL = "/__badge";

async function readBadgeTags() {
  try {
    const res = await (await caches.open(BADGE_CACHE)).match(BADGE_URL);
    const tags = res ? await res.json() : [];
    return Array.isArray(tags) ? tags : [];
  } catch {
    return [];
  }
}

async function bumpBadge(tag) {
  if (!("setAppBadge" in self.navigator)) return;
  // 用户正看着页面就不加角标
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (windows.some((w) => w.visibilityState === "visible")) return;
  const tags = await readBadgeTags();
  const id = tag || `untagged:${Date.now()}:${Math.random()}`;
  if (!tags.includes(id)) tags.push(id);
  await (await caches.open(BADGE_CACHE)).put(BADGE_URL, new Response(JSON.stringify(tags)));
  await self.navigator.setAppBadge(tags.length).catch(() => {});
}

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
