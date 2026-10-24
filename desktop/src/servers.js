// 每台服务器的运行时：独立的 session 分区、常驻的页面视图、在线状态、额度、待处理。
//
// 页面就是服务器自己的 Web 界面，原样加载。每台服务器一个 persist 分区，cookie、
// localStorage、Service Worker 互不相干，同时登录多台不会串。切到别的服务器时视图只是
// 从窗口上摘下来，不销毁：WebSocket 一直连着，通知照样能收到。
//
// 服务器前面可能挡着 Cloudflare Access 之类的登录网关（邮箱验证码、Google / GitHub 登录）：
//   - 登录流程就在服务器视图里走完，网关写的 cookie 落在这台服务器自己的分区里；
//   - 探测时发现被网关拦下（跳去了登录页）记成 "access" 状态，验证过期时提醒并把页面
//     带到登录页；
//   - 也可以配 Cloudflare 的 Service Token，请求自动带上，完全不用人去验证。
import { net, session, shell, WebContentsView } from "electron";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { store } from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE_PRELOAD = path.join(here, "preload-page.cjs");

/** 页面里允许的权限：通知、剪贴板、麦克风（语音输入）、全屏。其余一律拒绝。 */
const ALLOWED_PERMISSIONS = new Set(["notifications", "clipboard-sanitized-write", "clipboard-read", "media", "fullscreen"]);

/** Cloudflare Access 的登录页都在 <团队名>.cloudflareaccess.com 上 */
const CF_LOGIN_HOST = /(^|\.)cloudflareaccess\.com$/i;

/**
 * @typedef {{
 *   status: "unknown" | "online" | "login" | "setup" | "offline" | "access",
 *   error?: string,
 *   access?: { kind: "cloudflare" | "gateway", url: string },
 *   loadFailed?: { code: number, message: string },
 *   cert?: { fingerprint: string, subject: string, issuer: string, error: string },
 *   quotas?: any[], quotaAt?: number, quotaFullAt?: number, quotaError?: string,
 *   server?: { at: number, unsupported?: boolean, version?: string, latest?: string | null, updateAvailable?: boolean,
 *              canUpgrade?: boolean, reason?: string, service?: string | null },
 *   upgrading?: boolean,
 *   pending: { id: string, key: string, title: string, conv: string }[],
 *   busy: number,
 *   unread: number,
 *   view?: Electron.WebContentsView,
 *   pageMenu?: PageMenu,
 * }} Runtime
 */

/**
 * 页面报来的「更多」菜单（preload-page.cjs 的 setMenu）：顶栏「更多」里排在最上面，用量排在最下面。
 * checked 有值的是勾选项；点了把 id 发回页面
 * @typedef {{ items: ({ type: "separator" } | { id: string, label: string, checked?: boolean })[], usage: string[] }} PageMenu
 */

/**
 * 状态有变化就 emit("change")，主进程据此重画侧栏、菜单栏和 Dock 角标；
 * 原本在线、突然要重新过网关验证时 emit("access-expired", id)，主进程弹通知。
 */
export const servers = new EventEmitter();

/** @type {Map<string, Runtime>} */
const runtimes = new Map();
/** webContents.id → 服务器 id：页面通过 preload 发来的消息靠它认是哪台 */
const viewOwner = new Map();
const configuredSessions = new WeakSet();

let changeQueued = false;
function changed() {
  if (changeQueued) return;
  changeQueued = true;
  queueMicrotask(() => {
    changeQueued = false;
    servers.emit("change");
  });
}

/** @returns {Runtime} */
export function rt(id) {
  let r = runtimes.get(id);
  if (!r) {
    r = { status: "unknown", pending: [], busy: 0, unread: 0 };
    runtimes.set(id, r);
  }
  return r;
}

function patch(id, values) {
  Object.assign(rt(id), values);
  changed();
}

export function ownerOf(webContents) {
  return viewOwner.get(webContents.id);
}

/**
 * 页面经 preload 发来的消息是哪台服务器的。视图在走网关登录流程时会停在第三方页面上
 * （CF 登录页、Google……），那些页面也能摸到 preload 暴露的函数，所以只认服务器自己的
 * 源、主框架发来的。
 * @param {Electron.IpcMainEvent} e
 */
