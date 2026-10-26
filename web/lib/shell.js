import { $app, fill, h, icon } from "./dom.js";
import { api } from "./api.js";
import { closeMenu, showMenu } from "./overlay.js";
import { currentPushSub } from "./push.js";
import { desktop, framed, isAdmin, S, ui } from "../state.js";

// ---------- 多服务器：左上角切换到别的 agent-loft ----------
//
// 像 Codex 桌面端左上角那样切换。别的服务器的页面原样嵌在 iframe 里，各自登录、各自直连自己的
// 服务端（回复流、终端、远程桌面都不经过这台）；切走时 iframe 只是藏起来，连接一直在。
// 同一份前端两种身份：
//   - 外壳（host）：服务端配了别的服务器（bootstrap 的 servers），这台页面管着一排 iframe；
//   - 被嵌（guest）：自己在外壳的 iframe 里，左上角的切换列表由外壳发过来，点了告诉外壳。
// 两边用 postMessage 说话，只认对方的 origin：外壳只认列表里那台的地址、且是自己那个 iframe 发来的；
// 被嵌的只认 window.parent（服务端的 frame-ancestors 保证了它是允许嵌这台的地址）。
//
// 推送：手机上只有添加到主屏幕的外壳能订阅。外壳把订阅连同签名用的密钥发给各台，各台存到自己的
// 服务端，之后直接推到手机上（服务端 push.ts 的 relay）；点开通知回到外壳，地址里的 srv= 说是哪台。

const NS = "agent-loft";
/** 外壳自己在列表里的 id（和服务端 core/servers.ts 的 SELF_ID 一致） */
export const HOME = "home";
const LAST = "aim.server";
/** 页面加载完了还没报到：多半是被拒绝嵌入、卡在登录网关，或者连不上 */
const READY_WAIT_MS = 4000;
/** 一直没加载完 */
const LOAD_WAIT_MS = 25000;

export const SH = {
  /** "host"：外壳；"guest"：被嵌着；null：没有多服务器 */
  role: null,
  /** [{ id, name, icon, url?, pending, busy, state }]，第一个是外壳自己。state：ready / loading / down */
  servers: [],
  /** 外壳上正在显示哪台 */
  current: HOME,
  /** 被嵌时：这台在外壳列表里的 id，外壳现在是不是正显示着这台，外壳的地址 */
  self: null,
  active: true,
  hostOrigin: null,
  /** 要转给各台的推送订阅 { subscription, vapid }（外壳上开了通知才有） */
  push: null,
};

/** 这个页面现在是不是用户眼前那一个：外壳切到了别的服务器、或者被嵌着但没在显示，就不算 */
export function shownHere() {
  if (SH.role === "host") return SH.current === HOME;
  if (SH.role === "guest") return SH.active;
  return true;
}

const emit = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail }));

// ---------- 左上角的切换按钮 ----------

/** 挂着切换按钮的容器：侧栏顶部、登录页、iframe 还没就绪时的浮动按钮。同名的后挂的顶替先挂的 */
const mounted = new Map();

export function mountSwitcher(name, el) {
  mounted.set(name, el);
  renderSwitcher(el);
  return el;
}

function rerender() {
  for (const el of mounted.values()) renderSwitcher(el);
  // 切换器重绘会更新 hidden；已就绪的 iframe 不能再被加载期间的浮动按钮盖住。
  for (const f of frames.values()) f.pill.hidden = f.ready;
  emit("aim:servers");
}

const currentId = () => (SH.role === "guest" ? SH.self : SH.current);

function srvIcon(s, cls = "srv-icon") {
  if (s.icon) return h("span", { class: cls }, s.icon);
  // 没设图标：名字的第一个字
  return h("span", { class: `${cls} letter` }, [...(s.name || "?")][0].toUpperCase());
}

function renderSwitcher(el) {
  const cur = SH.servers.find((s) => s.id === currentId());
  el.hidden = !SH.role || SH.servers.length < 2 || !cur;
  if (el.hidden) return fill(el);
  // 别的服务器上有等你处理的：按钮上也标出来，不用点开才知道
  const ask = SH.servers.filter((s) => s !== cur).reduce((n, s) => n + (s.pending || 0), 0);
  const btn = h(
    "button",
    { class: "server-switch", title: "切换服务器", "aria-haspopup": "menu" },
    srvIcon(cur),
    h("span", { class: "srv-name" }, cur.name),
    ask ? h("span", { class: "srv-badge", title: `别的服务器上有 ${ask} 项等你处理` }, ask) : null,
    h("span", { class: "srv-chev" }, icon("down")),
  );
  btn.onclick = () => {
    if (ui.menu?.anchor === btn) return closeMenu();
    openSwitchMenu(btn);
  };
  fill(el, btn);
}

