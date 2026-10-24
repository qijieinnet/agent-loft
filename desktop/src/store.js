// 桌面端自己的配置：连哪些服务器、偏好设置、窗口位置。
// 存在 ~/Library/Application Support/Agent Loft/config.json。登录态不在这里，
// 每台服务器的 cookie 存在各自的 Electron 分区（persist:server-<id>）里。
import { app, safeStorage } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defaultWindow, normalizeWindows } from "./awake.js";

/**
 * @typedef {{
 *   id: string, name: string, url: string, icon?: string, certFingerprint?: string, partitionGen?: number,
 *   authDomains?: string[],
 *   serviceToken?: { clientId: string, secret: string },
 * }} Server
 *   authDomains：前面挡着的登录网关的域名（Cloudflare Access 的 *.cloudflareaccess.com 不用填），
 *     登录流程走到这些域名时留在窗口里，不扔给系统浏览器。
 *   serviceToken：Cloudflare Access 的 Service Token。secret 用 safeStorage 加密
 *     （密钥在 macOS 钥匙串里），base64 存放，配置文件里没有明文。
 * @typedef {{
 *   openAtLogin: boolean, quotaRefreshMin: number,
 *   autoUpdate: boolean, updateCheckHours: number,
 *   keepAwake: boolean,
 *   awakeMode: "system" | "always" | "scheduled",
 *   sleepWindows: import("./awake.js").SleepWindow[],
 *   sleepRequireLocked: boolean,
 *   trayItems: string[],
 *   trayBarMode: "remaining" | "used",
 * }} Prefs
 *   trayItems：macOS 菜单栏图标上显示哪些额度条（按这个顺序），每项是「服务器 id:agent」，
 *     服务器 id 是 * 表示所有服务器合起来取最高；空数组就只显示图标。
 *   trayBarMode：额度条的实心部分是剩余额度（remaining，像电池）还是已用额度（used）。
 *   keepAwake：本机服务端有会话在跑（或在等授权 / 回答）时不让这台 Mac 休眠；只管本机，不管远程服务器。
 *   awakeMode / sleepWindows / sleepRequireLocked：防休眠模式和定时休眠的时段，见 awake.js。
 */

/** @type {Prefs} */
const DEFAULT_PREFS = {
  openAtLogin: false,
  quotaRefreshMin: 10,
  autoUpdate: true,
  updateCheckHours: 24,
  keepAwake: false,
  awakeMode: "system",
  sleepWindows: [defaultWindow()],
  sleepRequireLocked: true,
  trayItems: ["*:claude", "*:codex"],
  trayBarMode: "remaining",
};

let data = {
  /** @type {Server[]} */
  servers: [],
  prefs: { ...DEFAULT_PREFS },
  /** @type {string | null} */
  lastActive: null,
  /** @type {Electron.Rectangle | null} */
  bounds: null,
  /** 首次启动向导走完了没有（老用户已经有服务器的，也当走完了） */
  onboarded: false,
  /** 已经弹过通知的新版本号：同一个版本只提醒一次 */
  /** @type {string | null} */
  notifiedUpdate: null,
  /** 定时休眠：每个时段最近一次睡过的那次的开始时间（毫秒），免得同一个时段睡两次 */
  /** @type {Record<string, number>} */
  sleepHandled: {},
};

const file = () => path.join(app.getPath("userData"), "config.json");

export function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
    data = { ...data, ...raw, prefs: { ...DEFAULT_PREFS, ...raw.prefs } };
  } catch {
    // 第一次打开，或文件坏了：用默认
  }
}

