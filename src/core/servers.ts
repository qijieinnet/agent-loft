// 多服务器：网页左上角切换到别的 agent-loft。
//
// 别的服务器的页面原样嵌在这台页面的 iframe 里，各自登录、各自直连自己的服务端，这台不中转。
// 几台要在同一个主域名下（a.example.com、b.example.com）：同站的 iframe 才带得上登录 cookie，
// iPhone 的 Safari 跨站一律不带。
//
// 两头各有一份配置（config.json 的 servers）：
//   - list：这台左上角能切到哪几台（这台是「外壳」）；
//   - embedders：允许哪些地址把这台的页面嵌进去（这台被别人嵌）。页面的 frame-ancestors 就按它出，
//     不在里面的一律嵌不进来。
import crypto from "node:crypto";
import os from "node:os";
import type { AppConfig } from "./config.js";
import { canUseResource, type User } from "./users.js";

export type ServerEntry = AppConfig["servers"]["list"][number];

/** 切换列表里最多几台：每台都是一整个常驻的页面 */
export const MAX_SERVERS = 12;
const MAX_EMBEDDERS = 20;
const MAX_NAME = 40;
/** 图标是 emoji：一个字形可能由好几个码位拼成（肤色、ZWJ 组合），按码位数放宽一点 */
const MAX_ICON = 16;

/** 外壳自己在列表里的 id（别的服务器的 id 是随机生成的，不会撞上） */
export const SELF_ID = "home";

/** 页面切换和通知链接共用的 id；home 只代表外壳自己。 */
export function validServerId(id: unknown): id is string {
  return typeof id === "string" && id !== SELF_ID && /^[\w-]{1,40}$/.test(id);
}

/**
 * 地址规范成 origin（https://a.example.com、http://localhost:8800）。
 * 只认 http / https，不带路径、查询、账号密码：agent-loft 只能挂在根路径上。
 */
export function normalizeOrigin(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("地址不能为空");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error(`地址不对：${text}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`只支持 http / https 地址：${text}`);
  if (url.username || url.password) throw new Error(`地址里不能带账号密码：${text}`);
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error(`只填到域名（和端口）就行，agent-loft 不支持挂在子路径下：${text}`);
  }
  return url.origin;
}

const clip = (v: unknown, max: number) => [...String(v ?? "").trim()].slice(0, max).join("");

function newId(taken: Set<string>): string {
  for (;;) {
    const id = crypto.randomBytes(4).toString("hex");
    if (!taken.has(id) && id !== SELF_ID) return id;
  }
}

/**
 * 设置页传来的 servers（只改了其中几项也行），校验后和现有的合并。
 * selfOrigin：这台页面自己的地址，不能把自己加进列表。出错抛 Error（说明给用户看）
 */
export function cleanServers(input: unknown, current: AppConfig["servers"], selfOrigin?: string): AppConfig["servers"] {
  const patch = (input ?? {}) as Partial<Record<keyof AppConfig["servers"], unknown>>;
  const next = structuredClone(current);
  if (patch.selfName !== undefined) next.selfName = clip(patch.selfName, MAX_NAME);
  if (patch.selfIcon !== undefined) next.selfIcon = clip(patch.selfIcon, MAX_ICON);

  if (patch.list !== undefined) {
    if (!Array.isArray(patch.list)) throw new Error("服务器列表格式不对");
    if (patch.list.length > MAX_SERVERS) throw new Error(`最多加 ${MAX_SERVERS} 台服务器`);
    const known = new Set(current.list.map((s) => s.id));
    const taken = new Set<string>();
    const origins = new Set<string>();
    const list: ServerEntry[] = [];
    for (const raw of patch.list as Partial<ServerEntry>[]) {
      const url = normalizeOrigin(raw?.url);
      if (selfOrigin && url === selfOrigin) throw new Error(`${url} 就是这台自己，不用加`);
      if (origins.has(url)) throw new Error(`${url} 加了两次`);
      origins.add(url);
      // 老的 id 留着（页面记着上次切到哪台、推送里带的也是它）；新加的现生成
      const id = typeof raw?.id === "string" && known.has(raw.id) && !taken.has(raw.id) ? raw.id : newId(new Set([...known, ...taken]));
      taken.add(id);
      const name = clip(raw?.name, MAX_NAME) || new URL(url).hostname.split(".")[0] || url;
      list.push({ id, name, icon: clip(raw?.icon, MAX_ICON), url });
    }
    next.list = list;
  }

  if (patch.embedders !== undefined) {
    if (!Array.isArray(patch.embedders)) throw new Error("允许嵌入的地址格式不对");
    const set = new Set<string>();
    for (const raw of patch.embedders) set.add(normalizeOrigin(raw));
    if (set.size > MAX_EMBEDDERS) throw new Error(`允许嵌入的地址最多 ${MAX_EMBEDDERS} 个`);
    next.embedders = [...set];
  }
  return next;
}

/** 切换列表里这台的名字：没设就用主机名 */
export function selfName(cfg: AppConfig["servers"]): string {
  return cfg.selfName || os.hostname().split(".")[0] || "这台";
}

/** 页面要的：左上角的切换列表。没加别的服务器就是 null（不显示切换） */
export function shellInfo(cfg: AppConfig["servers"], user?: User) {
  const list = cfg.list.filter((s) => !user || canUseResource(user, "servers", s.id));
  if (list.length === 0) return null;
  return {
    self: { id: SELF_ID, name: selfName(cfg), icon: cfg.selfIcon },
    list: list.map(({ id, name, icon, url }) => ({ id, name, icon, url })),
  };
}

/**
 * 页面（HTML 等静态文件）的 CSP：
 *   - frame-src：外壳要能嵌列表里的服务器；
 *   - frame-ancestors：只让 embedders 里的地址嵌这台，没有就谁都不行。
 */
export function pageCsp(cfg: AppConfig["servers"]): string {
  const frames = ["'self'", ...cfg.list.map((s) => s.url)].join(" ");
  const ancestors = cfg.embedders.length ? cfg.embedders.join(" ") : "'none'";
  return `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; frame-src ${frames}; frame-ancestors ${ancestors}; base-uri 'self'; form-action 'self'`;
}

/**
 * 这台自己嵌的东西（PDF 预览、回复里的图表）的 frame-ancestors。frame-ancestors 要求每一层祖先
 * 都对得上：这台被外壳嵌着时，只写 'self' 的话外壳那层通不过，预览就是一片空白
 */
export function ownFrameAncestors(cfg: AppConfig["servers"]): string {
  return ["'self'", ...cfg.embedders].join(" ");
}
