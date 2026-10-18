// agent-im Web 前端。无构建步骤，原生 ES module。
import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";
import hljs from "/vendor/hljs.js";

// ---------- 小工具 ----------

const $app = document.getElementById("app");
const isTouch = matchMedia("(pointer: coarse)").matches;

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** replaceChildren 会把 null 变成字面量 "null"，统一过滤掉 */
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
}

const ICON = {
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>',
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.4 11.6-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

function icon(name) {
  return h("span", { html: ICON[name], style: { display: "inline-grid" } });
}

function toast(text, ms = 2600) {
  const el = h("div", { class: "toast" }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    credentials: "same-origin",
    headers: opts.body !== undefined && !(opts.body instanceof Blob) ? { "Content-Type": "application/json" } : opts.headers,
    body: opts.body === undefined ? undefined : opts.body instanceof Blob ? opts.body : JSON.stringify(opts.body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // 没有 body
  }
  if (res.status === 401 && !path.startsWith("/api/me") && !path.startsWith("/api/login")) {
    showAuth();
    throw new Error("请先登录");
  }
  if (!res.ok) throw new Error(data?.error ?? `请求失败（${res.status}）`);
  return data;
}

function relTime(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr} 小时前`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN");
}

// ---------- markdown ----------

marked.setOptions({ gfm: true, breaks: true });

function renderMarkdown(text) {
  const html = DOMPurify.sanitize(marked.parse(text ?? ""), { ADD_ATTR: ["target"] });
  const div = h("div", { class: "md", html });
  for (const a of div.querySelectorAll("a")) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  for (const pre of div.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    if (!code) continue;
    const lang = /language-([\w+-]+)/.exec(code.className)?.[1] ?? "";
    try {
      if (lang && hljs.getLanguage(lang)) hljs.highlightElement(code);
      else if (code.textContent.length < 20000) {
        code.innerHTML = hljs.highlightAuto(code.textContent).value;
        code.classList.add("hljs");
      }
    } catch {
      // 高亮失败就原样显示
    }
    const copy = h("button", { class: "copy-btn", onclick: () => copyText(code.textContent, copy) }, "复制");
    pre.prepend(h("div", { class: "code-head" }, h("span", {}, lang || "code"), copy));
  }
  return div;
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h("textarea", { style: { position: "fixed", opacity: "0" } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = "已复制";
    setTimeout(() => (btn.textContent = old), 1200);
  } else toast("已复制");
}

// ---------- 状态 ----------

const S = {
  agents: [],
  bots: [],
  convs: new Map(),
  pending: new Map(),
  current: null,
  draftAgent: localStorage.getItem("aim.agent") || null,
  items: [],
  turnAi: null,
  seq: new Map(),
  uploads: [],
  busy: false,
  allowedAgents: [],
  search: "",
  loadToken: 0,
};

const ui = {};

// ---------- WebSocket ----------

const WS = {
  sock: null,
  rid: 0,
  waiters: new Map(),
  backoff: 500,
  connected: false,
  pingTimer: null,

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

  request(msg) {
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
      }, 15000);
    });
  },

  subscribe(key, since) {
    this.raw({ t: "sub", key, since, epoch: this.epoch });
  },
};

document.addEventListener("visibilitychange", () => {
  // 手机切回前台：连接多半已经被系统掐了，立刻重连而不是等退避
  if (document.visibilityState === "visible" && WS.sock?.readyState !== 1) {
    WS.backoff = 300;
    WS.connect();
  }
});

/** 重连后：以服务器上的会话列表和待处理授权为准，清掉本地已失效的 */
async function resync() {
  try {
    const data = await api("/api/bootstrap");
    S.convs = new Map(data.conversations.map((c) => [c.key, c]));
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
      const restarted = WS.epoch && WS.epoch !== msg.epoch;
      WS.epoch = msg.epoch;
      WS.hellos += 1;
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
      S.convs.set(msg.info.key, msg.info);
      if (msg.info.key === S.current) {
        renderTopbar();
        setBusy(msg.info.busy);
      }
      scheduleSidebar();
      return;
    case "ix":
      upsertInteraction(msg.interaction);
      return;
  }
}

function setConnBanner(text) {
  ui.banner?.remove();
  ui.banner = null;
  if (!text || !ui.main) return;
  ui.banner = h("div", { class: "conn-banner" }, text);
  ui.main.append(ui.banner);
}

// ---------- 登录 ----------

async function showAuth() {
  WS.stopped = true;
  WS.sock?.close();
  let me = { needsSetup: false };
  try {
    me = await api("/api/me");
  } catch {
    // 网络问题时按登录处理
  }
  const err = h("div", { class: "error-text" });
  const pw = h("input", { type: "password", placeholder: "密码", autocomplete: me.needsSetup ? "new-password" : "current-password" });
  const token = h("input", { placeholder: "设置码（在启动日志里）", autocomplete: "off" });
  const btn = h("button", { class: "btn primary", type: "submit" }, me.needsSetup ? "设置密码并进入" : "登录");
  const form = h(
    "form",
    {
      class: "auth-card",
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        btn.disabled = true;
        try {
          if (me.needsSetup) await api("/api/setup", { method: "POST", body: { token: token.value, password: pw.value } });
          else await api("/api/login", { method: "POST", body: { password: pw.value } });
          await boot();
        } catch (e2) {
          err.textContent = e2.message;
        } finally {
          btn.disabled = false;
        }
      },
    },
    h("h1", {}, "Agent IM"),
    h("p", {}, me.needsSetup ? "首次使用：输入启动日志里的设置码，并设一个登录密码（至少 8 位）" : "登录以继续"),
    me.needsSetup ? h("label", { class: "field" }, h("span", {}, "设置码"), token) : null,
    h("label", { class: "field" }, h("span", {}, me.needsSetup ? "新密码" : "密码"), pw),
    btn,
    err,
  );
  fill($app, h("div", { class: "auth" }, form));
  (me.needsSetup ? token : pw).focus();
}

// ---------- 主界面 ----------

async function boot() {
  const me = await api("/api/me");
  if (!me.authed) return showAuth();
  WS.stopped = false;
  WS.epoch = null;
  WS.hellos = 0;
  const data = await api("/api/bootstrap");
  S.agents = data.agents;
  S.bots = data.bots;
  S.workspaceRoot = data.workspaceRoot;
  S.convs = new Map(data.conversations.map((c) => [c.key, c]));
  S.pending = new Map(data.pending.map((i) => [i.id, i]));
  const enabled = S.agents.filter((a) => a.enabled).map((a) => a.id);
  if (!S.draftAgent || !enabled.includes(S.draftAgent)) S.draftAgent = enabled[0] ?? null;
  renderLayout();
  WS.connect();
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (fromHash && S.convs.has(fromHash)) await openConversation(fromHash);
  else newDraft();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

function renderLayout() {
  ui.convList = h("div", { class: "conv-list" });
  ui.search = h("input", {
    class: "side-search",
    placeholder: "搜索会话",
    oninput: (e) => {
      S.search = e.target.value.trim().toLowerCase();
      renderSidebar();
    },
  });
  ui.sidebar = h(
    "aside",
    { class: "sidebar" },
    h(
      "div",
      { class: "side-top" },
      h("button", { class: "btn new-chat", onclick: () => (newDraft(), closeSide()) }, icon("edit"), "新对话"),
    ),
    ui.search,
    ui.convList,
    h(
      "div",
      { class: "side-bottom" },
      h("button", { class: "btn", onclick: () => (openSettings(), closeSide()) }, icon("gear"), "设置"),
    ),
  );
  ui.topbar = h("div", { class: "topbar" });
  ui.msgInner = h("div", { class: "messages-inner" });
  ui.messages = h("div", { class: "messages" }, ui.msgInner);
  ui.composerWrap = h("div", { class: "composer-wrap" });
  ui.main = h("main", { class: "main" }, ui.topbar, ui.messages, ui.composerWrap);
  ui.layout = h("div", { class: "layout" }, ui.sidebar, h("div", { class: "scrim", onclick: closeSide }), ui.main);
  fill($app, ui.layout);
  renderComposer();
  renderSidebar();
}

function openSide() {
  ui.layout.classList.add("side-open");
}

function closeSide() {
  ui.layout?.classList.remove("side-open");
}

// ---------- 侧边栏 ----------

let sidebarScheduled = false;
function scheduleSidebar() {
  if (sidebarScheduled) return;
  sidebarScheduled = true;
  requestAnimationFrame(() => {
    sidebarScheduled = false;
    renderSidebar();
  });
}

function convTitle(c) {
  if (!c) return "新对话";
  if (c.title) return c.title;
  if (c.channel === "feishu") return `飞书会话 ${c.key.split(":")[2]?.slice(-6) ?? ""}`;
  return "新对话";
}

function agentLabel(id) {
  return S.agents.find((a) => a.id === id)?.label ?? id;
}

function renderSidebar() {
  if (!ui.convList) return;
  const groups = new Map();
  const askKeys = new Set([...S.pending.values()].filter((i) => !i.settled).map((i) => i.convKey));
  const list = [...S.convs.values()]
    .filter((c) => !c.hidden)
    .filter((c) => !S.search || convTitle(c).toLowerCase().includes(S.search))
    .sort((a, b) => b.activeAt - a.activeAt);
  for (const c of list) {
    const group =
      c.channel === "web" ? "Web" : c.channel === "feishu" ? `飞书 · ${S.bots.find((b) => b.id === c.channelId)?.name ?? c.channelId}` : c.channel;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(c);
  }
  const nodes = [];
  for (const [group, convs] of groups) {
    nodes.push(h("div", { class: "conv-group" }, group));
    for (const c of convs) {
      nodes.push(
        h(
          "button",
          {
            class: `conv-item${c.key === S.current ? " active" : ""}`,
            title: `${convTitle(c)}\n${agentLabel(c.agent)} · ${c.cwd}`,
            onclick: () => {
              closeSide();
              if (c.key !== S.current) void openConversation(c.key);
            },
          },
          askKeys.has(c.key) ? h("span", { class: "dot ask", title: "等你处理" }) : c.busy ? h("span", { class: "dot busy" }) : null,
          h("span", { class: "title" }, convTitle(c)),
          h("span", { class: "badge" }, c.agent === "claude" ? "Claude" : c.agent === "codex" ? "Codex" : c.agent),
        ),
      );
    }
  }
  if (nodes.length === 0) nodes.push(h("div", { class: "conv-group" }, "还没有会话"));
  fill(ui.convList, ...nodes);
  const asks = askKeys.size;
  document.title = asks ? `(${asks}) 待处理 · Agent IM` : "Agent IM";
}

// ---------- 顶栏 ----------

function renderTopbar() {
  const c = S.current ? S.convs.get(S.current) : null;
  const agentId = c ? c.agent : S.draftAgent;
  const agentPill = h(
    "button",
    {
      class: "pill",
      onclick: (e) => {
        const allowed = c ? S.allowedAgents : S.agents.filter((a) => a.enabled).map((a) => a.id);
        if (allowed.length < 2) return;
        showMenu(
          e.currentTarget,
          allowed.map((id) => ({
            label: `${agentLabel(id)}${id === agentId ? "  ✓" : ""}`,
            onclick: () => switchAgent(id),
          })),
        );
      },
    },
    agentLabel(agentId ?? "") || "无可用 agent",
    icon("down"),
  );
  const modelPill = c
    ? h(
        "button",
        { class: "pill", onclick: () => openModelPicker() },
        h("span", { class: "sub" }, c.model ? c.model : "默认模型"),
        c.effort ? h("span", { class: "sub" }, `· ${c.effort}`) : null,
        icon("down"),
      )
    : null;
  const more = h("button", { class: "icon-btn", title: "更多", onclick: (e) => openMoreMenu(e.currentTarget) }, icon("more"));
  fill(ui.topbar, 
    ...[
      h("button", { class: "icon-btn menu-btn", onclick: openSide, title: "会话列表" }, icon("menu")),
      h("div", { class: "top-title" }, agentPill, modelPill),
      c ? more : null,
    ].filter(Boolean),
  );
}

function showMenu(anchor, items) {
  closeMenu();
  const menu = h(
    "div",
    { class: "menu" },
    items.map((it) =>
      it === "sep"
        ? h("div", { class: "sep" })
        : h(
            "button",
            {
              class: it.danger ? "btn danger" : "",
              onclick: () => {
                closeMenu();
                it.onclick();
              },
            },
            it.label,
          ),
    ),
  );
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  menu.style.top = `${Math.min(r.bottom + 4, innerHeight - menu.offsetHeight - 8)}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  ui.menu = menu;
  setTimeout(() => document.addEventListener("pointerdown", onOutsideMenu), 0);
}

function onOutsideMenu(e) {
  if (ui.menu && !ui.menu.contains(e.target)) closeMenu();
}

function closeMenu() {
  ui.menu?.remove();
  ui.menu = null;
  document.removeEventListener("pointerdown", onOutsideMenu);
}

function openMoreMenu(anchor) {
  const c = S.convs.get(S.current);
  if (!c) return;
  showMenu(anchor, [
    { label: "历史会话…", onclick: () => openSessions(false) },
    { label: "开新会话（清空上下文）", onclick: () => doAction("new") },
    { label: "分叉当前会话", onclick: () => doAction("fork") },
    { label: "切换工作目录…", onclick: () => changeCwd() },
    { label: "查看状态", onclick: () => showStatus() },
    "sep",
    { label: "重命名", onclick: () => renameConv() },
    ...(c.channel === "web" ? [{ label: "从列表删除", danger: true, onclick: () => deleteConv() }] : []),
  ]);
}

// ---------- 打开会话 ----------

function newDraft() {
  if (S.current) WS.raw({ t: "unsub", key: S.current });
  S.current = null;
  S.items = [];
  S.turnAi = null;
  S.uploads = [];
  setBusy(false);
  history.replaceState(null, "", location.pathname);
  renderTopbar();
  renderEmpty();
  renderChips();
  renderSidebar();
  ui.input?.focus();
}

function renderEmpty() {
  const enabled = S.agents.filter((a) => a.enabled);
  fill(ui.msgInner, 
    h(
      "div",
      { class: "empty" },
      h("h2", {}, "有什么可以帮你？"),
      h("div", {}, enabled.length ? `工作目录：${S.workspaceRoot ?? ""}` : "还没有启用任何 agent，先去设置里启用。"),
      enabled.length > 1
        ? h(
            "div",
            { class: "agent-choice" },
            enabled.map((a) =>
              h(
                "button",
                {
                  class: `btn${a.id === S.draftAgent ? " on" : ""}`,
                  onclick: () => {
                    S.draftAgent = a.id;
                    localStorage.setItem("aim.agent", a.id);
                    renderTopbar();
                    renderEmpty();
                  },
                },
                a.label,
              ),
            ),
          )
        : null,
    ),
  );
}

async function openConversation(key) {
  const token = ++S.loadToken;
  if (S.current && S.current !== key) WS.raw({ t: "unsub", key: S.current });
  S.current = key;
  S.items = [];
  S.turnAi = null;
  S.uploads = [];
  renderChips();
  history.replaceState(null, "", `#${encodeURIComponent(key)}`);
  renderTopbar();
  renderSidebar();
  fill(ui.msgInner, h("div", { class: "empty" }, h("span", { class: "spinner" })));
  let data;
  try {
    data = await api(`/api/conversations/${encodeURIComponent(key)}/history`);
  } catch (err) {
    if (token === S.loadToken) fill(ui.msgInner, h("div", { class: "empty" }, err.message));
    return;
  }
  if (token !== S.loadToken) return; // 期间又切到别的会话了
  S.convs.set(key, data.info);
  S.allowedAgents = data.allowedAgents;
  fill(ui.msgInner, );
  for (const m of data.messages) {
    if (m.role === "user") addItem({ type: "user", text: m.text, files: [], origin: null });
    else addItem({ type: "ai", steps: m.steps ?? [], committed: m.text, partial: "", done: true });
  }
  S.seq.set(key, 0);
  for (const env of data.live) applyEvent(env);
  S.seq.set(key, Math.max(S.seq.get(key) ?? 0, data.seq));
  for (const ix of data.pending) upsertInteraction(ix);
  if (S.items.length === 0) {
    ui.msgInner.append(
      h(
        "div",
        { class: "empty" },
        h("h2", {}, convTitle(data.info)),
        h("div", {}, data.info.sessionId ? "这条会话暂时读不到历史记录，直接接着说就行。" : `${agentLabel(data.info.agent)} · ${data.info.cwd}`),
      ),
    );
  }
  setBusy(data.info.busy);
  renderTopbar();
  WS.subscribe(key, S.seq.get(key));
  scrollToBottom(true);
}

// ---------- 消息渲染 ----------

function nearBottom() {
  const m = ui.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight < 120;
}

function scrollToBottom(force) {
  if (force || ui.stick) ui.messages.scrollTop = ui.messages.scrollHeight;
}

function addItem(item) {
  ui.msgInner.querySelector(".empty")?.remove();
  const stick = nearBottom();
  item.el = renderItem(item);
  ui.msgInner.append(item.el);
  S.items.push(item);
  if (stick) scrollToBottom(true);
  return item;
}

const dirty = new Set();
let flushScheduled = false;
function updateItem(item) {
  dirty.add(item);
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => {
    flushScheduled = false;
    const stick = nearBottom();
    for (const it of dirty) {
      if (!it.el?.isConnected) continue;
      const next = renderItem(it);
      it.el.replaceWith(next);
      it.el = next;
    }
    dirty.clear();
    if (stick) scrollToBottom(true);
  });
}