function save() {
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/**
 * 用户随手填的地址规整成 origin：「192.168.1.5:8800」→「http://192.168.1.5:8800」。
 * agent-loft 的页面全用绝对路径（/api、/ws），只能挂在根上，所以路径一律丢掉。
 */
export function normalizeUrl(input) {
  let text = String(input ?? "").trim();
  if (!text) throw new Error("请填写服务器地址");
  if (!/^[a-z]+:\/\//i.test(text)) text = `http://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("地址格式不对，例如 http://192.168.1.5:8800 或 https://loft.example.com");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只支持 http:// 或 https://");
  return url.origin;
}

/** 「a.com, https://b.com/x」→ ["a.com", "b.com"]：只留主机名 */
export function normalizeDomains(input) {
  const list = Array.isArray(input) ? input : String(input ?? "").split(/[\s,，;；]+/);
  const out = [];
  for (const raw of list) {
    // 「*.example.com」当作 example.com 及其子域名
    const text = String(raw).trim().toLowerCase().replace(/^([a-z]+:\/\/)?\*\./, "$1");
    if (!text) continue;
    let host;
    try {
      host = new URL(/^[a-z]+:\/\//.test(text) ? text : `https://${text}`).hostname;
    } catch {
      throw new Error(`登录域名格式不对：${raw}`);
    }
    if (!host.includes(".")) throw new Error(`登录域名格式不对：${raw}`);
    if (!out.includes(host)) out.push(host);
  }
  return out.slice(0, 20);
}

function encryptSecret(secret) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("系统钥匙串不可用，没法安全保存 Secret");
  // Linux 上没有密钥环（GNOME Keyring / KWallet）时 Electron 退回到 basic_text：用写死的密码混淆，不算加密
  if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") {
    throw new Error("没有可用的系统密钥环（GNOME Keyring / KWallet），没法安全保存 Secret");
  }
  return safeStorage.encryptString(secret).toString("base64");
}

/** 服务器图标：一个 emoji（组合 emoji 由好几个码点组成，所以按长度限制而不是按字符数） */
function normalizeIcon(icon) {
  const text = String(icon ?? "").trim();
  if (!text) return undefined;
  if (text.length > 16 || /\s/.test(text)) throw new Error("图标只能是一个 emoji");
  return text;
}

/** 解密后的 Service Token，缓存在内存里（每个请求都要用） */
const tokenCache = new Map();

export const store = {
  /** @returns {Server[]} */
  servers: () => data.servers,
  /** @returns {Server | undefined} */
  server: (id) => data.servers.find((s) => s.id === id),
  prefs: () => data.prefs,
  lastActive: () => data.lastActive,
  bounds: () => data.bounds,

  addServer(name, url, icon) {
    const origin = normalizeUrl(url);
    if (data.servers.some((s) => s.url === origin)) throw new Error("这台服务器已经添加过了");
    const server = { id: crypto.randomBytes(6).toString("hex"), name: String(name ?? "").trim() || new URL(origin).hostname, url: origin };
    const emoji = normalizeIcon(icon);
    if (emoji) server.icon = emoji;
    data.servers.push(server);
    save();
    return server;
  },

  /** 解密后的 Service Token；没配就是 null */
  serviceToken(id) {
    const server = store.server(id);
    if (!server?.serviceToken) return null;
    const cached = tokenCache.get(id);
    if (cached && cached.enc === server.serviceToken.secret) return cached.token;
    try {
      const secret = safeStorage.decryptString(Buffer.from(server.serviceToken.secret, "base64"));
      const token = { clientId: server.serviceToken.clientId, secret };
      tokenCache.set(id, { enc: server.serviceToken.secret, token });
      return token;
    } catch {
      return null;
    }
  },

  /**
   * 改认证相关的设置。
   * serviceToken：null 清掉；{ clientId, secret }，secret 为空表示沿用原来的。
   * @returns {boolean} 有没有实际变化
   */
  updateAuth(id, { authDomains, serviceToken } = {}) {
    const server = store.server(id);
    if (!server) throw new Error("服务器不存在");
    const before = JSON.stringify([server.authDomains ?? [], server.serviceToken ?? null]);
    if (authDomains !== undefined) {
      const list = normalizeDomains(authDomains);
      if (list.length) server.authDomains = list;
      else delete server.authDomains;
    }
    if (serviceToken === null) {
      delete server.serviceToken;
    } else if (serviceToken !== undefined) {
      const clientId = String(serviceToken.clientId ?? "").trim();
      const secret = String(serviceToken.secret ?? "").trim();
      if (!clientId && !secret) {
        delete server.serviceToken;
      } else {
        if (!clientId) throw new Error("请填写 Service Token 的 Client ID");
        if (!secret && !server.serviceToken) throw new Error("请填写 Service Token 的 Client Secret");
        if (clientId.length > 200 || secret.length > 500) throw new Error("Service Token 太长了，检查一下是不是粘错了");
        server.serviceToken = { clientId, secret: secret ? encryptSecret(secret) : server.serviceToken.secret };
      }
    }
    const changedAuth = JSON.stringify([server.authDomains ?? [], server.serviceToken ?? null]) !== before;
    if (changedAuth) {
      tokenCache.delete(id);
      save();
    }
    return changedAuth;
  },

  /** @returns {{ server: Server, urlChanged: boolean }} */
  updateServer(id, patch) {
    const server = store.server(id);
    if (!server) throw new Error("服务器不存在");
    let urlChanged = false;
    if (patch.url !== undefined) {
      const origin = normalizeUrl(patch.url);
      if (origin !== server.url) {
        if (data.servers.some((s) => s.id !== id && s.url === origin)) throw new Error("这台服务器已经添加过了");
        server.url = origin;
        // 换了地址，原来信任的证书就不作数了
        delete server.certFingerprint;
        urlChanged = true;
      }
    }
    if (patch.name !== undefined) server.name = String(patch.name).trim() || new URL(server.url).hostname;
    if (patch.icon !== undefined) {
      const emoji = normalizeIcon(patch.icon);
      if (emoji) server.icon = emoji;
      else delete server.icon;
    }
    if (patch.certFingerprint !== undefined) server.certFingerprint = patch.certFingerprint;
    if (patch.partitionGen !== undefined) server.partitionGen = patch.partitionGen;
    save();
    return { server, urlChanged };
  },

  removeServer(id) {
    tokenCache.delete(id);
    data.servers = data.servers.filter((s) => s.id !== id);
    if (data.lastActive === id) data.lastActive = null;
    // 菜单栏额度里选了这台的项
    data.prefs.trayItems = data.prefs.trayItems.filter((k) => !k.startsWith(`${id}:`));
    save();
  },

  /** 把服务器挪到第 to 个（从 0 数），其余顺延 */
  moveServer(id, to) {
    const from = data.servers.findIndex((s) => s.id === id);
    if (from < 0 || !Number.isInteger(to) || to < 0 || to >= data.servers.length || to === from) return;
    const [server] = data.servers.splice(from, 1);
    data.servers.splice(to, 0, server);
    save();
  },

  setPref(key, value) {
    if (!(key in DEFAULT_PREFS)) throw new Error(`未知设置：${key}`);
    if (typeof value !== typeof DEFAULT_PREFS[key] || Array.isArray(value) !== Array.isArray(DEFAULT_PREFS[key])) {
      throw new Error(`设置 ${key} 的值类型不对`);
    }
    if (key === "trayItems") {
      value = [...new Set(value.filter((a) => typeof a === "string" && /^(\*|[\w-]{1,64}):[a-z0-9_-]{1,32}$/.test(a)))].slice(0, 12);
    }
    if (key === "trayBarMode" && !["remaining", "used"].includes(value)) throw new Error("未知的额度条显示方式");
    if (key === "awakeMode" && !["system", "always", "scheduled"].includes(value)) throw new Error("未知的防休眠模式");
    if (key === "sleepWindows") value = normalizeWindows(value);
    if (key === "quotaRefreshMin") value = Math.max(1, Math.min(1440, Math.round(value)));
    if (key === "updateCheckHours") value = Math.max(1, Math.min(24 * 30, Math.round(value)));
    data.prefs[key] = value;
    save();
  },

  onboarded: () => data.onboarded || data.servers.length > 0,
  setOnboarded() {
    data.onboarded = true;
    save();
  },
  notifiedUpdate: () => data.notifiedUpdate,
  setNotifiedUpdate(version) {
    data.notifiedUpdate = version;
    save();
  },

  sleepHandled: () => data.sleepHandled,
  setSleepHandled(id, due) {
    data.sleepHandled = { ...data.sleepHandled, [id]: due };
    save();
  },

  setLastActive(id) {
    if (data.lastActive === id) return;
    data.lastActive = id;
    save();
  },

  setBounds(bounds) {
    data.bounds = bounds;
    save();
  },
};