export function pageOwner(e) {
  const id = viewOwner.get(e.sender.id);
  const server = id && store.server(id);
  if (!server || e.senderFrame !== e.sender.mainFrame) return undefined;
  try {
    return new URL(e.senderFrame.url).origin === server.url ? id : undefined;
  } catch {
    return undefined;
  }
}

/** 这个主机是不是登录网关：Cloudflare Access，或者用户在这台服务器上加的登录域名 */
function isAuthHost(id, hostname) {
  if (CF_LOGIN_HOST.test(hostname)) return true;
  const host = hostname.toLowerCase();
  return (store.server(id)?.authDomains ?? []).some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * 去掉 UA 里的「Electron/…」和 App 名：Google 等身份源会拒绝在内嵌浏览器里登录，
 * 认的主要就是这个。剩下的和同版本的 Chrome 一样。
 */
function plainUserAgent(ua) {
  // App 名夹在「(KHTML, like Gecko)」和「Chrome/」之间，按位置去掉，不管它叫什么
  return ua.replace(/\s+Electron\/\S+/, "").replace(/\)\s+[^\s()]+\/\S+\s+(?=Chrome\/)/, ") ");
}

function sameHost(origin, hostname) {
  try {
    return new URL(origin).hostname === hostname;
  } catch {
    return false;
  }
}

/**
 * 每台服务器的 session 分区。信任新证书时会换一代：Chromium 会把「不受信任」的校验结论
 * 缓存在 session 里（重新装校验函数、断开连接都清不掉），只能换一个新分区。
 */
function partitionOf(id) {
  const gen = store.server(id)?.partitionGen ?? 0;
  return gen ? `persist:server-${id}-${gen}` : `persist:server-${id}`;
}

/**
 * 自签证书：用户确认过指纹的就放行；别的交回 Chromium 自己判断（不受信任就失败，
 * 页面加载失败时侧栏会把证书信息给用户看，让他决定要不要信任）。
 */
function installCertVerifier(id, ses) {
  ses.setCertificateVerifyProc((req, callback) => {
    const server = store.server(id);
    if (req.errorCode !== 0 && server && sameHost(server.url, req.hostname)) {
      if (server.certFingerprint && server.certFingerprint === req.certificate.fingerprint) return callback(0);
      rt(id).cert = {
        fingerprint: req.certificate.fingerprint,
        subject: req.certificate.subjectName,
        issuer: req.certificate.issuerName,
        error: req.verificationResult,
      };
      changed();
    }
    callback(-3);
  });
}

function sessionFor(id) {
  const ses = session.fromPartition(partitionOf(id));
  if (configuredSessions.has(ses)) return ses;
  configuredSessions.add(ses);
  ses.setUserAgent(plainUserAgent(ses.getUserAgent()));

  // Cloudflare Access 的 Service Token：只给本服务器的请求（页面、接口、WebSocket）带上，
  // 登录页和外站一概不带
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const server = store.server(id);
    const token = server && store.serviceToken(id);
    if (token) {
      try {
        const url = new URL(details.url);
        const own = new URL(server.url);
        const wsProto = own.protocol === "https:" ? "wss:" : "ws:";
        if (url.host === own.host && (url.protocol === own.protocol || url.protocol === wsProto)) {
          details.requestHeaders["CF-Access-Client-Id"] = token.clientId;
          details.requestHeaders["CF-Access-Client-Secret"] = token.secret;
        }
      } catch {
        // 地址解析不了：原样放过
      }
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  installCertVerifier(id, ses);

  const fromServer = (origin) => {
    const server = store.server(id);
    try {
      return !!server && new URL(origin).origin === server.url;
    } catch {
      return false;
    }
  };
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && fromServer(details.requestingUrl));
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => ALLOWED_PERMISSIONS.has(permission) && fromServer(origin));
  return ses;
}

function openExternal(url) {
  try {
    const { protocol } = new URL(url);
    if (protocol === "http:" || protocol === "https:" || protocol === "mailto:") void shell.openExternal(url);
  } catch {
    // 不是合法地址：不管
  }
}