function renderItem(item) {
  switch (item.type) {
    case "user":
      return h(
        "div",
        { class: "msg-user" },
        item.origin && item.origin.channel !== "web" ? h("span", { class: "origin" }, `来自${item.origin.name ?? item.origin.channel}`) : null,
        item.text,
        item.files?.length ? h("div", { class: "files" }, `📎 ${item.files.join("、")}`) : null,
      );
    case "ai":
      return renderAi(item);
    case "notice":
      return h("div", { class: "notice" }, renderMarkdown(item.text));
    case "error":
      return h("div", { class: "error-box" }, item.text);
    case "ix":
      return renderInteraction(item);
  }
  return h("div");
}

function renderAi(item) {
  const body = item.committed + (item.partial ? (item.committed ? "\n\n" : "") + item.partial : "");
  const working = !item.done;
  const steps =
    item.steps.length > 0
      ? h(
          "details",
          {
            class: "steps",
            open: item.stepsOpen ?? false,
            ontoggle: (e) => (item.stepsOpen = e.currentTarget.open),
          },
          h(
            "summary",
            {},
            working ? h("span", { class: "spinner" }) : null,
            working
              ? `正在处理… ${item.steps[item.steps.length - 1]}`
              : `${item.segment ? "" : "已完成 "}${item.steps.length} 步${item.segment ? "过程" : ""}`,
          ),
          h("ol", {}, item.steps.map((s) => h("li", {}, s))),
        )
      : null;
  return h(
    "div",
    { class: "msg-ai" },
    steps,
    body ? renderMarkdown(body) : working && item.steps.length === 0 ? h("div", { class: "thinking" }, h("span", { class: "spinner" }), "思考中…") : null,
    item.error ? h("div", { class: "error-box" }, item.error) : null,
    item.done && !item.segment && (body || item.footer)
      ? h(
          "div",
          { class: "ai-actions" },
          body ? h("button", { class: "icon-btn", title: "复制", onclick: () => copyText(body) }, icon("copy")) : null,
          item.footer ? h("span", { class: "footer-note" }, item.footer) : null,
        )
      : null,
  );
}

