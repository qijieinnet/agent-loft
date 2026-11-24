import { h, icon } from "../lib/dom.js";
import { dismissLocalNotifications } from "./push-session.js";

export { h, icon };
export const byId = (id) => document.getElementById(id);
export function button(label, onClick, className = "row") {
  return h("button", { type: "button", class: className, onclick: onClick }, label);
}
export function field(label, input) {
  return h("label", { class: "field", for: input.id }, label, input);
}

export async function api(path, method = "GET", body) {
  let res;
  try {
    res = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("网络连接不上，恢复后再试一次。");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error || "请求失败，请稍后重试。"), { status: res.status });
  if (data === null) throw new Error("服务暂时没有响应，请稍后重试。");
  return data;
}

export function requestId() {
  // getRandomValues also works when testing a home server over LAN HTTP.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function pushSupport() {
  if (!window.isSecureContext) return "请通过 HTTPS 打开这个页面，才能接收手机通知。";
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (ios && !(navigator.standalone || matchMedia("(display-mode: standalone)").matches)) {
    return "在 Safari 点「分享 → 添加到主屏幕」，然后从主屏幕图标打开并启用通知。需要 iOS 16.4 或更新版本。";
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
    return "这个浏览器暂不支持系统通知，提醒会留在对话里。";
  return "";
}

async function pushRegistration() {
  if (pushSupport()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/bot/");
  return reg?.scope === new URL("/bot/", location.origin).href ? reg : null;
}

export async function deviceSubscribed() {
  const reg = await pushRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return false;
  const { subscriptions } = await api("/api/push?purpose=bot");
  const mine = subscriptions.find((item) => item.endpoint === sub.endpoint);
  if (!mine) {
    // This worker belongs only to Bot. A subscription left by a previous
    // account must stop receiving that account's messages on this device.
    await sub.unsubscribe();
    return false;
  }
  return !!mine.botReady;
}

export async function enableDevice() {
  const reason = pushSupport();
  if (reason) throw new Error(reason);
  // iOS requires the permission request in the original button gesture.
  const permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw new Error(
      permission === "denied" ? "通知权限已关闭，请到浏览器或系统设置里打开。" : "暂时跳过，提醒仍然可以在对话里查看。",
    );
  const registration = await navigator.serviceWorker.register("/bot/sw.js", { scope: "/bot/" });
  if (!registration.active) {
    // ready can resolve to the older root worker while scope control is changing.
    const worker = registration.installing || registration.waiting;
    if (!worker) throw new Error("通知服务还没准备好，请刷新后重试。");
    await new Promise((resolve, reject) => {
      const stop = () => { clearTimeout(timer); worker.removeEventListener("statechange", check); };
      const check = () => {
        if (worker.state === "activated") { stop(); resolve(); }
        else if (worker.state === "redundant") { stop(); reject(new Error("通知服务启动失败，请刷新后重试。")); }
      };
      const timer = setTimeout(() => { stop(); reject(new Error("通知服务还没准备好，请刷新后重试。")); }, 8000);
      worker.addEventListener("statechange", check);
      check();
    });
  }
  const { publicKey } = await api("/api/push?purpose=bot");
  const raw = atob(
    publicKey
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(publicKey.length / 4) * 4, "="),
  );
  const sub =
    (await registration.pushManager.getSubscription()) ||
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: Uint8Array.from(raw, (char) => char.charCodeAt(0)),
    }));
  await api("/api/push/subscribe", "POST", { subscription: sub.toJSON(), purpose: "bot" });
}
export async function testDeviceNotification(threadId) {
  const subscription = await (await pushRegistration())?.pushManager.getSubscription();
  if (!subscription) throw new Error("请先在当前设备上开启通知。");
  await api("/api/bot-inbox/test-device", "POST", { threadId, endpoint: subscription.endpoint });
}
export async function disableDevice() {
  const sub = await (await pushRegistration())?.pushManager.getSubscription();
  if (!sub) return;
  const { retained } = await api("/api/push/unsubscribe", "POST", { endpoint: sub.endpoint, purpose: "bot" });
  if (!retained) await sub.unsubscribe();
  await dismissLocalNotifications({ type: "notifications-disabled" });
}

export function clearBotNotifications({ threadId, through, delegationId } = {}) {
  // Also dismiss matching Bot notices received before the Bot worker got its own scope.
  dismissLocalNotifications({ type: "bot-notices-read", threadId, through, delegationId }).catch(() => {});
}

function encoded(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ mimeType: blob.type, data: String(reader.result).split(",")[1] });
    reader.onerror = () => reject(new Error("照片读取失败，请重新选择。"));
    reader.readAsDataURL(blob);
  });
}
export async function photoPayload(file) {
  if (!file.type.startsWith("image/")) throw new Error("请选择一张照片。");
  const maxBytes = 3 * 1024 * 1024;
  if (file.size <= maxBytes && (file.type === "image/gif" || file.type === "image/webp")) {
    const { cleanAnimation } = await import("./animated-photo.js");
    const cleaned = cleanAnimation(new Uint8Array(await file.arrayBuffer()), file.type);
    if (cleaned) return encoded(cleaned);
  }
  const objectURL = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectURL;
    await image.decode().catch(() => {
      throw new Error("这张照片无法读取，请选择 JPG、PNG 或截图。");
    });
    const ratio = Math.min(1, 1800 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * ratio));
    canvas.height = Math.max(1, Math.round(image.height * ratio));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法处理这张照片，请选择较小的图片。");
    if (file.type !== "image/png" && file.type !== "image/webp") {
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const format = ["image/png", "image/webp"].includes(file.type) ? file.type : "image/jpeg";
    let clean = await new Promise(resolve => canvas.toBlob(resolve, format, 0.9));
    if (clean && clean.size > maxBytes && format !== "image/jpeg") {
      // Try a compact encode before asking the user to crop a screenshot.
      clean = await new Promise(resolve => canvas.toBlob(resolve, "image/webp", 0.84));
    }
    if (!clean || clean.size > maxBytes) throw new Error("这张照片太大，请裁剪后再试。");
    return encoded(clean);
  } finally {
    URL.revokeObjectURL(objectURL);
  }
}