function openSwitchMenu(btn) {
  const cur = currentId();
  const items = SH.servers.map((s) => ({
    class: `srv-item${s.id === cur ? " on" : ""}`,
    label: [
      srvIcon(s),
      h("span", { class: "srv-item-name" }, s.name),
      s.pending
        ? h("span", { class: "srv-badge", title: `${s.pending} 项等你处理` }, s.pending)
        : s.busy
          ? h("span", { class: "srv-busy", title: `${s.busy} 个对话正在运行` })
          : s.state === "down"
            ? h("span", { class: "srv-down" }, "没连上")
            : null,
      s.id === cur ? h("span", { class: "srv-check" }, "✓") : null,
    ],
    onclick: () => pickServer(s.id),
  }));
  // 服务器在外壳那台的设置里管：被嵌着的页面里不放入口（那是另一台的设置）
  if (SH.role === "host" && isAdmin()) items.push("sep", { class: "srv-manage", label: "管理服务器…", onclick: () => emit("aim:open-settings", "服务器") });
  showMenu(btn, items);
  if (ui.menu) ui.menu.anchor = btn;
}

function pickServer(id) {
  if (id === currentId()) return;
  emit("aim:server-leave");
  if (SH.role === "host") switchServer(id);
  else if (SH.role === "guest") toHost({ t: "switch", to: id });
}

// ---------- 外壳 ----------

/** id → { s, wrap, iframe, overlay, pill, ready, loaded, timers, queue, insets } */
const frames = new Map();
/** 已从列表移除、还在等远端退订完成的页面 */
const retiringFrames = new Set();
let cleanupId = 0;
let box = null;
/** 这台自己的待处理、运行数（sidebar.js 报上来） */
let local = { pending: 0, busy: 0 };

const post = (f, msg) => f.iframe.contentWindow?.postMessage({ ns: NS, ...msg }, f.s.url);

function sendWhenReady(f, msg) {
  if (f.ready) post(f, msg);
  else f.queue.push(msg);
}

const publicServers = () => SH.servers.map(({ id, name, icon: ic, pending, busy, state }) => ({ id, name, icon: ic, pending, busy, state }));

let broadcastQueued = false;
/** 列表、角标变了：告诉各台（它们左上角的切换按钮要跟着变）。连着几次变化只发一次 */
function broadcastServers() {
  if (broadcastQueued) return;
  broadcastQueued = true;
  queueMicrotask(() => {
    broadcastQueued = false;
    const servers = publicServers();
    for (const f of frames.values()) if (f.ready) post(f, { t: "servers", servers });
  });
}

function stateOf(f) {
  return f.ready ? "ready" : f.down ? "down" : "loading";
}

function setFrameState(f) {
  if (f.stale) return;
  f.s.state = stateOf(f);
  f.overlay.hidden = f.ready || f.dismissed;
  f.pill.hidden = f.ready;
  if (!f.ready) {
    fill(
      f.overlay,
      f.down
        ? h(
            "div",
            { class: "srv-card" },
            h("h3", {}, `${f.s.name} 没有响应`),
            h(
              "ul",
              {},
              h("li", {}, "那台还没允许这台嵌入：点「打开并授权」，在新页面里确认"),
              h("li", {}, "前面有登录网关（比如 Cloudflare Access）：在新页面里先验证一次"),
              h("li", {}, "那台的 agent-loft 版本太旧（要支持多服务器的版本），或者现在连不上"),
            ),
            h(
              "div",
              { class: "row" },
              h("button", { class: "btn primary", onclick: () => openForAuth(f.s) }, "打开并授权"),
              h("button", { class: "btn", onclick: () => reloadFrame(f) }, "重试"),
              h("button", { class: "btn ghost", onclick: () => ((f.dismissed = true), setFrameState(f)) }, "关掉提示"),
            ),
          )
        : h("div", { class: "srv-loading" }, h("span", { class: "spinner" }), `正在打开 ${f.s.name}…`),
    );
  }
  rerender();
  broadcastServers();
}

/** 在新标签页打开那台，带上 allow-embed：那边的管理员确认后就允许这台嵌入，再通知这边重新加载 */
export function openForAuth(s) {
  window.open(`${s.url}/?allow-embed=${encodeURIComponent(location.origin)}`, "_blank");
}