function currentAi() {
  if (!S.turnAi || S.turnAi.done) {
    S.turnAi = addItem({ type: "ai", steps: [], committed: "", partial: "", done: false });
  }
  return S.turnAi;
}

function applyEvent(env) {
  if (env.key !== S.current) return;
  const last = S.seq.get(env.key) ?? 0;
  if (env.seq <= last) return;
  S.seq.set(env.key, env.seq);
  const ev = env.ev;
  switch (ev.type) {
    case "user": {
      if (S.turnAi && !S.turnAi.done && S.turnAi.steps.length === 0 && !S.turnAi.committed) {
        // 上一个占位还空着（比如消息被当成了作答），不再多留一个
        S.turnAi.el.remove();
        S.items = S.items.filter((i) => i !== S.turnAi);
        S.turnAi = null;
      }
      addItem({ type: "user", text: ev.text, files: ev.attachments, origin: ev.origin });
      currentAi();
      return;
    }
    case "step": {
      const ai = currentAi();
      ai.steps.push(ev.text);
      updateItem(ai);
      return;
    }
    case "delta": {
      const ai = currentAi();
      ai.partial += ev.text;
      updateItem(ai);
      return;
    }
    case "text": {
      const ai = currentAi();
      ai.committed += (ai.committed ? "\n\n" : "") + ev.text;
      ai.partial = "";
      updateItem(ai);
      return;
    }
    case "result": {
      const ai = currentAi();
      if (!ai.committed && ev.text) ai.committed = ev.text;
      ai.partial = "";
      ai.done = true;
      ai.footer = ev.footer;
      updateItem(ai);
      S.turnAi = null;
      return;
    }
    case "error": {
      if (S.turnAi && !S.turnAi.done) {
        S.turnAi.done = true;
        S.turnAi.error = ev.message;
        updateItem(S.turnAi);
        S.turnAi = null;
      } else addItem({ type: "error", text: ev.message });
      return;
    }
    case "notice":
      addItem({ type: "notice", text: ev.text });
      return;
    case "state":
      setBusy(ev.busy);
      if (!ev.busy && S.turnAi && !S.turnAi.done) {
        S.turnAi.done = true;
        updateItem(S.turnAi);
        S.turnAi = null;
      }
      return;
    case "meta":
      return;
  }
}

