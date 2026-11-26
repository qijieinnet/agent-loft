// Keep conversation content on the server; only system notifications are managed here.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function localUrl(value) {
  try {
    const url = new URL(value, self.location.origin);
    if ("Origin" in globalThis) return Origin.from(url).isSameOrigin(Origin.from(self.location.origin)) ? url : null;
    return url.origin !== "null" && url.origin === self.location.origin ? url : null;
  } catch { return null; }
}
const bot = self.loftBot === true;

// An acknowledgement and a push may arrive together. Update the native badge
// after the matching notification changes, in the same order as the events.
let previous = Promise.resolve();
function update(event, action) {
  const work = previous.then(action);
  previous = work.catch(() => {});
  event.waitUntil(work);
}
async function syncBadge() {
  if (!self.navigator.setAppBadge) return;
  const pending = await self.registration.getNotifications();
  const count = pending.length;
  if (count) await self.navigator.setAppBadge(count).catch(() => {});
  else await self.navigator.clearAppBadge?.().catch(() => {});
}

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data?.json() ?? {}; }
  catch { data = { body: event.data?.text() || "" }; }
  const url = localUrl(data.url || "/");
  update(event, async () => {
    // An obsolete endpoint can still have a payload in flight during migration.
    // Never show the other app's title or preview in this registration.
    const matched = url && (data.purpose === "bot") === bot && url.pathname === "/";
    await self.registration.showNotification(matched && data.title || (bot ? "我的 Bot" : "Agent Loft"), {
      body: matched ? data.body || "" : "打开应用查看通知",
      tag: matched ? data.tag : "subscription-updated",
      icon: bot ? "/icons/app-192.png" : "/apple-touch-icon.png",
      badge: bot ? "/icons/badge.png" : "/apple-touch-icon.png",
      data: { url: matched ? url.href : "/" },
    });
    await syncBadge();
  });
});

self.addEventListener("message", event => {
  const source = event.source?.url && localUrl(event.source.url);
  const data = event.data;
  if (!source || !data) return;
  if (data.type === "session-ended") {
    update(event, async () => {
      const notices = await self.registration.getNotifications();
      for (const notice of notices) notice.close();
      await syncBadge();
    });
    return;
  }
  const disabled = data.type === "notifications-disabled";
  if (!disabled && data.type !== (bot ? "bot-notices-read" : "workbench-notices-read")) return;
  if (bot && !disabled && typeof data.threadId !== "string") return;
  update(event, async () => {
    const notices = await self.registration.getNotifications();
    for (const notice of notices) {
      const url = localUrl(notice.data?.url || "/");
      if (!url) continue;
      if (bot && !disabled) {
        if (url.searchParams.get("thread") !== data.threadId) continue;
        const message = Number(url.searchParams.get("message"));
        const readMessage = Number.isSafeInteger(data.through) && message > 0 && message <= data.through;
        const readDelegation = data.delegationId && data.delegationId === url.searchParams.get("delegation");
        if (!readMessage && !readDelegation) continue;
      }
      notice.close();
    }
    await syncBadge();
  });
});
self.addEventListener("notificationclose", event => update(event, syncBadge));

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = localUrl(event.notification.data?.url || "/");
  if (!target) return;
  update(event, async () => {
    await syncBadge();
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find(w => {
      const page = localUrl(w.url);
      return page?.pathname === "/";
    });
    if (existing) {
      await existing.focus().catch(() => {});
      existing.postMessage({ type: "open", url: target.href });
    } else await self.clients.openWindow(target.href);
  });
});