/** 取（必要时创建）服务器的页面视图。视图常驻，切走也不销毁。 */
export function viewFor(id) {
  const r = rt(id);
  if (r.view && !r.view.webContents.isDestroyed()) return r.view;
  const server = store.server(id);
  if (!server) throw new Error("服务器不存在");

  const view = new WebContentsView({
    webPreferences: {
      session: sessionFor(id),
      preload: PAGE_PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // 不在前台的服务器也要保持 WebSocket 和计时器，否则通知会晚到
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  const wc = view.webContents;
  r.view = view;
  viewOwner.set(wc.id, id);

  // 平时只在本服务器的源里导航，外链交给系统浏览器。
  // 例外是登录网关：跳到网关之后就进入「登录流程」，网关再转去的身份源（Google、GitHub、
  // 公司 SSO……）事先不知道是哪些，所以流程中的 https 导航都放行，回到本服务器就结束。
  const ownOrigin = (url) => {
    try {
      return new URL(url).origin === store.server(id)?.url;
    } catch {
      return false;
    }
  };
  let inAuthFlow = false;
  const allowed = (url) => {
    if (ownOrigin(url)) return true;
    try {
      const u = new URL(url);
      if (u.protocol !== "https:") return false;
      return inAuthFlow || isAuthHost(id, u.hostname);
    } catch {
      return false;
    }
  };
  wc.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, url) => {
    if (allowed(url)) return;
    e.preventDefault();
    openExternal(url);
  });
  // 服务端重定向（网关把人送去登录页、登录页再送回来）不触发 will-navigate，在这里拦
  wc.on("will-redirect", (e, url, _inPlace, isMainFrame) => {
    if (!isMainFrame || allowed(url)) return;
    e.preventDefault();
    openExternal(url);
  });
  wc.on("did-navigate", (_e, url) => {
    if (ownOrigin(url)) {
      // 从网关登录回来了：重新看一下状态
      if (inAuthFlow) {
        inAuthFlow = false;
        void probe(id);
      }
      return;
    }
    try {
      if (isAuthHost(id, new URL(url).hostname) || inAuthFlow) {
        inAuthFlow = true;
        const kind = CF_LOGIN_HOST.test(new URL(url).hostname) ? "cloudflare" : "gateway";
        if (rt(id).status !== "access") patch(id, { status: "access", access: { kind, url } });
      }
    } catch {
      // 不管
    }
  });
  wc.on("did-fail-load", (_e, code, message, _url, isMainFrame) => {
    // -3 是被新的导航打断，不算失败
    if (!isMainFrame || code === -3) return;
    patch(id, { loadFailed: { code, message }, status: "offline", error: message });
  });
  wc.on("did-finish-load", () => {
    if (rt(id).loadFailed) return;
    void probe(id);
  });
  wc.on("render-process-gone", (_e, details) => {
    if (details.reason !== "clean-exit") setTimeout(() => !wc.isDestroyed() && wc.reload(), 1000);
  });
  wc.once("destroyed", () => viewOwner.delete(wc.id));
  // 页面重新加载：旧菜单里的项新页面不认，等它加载完重新报
  wc.on("did-start-loading", () => delete rt(id).pageMenu);

  void wc.loadURL(`${server.url}/`);
  return view;
}

/** 重新加载页面（连接失败后点「重试」、信任证书之后） */
export function reload(id) {
  const r = rt(id);
  const server = store.server(id);
  if (!server) return;
  r.loadFailed = undefined;
  r.cert = undefined;
  changed();
  const view = viewFor(id);
  void view.webContents.loadURL(`${server.url}/`);
}

/** 地址改了 / 删除服务器：页面销毁，下次用到时重建 */
export function dispose(id, { clearData = false } = {}) {
  const r = runtimes.get(id);
  if (r?.view && !r.view.webContents.isDestroyed()) r.view.webContents.close();
  runtimes.delete(id);
  if (clearData) void session.fromPartition(partitionOf(id)).clearData();
  changed();
}

/** 认证设置（登录域名、Service Token）改了：断开旧连接，页面按新设置重新加载 */
export async function applyAuth(id) {
  if (!store.server(id)) return;
  await sessionFor(id).closeAllConnections();
  reload(id);
  void probe(id);
}

/** 把旧分区的 cookie 搬到新分区（证书换了也不用重新登录 agent-loft、重新过网关） */
async function copyCookies(from, to) {
  for (const c of await from.cookies.get({})) {
    const host = c.domain.replace(/^\./, "");
    try {
      await to.cookies.set({
        url: `${c.secure ? "https" : "http"}://${host}${c.path}`,
        name: c.name,
        value: c.value,
        ...(c.hostOnly ? {} : { domain: c.domain }),
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        ...(c.session ? {} : { expirationDate: c.expirationDate }),
      });
    } catch {
      // 个别 cookie 搬不过去：大不了重新登录一次
    }
  }
}

export async function trustCert(id) {
  const cert = rt(id).cert;
  const server = store.server(id);
  if (!cert || !server) return;
  const old = sessionFor(id);
  store.updateServer(id, { certFingerprint: cert.fingerprint, partitionGen: (server.partitionGen ?? 0) + 1 });
  await copyCookies(old, sessionFor(id));
  // 页面换到新分区上重建，旧分区清掉
  const r = rt(id);
  if (r.view && !r.view.webContents.isDestroyed()) r.view.webContents.close();
  r.view = undefined;
  r.loadFailed = undefined;
  r.cert = undefined;
  void old.clearData();
  viewFor(id);
  changed();
}

// ---------- 状态和额度 ----------

/**
 * 请求服务器的接口。用 net.request 而不是 session.fetch：fetch 跟随重定向后拿不到最终
 * 地址（url 是空的），redirect: "manual" 又直接抛错；这里要的正是「被重定向去了哪」。
 * agent-loft 的 /api/* 从不重定向，所以只要发生重定向，就是被前面的网关拦下了。
 * @returns {Promise<{ redirect?: string, status: number, headers: Record<string, string | string[]>, body?: string }>}
 */
function apiRequest(id, apiPath, timeoutMs, { method = "GET", body } = {}) {
  const server = store.server(id);
  if (!server) return Promise.reject(new Error("服务器不存在"));
  return new Promise((resolve, reject) => {
    const req = net.request({
      url: `${server.url}${apiPath}`,
      method,
      session: sessionFor(id),
      useSessionCookies: true,
      redirect: "manual",
      cache: "no-store",
    });
    const timer = setTimeout(() => {
      req.abort();
      reject(new Error("连接超时"));
    }, timeoutMs);
    const done = (fn) => (...args) => {
      clearTimeout(timer);
      fn(...args);
    };
    req.on(
      "redirect",
      done((status, _method, redirectUrl) => {
        req.abort();
        resolve({ redirect: redirectUrl, status, headers: {} });
      }),
    );
    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", done(() => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") })));
      res.on("error", done(reject));
    });
    req.on("error", done(reject));
    if (body !== undefined) {
      req.setHeader("Content-Type", "application/json");
      req.end(JSON.stringify(body));
    } else {
      req.end();
    }
  });
}