// ---------- 交互（授权 / 提问） ----------

function upsertInteraction(ix) {
  // 只进不退：本地已经知道它处理完了，晚到的旧快照（还写着待处理）不能把它复活
  const known = S.pending.get(ix.id);
  if (known?.settled && !ix.settled) return;
  S.pending.set(ix.id, ix);
  if (ix.settled) setTimeout(() => S.pending.get(ix.id)?.settled && S.pending.delete(ix.id), 60000);
  scheduleSidebar();
  if (ix.convKey !== S.current) {
    if (!ix.settled && document.visibilityState === "visible") {
      const c = S.convs.get(ix.convKey);
      toast(`「${convTitle(c)}」在等你处理：${ix.spec.title}`, 4000);
    }
    return;
  }
  const existing = S.items.find((i) => i.type === "ix" && i.id === ix.id);
  if (existing) {
    existing.ix = ix;
    updateItem(existing);
    return;
  }
  if (ix.settled) return;
  // 卡片插在这一轮中间：之前的输出先封口，之后的输出接在卡片下面，顺序才对
  if (S.turnAi && !S.turnAi.done) {
    S.turnAi.done = true;
    S.turnAi.segment = true;
    updateItem(S.turnAi);
    S.turnAi = null;
  }
  addItem({ type: "ix", id: ix.id, ix });
  notifyIfHidden(ix);
}

function notifyIfHidden(ix) {
  if (document.visibilityState === "visible" || !("Notification" in window)) return;
  if (Notification.permission === "granted") {
    try {
      new Notification("Agent IM 需要你处理", { body: ix.spec.title, tag: ix.id });
    } catch {
      // 某些浏览器只允许在 SW 里发
    }
  }
}

async function ixOp(id, op, extra = {}) {
  try {
    await WS.request({ t: "ix", id, op, ...extra });
  } catch (err) {
    toast(err.message);
  }
}

const SETTLE_LABEL = {
  "allow-once": "已允许（本次）",
  "allow-always": "已允许（总是）",
  deny: "已拒绝",
  timeout: "已超时，按拒绝处理",
  cancelled: "已取消",
  answered: "已回答",
  skipped: "已跳过",
  gone: "已处理",
};

function renderInteraction(item) {
  const ix = item.ix;
  const spec = ix.spec;
  const settled = ix.settled;
  if (spec.kind === "approval") {
    return h(
      "div",
      { class: `ix-card${settled ? " settled" : ""}` },
      h("div", { class: "ix-title" }, settled ? "" : "⚠️", spec.title),
      h("div", { class: "ix-detail" }, renderMarkdown(spec.detail)),
      settled
        ? h("div", { class: "ix-meta" }, `${SETTLE_LABEL[settled.settlement] ?? settled.settlement} · ${settled.by}`)
        : h(
            "div",
            { class: "ix-buttons" },
            h("button", { class: "btn accent", onclick: () => ixOp(ix.id, "decide", { decision: "allow-once" }) }, "允许一次"),
            spec.alwaysLabel
              ? h("button", { class: "btn", onclick: () => ixOp(ix.id, "decide", { decision: "allow-always" }) }, spec.alwaysLabel)
              : null,
            h("button", { class: "btn danger", onclick: () => ixOp(ix.id, "decide", { decision: "deny" }) }, "拒绝"),
          ),
    );
  }
  // 提问
  const needsSubmit = spec.questions.some((q) => q.multiSelect);
  return h(
    "div",
    { class: `ix-card ask${settled ? " settled" : ""}` },
    h("div", { class: "ix-title" }, settled ? "" : "❓", spec.title),
    spec.questions.map((q, qi) => {
      const picked = ix.selections[qi] ?? [];
      const free = ix.freeText?.[qi];
      return h(
        "div",
        { class: "ix-q" },
        h("div", { class: "q-head" }, h("b", {}, q.header), q.question, q.multiSelect ? "（可多选）" : ""),
        q.options.map((opt, oi) => {
          const on = picked.includes(oi);
          return h(
            "button",
            {
              class: `opt${on ? " on" : ""}`,
              disabled: !!settled,
              onclick: () => ixOp(ix.id, "select", { q: qi, o: oi, v: q.multiSelect ? !on : true }),
            },
            `${on ? "✓ " : ""}${opt.label}`,
            opt.description ? h("small", {}, opt.description) : null,
          );
        }),
        free ? h("div", { class: "ix-meta" }, `→ ${free}`) : null,
      );
    }),
    settled
      ? h("div", { class: "ix-meta" }, `${SETTLE_LABEL[settled.settlement] ?? settled.settlement} · ${settled.by}`)
      : h(
          "div",
          { class: "ix-buttons" },
          needsSubmit ? h("button", { class: "btn accent", onclick: () => ixOp(ix.id, "submit") }, "提交") : null,
          h("button", { class: "btn", onclick: () => ixOp(ix.id, "skip") }, "跳过"),
          h("span", { class: "ix-meta" }, "都不合适？直接在下面输入框里回答"),
        ),
  );
}

// ---------- 输入框 ----------