function waitReady(f, ms) {
  clearTimeout(f.timer);
  f.timer = setTimeout(() => {
    if (f.ready) return;
    f.down = true;
    setFrameState(f);
  }, ms);
}

/**
 * 页面加载时 CSP 的 frame-src 里有哪些地址（服务端按当时的列表出的）。之后新加的，
 * 要刷新页面拿到新的 CSP 才嵌得进来
 */
let frameable = null;
export const canFrame = (url) => !!frameable?.has(url);

function createFrame(s) {
  if (!canFrame(s.url)) {
    const f = { s, iframe: h("iframe", { title: s.name }), ready: false, down: true, dismissed: false, queue: [], timer: 0, stale: true };
    f.overlay = h(
      "div",
      { class: "srv-overlay" },
      h("div", { class: "srv-card" }, h("h3", {}, `${s.name} 是刚加的`), h("p", {}, "刷新一下页面才能打开它。"), h("div", { class: "row" }, h("button", { class: "btn primary", onclick: () => location.reload() }, "刷新页面"))),
    );
    f.pill = mountSwitcher(`pill:${s.id}`, h("div", { class: "srv-pill" }));
    f.wrap = h("div", { class: "server-frame" }, f.overlay, f.pill);
    frames.set(s.id, f);
    box.append(f.wrap);
    s.state = "down";
    return f;
  }
  const iframe = h("iframe", {
    src: `${s.url}/`,
    title: s.name,
    // 语音输入、复制粘贴、远程桌面全屏
    allow: "microphone; clipboard-read; clipboard-write; fullscreen; autoplay; screen-wake-lock",
    allowfullscreen: true,
  });
  const f = { s, iframe, ready: false, down: false, dismissed: false, queue: [], timer: 0 };
  f.overlay = h("div", { class: "srv-overlay" });
  f.pill = mountSwitcher(`pill:${s.id}`, h("div", { class: "srv-pill" }));
  f.wrap = h("div", { class: "server-frame" }, iframe, f.overlay, f.pill);
  iframe.addEventListener("load", () => {
    // 页面加载完还没报到：等一小会儿，还没有就提示
    if (!f.ready) waitReady(f, READY_WAIT_MS);
  });
  waitReady(f, LOAD_WAIT_MS);
  frames.set(s.id, f);
  box.append(f.wrap);
  setFrameState(f);
  return f;
}

function reloadFrame(f) {
  f.ready = false;
  f.down = false;
  f.dismissed = false;
  f.iframe.src = `${f.s.url}/`;
  waitReady(f, LOAD_WAIT_MS);
  setFrameState(f);
}

function dropFrame(f) {
  clearTimeout(f.timer);
  mounted.delete(`pill:${f.s.id}`);
  frames.delete(f.s.id);
  f.wrap.hidden = true;
  if (!f.ready || !SH.push) {
    f.wrap.remove();
    return Promise.resolve();
  }
  // postMessage 是异步的，等远端完成退订再销毁页面；超时也要回收失联的 iframe。
  retiringFrames.add(f);
  return new Promise((resolve) => {
    f.cleanupId = ++cleanupId;
    f.finishCleanup = () => {
      clearTimeout(f.timer);
      retiringFrames.delete(f);
      f.wrap.remove();
      resolve();
    };
    f.timer = setTimeout(f.finishCleanup, 8000);
    post(f, { t: "push-off", endpoint: SH.push.subscription.endpoint, request: f.cleanupId });
  });
}

