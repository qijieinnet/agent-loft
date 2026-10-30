import { h } from "./dom.js";
import { api } from "./api.js";
import { desktop, framed, S, ui } from "../state.js";
import { showAuth } from "../views/auth.js";
import { applyBootstrap, bootstrapQuery, renderSidebar, scheduleSidebar } from "../views/sidebar.js";
import { scheduleQuota } from "../views/quota.js";
import { renderTopbar } from "../views/topbar.js";
import { applyEvent, openConversation } from "../views/messages.js";
import { upsertInteraction } from "../views/interaction.js";
import { setBusy } from "../views/composer.js";
import { SH, shownHere } from "./shell.js";
import { currentPushSub } from "./push.js";
import { renderScheduled } from "../views/schedule.js";

// ---------- WebSocket ----------

export const WS = {
  sock: null,
  rid: 0,
  waiters: new Map(),
  backoff: 500,
  connected: false,
  pingTimer: null,
  pushEndpoint: null,

  stopped: false,
  epoch: null,
  hellos: 0,

  connect() {
    if (this.stopped) return;
    if (this.sock && (this.sock.readyState === 0 || this.sock.readyState === 1)) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = new WebSocket(`${proto}://${location.host}/ws`);
    this.sock = sock;
    sock.onopen = () => {
      this.connected = true;
      this.backoff = 500;
      setConnBanner(null);
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.raw({ t: "ping" }), 25000);
    };
    sock.onmessage = (e) => onWsMessage(JSON.parse(e.data));
    sock.onclose = async (e) => {
      this.connected = false;
      clearInterval(this.pingTimer);
      for (const w of this.waiters.values()) w.reject(new Error("连接已断开"));
      this.waiters.clear();
      if (this.sock !== sock) return;
      // 登录已失效（改了密码、被踢下线）：回登录页，不再重连
      if (e.code === 4401) {
        this.stopped = true;
        showAuth();
        return;
      }
      if (this.stopped) return;
      // 握手被拒（401）在浏览器里只表现为 1006：问一下是不是登录态没了
      try {
        const me = await (await fetch("/api/me", { credentials: "same-origin" })).json();
        if (!me.authed) {
          this.stopped = true;
          showAuth();
          return;
        }
      } catch {
        // 网络不通，照常重连
      }
      if (document.visibilityState === "visible") setConnBanner("连接已断开，正在重连…");
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 10000);
    };
  },

  raw(msg) {
    if (this.sock?.readyState === 1) this.sock.send(JSON.stringify(msg));
  },

  request(msg, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (this.sock?.readyState !== 1) {
        reject(new Error("还没连上服务器，稍等再试"));
        return;
      }
      const rid = ++this.rid;
      this.waiters.set(rid, { resolve, reject });
      this.sock.send(JSON.stringify({ ...msg, rid }));
      setTimeout(() => {
        if (this.waiters.delete(rid)) reject(new Error("服务器没有响应"));
      }, timeoutMs);
    });
  },

  subscribe(key, since) {
    this.raw({ t: "sub", key, since, epoch: this.epoch });
  },

  /** 告诉服务器我是否在前台、正看着哪条会话：正看着的会话不推系统通知 */
  /**
   * 告诉服务端「我正看着这条会话」：看着的时候不推送。要页面在前台、有焦点，而且最近还有人在动它 ——
   * 窗口开着人走开了（电脑上停在这条会话、人在用手机），照样推
   */
  presence() {
    // 多服务器：外壳切到了别的服务器、或者这台被嵌着但没在显示，也算没在看
    const visible = document.visibilityState === "visible" && document.hasFocus() && Date.now() - lastInput < IDLE_MS && shownHere();
    // 在定时任务、远程控制页上：没在看哪条对话（远程控制页不清 S.current，回来时对话还在）
    this.raw({
      t: "presence", visible, key: S.view ? "" : (S.current ?? ""),
      // 前台免打扰按设备判断，不受正在看哪条会话、是否空闲的影响。
      foreground: document.visibilityState === "visible",
      pushEndpoint: framed ? (SH.push?.subscription.endpoint ?? null) : this.pushEndpoint,
    });
  },

  async refreshPushPresence() {
    if (!framed) this.pushEndpoint = (await currentPushSub())?.endpoint ?? null;
    this.presence();
  },
};

// 切回窗口本身就算动了一下
window.addEventListener("focus", () => {
  markActive();
  WS.presence();
  clearAppNotifications();
  void WS.refreshPushPresence();
});
document.addEventListener("aim:shell-active", () => {
  if (shownHere()) markActive();
  WS.presence();
});
window.addEventListener("blur", () => WS.presence());

// ---------- 有没有人在动页面 ----------
// 超过 IDLE_MS 没点、没按键、没滚动，就当人不在了：报一次 presence，服务端照常推送；一动又报回来

const IDLE_MS = 2 * 60_000;
let lastInput = Date.now();
let idle = false;
let idleTimer = 0;
function markActive() {
  lastInput = Date.now();
  idle = false;
  armIdle();
}
function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idle = true;
    WS.presence();
  }, IDLE_MS);
}
function onInput() {
  const now = Date.now();
  // 滚动一秒几十次，重设计时器不用那么勤
  if (!idle && now - lastInput < 5000) return;
  lastInput = now;
  if (idle) {
    idle = false;
    WS.presence();
  }
  armIdle();
}
for (const ev of ["pointerdown", "keydown", "wheel", "touchstart", "scroll"]) window.addEventListener(ev, onInput, { capture: true, passive: true });
armIdle();