function renderComposer() {
  ui.input = h("textarea", {
    rows: 1,
    placeholder: "给 agent 发消息",
    oninput: autosize,
    onkeydown: (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !isTouch) {
        e.preventDefault();
        void sendMessage();
      }
    },
    onpaste: (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) {
        e.preventDefault();
        void addFiles(files);
      }
    },
  });
  ui.fileInput = h("input", {
    type: "file",
    multiple: true,
    style: { display: "none" },
    onchange: (e) => {
      void addFiles([...e.target.files]);
      e.target.value = "";
    },
  });
  ui.sendBtn = h("button", { class: "send-btn", title: "发送", onclick: () => (S.busy && !hasDraft() ? stopTurn() : sendMessage()) });
  ui.chips = h("div", { class: "chips" });
  ui.composer = h(
    "div",
    {
      class: "composer",
      ondragover: (e) => {
        e.preventDefault();
        ui.composer.classList.add("drag");
      },
      ondragleave: () => ui.composer.classList.remove("drag"),
      ondrop: (e) => {
        e.preventDefault();
        ui.composer.classList.remove("drag");
        void addFiles([...(e.dataTransfer?.files ?? [])]);
      },
    },
    ui.chips,
    ui.input,
    h(
      "div",
      { class: "composer-row" },
      h("button", { class: "icon-btn", title: "添加附件", onclick: () => ui.fileInput.click() }, icon("clip")),
      ui.fileInput,
      h("span", { class: "spacer" }),
      ui.sendBtn,
    ),
  );
  fill(ui.composerWrap, 
    ui.composer,
    h("div", { class: "composer-hint" }, "Enter 发送，Shift+Enter 换行。agent 会在你的机器上执行操作，注意审批。"),
  );
  ui.input.addEventListener("input", updateSendBtn);
  updateSendBtn();
}

function autosize() {
  ui.input.style.height = "auto";
  ui.input.style.height = `${Math.min(ui.input.scrollHeight, innerHeight * 0.4)}px`;
}

function hasDraft() {
  return !!ui.input?.value.trim() || S.uploads.length > 0;
}

function updateSendBtn() {
  if (!ui.sendBtn) return;
  const stop = S.busy && !hasDraft();
  ui.sendBtn.innerHTML = stop ? ICON.stop : ICON.send;
  ui.sendBtn.title = stop ? "停止" : "发送";
  ui.sendBtn.disabled = !stop && !hasDraft();
}

function setBusy(busy) {
  S.busy = !!busy;
  updateSendBtn();
}

function renderChips() {
  if (!ui.chips) return;
  fill(ui.chips, 
    ...S.uploads.map((u) =>
      h(
        "span",
        { class: "chip" },
        u.uploading ? h("span", { class: "spinner" }) : u.kind === "image" ? "🖼" : "📄",
        h("span", {}, u.name),
        h(
          "button",
          {
            title: "移除",
            onclick: () => {
              S.uploads = S.uploads.filter((x) => x !== u);
              renderChips();
            },
          },
          "×",
        ),
      ),
    ),
  );
  updateSendBtn();
}

async function ensureConversation() {
  if (S.current) return S.current;
  if (!S.draftAgent) throw new Error("没有可用的 agent");
  const info = await api("/api/conversations", { method: "POST", body: { agent: S.draftAgent } });
  S.convs.set(info.key, info);
  S.current = info.key;
  S.allowedAgents = S.agents.filter((a) => a.enabled).map((a) => a.id);
  S.seq.set(info.key, 0);
  history.replaceState(null, "", `#${encodeURIComponent(info.key)}`);
  fill(ui.msgInner, );
  WS.subscribe(info.key, 0);
  renderTopbar();
  renderSidebar();
  return info.key;
}

async function addFiles(files) {
  if (!files.length) return;
  let key;
  try {
    key = await ensureConversation();
  } catch (err) {
    toast(err.message);
    return;
  }
  for (const file of files) {
    const u = { name: file.name || "粘贴的图片.png", kind: file.type.startsWith("image/") ? "image" : "file", uploading: true };
    S.uploads.push(u);
    renderChips();
    try {
      const res = await api(`/api/conversations/${encodeURIComponent(key)}/upload?name=${encodeURIComponent(u.name)}`, {
        method: "POST",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      });
      Object.assign(u, { id: res.id, kind: res.kind, uploading: false });
    } catch (err) {
      S.uploads = S.uploads.filter((x) => x !== u);
      toast(`${u.name} 上传失败：${err.message}`);
    }
    renderChips();
  }
}

async function sendMessage() {
  const text = ui.input.value;
  if (!text.trim() && S.uploads.length === 0) return;
  if (S.uploads.some((u) => u.uploading)) {
    toast("附件还在上传，稍等");
    return;
  }
  let key;
  try {
    key = await ensureConversation();
    if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
    await WS.request({ t: "send", key, text, uploads: S.uploads.map((u) => u.id) });
  } catch (err) {
    toast(err.message);
    return;
  }
  ui.input.value = "";
  autosize();
  S.uploads = [];
  renderChips();
  ui.stick = true;
  scrollToBottom(true);
}

async function stopTurn() {
  await doAction("stop");
}

// ---------- 会话操作 ----------

async function doAction(action, value, extra = {}) {
  if (!S.current) return;
  try {
    const res = await api(`/api/conversations/${encodeURIComponent(S.current)}/action`, {
      method: "POST",
      body: { action, value, ...extra },
    });
    S.convs.set(res.info.key, res.info);
    renderTopbar();
    toast(res.text);
    if (["new", "fork", "resume", "agent", "cd"].includes(action)) await openConversation(S.current);
    return res;
  } catch (err) {
    toast(err.message);
  }
}

async function switchAgent(id) {
  if (!S.current) {
    S.draftAgent = id;
    localStorage.setItem("aim.agent", id);
    renderTopbar();
    renderEmpty();
    return;
  }
  await doAction("agent", id);
}

function modal({ title, body, foot, wide }) {
  const close = () => overlay.remove();
  const overlay = h(
    "div",
    { class: "overlay", onclick: (e) => e.target === overlay && close() },
    h(
      "div",
      { class: `modal${wide ? " wide" : ""}` },
      h("div", { class: "modal-head" }, h("h3", {}, title), h("button", { class: "icon-btn", onclick: close }, icon("x"))),
      body,
      foot ?? null,
    ),
  );
  document.body.append(overlay);
  return close;
}

async function openModelPicker() {
  const body = h("div", { class: "modal-body" }, h("span", { class: "spinner" }));
  const close = modal({ title: "切换模型", body });
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(S.current)}/models`);
    const efforts = data.models.find((m) => m.id === data.current)?.efforts ?? data.models.find((m) => m.efforts?.length)?.efforts ?? [];
    fill(body, 
      ...data.models.map((m) =>
        h(
          "button",
          {
            class: `list-item${m.id === data.current ? " on" : ""}`,
            onclick: async () => {
              close();
              await doAction("model", m.id);
            },
          },
          h("div", { class: "grow" }, h("div", { class: "t" }, m.label), m.description ? h("div", { class: "s" }, m.description) : null),
          m.id === data.current ? "✓" : null,
        ),
      ),
      data.effortSupported && efforts.length
        ? h(
            "div",
            { class: "section" },
            h("h4", {}, "思考程度"),
            h(
              "div",
              { class: "row" },
              efforts.map((e) =>
                h(
                  "button",
                  {
                    class: `btn small${e === data.currentEffort ? " primary" : ""}`,
                    onclick: async () => {
                      close();
                      await doAction("effort", e);
                    },
                  },
                  e,
                ),
              ),
            ),
          )
        : null,
    );
  } catch (err) {
    fill(body, h("div", { class: "error-text" }, err.message));
  }
}

async function openSessions(all) {
  const body = h("div", { class: "modal-body" }, h("span", { class: "spinner" }));
  const close = modal({ title: "历史会话", body });
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(S.current)}/sessions${all ? "?all=1" : ""}`);
    fill(body, 
      h(
        "div",
        { class: "muted" },
        data.allDirs ? (data.fellBack ? `${data.cwd} 下没有历史会话，已列出所有目录的` : "所有目录的最近会话") : `目录 ${data.cwd}`,
        !data.allDirs
          ? h(
              "button",
              {
                class: "btn small",
                style: { marginLeft: "8px" },
                onclick: () => {
                  close();
                  void openSessions(true);
                },
              },
              "看所有目录",
            )
          : null,
      ),
      ...(data.sessions.length === 0
        ? [h("div", { class: "muted" }, "还没有历史会话")]
        : data.sessions.map((s) =>
            h(
              "button",
              {
                class: `list-item${s.id === data.current ? " on" : ""}`,
                onclick: async () => {
                  if (s.id === data.current) return;
                  close();
                  await doAction("resume", s.id, s.cwd ? { cwd: s.cwd } : {});
                },
              },
              h(
                "div",
                { class: "grow" },
                h("div", { class: "t" }, s.title),
                h("div", { class: "s" }, `${relTime(s.updatedAt)}${data.allDirs && s.cwd ? ` · ${s.cwd}` : ""}`),
              ),
              s.id === data.current ? "当前" : null,
            ),
          )),
    );
  } catch (err) {
    fill(body, h("div", { class: "error-text" }, err.message));
  }
}