/**
 * 请求是不是被登录网关拦下了：Cloudflare Access 没有（或者过期的）CF_Authorization 时，
 * 把请求重定向到 <团队名>.cloudflareaccess.com 的登录页；有的网关直接回 401 / 403，
 * 带着 cf-access-* 之类的头。
 * @returns {{ kind: "cloudflare" | "gateway", url: string } | null}
 */
function gateOf(id, res) {
  const server = store.server(id);
  if (res.redirect) {
    let target;
    try {
      target = new URL(res.redirect, server.url);
    } catch {
      return { kind: "gateway", url: `${server.url}/` };
    }
    const cf = CF_LOGIN_HOST.test(target.hostname) || target.pathname.startsWith("/cdn-cgi/access/");
    return { kind: cf ? "cloudflare" : "gateway", url: target.href };
  }
  if ((res.status === 401 || res.status === 403) && Object.keys(res.headers).some((n) => n.toLowerCase().startsWith("cf-access"))) {
    return { kind: "cloudflare", url: `${server.url}/` };
  }
  return null;
}

async function getJson(id, apiPath, timeoutMs, options) {
  const res = await apiRequest(id, apiPath, timeoutMs, options);
  const gate = gateOf(id, res);
  if (gate) return { gate };
  if (res.status === 401) return { unauthorized: true };
  if (res.status < 200 || res.status >= 300) {
    // agent-loft 的错误是 { error: "…" }，把说明带出来
    let message = `HTTP ${res.status}`;
    try {
      message = JSON.parse(res.body ?? "").error || message;
    } catch {
      // 不是 JSON：用状态码
    }
    throw Object.assign(new Error(message), { status: res.status });
  }
  try {
    return { body: JSON.parse(res.body ?? "") };
  } catch {
    throw new Error("返回的不是 agent-loft 的接口（地址填错了，或者被别的页面拦住了）");
  }
}