/** 打开 / 切回页面：清掉本应用已显示的通知、桌面图标角标和计数。 */
export function clearAppNotifications() {
  if (framed || document.visibilityState !== "visible") return;
  navigator.clearAppBadge?.().catch(() => {});
  if ("caches" in window) caches.delete("aim-badge").catch(() => {});
  navigator.serviceWorker?.getRegistration().then(async (reg) => {
    const notifications = await reg?.getNotifications();
    // 异步读取期间可能已经切走，后台到达的新通知留着提醒。
    if (document.visibilityState === "visible") for (const n of notifications ?? []) n.close();
  }).catch(() => {});
}

window.addEventListener("pageshow", () => {
  clearAppNotifications();
  void WS.refreshPushPresence();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") markActive();
  WS.presence();
  clearAppNotifications();
  if (document.visibilityState === "visible") void WS.refreshPushPresence();
  // 手机切回前台：连接多半已经被系统掐了，立刻重连而不是等退避
  if (document.visibilityState === "visible" && WS.sock?.readyState !== 1) {
    WS.backoff = 300;
    WS.connect();
  }
});

/** 重连后：以服务器上的会话列表和待处理授权为准，清掉本地已失效的 */
async function resync() {
  try {
    const data = await api(`/api/bootstrap${bootstrapQuery()}`);
    applyBootstrap(data);
    const live = new Set(data.pending.map((i) => i.id));
    for (const ix of S.pending.values()) {
      // 快照生成之后才出现的授权，快照里当然没有，不能当成「已在别处处理」
      if (!ix.settled && !live.has(ix.id) && ix.createdAt <= data.serverTime) markGone(ix);
    }
    for (const ix of data.pending) upsertInteraction(ix);
    renderSidebar();
  } catch {
    // 下次重连再说
  }
}

/** 本地以为还挂着、服务器上已经没了的授权：断线期间在别处处理掉了，或者服务重启过 */
function markGone(ix) {
  upsertInteraction({ ...ix, settled: { settlement: "gone", by: "已在别处处理或已失效", at: Date.now() } });
}

function onWsMessage(msg) {
  switch (msg.t) {
    case "hello": {
      if (checkServerVersion(msg.version)) return;
      const restarted = WS.epoch && WS.epoch !== msg.epoch;
      WS.epoch = msg.epoch;
      WS.hellos += 1;
      WS.presence();
      void WS.refreshPushPresence();
      if (restarted) {
        // 服务重启过：seq 从头计数了，旧游标全部作废，当前会话整页重拉
        S.seq.clear();
        if (S.current) void openConversation(S.current);
      } else if (S.current) {
        WS.subscribe(S.current, S.seq.get(S.current) ?? 0);
      }
      if (WS.hellos > 1 || restarted) void resync();
      return;
    }
    case "ack": {
      const w = WS.waiters.get(msg.rid);
      if (!w) return;
      WS.waiters.delete(msg.rid);
      if (msg.ok) w.resolve(msg);
      else w.reject(new Error(msg.error ?? "操作失败"));
      return;
    }
    case "ev":
      applyEvent(msg);
      return;
    case "replay":
      if (msg.key !== S.current) return;
      if (msg.reset) {
        void openConversation(msg.key);
        return;
      }
      for (const env of msg.events) applyEvent(env);
      {
        const live = new Set(msg.pending.map((i) => i.id));
        for (const ix of S.pending.values()) {
          if (ix.convKey === msg.key && !ix.settled && !live.has(ix.id)) markGone(ix);
        }
      }
      for (const ix of msg.pending) upsertInteraction(ix);
      setBusy(msg.busy);
      return;
    case "conv":
      if (S.convs.get(msg.info.key)?.busy && !msg.info.busy) scheduleQuota();
      S.convs.set(msg.info.key, msg.info);
      if (msg.info.key === S.current) {
        renderTopbar();
        setBusy(msg.info.busy);
        renderScheduled();
      }
      scheduleSidebar();
      return;
    case "ix":
      upsertInteraction(msg.interaction);
      return;
    case "tasks":
      // 自己的定时任务变了：定时任务页开着的话会去重新拉（views/tasks.js）
      document.dispatchEvent(new Event("aim:tasks"));
      return;
    case "remote":
      // 自己的终端开了 / 关了，或者远程控制的权限、设置变了：重新问一下（views/layout.js）
      document.dispatchEvent(new Event("aim:remote"));
      return;
    case "skills":
      // 技能变了：设置里的技能页开着就重新拉，@ 补全的缓存作废
      document.dispatchEvent(new Event("aim:skills"));
      return;
    case "notice":
      // 正看着这条会话就不打扰；普通网页靠 Web Push，这里只给桌面端
      if (!desktop) return;
      if (document.visibilityState === "visible" && document.hasFocus() && msg.key === S.current) return;
      desktop.notify({ key: msg.key, title: msg.title, body: msg.body, tag: msg.tag });
      return;
  }
}

function setConnBanner(text, onclick) {
  ui.banner?.remove();
  ui.banner = null;
  if (!text || !ui.main) return;
  ui.banner = onclick ? h("button", { class: "conn-banner clickable", onclick }, text) : h("div", { class: "conn-banner" }, text);
  ui.main.append(ui.banner);
}

/** 页面加载时连上的服务端版本。服务端升级重启后版本变了，页面上跑的还是旧前端，得刷新 */
let loadedServerVersion = null;

/** 服务端换了版本：刷新页面换上新前端。返回 true 表示已经在刷新了，后面不用再处理 */
function checkServerVersion(version) {
  if (!version) return false;
  if (!loadedServerVersion) loadedServerVersion = version;
  if (version === loadedServerVersion) return false;
  // 输入框里有没发出去的字：别直接刷掉，提示一下让用户自己点
  if (ui.input?.value.trim()) {
    setConnBanner(`服务端已升级到 ${version}，点这里刷新页面`, () => location.reload());
    return false;
  }
  location.reload();
  return true;
}