async function changeCwd() {
  const c = S.convs.get(S.current);
  const dir = prompt(`切换到哪个目录？（相对 ${S.workspaceRoot ?? "workspace"}，切换后开新会话）`, "");
  if (dir === null || !dir.trim()) return;
  await doAction("cd", dir.trim());
  void c;
}

async function showStatus() {
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(S.current)}/status`);
    modal({ title: "状态", body: h("div", { class: "modal-body" }, renderMarkdown("```\n" + data.text + "\n```")) });
  } catch (err) {
    toast(err.message);
  }
}

async function renameConv() {
  const c = S.convs.get(S.current);
  const title = prompt("新名称", convTitle(c));
  if (title === null) return;
  try {
    const info = await api(`/api/conversations/${encodeURIComponent(S.current)}`, { method: "PATCH", body: { title } });
    S.convs.set(info.key, info);
    renderSidebar();
  } catch (err) {
    toast(err.message);
  }
}

async function deleteConv() {
  if (!confirm("从列表里删除这条会话？（agent 那边的记录还在，之后能从「历史会话」恢复）")) return;
  try {
    await api(`/api/conversations/${encodeURIComponent(S.current)}`, { method: "DELETE" });
    const c = S.convs.get(S.current);
    if (c) c.hidden = true;
    newDraft();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- 设置 ----------

async function openSettings() {
  const nav = h("div", { class: "settings-nav" });
  const panel = h("div", { class: "settings-body" });
  const close = modal({ title: "设置", wide: true, body: h("div", { class: "settings" }, nav, panel) });
  let cfg;
  try {
    cfg = await api("/api/config");
  } catch (err) {
    panel.append(h("div", { class: "error-text" }, err.message));
    return;
  }
  const tabs = [
    ["通用", () => generalTab(cfg, panel)],
    ["Agent", () => agentsTab(cfg, panel)],
    ["飞书机器人", () => feishuTab(cfg, panel)],
    ["授权", () => authTab(panel)],
    ["安全", () => securityTab(panel)],
    ["系统", () => systemTab(panel, close)],
  ];
  const select = (i) => {
    nav.querySelectorAll("button").forEach((b, j) => b.classList.toggle("on", i === j));
    fill(panel, );
    tabs[i][1]();
  };
  nav.append(...tabs.map(([name], i) => h("button", { onclick: () => select(i) }, name)));
  select(0);
}

async function saveConfig(cfg, patch) {
  try {
    const next = await api("/api/config", { method: "PUT", body: patch });
    Object.assign(cfg, next);
    toast("已保存");
    const boot2 = await api("/api/bootstrap");
    S.agents = boot2.agents;
    S.bots = boot2.bots;
    S.workspaceRoot = boot2.workspaceRoot;
    renderTopbar();
    renderSidebar();
  } catch (err) {
    toast(err.message);
  }
}

function field(label, input, hint) {
  return h("label", { class: "field" }, h("span", {}, label), input, hint ? h("small", {}, hint) : null);
}

function generalTab(cfg, panel) {
  const root = h("input", { value: cfg.workspaceRoot });
  const approval = h("input", { type: "number", min: 1, value: Math.round(cfg.approvalTimeoutMs / 60000) });
  const ttl = h("input", { type: "number", min: 0, value: Math.round(cfg.sessionTtlMs / 3600000) });
  panel.append(
    h(
      "div",
      { class: "section" },
      h("h4", {}, "通用"),
      field("工作目录（workspace）", root, "所有会话的默认目录，/cd 只能在它之内"),
      field("授权等待超时（分钟）", approval, "超时按拒绝处理"),
      field("会话闲置多久自动开新会话（小时）", ttl, "0 表示永不过期"),
      h(
        "div",
        { class: "row" },
        h(
          "button",
          {
            class: "btn primary",
            onclick: () =>
              saveConfig(cfg, {
                workspaceRoot: root.value,
                approvalTimeoutMs: Number(approval.value) * 60000,
                sessionTtlMs: Number(ttl.value) * 3600000,
              }),
          },
          "保存",
        ),
      ),
    ),
  );
}

function agentsTab(cfg, panel) {
  const a = structuredClone(cfg.agents);
  const claudeOn = h("input", { type: "checkbox", checked: a.claude.enabled });
  const claudeModel = h("input", { value: a.claude.defaultModel, placeholder: "留空跟随 Claude Code 默认" });
  const claudeEffort = h("input", { value: a.claude.defaultEffort, placeholder: "low / medium / high / xhigh / max，留空默认" });
  const codexOn = h("input", { type: "checkbox", checked: a.codex.enabled });
  const codexPath = h("input", { value: a.codex.path });
  const codexHome = h("input", { value: a.codex.home, placeholder: "留空用 ~/.codex" });
  const sandbox = h(
    "select",
    {},
    ["read-only", "workspace-write", "danger-full-access"].map((m) => h("option", { value: m, selected: m === a.codex.sandbox }, m)),
  );
  const codexModel = h("input", { value: a.codex.defaultModel, placeholder: "留空跟随 config.toml" });
  const codexEffort = h("input", { value: a.codex.defaultEffort, placeholder: "留空跟随 config.toml" });
  panel.append(
    h(
      "div",
      { class: "section" },
      h("h4", {}, "Claude Code", h("span", { class: "grow" }), h("label", { class: "check" }, claudeOn, "启用")),
      field("默认模型", claudeModel),
      field("默认思考程度", claudeEffort),
    ),
    h(
      "div",
      { class: "section" },
      h("h4", {}, "Codex", h("span", { class: "grow" }), h("label", { class: "check" }, codexOn, "启用")),
      field("codex 可执行文件", codexPath, "以系统服务运行时 PATH 很短，建议写绝对路径"),
      field("CODEX_HOME", codexHome),
      field("沙箱", sandbox, "workspace-write：目录内可读写，越界才弹授权。danger-full-access 等于关掉沙箱"),
      field("默认模型", codexModel),
      field("默认思考程度", codexEffort),
    ),
    h(
      "div",
      { class: "row" },
      h(
        "button",
        {
          class: "btn primary",
          onclick: () =>
            saveConfig(cfg, {
              agents: {
                claude: { enabled: claudeOn.checked, defaultModel: claudeModel.value.trim(), defaultEffort: claudeEffort.value.trim() },
                codex: {
                  enabled: codexOn.checked,
                  path: codexPath.value.trim() || "codex",
                  home: codexHome.value.trim(),
                  sandbox: sandbox.value,
                  defaultModel: codexModel.value.trim(),
                  defaultEffort: codexEffort.value.trim(),
                },
              },
            }),
        },
        "保存",
      ),
    ),
  );
}

function feishuTab(cfg, panel) {
  const bots = structuredClone(cfg.feishu.bots);
  const statusBox = new Map();
  const render = () => {
    fill(panel, 
      h(
        "div",
        { class: "row" },
        h("button", { class: "btn accent", onclick: () => registerBot() }, "扫码创建新机器人"),
        h(
          "button",
          {
            class: "btn",
            onclick: () => {
              bots.push({ id: "", name: "新机器人", enabled: true, appId: "", appSecret: "", domain: "feishu", allowFrom: [], agents: ["claude"], defaultAgent: "claude", _new: true });
              render();
            },
          },
          "手动添加",
        ),
      ),
      ...bots.map((b, i) => botSection(b, i)),
      bots.length === 0 ? h("div", { class: "muted" }, "还没有飞书机器人。") : null,
    );
  };
  const botSection = (b, i) => {
    const name = h("input", { value: b.name });
    const appId = h("input", { value: b.appId, placeholder: "cli_xxx" });
    const secret = h("input", { value: b.appSecret, placeholder: "App Secret", type: "password", autocomplete: "off" });
    const domain = h("select", {}, h("option", { value: "feishu", selected: b.domain !== "lark" }, "飞书"), h("option", { value: "lark", selected: b.domain === "lark" }, "Lark"));
    const allow = h("textarea", { rows: 2, placeholder: "ou_xxx，一行一个" });
    allow.value = b.allowFrom.join("\n");
    const enabled = h("input", { type: "checkbox", checked: b.enabled });
    const agentChecks = S.agents.map((a) => {
      const box = h("input", { type: "checkbox", checked: b.agents.includes(a.id), value: a.id });
      return { id: a.id, box, el: h("label", { class: "check" }, box, a.label) };
    });
    const def = h("select", {}, S.agents.map((a) => h("option", { value: a.id, selected: a.id === b.defaultAgent }, a.label)));
    const status = h("span", { class: "status-tag" }, "…");
    statusBox.set(b.id, status);
    const collect = () => ({
      ...b,
      name: name.value.trim(),
      appId: appId.value.trim(),
      appSecret: secret.value.trim(),
      domain: domain.value,
      allowFrom: allow.value.split(/[\s,]+/).filter(Boolean),
      enabled: enabled.checked,
      agents: agentChecks.filter((c) => c.box.checked).map((c) => c.id),
      defaultAgent: def.value,
    });
    return h(
      "div",
      { class: "section" },
      h("h4", {}, b.name || "机器人", b._new ? null : status, h("span", { class: "grow" }), h("label", { class: "check" }, enabled, "启用")),
      field("名称", name),
      h("div", { class: "row" }, h("div", { style: { flex: 1 } }, field("App ID", appId)), h("div", { style: { flex: 1 } }, field("App Secret", secret))),
      field("域名", domain),
      field("可用的 Agent", h("div", { class: "row" }, agentChecks.map((c) => c.el)), "勾一个 = 一个机器人对应一个 agent；勾多个可在会话里用 /agent 切换"),
      field("默认 Agent", def),
      field("Owner 白名单（open_id）", allow, "陌生人发消息会拿到配对码，在「授权」里批准即可，不必手填"),
      h(
        "div",
        { class: "row" },
        h(
          "button",
          {
            class: "btn primary",
            onclick: async () => {
              bots[i] = collect();
              delete bots[i]._new;
              await saveConfig(cfg, { feishu: { bots } });
              feishuTab(cfg, (fill(panel, ), panel));
            },
          },
          "保存",
        ),
        h(
          "button",
          {
            class: "btn",
            onclick: async () => {
              const v = collect();
              try {
                const r = await api("/api/feishu/test", { method: "POST", body: { id: b.id, appId: v.appId, appSecret: v.appSecret, domain: v.domain } });
                toast(r.ok ? "✅ 凭据有效" : `❌ ${r.message}`);
              } catch (err) {
                toast(err.message);
              }
            },
          },
          "测试凭据",
        ),
        h(
          "button",
          {
            class: "btn danger",
            onclick: async () => {
              if (!confirm(`删除机器人「${b.name}」？`)) return;
              bots.splice(i, 1);
              if (!b._new) await saveConfig(cfg, { feishu: { bots } });
              render();
            },
          },
          "删除",
        ),
      ),
    );
  };
  const registerBot = async () => {
    const nameInput = h("input", { value: "Agent 助手" });
    const checks = S.agents.filter((a) => a.enabled).map((a) => ({ id: a.id, box: h("input", { type: "checkbox", checked: true }), label: a.label }));
    const body = h(
      "div",
      { class: "modal-body" },
      h("div", { class: "muted" }, "用飞书扫码，会自动创建一个飞书应用（机器人），并把扫码的你设为 owner。"),
      field("机器人名称", nameInput),
      field("可用的 Agent", h("div", { class: "row" }, checks.map((c) => h("label", { class: "check" }, c.box, c.label)))),
    );
    const go = h("button", { class: "btn primary" }, "生成二维码");
    const closeReg = modal({ title: "扫码创建飞书机器人", body, foot: h("div", { class: "modal-foot" }, go) });
    go.onclick = async () => {
      go.disabled = true;
      try {
        const reg = await api("/api/feishu/register", {
          method: "POST",
          body: { name: nameInput.value, agents: checks.filter((c) => c.box.checked).map((c) => c.id) },
        });
        const state = h("div", { class: "muted", style: { textAlign: "center" } }, "等待扫码确认…");
        fill(body, 
          h("div", { class: "qr", html: reg.qrSvg }),
          h("div", { class: "row", style: { justifyContent: "center" } }, h("a", { href: reg.qrUrl, target: "_blank", rel: "noopener" }, "手机上直接打开链接")),
          state,
        );
        go.remove();
        const poll = async () => {
          if (!body.isConnected) return;
          try {
            const r = await api(`/api/feishu/register/${reg.id}`);
            if (r.status === "pending") return setTimeout(poll, 3000);
            if (r.status === "success") {
              toast("✅ 机器人已创建并启动");
              closeReg();
              const fresh = await api("/api/config");
              Object.assign(cfg, fresh);
              await saveConfig(cfg, {});
              feishuTab(cfg, (fill(panel, ), panel));
              return;
            }
            state.textContent = { access_denied: "已拒绝授权", expired: "二维码已过期", timeout: "超时了" }[r.status] ?? `出错：${r.message ?? r.status}`;
          } catch (err) {
            state.textContent = err.message;
          }
        };
        setTimeout(poll, 3000);
      } catch (err) {
        toast(err.message);
        go.disabled = false;
      }
    };
  };
  render();
  api("/api/feishu/status")
    .then((list) => {
      for (const s of list) {
        const el = statusBox.get(s.id);
        if (!el) continue;
        const label = { connected: "已连接", connecting: "连接中", reconnecting: "重连中", failed: "连接失败", stopped: "已停止" }[s.state] ?? s.state;
        el.textContent = label;
        el.className = `status-tag ${s.state === "connected" ? "ok" : s.state === "failed" ? "bad" : ""}`;
        if (s.error) el.title = s.error;
      }
    })
    .catch(() => {});
}

async function authTab(panel) {
  const [pairs, allowlist] = await Promise.all([api("/api/pairing"), api("/api/claude/allowlist")]);
  const botName = (id) => S.bots.find((b) => b.id === id)?.name ?? id;
  const allowText = h("textarea", { rows: 8 });
  allowText.value = allowlist.join("\n");
  panel.append(
    h(
      "div",
      { class: "section" },
      h("h4", {}, "待批准的配对"),
      pairs.pending.length === 0
        ? h("div", { class: "muted" }, "没有待批准的请求。陌生人给机器人发消息时会出现在这里。")
        : pairs.pending.map(({ channelId, request }) =>
            h(
              "div",
              { class: "list-item" },
              h("div", { class: "grow" }, h("div", { class: "t" }, `${request.code} · ${botName(channelId)}`), h("div", { class: "s" }, `${request.userId} · ${relTime(request.createdAt)}`)),
              h(
                "button",
                {
                  class: "btn small accent",
                  onclick: async () => {
                    try {
                      await api("/api/pairing/approve", { method: "POST", body: { code: request.code } });
                      toast("已批准");
                      fill(panel, );
                      void authTab(panel);
                    } catch (err) {
                      toast(err.message);
                    }
                  },
                },
                "批准",
              ),
            ),
          ),
    ),
    h(
      "div",
      { class: "section" },
      h("h4", {}, "已配对的用户"),
      pairs.approved.length === 0
        ? h("div", { class: "muted" }, "无")
        : pairs.approved.map(({ channelId, userId }) =>
            h(
              "div",
              { class: "list-item" },
              h("div", { class: "grow" }, h("div", { class: "t" }, userId), h("div", { class: "s" }, botName(channelId))),
              h(
                "button",
                {
                  class: "btn small danger",
                  onclick: async () => {
                    await api("/api/pairing/revoke", { method: "POST", body: { channelId, userId } });
                    fill(panel, );
                    void authTab(panel);
                  },
                },
                "撤销",
              ),
            ),
          ),
    ),
    h(
      "div",
      { class: "section" },
      h("h4", {}, "Claude「总是允许」名单"),
      h("div", { class: "muted" }, "点过「总是允许」的会记在这里。Bash:git 表示 git 开头的命令都放行；Edit:/路径 表示该目录下的修改都放行。一行一条，删掉即撤销。"),
      allowText,
      h(
        "div",
        { class: "row" },
        h(
          "button",
          {
            class: "btn primary",
            onclick: async () => {
              await api("/api/claude/allowlist", { method: "PUT", body: { list: allowText.value.split("\n") } });
              toast("已保存");
            },
          },
          "保存",
        ),
      ),
    ),
  );
}

async function securityTab(panel) {
  const old = h("input", { type: "password", autocomplete: "current-password" });
  const pw = h("input", { type: "password", autocomplete: "new-password" });
  const sessions = await api("/api/web-sessions");
  panel.append(
    h(
      "div",
      { class: "section" },
      h("h4", {}, "修改登录密码"),
      field("原密码", old),
      field("新密码（至少 8 位）", pw),
      h(
        "div",
        { class: "row" },
        h(
          "button",
          {
            class: "btn primary",
            onclick: async () => {
              try {
                await api("/api/password", { method: "POST", body: { old: old.value, password: pw.value } });
                toast("密码已修改，其它设备已下线");
                old.value = pw.value = "";
              } catch (err) {
                toast(err.message);
              }
            },
          },
          "修改",
        ),
      ),
    ),
    h(
      "div",
      { class: "section" },
      h("h4", {}, "已登录的设备"),
      sessions.map((s) =>
        h(
          "div",
          { class: "list-item" },
          h("div", { class: "grow" }, h("div", { class: "t" }, s.userAgent.slice(0, 80) || "未知设备"), h("div", { class: "s" }, `${s.ip} · 最近活动 ${relTime(s.lastSeen)}`)),
          h(
            "button",
            {
              class: "btn small danger",
              onclick: async () => {
                await api("/api/web-sessions/revoke", { method: "POST", body: { id: s.id } });
                fill(panel, );
                void securityTab(panel);
              },
            },
            "下线",
          ),
        ),
      ),
    ),
    h(
      "div",
      { class: "row" },
      h(
        "button",
        {
          class: "btn danger",
          onclick: async () => {
            await api("/api/logout", { method: "POST" });
            location.reload();
          },
        },
        "退出登录",
      ),
    ),
  );
}

async function systemTab(panel) {
  const sys = await api("/api/system");
  panel.append(
    h(
      "div",
      { class: "section" },
      h("h4", {}, "系统"),
      h("div", {}, `版本 ${sys.version} · Node ${sys.node} · 已运行 ${Math.round(sys.uptimeMs / 60000)} 分钟`),
      h("div", { class: "muted" }, sys.underSystemd ? "以系统服务运行" : "前台运行（重启需要在终端里操作）"),
      h(
        "div",
        { class: "row" },
        h(
          "button",
          {
            class: "btn",
            disabled: !sys.underSystemd,
            onclick: async () => {
              if (!confirm("重启 agent-im？进行中的对话会被中断。")) return;
              try {
                await api("/api/system/restart", { method: "POST" });
                toast("正在重启…");
                setTimeout(() => location.reload(), 5000);
              } catch (err) {
                toast(err.message);
              }
            },
          },
          "重启服务",
        ),
        "Notification" in window && Notification.permission !== "granted"
          ? h("button", { class: "btn", onclick: () => Notification.requestPermission() }, "开启浏览器通知")
          : null,
      ),
    ),
  );
}

// ---------- 启动 ----------

boot()
  .then(() => {
    ui.messages?.addEventListener("scroll", () => (ui.stick = nearBottom()), { passive: true });
  })
  .catch((err) => {
    fill($app, h("div", { class: "auth" }, h("div", { class: "auth-card" }, h("p", {}, `加载失败：${err.message}`))));
  });
