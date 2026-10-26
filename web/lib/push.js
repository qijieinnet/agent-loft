import { api } from "./api.js";
import { desktop, framed } from "../state.js";

// ---------- 系统通知（Web Push） ----------

export function pushSupport() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (desktop) return { ok: false, why: "桌面端会直接弹出 macOS 系统通知，不需要在这里开启。" };
  if (framed) return { ok: false, framed: true, why: "这台是在别的服务器的页面里打开的：通知跟着外层那台走，在那边的 设置 → 通知 里开启，这台的提醒也会推过去。" };
  if (!window.isSecureContext) return { ok: false, why: "通知需要 HTTPS 访问（localhost 除外）。请通过 HTTPS 的反向代理地址打开。" };
  if (ios && !standalone) {
    return { ok: false, why: "iPhone / iPad 上要先在 Safari 里点「分享 → 添加到主屏幕」，再从桌面图标打开，才能开启通知（需 iOS 16.4+）。" };
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return { ok: false, why: "这个浏览器不支持网页推送通知。" };
  }
  return { ok: true };
}

function swReady(ms = 8000) {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Service Worker 没有就绪，刷新页面再试")), ms)),
  ]);
}

export async function currentPushSub() {
  if (!pushSupport().ok) return null;
  try {
    return await (await swReady()).pushManager.getSubscription();
  } catch {
    return null;
  }
}

export async function enablePush() {
  // 必须在点击里直接请求权限，iOS 不认异步之后再弹的
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied" ? "通知权限被拒绝了，请到系统设置里给这个应用打开通知" : "没有授予通知权限");
  const { publicKey } = await api("/api/push");
  const reg = await swReady();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const raw = atob(publicKey.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(publicKey.length / 4) * 4, "="));
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)),
    });
  }
  await api("/api/push/subscribe", { method: "POST", body: { subscription: sub.toJSON() } });
}

/** 这台设备不再收通知：服务端删掉订阅，浏览器也退订 */
export async function dropPushSub() {
  if (framed) {
    // 只撤销这台的转发订阅，不能退订外壳与其他服务器共用的浏览器订阅。
    const { dropRelayPush } = await import("./shell.js");
    await dropRelayPush();
    return;
  }
  const sub = await currentPushSub();
  if (!sub) return;
  await api("/api/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

/**
 * 登录后：这个浏览器上的通知订阅如果不是当前账号的（上一个人没退出就换了账号），
 * 退订掉 —— 推送服务随后会让服务端那条订阅失效，上一个人的通知就不会再推到这里。
 */
export async function releaseForeignPushSub() {
  const sub = await currentPushSub();
  if (!sub) return;
  const { subscriptions } = await api("/api/push");
  if (!subscriptions.some((d) => d.endpoint === sub.endpoint)) await sub.unsubscribe().catch(() => {});
}