/**
 * 给主进程调服务器接口用（读 Agent 环境、首次设置密码）。带着这台服务器分区里的登录态。
 * 被网关拦下、没登录都抛错。
 */
export async function callApi(id, apiPath, { method = "GET", body, timeoutMs = 60_000 } = {}) {
  const result = await getJson(id, apiPath, timeoutMs, { method, body });
  if (result.gate) throw new Error("被登录网关拦下了，先在窗口里完成验证");
  if (result.unauthorized) throw new Error("还没登录这台服务器");
  return result.body;
}

/** 服务端版本和能不能升级。老版本的服务端没有这个接口，记成 unsupported */
export async function refreshServerVersion(id, refresh = false) {
  try {
    const v = await callApi(id, `/api/server/version${refresh ? "?refresh=1" : ""}`, { timeoutMs: 45_000 });
    patch(id, { server: { ...v, at: Date.now() } });
  } catch (err) {
    if (err?.status === 404) patch(id, { server: { unsupported: true, at: Date.now() } });
  }
}

/**
 * 让服务端自己升级（npm install -g agent-loft@latest）。跑在系统服务下的会自动重启：
 * 等它重新上线，再刷新版本信息。
 * @returns {Promise<{ from: string, to: string, restarting: boolean }>}
 */
export async function upgradeServer(id) {
  if (rt(id).upgrading) throw new Error("正在升级");
  patch(id, { upgrading: true });
  try {
    const result = await callApi(id, "/api/server/upgrade", { method: "POST", timeoutMs: 11 * 60_000 });
    if (result.restarting) {
      // 进程退出、被 launchd / systemd 拉起来，一般几秒到十几秒
      await new Promise((r) => setTimeout(r, 3000));
      for (let i = 0; i < 40; i++) {
        await probe(id);
        if (rt(id).status === "online") break;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    await refreshServerVersion(id, true);
    return result;
  } finally {
    patch(id, { upgrading: false });
  }
}

/** 被网关拦下：记状态。原本在线的，说明验证过期了，提醒一下，并把页面带到登录页。 */
function gated(id, gate) {
  const r = rt(id);
  const wasOnline = r.status === "online";
  patch(id, { status: "access", access: gate, error: undefined });
  if (!wasOnline) return;
  servers.emit("access-expired", id);
  // 页面还停在服务器上（多半挂着「正在重连」）：重新加载，网关会把它送去登录页
  const wc = r.view?.webContents;
  const server = store.server(id);
  if (wc && !wc.isDestroyed() && server && wc.getURL().startsWith(server.url)) void wc.loadURL(`${server.url}/`);
}

/** 看看服务器在不在、登没登录。只用公开的 /api/me。 */
export async function probe(id) {
  if (!store.server(id)) return;
  try {
    const { body, gate } = await getJson(id, "/api/me", 8000);
    if (gate) return gated(id, gate);
    const status = body?.authed ? "online" : body?.needsSetup ? "setup" : "login";
    const wasOnline = rt(id).status === "online";
    patch(id, { status, error: undefined, access: undefined });
    if (status === "online" && (!wasOnline || !rt(id).quotaAt)) void refreshQuota([id]);
    // 服务端版本：上线时、以及每 6 小时看一次有没有新版
    const info = rt(id).server;
    if (status === "online" && !rt(id).upgrading && (!info || Date.now() - info.at > 6 * 3600_000)) void refreshServerVersion(id);
  } catch (err) {
    patch(id, { status: "offline", error: err instanceof Error ? err.message : String(err) });
  }
}

// ---------- 额度 ----------
//
// 额度由桌面端统一去查，查到后推给各服务器的页面（新版页面在桌面端里不再自己查）。
// 服务端每条额度带着账号标识 account（同一个账号在哪台服务器上都一样）：
//   - 一轮刷新里，同一个 agent + account 只在一台服务器上问，结果分给登着同一个账号的其他几台；
//   - 第一次、以及每隔 FULL_EVERY 对每台做一次全量查询，好发现新启用的 agent、换了的账号；
//   - 没有 account 的（老版本服务端、API key 登录）照旧逐台去问。

/** 服务端对额度缓存 60 秒，这之内再问拿到的还是旧数 */
const SERVER_CACHE = 60_000;
const FULL_EVERY = 30 * 60_000;
const quotaLoading = new Set();
const quotaTimers = new Map();

const accountOf = (q) => (q?.agent && q?.account ? `${q.agent}:${q.account}` : null);

/** 把这台的额度推给它的页面：页面侧栏显示的就是这份 */
function pushQuota(id) {
  const r = rt(id);
  const wc = r.view?.webContents;
  const server = store.server(id);
  if (!wc || wc.isDestroyed() || !server || !wc.getURL().startsWith(server.url)) return;
  wc.send("page:quota-update", { quotas: r.quotas ?? [], at: r.quotaAt ?? 0, error: r.quotaError ?? null });
}

function patchQuota(id, values) {
  patch(id, values);
  pushQuota(id);
}

/** 只换掉 agents 里这几个的额度，其余照旧；顺序不变，新出现的接在后面 */
function mergeAgents(old, fresh, agents) {
  const byAgent = new Map(fresh.map((q) => [q.agent, q]));
  const out = [];
  for (const q of old) {
    if (!agents.includes(q.agent)) out.push(q);
    else if (byAgent.has(q.agent)) {
      out.push(byAgent.get(q.agent));
      byAgent.delete(q.agent);
    }
  }
  return [...out, ...byAgent.values()];
}

/** 刚从 from 查到的额度，分给登着同一个账号的其他服务器 */
function shareQuota(from, fresh, at) {
  const byAccount = new Map(fresh.map((q) => [accountOf(q), q]).filter(([k]) => k));
  if (byAccount.size === 0) return;
  for (const server of store.servers()) {
    if (server.id === from) continue;
    const r = rt(server.id);
    if (!r.quotas?.length) continue;
    let hits = 0;
    const quotas = r.quotas.map((q) => {
      const same = byAccount.get(accountOf(q));
      if (!same) return q;
      hits++;
      return same;
    });
    if (!hits) continue;
    // 全部都换成了新的，才算这台「刚更新过」
    patchQuota(server.id, { quotas, ...(hits === quotas.length ? { quotaAt: Math.max(r.quotaAt ?? 0, at), quotaError: undefined } : {}) });
  }
}

/** 查一台的额度。agents 给了就只问这几个 agent，不给就全问。 */
async function fetchQuota(id, agents) {
  if (quotaLoading.has(id) || !store.server(id)) return;
  quotaLoading.add(id);
  try {
    const query = agents ? `?agent=${agents.map(encodeURIComponent).join(",")}` : "";
    const result = await getJson(id, `/api/quota${query}`, 30_000);
    if (result.gate) return gated(id, result.gate);
    if (result.unauthorized) return patch(id, { status: "login" });
    const fresh = Array.isArray(result.body?.quotas) ? result.body.quotas.slice(0, 20) : [];
    const now = Date.now();
    // 老版本服务端不认 ?agent，会把全部都返回来：当成全量
    // 服务端设置里关了查额度（disabled）：也当成全量，旧的额度清掉
    const full = !agents || !!result.body?.disabled || fresh.some((q) => !agents.includes(q.agent));
    const quotas = full ? fresh : mergeAgents(rt(id).quotas ?? [], fresh, agents);
    patchQuota(id, { quotas, quotaAt: now, quotaError: undefined, ...(full ? { quotaFullAt: now } : {}) });
    shareQuota(id, fresh, now);
  } catch (err) {
    patchQuota(id, { quotaError: err instanceof Error ? err.message : String(err) });
  } finally {
    quotaLoading.delete(id);
  }
}

/**
 * 刷新额度。ids 不给就是所有在线的服务器；full 表示这几台都全量问一遍（页面上点了刷新、
 * 刚跑完一轮的那台：就是要它自己的最新数）。
 */
export async function refreshQuota(ids, { full = false } = {}) {
  const targets = (ids ?? store.servers().filter((s) => rt(s.id).status === "online").map((s) => s.id)).filter((id) => store.server(id));
  const now = Date.now();
  const needFull = (id) => full || !rt(id).quotas || now - (rt(id).quotaFullAt ?? 0) > FULL_EVERY;
  /** @type {[string, string[] | undefined][]} */
  const plan = [];
  const covered = new Set();
  for (const id of targets.filter(needFull)) {
    plan.push([id, undefined]);
    for (const q of rt(id).quotas ?? []) if (accountOf(q)) covered.add(accountOf(q));
  }
  // 上次出过错的排后面：同一个账号尽量挑能查到的那台
  const rest = targets.filter((id) => !needFull(id)).sort((a, b) => Number(!!rt(a).quotaError) - Number(!!rt(b).quotaError));
  for (const id of rest) {
    const agents = [];
    for (const q of rt(id).quotas) {
      const key = accountOf(q);
      if (key && covered.has(key)) continue;
      if (key) covered.add(key);
      agents.push(q.agent);
    }
    if (agents.length) plan.push([id, agents]);
  }
  await Promise.all(plan.map(([id, agents]) => fetchQuota(id, agents)));
}

/** 跑完一轮：等服务端那 60 秒缓存过期再全量问这台（至少等 10 秒），连着跑完几轮只问一次 */
function quotaAfterTurn(id) {
  const wait = Math.max(10_000, (rt(id).quotaAt ?? 0) + SERVER_CACHE + 1000 - Date.now());
  clearTimeout(quotaTimers.get(id));
  quotaTimers.set(
    id,
    setTimeout(() => {
      quotaTimers.delete(id);
      void refreshQuota([id], { full: true });
    }, wait),
  );
}

/** 页面要额度（刚加载完）：有就直接推，还没有就去查 */
export function pageWantsQuota(id) {
  if (rt(id).quotaAt) pushQuota(id);
  else void refreshQuota([id], { full: true });
}

export function refreshAll({ quota = false } = {}) {
  for (const server of store.servers()) void probe(server.id);
  if (quota) void refreshQuota();
}

// ---------- 页面上报 ----------

const MAX_PENDING = 50;
const str = (v, max) => String(v ?? "").slice(0, max);

/** 页面报来的待处理和运行数（只信形状对的部分） */
export function setPageState(id, state) {
  const pending = Array.isArray(state?.pending)
    ? state.pending.slice(0, MAX_PENDING).map((p) => ({ id: str(p?.id, 100), key: str(p?.key, 300), title: str(p?.title, 200), conv: str(p?.conv, 100) }))
    : [];
  const busy = Number.isFinite(state?.busy) ? Math.max(0, Math.min(999, state.busy)) : 0;
  const r = rt(id);
  // 有会话从「运行中」变成空闲：跑完一轮了，额度多半变了
  if (busy < r.busy) quotaAfterTurn(id);
  patch(id, { pending, busy, status: "online" });
}

/** 页面报来的「更多」菜单（只信形状对的部分） */
export function setPageMenu(id, menu) {
  const items = Array.isArray(menu?.items)
    ? menu.items
        .slice(0, 20)
        .map((it) =>
          it?.type === "separator"
            ? { type: "separator" }
            : { id: str(it?.id, 40), label: str(it?.label, 80), ...(typeof it?.checked === "boolean" ? { checked: it.checked } : {}) },
        )
        .filter((it) => it.type === "separator" || (it.id && it.label))
    : [];
  const usage = Array.isArray(menu?.usage) ? menu.usage.slice(0, 10).map((l) => str(l, 120)).filter(Boolean) : [];
  rt(id).pageMenu = { items, usage };
}

/** 老版本页面自己查了额度报上来（新版页面在桌面端里不查，等这边推） */
export function setPageQuota(id, quotas) {
  if (!Array.isArray(quotas)) return;
  const now = Date.now();
  const fresh = quotas.slice(0, 20);
  patch(id, { quotas: fresh, quotaAt: now, quotaFullAt: now, quotaError: undefined });
  shareQuota(id, fresh, now);
}

export function addUnread(id) {
  patch(id, { unread: rt(id).unread + 1 });
}

export function clearUnread(id) {
  if (rt(id).unread) patch(id, { unread: 0 });
}

/** 给侧栏和菜单栏面板用的快照（不含视图对象） */
export function publicState(id) {
  const { view: _view, pageMenu: _menu, ...rest } = rt(id);
  return rest;
}