/** 安全区（刘海、底部横条）：iframe 里拿到的多半是 0，由外壳在外面垫上差额 */
function safeInsets() {
  const probe = h("div", {
    style: {
      position: "fixed",
      visibility: "hidden",
      pointerEvents: "none",
      paddingTop: "env(safe-area-inset-top)",
      paddingRight: "env(safe-area-inset-right)",
      paddingBottom: "env(safe-area-inset-bottom)",
      paddingLeft: "env(safe-area-inset-left)",
    },
  });
  document.body.append(probe);
  const cs = getComputedStyle(probe);
  const out = { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
  probe.remove();
  return out;
}

function padFrame(f) {
  const mine = safeInsets();
  const theirs = f.insets ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const gap = (k) => `${Math.max(0, mine[k] - (theirs[k] || 0))}px`;
  f.wrap.style.padding = `${gap("top")} ${gap("right")} ${gap("bottom")} ${gap("left")}`;
}
addEventListener("resize", () => {
  for (const f of frames.values()) padFrame(f);
});

function showCurrent() {
  if (!box) return;
  // 跟着当前历史记录保存：刷新沿用这台，新打开的对话链接仍可直接定位本机。
  history.replaceState({ ...history.state, loftServer: SH.current }, "");
  box.hidden = SH.current === HOME;
  for (const [id, f] of frames) f.wrap.classList.toggle("on", id === SH.current);
  // 别的服务器盖在上面时，底下这台的页面不能被 Tab 到、不能被读屏读到
  $app.inert = SH.current !== HOME;
}

/** 外壳上切到哪台 */
export function switchServer(id) {
  if (SH.role !== "host" || !SH.servers.some((s) => s.id === id)) return;
  closeMenu();
  if (id !== SH.current) {
    SH.current = id;
    localStorage.setItem(LAST, id);
    showCurrent();
    for (const f of frames.values()) if (f.ready) post(f, { t: "active", current: id });
    emit("aim:shell-active");
    rerender();
  }
  const f = frames.get(id);
  if (f) {
    padFrame(f);
    f.iframe.focus();
  }
}

/**
 * 点了别的服务器的通知：切过去，让那台打开那条对话。srv 不认识（列表里删掉了）返回 false，
 * 留在这台
 */
export function routeToServer(srv, key) {
  if (SH.role !== "host" || !srv || srv === HOME) return false;
  const f = frames.get(srv);
  if (!f) return false;
  switchServer(srv);
  if (key) sendWhenReady(f, { t: "open", key });
  return true;
}

/**
 * 服务端给的列表（bootstrap 的 servers）。启动时、设置里改了之后调；null 就是没有别的服务器了。
 * 首次调用时 want 是想先显示哪台（通知点进来的、上次看的）
 */
export function applyShellInfo(info, want) {
  if (desktop || framed) return;
  frameable ??= new Set((info?.list ?? []).map((s) => s.url));
  if (!info?.list?.length) {
    if (SH.role !== "host") return;
    const cleanup = Promise.all([...frames.values()].map(dropFrame));
    SH.role = null;
    SH.servers = [];
    SH.current = HOME;
    showCurrent();
    const oldBox = box;
    box = null;
    void cleanup.then(() => oldBox?.remove());
    emit("aim:shell-active");
    rerender();
    return;
  }
  const first = SH.role !== "host";
  SH.role = "host";
  const old = new Map(SH.servers.map((s) => [s.id, s]));
  SH.servers = [
    { id: HOME, name: info.self.name, icon: info.self.icon, ...local, state: "ready" },
    ...info.list.map((s) => ({ pending: 0, busy: 0, state: "loading", ...old.get(s.id), ...s })),
  ];
  if (!box) {
    box = h("div", { class: "server-frames", hidden: true });
    document.body.append(box);
  }
  for (const f of [...frames.values()]) {
    const s = SH.servers.find((x) => x.id === f.s.id);
    if (!s || s.url !== f.s.url) dropFrame(f);
    else f.s = s;
  }
  for (const s of SH.servers) if (s.id !== HOME && !frames.has(s.id)) createFrame(s);
  for (const f of frames.values()) {
    f.iframe.title = f.s.name;
    setFrameState(f);
  }
  rerender();
  if (first) {
    const last = localStorage.getItem(LAST);
    const pick = want ?? last ?? HOME;
    SH.current = SH.servers.some((s) => s.id === pick) ? pick : HOME;
  } else if (!SH.servers.some((s) => s.id === SH.current)) SH.current = HOME;
  showCurrent();
  if (SH.current !== HOME) padFrame(frames.get(SH.current));
  emit("aim:shell-active");
  rerender();
  broadcastServers();
  void refreshShellPush();
}

function onGuestMessage(f, m) {
  switch (m.t) {
    case "ready":
      f.ready = true;
      f.down = false;
      f.dismissed = false;
      clearTimeout(f.timer);
      f.insets = m.insets;
      padFrame(f);
      post(f, { t: "hello", self: f.s.id, servers: publicServers(), current: SH.current, push: SH.push });
      for (const msg of f.queue.splice(0)) post(f, msg);
      setFrameState(f);
      return;
    case "bye":
      // 那台的页面要换了（刷新、跳去登录网关）：等新页面报到
      f.ready = false;
      setFrameState(f);
      return;
    case "state": {
      const pending = Math.max(0, Math.min(999, Number(m.pending) || 0));
      const busy = Math.max(0, Math.min(999, Number(m.busy) || 0));
      if (pending === f.s.pending && busy === f.s.busy) return;
      Object.assign(f.s, { pending, busy });
      rerender();
      broadcastServers();
      return;
    }
    case "switch":
      if (typeof m.to === "string") switchServer(m.to);
      return;
  }
}

/** 这台自己的待处理、运行数变了（侧栏重画时报）：外壳上更新自己那项，被嵌时报给外壳 */
export function reportShellState(pending, busy) {
  if (pending === local.pending && busy === local.busy) return;
  local = { pending, busy };
  if (SH.role === "host") {
    Object.assign(SH.servers[0], local);
    rerender();
    broadcastServers();
  } else if (SH.role === "guest") {
    toHost({ t: "state", ...local });
  }
}

// ---------- 推送：外壳把订阅转给各台 ----------

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** 这个浏览器的通知订阅开了 / 关了：告诉各台。设置里开关通知后、启动时调 */
export async function refreshShellPush() {
  if (SH.role !== "host") return;
  let next = null;
  const sub = await currentPushSub();
  if (sub) {
    try {
      const vapid = await api("/api/push/relay-key");
      // 订阅得是对着这台的公钥开的，各台用这把密钥签名才推得过去
      const key = sub.options?.applicationServerKey;
      if (!key || b64url(key) === vapid.publicKey) next = { subscription: sub.toJSON(), vapid };
    } catch {
      // 拿不到就先不转
    }
  }
  const old = SH.push;
  if (old?.subscription.endpoint === next?.subscription.endpoint) return;
  SH.push = next;
  for (const f of frames.values()) {
    if (!f.ready) continue;
    if (next) post(f, { t: "push", push: next });
    else post(f, { t: "push-off", endpoint: old.subscription.endpoint });
  }
}

// ---------- 被嵌着 ----------

function toHost(msg) {
  if (SH.hostOrigin) window.parent.postMessage({ ns: NS, ...msg }, SH.hostOrigin);
}

/** 登录完了、打开过的页面才处理的：外壳让打开的对话 */
let pendingOpen = null;
let relayed = null;
let relayWork = Promise.resolve();
let relayStopped = false;

/** 把外壳转来的推送订阅存到这台的服务端（要登录了才行；同一个订阅、同一个账号只存一次） */
function applyRelayPush() {
  if (SH.role !== "guest" || !SH.push || !S.user || relayStopped) return;
  const me = SH.servers.find((s) => s.id === SH.self);
  const label = me ? `${me.icon} ${me.name}`.trim() : "";
  const mark = JSON.stringify([S.user.id, SH.push.subscription.endpoint, SH.self, label]);
  if (relayed === mark) return;
  relayed = mark;
  const body = {
    subscription: SH.push.subscription,
    vapid: SH.push.vapid,
    via: { origin: SH.hostOrigin, server: SH.self, label },
  };
  relayWork = relayWork.catch(() => {}).then(() => api("/api/push/relay", {
    method: "POST",
    body,
  })).catch((err) => {
    if (relayed === mark) relayed = null;
    console.warn("[多服务器] 通知订阅没转过来：", err.message);
  });
}

/** 退出登录或外壳移除这台：先等正在注册的请求结束，再撤销这台的订阅。 */
export function dropRelayPush(endpoint = SH.push?.subscription.endpoint, loggingOut = true) {
  if (SH.role !== "guest") return Promise.resolve();
  if (loggingOut) relayStopped = true;
  relayed = null;
  if (!S.user || typeof endpoint !== "string") return Promise.resolve();
  relayWork = relayWork.catch(() => {}).then(() => api("/api/push/unsubscribe", {
    method: "POST",
    body: { endpoint },
    // 超时回收 iframe 时，已经发出的退订请求仍能完成。
    keepalive: true,
  }));
  return relayWork;
}

function onHostMessage(origin, m) {
  switch (m.t) {
    case "hello":
      SH.role = "guest";
      SH.hostOrigin = origin;
      SH.self = m.self;
      SH.servers = Array.isArray(m.servers) ? m.servers : [];
      SH.current = m.current;
      SH.active = m.current === m.self;
      SH.push = m.push ?? null;
      document.documentElement.classList.add("in-shell");
      toHost({ t: "state", ...local });
      emit("aim:shell-active");
      rerender();
      applyRelayPush();
      return;
    case "servers":
      if (Array.isArray(m.servers)) SH.servers = m.servers;
      rerender();
      applyRelayPush();
      return;
    case "active":
      SH.current = m.current;
      SH.active = m.current === SH.self;
      emit("aim:shell-active");
      return;
    case "open":
      if (typeof m.key !== "string") return;
      if (S.user) emit("aim:shell-open", m.key);
      else pendingOpen = m.key;
      return;
    case "push":
      SH.push = m.push ?? null;
      applyRelayPush();
      return;
    case "push-off":
      SH.push = null;
      void dropRelayPush(m.endpoint, false).then(() => {
        toHost({ t: "push-off-done", request: m.request });
      }).catch((err) => console.warn("[多服务器] 通知订阅没有撤销：", err.message));
      return;
  }
}

/** 页面启动完（登录了、主界面画好了）：被嵌时把攒着的事办了 */
export function shellBooted() {
  if (SH.role !== "guest") return;
  relayStopped = false;
  toHost({ t: "state", ...local });
  applyRelayPush();
  if (pendingOpen) {
    emit("aim:shell-open", pendingOpen);
    pendingOpen = null;
  }
}

window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || typeof m !== "object" || m.ns !== NS || typeof m.t !== "string") return;
  if (framed) {
    if (e.source !== window.parent || (SH.hostOrigin && e.origin !== SH.hostOrigin)) return;
    onHostMessage(e.origin, m);
    return;
  }
  // 删掉最后一台后 role 已经清空，仍要接收退订确认。
  for (const f of retiringFrames) {
    if (e.source === f.iframe.contentWindow && e.origin === f.s.url) {
      if (m.t === "push-off-done" && m.request === f.cleanupId) f.finishCleanup();
      return;
    }
  }
  if (SH.role !== "host") return;
  for (const f of frames.values()) {
    if (f.iframe.contentWindow !== e.source) continue;
    if (e.origin === f.s.url) onGuestMessage(f, m);
    return;
  }
  // 新标签页里那台授权完了（openForAuth）：重新加载它
  if (m.t === "embed-allowed") {
    for (const f of frames.values()) if (f.s.url === e.origin) reloadFrame(f);
  }
});

if (framed) {
  // 报到：外壳收到后回 hello。这条不带任何内容，发给谁都无所谓
  window.parent.postMessage({ ns: NS, t: "ready", insets: safeInsets() }, "*");
  addEventListener("pagehide", () => toHost({ t: "bye" }));
}

// ---------- 被别的服务器嵌：在新标签页里确认（地址带 ?allow-embed=外壳地址） ----------

/**
 * 一加载就记下来、从地址里去掉：没登录的话要等登录完才处理，那时地址早被别处改过了。
 * 要授权的外壳地址；处理过就清掉
 */
let allowEmbed = (() => {
  const params = new URLSearchParams(location.search);
  const raw = params.get("allow-embed");
  if (!raw) return null;
  params.delete("allow-embed");
  const rest = params.toString();
  history.replaceState(history.state, "", `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
  return framed ? null : raw;
})();

/** 页面启动（登录）后调。不是管理员只提示；确认了就加进允许嵌入的地址，告诉打开它的外壳重新加载 */
export async function handleAllowEmbed(confirmDialog, toast) {
  const raw = allowEmbed;
  allowEmbed = null;
  if (!raw) return;
  let origin;
  try {
    origin = new URL(raw).origin;
  } catch {
    return;
  }
  if (origin === "null" || origin === location.origin) return;
  if (!isAdmin()) {
    toast(`${origin} 想切换到这台，要这台的管理员来授权`, 6000);
    return;
  }
  let cfg;
  try {
    cfg = await api("/api/config");
  } catch (err) {
    toast(err.message);
    return;
  }
  const embedders = cfg.servers?.embedders ?? [];
  if (!embedders.includes(origin)) {
    const ok = await confirmDialog({
      title: "允许在别的服务器上切换到这台？",
      message: `${origin} 的页面左上角会多出这台，切过来时这台的页面嵌在那边显示（照样要登录这台的账号，聊天内容不经过那台）。以后不想要了，在 设置 → 服务器 里移除。`,
      confirmText: "允许",
    });
    if (!ok) return;
    try {
      await api("/api/config", { method: "PUT", body: { servers: { embedders: [...embedders, origin] } } });
    } catch (err) {
      toast(err.message);
      return;
    }
  }
  window.opener?.postMessage({ ns: NS, t: "embed-allowed" }, origin);
  toast(window.opener ? "已允许，回到原来的页面就能切过来了" : `已允许，回到 ${origin} 刷新一下就能切过来了`, 6000);
  if (window.opener) setTimeout(() => window.close(), 1500);
}
