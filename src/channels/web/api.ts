// Web 的 REST 接口。实时的东西（事件流、发消息、点授权）走 WebSocket，见 server.ts。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AGENT_IDS, config, listWorkspaceDirs, resolveWorkspacePath, saveConfig, type AppConfig } from "../../core/config.js";
import { cleanCustomCommands } from "../../core/command-catalog.js";
import { hub } from "../../core/hub.js";
import { interactions } from "../../core/interactions.js";
import { approve, listApproved, listPending, revoke } from "../../core/pairing.js";
import { getConversation, listConversations, updateConversation } from "../../core/store.js";
import { addScheduled, clearScheduled, removeScheduled } from "../../core/scheduled.js";
import { resolveUploadFile, saveBuffer, sniff, uploadKeyOf } from "../../core/uploads.js";
import { mentions, replyFileType, resolveReplyFile } from "../../core/reply-files.js";
import { HTML_CSP, HTML_MAX, htmlDocument } from "../../core/visualize.js";
import { cleanServers, ownFrameAncestors, shellInfo } from "../../core/servers.js";
import {
  createUser,
  getUser,
  isAdmin,
  legacyOwnerId,
  listUsers,
  ownedBy,
  removeUser,
  verifyLogin,
  verifyPassword,
  type Role,
  type User,
} from "../../core/users.js";
import type { AttachmentInfo, SavedAttachment } from "../../core/types.js";
import { dailyUsage } from "../../core/usage.js";
import { appendDirOrder, getDirOrder, setDirOrder } from "../../core/ui-prefs.js";
import {
  addMemoryItem,
  clearMemory,
  MEMORY_LIMITS,
  readMemory,
  removeMemoryItem,
  setMemoryOptions,
  updateMemoryItem,
  type CurateSettings,
} from "../../core/memory.js";
import { createLinkCode, listLinks, unlink, unlinkUser } from "../../core/feishu-links.js";
import { purgeUserData } from "../../core/personal.js";
import { purgeHistory, readMeta, readRecords, searchHistory, writeMeta } from "../../core/chat-history.js";
import { curateNow, pendingCount } from "../../core/memory-curator.js";
import { listAllowlist, setAllowlist } from "../../agents/claude/permissions.js";
import { agentAvailability, agentHealth, invalidateHealth } from "../../agents/health.js";
import { installCodex, upgrade, useInstalledCodex, versionInfo } from "../../core/upgrade.js";
import { feishuBots } from "../feishu/index.js";
import { fromThisMachine, isLoopbackHost, lanAddresses, listening, rebind } from "./listen.js";
import { beginRegistration, initRegistration, pollRegistration, qrSvg } from "../feishu/register.js";
import { FeishuClient } from "../feishu/client.js";
import {
  checkSetupToken,
  clearAttempts,
  createSession,
  destroySession,
  listSessions as listWebSessions,
  needsSetup,
  revokeSession,
  revokeUserSessions,
  sessionUser,
  patchUser,
  setUserPassword,
  setupFirstAdmin,
  takeAttempt,
} from "./auth.js";
import { canSeeConv, pushOwnedBy, sessionVisibleTo } from "./access.js";
import { clampLimit, dirsOf, inDir, inRecent, pageOf, parseCursor, searchConvs } from "./conv-pages.js";
import { clientIp, cookies, HttpError, isHttps, readBody, readJsonBody, SECURITY_HEADERS, sendJson } from "./http.js";
import { handleTasksApi } from "./tasks-api.js";
import { handleSkillsApi } from "./skills-api.js";
import { handleExpertsApi } from "./experts-api.js";
import { canUseExpert, getExpert, isBuiltin, listExperts } from "../../core/experts.js";
import { expertBrief } from "./experts-api.js";
import { handleTerminalApi } from "./terminal.js";
import { handleDesktopApi, remoteStatus } from "./desktop.js";
import {
  addRelaySubscription,
  addSubscription,
  listSubscriptions,
  pushToAll,
  removeSubscription,
  removeSubscriptionsOf,
  vapidKeyPair,
  vapidPublicKey,
} from "./push.js";

export const COOKIE = "aim_session";
const startedAt = Date.now();

// ---------- 上传 ----------

/** 上传后先存着，发消息时用 id 认领。一小时没人认领就作废 */
const uploads = new Map<string, { key: string; attachment: SavedAttachment; at: number }>();

/**
 * 认领上传的附件。有任何一个已失效（id 不认识、不属于这条会话、文件已被删 —— 比如
 * 另一个浏览器在这期间开了新会话、清掉了上传目录）就整条拒绝，让前端提示重新上传，
 * 而不是悄悄少发一个附件。
 */
export function takeUploads(key: string, ids: unknown): SavedAttachment[] {
  if (!Array.isArray(ids)) return [];
  const entries = ids.map((id) => (typeof id === "string" ? uploads.get(id) : undefined));
  const bad = entries.filter((e) => !e || e.key !== key || !fs.existsSync(e.attachment.path)).length;
  if (bad > 0) throw new HttpError(410, `有 ${bad} 个附件已失效（可能会话被重置过），请重新上传`);
  for (const id of ids) uploads.delete(id as string);
  return entries.map((e) => e!.attachment);
}

/** 已发送的附件重新领一个上传编号，让撤回的消息能带着原附件再次发送 */
function editableDraft(key: string, user: User, message: { text: string; attachments: AttachmentInfo[] }) {
  let missing = 0;
  const restored = message.attachments.flatMap((file) => {
    const resolved = resolveUploadFile(file.path);
    const sourceKey = resolved && uploadKeyOf(resolved);
    const source = sourceKey && getConversation(sourceKey);
    if (!resolved || !source || !canSeeConv(user, source)) {
      missing++;
      return [];
    }
    try {
      const head = Buffer.alloc(12);
      const fd = fs.openSync(resolved, "r");
      try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
      const attachment: SavedAttachment = { ...file, path: resolved, size: fs.statSync(resolved).size, mediaType: sniff(head)?.mediaType };
      const id = crypto.randomBytes(12).toString("hex");
      uploads.set(id, { key, attachment, at: Date.now() });
      return [{ id, name: file.name, kind: file.kind, ...(file.kind === "image" ? { url: `/api/file?path=${encodeURIComponent(resolved)}` } : {}) }];
    } catch {
      missing++;
      return [];
    }
  });
  return { text: message.text, uploads: restored, missing };
}

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of uploads) if (now - entry.at > 60 * 60 * 1000) uploads.delete(id);
}, 10 * 60 * 1000).unref();

/**
 * 附件文件。只有按文件头确认是常见图片的才 inline 显示（缩略图 / 大图要用），其余一律当下载，
 * 免得用户传上来的 HTML / SVG 在本站域名下被浏览器当网页执行
 */
const INLINE_IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function serveUpload(res: ServerResponse, user: User, requested: string, download: boolean): void {
  const file = requested ? resolveUploadFile(requested) : undefined;
  // 只能看自己会话里的附件。会话已经没了的，只有管理员能看
  const key = file ? uploadKeyOf(file) : undefined;
  const conv = key ? getConversation(key) : undefined;
  const allowed = conv ? canSeeConv(user, conv) : isAdmin(user);
  if (!file || !allowed) throw new HttpError(404, "文件不存在（可能会话重置时已清理）");
  const head = Buffer.alloc(12);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, head, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  const type = sniff(head)?.mediaType;
  const inline = !download && !!type && INLINE_IMAGE.has(type);
  const name = path.basename(file);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": inline ? type! : "application/octet-stream",
    "Content-Length": fs.statSync(file).size,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; sandbox",
    "Cache-Control": "private, max-age=3600",
  });
  fs.createReadStream(file).pipe(res);
}

// ---------- agent 回复里提到的文件 ----------

/** 每条会话 agent 回复的全文（从 agent 记录里读，比较慢）：缓存一会儿，一屏好几张图不用每张都读一遍 */
const replyTextCache = new Map<string, { at: number; text: string }>();

async function historyReplyText(key: string): Promise<string> {
  const messages = await hub.history(key);
  const text = messages.filter((m) => m.role === "assistant").map((m) => m.text).join("\n");
  replyTextCache.delete(key);
  replyTextCache.set(key, { at: Date.now(), text });
  // 只留最近的几十条会话
  for (const k of replyTextCache.keys()) {
    if (replyTextCache.size <= 50) break;
    replyTextCache.delete(k);
  }
  return text;
}

/** 这条会话的 agent 回复里写没写过这个路径。缓存里没有、缓存又不是刚读的，就重读一次再说 */
async function replyMentions(key: string, requested: string): Promise<boolean> {
  if (mentions(hub.recentReplyText(key), requested)) return true;
  const cached = replyTextCache.get(key);
  if (cached && mentions(cached.text, requested)) return true;
  if (cached && Date.now() - cached.at < 3000) return false;
  return mentions(await historyReplyText(key), requested);
}

/**
 * 回复里的文件：stat=1 只回名字和大小；其余返回内容，支持 Range（视频拖进度、iOS 放视频都要它）。
 * 图片、PDF、音视频按类型 inline，别的一律当下载 —— HTML 之类不能在本站域名下被当网页打开
 */
function serveReplyFile(req: IncomingMessage, res: ServerResponse, file: string, opts: { stat: boolean; download: boolean }): void {
  const st = fs.statSync(file);
  const name = path.basename(file);
  if (opts.stat) {
    sendJson(res, 200, { name, path: file, size: st.size, mtime: st.mtimeMs });
    return;
  }
  const type = replyFileType(file);
  const inline = !opts.download && !!type;
  const headers: Record<string, string | number> = {
    ...SECURITY_HEADERS,
    "Content-Type": inline ? type! : "application/octet-stream",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-cache",
    "Last-Modified": new Date(st.mtimeMs).toUTCString(),
  };
  if (type === "application/pdf") {
    // 预览窗里用 iframe 嵌 PDF：要允许本站嵌入。Chrome 带 sandbox 的文档不显示 PDF，这里不加
    // （所有接口的响应事先都带上了 SECURITY_HEADERS，见 server.ts，这里得把那个也去掉）
    delete headers["X-Frame-Options"];
    res.removeHeader("X-Frame-Options");
    headers["Content-Security-Policy"] = `default-src 'none'; frame-ancestors ${ownFrameAncestors(config().servers)}`;
  } else {
    headers["Content-Security-Policy"] = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox";
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start >= st.size || start > end) {
      res.writeHead(416, { ...headers, "Content-Range": `bytes */${st.size}` });
      res.end();
      return;
    }
    start = Math.max(0, start);
    end = Math.max(start, end);
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, "Content-Length": st.size });
  fs.createReadStream(file).pipe(res);
}

// ---------- 飞书扫码创建应用 ----------

type Registration = {
  status: "pending" | "success" | "access_denied" | "expired" | "timeout" | "error";
  qrUrl: string;
  qrSvg: string;
  message?: string;
  botId?: string;
};
const registrations = new Map<string, Registration>();

async function startRegistration(name: string, agents: string[]): Promise<{ id: string } & Registration> {
  await initRegistration("feishu");
  const begin = await beginRegistration("feishu");
  const id = crypto.randomBytes(8).toString("hex");
  const reg: Registration = { status: "pending", qrUrl: begin.qrUrl, qrSvg: await qrSvg(begin.qrUrl) };
  registrations.set(id, reg);
  void pollRegistration({ deviceCode: begin.deviceCode, interval: begin.interval, expireIn: begin.expireIn })
    .then((outcome) => {
      if (outcome.status !== "success") {
        reg.status = outcome.status;
        if (outcome.status === "error") reg.message = outcome.message;
        return;
      }
      const cfg = structuredClone(config());
      const botId = `bot_${crypto.randomBytes(3).toString("hex")}`;
      const list = agents.filter((a) => (AGENT_IDS as readonly string[]).includes(a));
      cfg.feishu.bots.push({
        id: botId,
        name: name || "飞书机器人",
        enabled: true,
        appId: outcome.result.appId,
        appSecret: outcome.result.appSecret,
        domain: outcome.result.domain,
        allowFrom: outcome.result.openId ? [outcome.result.openId.toLowerCase()] : [],
        agents: list.length ? list : ["claude"],
        defaultAgent: list[0] ?? "claude",
      });
      saveConfig(cfg);
      reg.status = "success";
      reg.botId = botId;
    })
    .catch((err) => {
      reg.status = "error";
      reg.message = err instanceof Error ? err.message : String(err);
    });
  setTimeout(() => registrations.delete(id), 30 * 60 * 1000).unref();
  return { id, ...reg };
}

// ---------- 配置读写 ----------

const MASK = "••••••";

function maskSecret(secret: string): string {
  return secret ? `${MASK}${secret.slice(-4)}` : "";
}

function publicConfig(): unknown {
  const cfg = structuredClone(config()) as AppConfig & { web: { passwordHash?: string } };
  return {
    ...cfg,
    web: { ...cfg.web, passwordHash: undefined },
    feishu: { ...cfg.feishu, bots: cfg.feishu.bots.map((b) => ({ ...b, appSecret: maskSecret(b.appSecret) })) },
    // VNC 密码最多 8 位，不能像 appSecret 那样露出后 4 位
    remote: { ...cfg.remote, vncPassword: cfg.remote.vncPassword ? MASK : "" },
  };
}

/** selfOrigin：发起保存的页面的地址（多服务器列表里不能加自己） */
function applyConfig(input: Partial<AppConfig>, selfOrigin?: string): void {
  const current = config();
  const next = structuredClone(current);
  if (input.servers !== undefined) {
    try {
      next.servers = cleanServers(input.servers, current.servers, selfOrigin);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
  }
  if (typeof input.workspaceRoot === "string" && input.workspaceRoot.trim()) next.workspaceRoot = input.workspaceRoot.trim();
  if (typeof input.approvalTimeoutMs === "number") next.approvalTimeoutMs = Math.max(60_000, input.approvalTimeoutMs);
  if (typeof input.sessionTtlMs === "number") next.sessionTtlMs = Math.max(0, input.sessionTtlMs);
  if (input.agents) {
    // 按 agent 逐个合并：只改了其中几项（比如没带 models）时，其余的保持原样
    for (const id of AGENT_IDS) {
      const patch = structuredClone(input.agents[id]) as Partial<AppConfig["agents"][typeof id]> | undefined;
      if (!patch) continue;
      if (patch.models !== undefined) {
        patch.models = Array.isArray(patch.models) ? [...new Set(patch.models.filter((m) => typeof m === "string" && m))] : [];
      }
      Object.assign(next.agents[id], patch);
    }
  }
  if (input.web) {
    // 密码只能走专门的接口改
    // 监听地址、端口已经在 applyListen 里校验并换好了，这里只收形状对的
    const { passwordHash: _ignored, host, port, ...web } = input.web as AppConfig["web"];
    next.web = { ...next.web, ...web, passwordHash: current.web.passwordHash };
    if (typeof host === "string" && host.trim()) next.web.host = host.trim();
    if (Number.isInteger(Number(port)) && Number(port) >= 1 && Number(port) <= 65535) next.web.port = Number(port);
    const q = Number(next.web.quotaRefreshMin);
    next.web.quotaRefreshMin = Number.isFinite(q) ? Math.max(0, Math.min(1440, Math.round(q))) : 10;
    next.web.quotaEnabled = next.web.quotaEnabled !== false;
  }
  if (input.remote) {
    const r = input.remote as Partial<AppConfig["remote"]>;
    if (typeof r.terminal === "boolean") next.remote.terminal = r.terminal;
    if (typeof r.desktop === "boolean") next.remote.desktop = r.desktop;
    const k = Number(r.keepAliveMin);
    if (r.keepAliveMin !== undefined && Number.isFinite(k)) next.remote.keepAliveMin = Math.max(1, Math.min(1440, Math.round(k)));
    if (r.desktopSource === "auto" || r.desktopSource === "vnc") next.remote.desktopSource = r.desktopSource;
    if (typeof r.display === "string") {
      const d = r.display.trim();
      if (d && !/^:\d{1,3}(\.\d)?$/.test(d)) throw new HttpError(400, "X 显示要写成 :0、:1 这样，留空自动找");
      next.remote.display = d;
    }
    if (typeof r.vncHost === "string" && r.vncHost.trim()) next.remote.vncHost = r.vncHost.trim();
    const port = Number(r.vncPort);
    if (r.vncPort !== undefined && Number.isInteger(port) && port >= 1 && port <= 65535) next.remote.vncPort = port;
    if (typeof r.vncUsername === "string") next.remote.vncUsername = r.vncUsername.trim();
    // 回传的是打了码的旧值：不改
    if (typeof r.vncPassword === "string" && !r.vncPassword.startsWith(MASK)) next.remote.vncPassword = r.vncPassword;
  }
  if (input.commands) {
    // 只收字符串数组，别的一律当没传
    const names = (v: unknown) =>
      Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === "string" && s.length > 0 && s.length < 128))] : null;
    for (const id of AGENT_IDS) {
      const prefs = (input.commands as Record<string, { order?: unknown; hidden?: unknown; custom?: unknown } | undefined>)[id];
      if (!prefs) continue;
      let custom = next.commands[id].custom;
      if (prefs.custom !== undefined) {
        try {
          custom = cleanCustomCommands(prefs.custom, true);
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
      }
      next.commands[id] = {
        order: names(prefs.order) ?? next.commands[id].order,
        hidden: names(prefs.hidden) ?? next.commands[id].hidden,
        custom,
      };
    }
  }
  if (input.feishu) {
    if (typeof input.feishu.watchdogMs === "number") next.feishu.watchdogMs = input.feishu.watchdogMs;
    if (Array.isArray(input.feishu.bots)) {
      next.feishu.bots = input.feishu.bots.map((b) => {
        const old = current.feishu.bots.find((o) => o.id === b.id);
        // 前端拿到的是打码后的密钥，原样传回来表示「没改」
        const secret = !b.appSecret || b.appSecret.startsWith(MASK) ? (old?.appSecret ?? "") : b.appSecret;
        return { ...b, appSecret: secret };
      });
    }
  }
  saveConfig(next);
}

// ---------- 监听地址（局域网访问、端口） ----------

/** 设置页「网络访问」要显示的：这台机器的局域网地址、当前请求是不是从本机来的 */
function networkInfo(req: IncomingMessage) {
  return { lan: lanAddresses(), local: fromThisMachine(req.socket.remoteAddress), listening: listening() };
}

/**
 * 改了监听地址 / 端口：先真的换过去，成功了配置才保存（applyConfig 里只是照抄）。
 * 端口被占用之类的失败直接报给页面，旧地址照常工作。
 */
async function applyListen(req: IncomingMessage, web: Partial<AppConfig["web"]> | undefined): Promise<void> {
  if (!web || (web.host === undefined && web.port === undefined)) return;
  const current = config().web;
  const host = web.host === undefined ? current.host : String(web.host).trim();
  const port = web.port === undefined ? current.port : Number(web.port);
  if (!host) throw new HttpError(400, "监听地址不能为空");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, "端口要是 1 到 65535 之间的整数");
  if (host === current.host && port === current.port) return;
  // 从局域网里的另一台设备上关掉局域网访问：这个页面马上就连不上了，而且没法在这台设备上改回来
  if (isLoopbackHost(host) && !isLoopbackHost(current.host) && !fromThisMachine(req.socket.remoteAddress)) {
    throw new HttpError(400, "你现在是从局域网里的另一台设备访问的，关掉局域网访问后这个页面会立刻断开、也没法再改回来。请在运行 agent-loft 的这台机器上操作。");
  }
  if (config().web.enabled) {
    try {
      await rebind(host, port);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
  }
}

// ---------- 鉴权 ----------

function setCookie(req: IncomingMessage, res: ServerResponse, token: string, maxAgeSec: number): void {
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
    ...(isHttps(req) ? ["Secure"] : []),
  ];
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function authed(req: IncomingMessage): boolean {
  return !!currentUser(req);
}

/** 这个请求是哪个用户的（没登录 / 登录态失效返回 undefined） */
export function currentUser(req: IncomingMessage): User | undefined {
  return sessionUser(cookies(req)[COOKIE]);
}

function newSession(req: IncomingMessage, res: ServerResponse, userId: string): void {
  setCookie(req, res, createSession(userId, clientIp(req), String(req.headers["user-agent"] ?? "")), 30 * 24 * 3600);
}

/**
 * 只有管理员能用的接口：所有设置（Agent、飞书、配对、总是允许名单、网络、升级、重启）和用户管理。
 * 写在一处，方便核对。普通成员只能用自己的会话、通知、密码和登录设备。
 */
function adminOnly(p: string): boolean {
  return (
    p === "/api/config" ||
    p === "/api/server/upgrade" ||
    p === "/api/agents/codex/install" ||
    p.startsWith("/api/pairing") ||
    p.startsWith("/api/claude/") ||
    p.startsWith("/api/feishu/") ||
    p.startsWith("/api/system") ||
    p.startsWith("/api/users")
  );
}

function publicMe(user: User) {
  return { id: user.id, name: user.name, role: user.role };
}

/** users.ts 抛的是给人看的错误，转成 400 */
function userOp<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
}

// ---------- 记忆、飞书绑定 ----------

/** 飞书 open_id 只给人看个尾巴：认得出是哪个就够了 */
function maskOpenId(openId: string): string {
  return openId.length > 10 ? `${openId.slice(0, 3)}…${openId.slice(-6)}` : openId;
}

function feishuLinksOf(userId: string) {
  const bots = config().feishu.bots;
  return listLinks(userId).map((l) => ({
    botId: l.botId,
    botName: bots.find((b) => b.id === l.botId)?.name ?? "（已删除的机器人）",
    openId: l.openId,
    openIdShort: maskOpenId(l.openId),
    boundAt: l.boundAt,
  }));
}

/**
 * 解除绑定后，那个人和机器人的私聊立刻不再是他的：交还给管理员的地盘，旧会话不带过去
 * （见 hub.reassignOwner）。不等他下次发消息 —— 万一他再也不发，那条对话就一直挂在他名下。
 */
function releaseFeishuChats(userId: string, botId?: string): void {
  for (const c of listConversations()) {
    if (c.channel !== "feishu" || c.owner !== userId || (botId && c.channelId !== botId)) continue;
    hub.reassignOwner(c.key, undefined);
  }
}

function memoryOp<T>(userId: string, fn: () => T, affectsAgents = true): T {
  try {
    const result = fn();
    // 用户在设置里改了记忆：他名下空闲的会话下次说话时换上新的（只改整理时机、用哪个模型的不用）
    if (affectsAgents) hub.memoryChanged(userId);
    return result;
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
}

// ---------- 路由 ----------

function conversationOr404(key: string) {
  const conv = getConversation(key);
  if (!conv) throw new HttpError(404, "会话不存在");
  return conv;
}

/** 这条会话能用的 agent：飞书会话受机器人配置约束，Web 会话全部已启用的都行 */
export function allowedAgentsFor(key: string): string[] {
  const conv = getConversation(key);
  const enabled = hub.enabledAgents().map((d) => d.id);
  if (conv?.channel === "feishu") {
    const bot = config().feishu.bots.find((b) => b.id === conv.channelId);
    return bot ? bot.agents.filter((a) => enabled.includes(a)) : enabled;
  }
  return enabled;
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? "GET";
  const p = url.pathname;
  const ip = clientIp(req);

  // ----- 无需登录 -----
  if (p === "/api/me" && method === "GET") {
    const user = currentUser(req);
    sendJson(res, 200, {
      authed: !!user,
      needsSetup: needsSetup(),
      // 不止一个人能登录：登录页要填用户名
      multiUser: listUsers().filter((u) => !u.disabled).length > 1,
      ...(user ? { user: publicMe(user) } : {}),
    });
    return;
  }
  if (p === "/api/setup" && method === "POST") {
    if (!needsSetup()) throw new HttpError(400, "已经设置过了，直接登录");
    const body = await readJsonBody<{ token?: string; name?: string; password?: string }>(req);
    const left = takeAttempt(ip);
    if (left) throw new HttpError(429, `尝试次数太多，请 ${Math.ceil(left / 60000)} 分钟后再试`);
    if (!checkSetupToken(String(body.token ?? ""))) {
      throw new HttpError(403, "设置码不对。它打印在 agent-loft 的启动日志里");
    }
    const user = userOp(() => setupFirstAdmin(String(body.name ?? ""), String(body.password ?? "")));
    clearAttempts(ip);
    newSession(req, res, user.id);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (p === "/api/login" && method === "POST") {
    const body = await readJsonBody<{ name?: string; password?: string }>(req);
    const left = takeAttempt(ip);
    if (left) throw new HttpError(429, `尝试次数太多，请 ${Math.ceil(left / 60000)} 分钟后再试`);
    const user = verifyLogin(typeof body.name === "string" ? body.name : undefined, String(body.password ?? ""));
    if (!user) throw new HttpError(403, listUsers().filter((u) => !u.disabled).length > 1 ? "用户名或密码不对" : "密码不对");
    clearAttempts(ip);
    newSession(req, res, user.id);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (p === "/api/logout" && method === "POST") {
    destroySession(cookies(req)[COOKIE]);
    setCookie(req, res, "", 0);
    sendJson(res, 200, { ok: true });
    return;
  }

  const user = currentUser(req);
  if (!user) throw new HttpError(401, "请先登录");
  if (adminOnly(p) && !isAdmin(user)) throw new HttpError(403, "只有管理员能做这个操作");
  const admin = isAdmin(user);
  const visible = (c: Parameters<typeof canSeeConv>[1]) => canSeeConv(user, c);

  // ----- 附件预览 / 下载：只给上传目录里的文件 -----
  if (p === "/api/file" && method === "GET") {
    serveUpload(res, user, url.searchParams.get("path") ?? "", url.searchParams.get("download") === "1");
    return;
  }

  // ----- 总览 -----
  if (p === "/api/bootstrap" && method === "GET") {
    // 会话只给侧栏第一屏要的（见 conv-pages.ts）：「最近」的前 recent 棵树、展开着的目录各自的前几棵，
    // 每个飞书机器人最近的一条，再加上正在跑的、等你处理的（侧栏要显示状态）。其余点「展开显示」再拉
    const all = hub.list(visible).filter((c) => !c.hidden);
    const pending = interactions.listPending().filter((i) => visible(getConversation(i.convKey)));
    const recent = pageOf(all.filter(inRecent), null, clampLimit(url.searchParams.get("recent"), 10));
    let open: [string, number][] = [];
    try {
      const raw: unknown = JSON.parse(url.searchParams.get("open") ?? "[]");
      if (Array.isArray(raw)) {
        open = raw
          .slice(0, 50)
          .filter((x): x is [string, unknown] => Array.isArray(x) && typeof x[0] === "string")
          .map(([dir, n]) => [dir, clampLimit(n, 5)]);
      }
    } catch {
      // 参数坏了就当没有展开的目录
    }
    const dirPages = new Map(open.map(([dir, n]) => [dir, pageOf(all.filter(inDir(dir)), null, n)]));
    const byKey = new Map(all.map((c) => [c.key, c]));
    const keep = new Map(recent.conversations.map((c) => [c.key, c]));
    for (const page of dirPages.values()) for (const c of page.conversations) keep.set(c.key, c);
    const asking = new Set(pending.map((i) => i.convKey));
    const bots = new Set<string>();
    for (const c of all) {
      // all 已按活跃时间从新到旧：每个机器人遇到的第一条就是它最近的
      if (c.channel === "feishu" && !bots.has(c.channelId)) {
        bots.add(c.channelId);
        keep.set(c.key, c);
      }
      if (c.busy || asking.has(c.key)) keep.set(c.key, c);
    }
    // 正开着的会话（可能是后面几页里的，重连时页面上还显示着它）
    const current = byKey.get(url.searchParams.get("current") ?? "");
    if (current) keep.set(current.key, current);
    // 分叉来源：提示里要写它的标题
    for (const c of [...keep.values()]) {
      const parent = c.forkOf ? byKey.get(c.forkOf) : undefined;
      if (parent) keep.set(parent.key, parent);
    }
    sendJson(res, 200, {
      agents: [...AGENT_IDS].map((id) => {
        const d = hub.driver(id);
        return {
          id,
          label: d?.label ?? id,
          enabled: hub.enabledAgents().some((e) => e.id === id),
          capabilities: d?.capabilities ?? {},
          // 输入框模型列表里显示哪些，空 = 全部
          models: config().agents[id].models.filter((m) => typeof m === "string"),
          // 没装 / 没登录：新对话里不出现（null = 还没查过，当作能用）
          ...(agentAvailability(id) ?? {}),
        };
      }),
      // 飞书机器人是管理员配的，飞书会话也只给管理员看
      bots: admin ? config().feishu.bots.map((b) => ({ id: b.id, name: b.name, agents: b.agents, enabled: b.enabled })) : [],
      // 自己的专家（新对话、定时任务里选）。内置的 Claude Code / Codex 就是上面的 agents
      experts: listExperts(user.id).map(expertBrief),
      workspaceRoot: config().workspaceRoot,
      quotaRefreshMin: config().web.quotaRefreshMin,
      quotaEnabled: config().web.quotaEnabled,
      conversations: [...keep.values()],
      sidebar: {
        recent: { next: recent.next },
        // 展开着的目录带上翻页游标（没带 next 的目录前端还没拉过）
        dirs: dirsOf(all).map((d) => (dirPages.has(d.dir) ? { ...d, next: dirPages.get(d.dir)!.next } : d)),
      },
      // 「项目」目录的顺序（拖拽排的），跟着账号走；null = 还没存过
      dirOrder: getDirOrder(user.id) ?? null,
      pending,
      user: publicMe(user),
      remote: remoteStatus(user),
      // 左上角切换服务器：没加别的服务器是 null
      servers: shellInfo(config().servers),
      serverTime: Date.now(),
    });
    return;
  }

  // ----- 侧栏「项目」目录顺序：order 整份换掉，append 只把新目录接在最后 -----
  if (p === "/api/ui/dir-order" && method === "PUT") {
    const body = await readJsonBody<{ order?: unknown; append?: unknown }>(req);
    const order = body.order !== undefined ? setDirOrder(user.id, body.order) : appendDirOrder(user.id, body.append);
    sendJson(res, 200, { order });
    return;
  }

  // ----- 系统通知（Web Push） -----
  if (p === "/api/push" && method === "GET") {
    sendJson(res, 200, { publicKey: vapidPublicKey(), subscriptions: listSubscriptions(pushOwnedBy(user.id)) });
    return;
  }
  if (p === "/api/push/subscribe" && method === "POST") {
    const body = await readJsonBody<{ subscription?: unknown }>(req);
    try {
      const record = addSubscription(body.subscription, String(req.headers["user-agent"] ?? ""), user.id);
      sendJson(res, 200, { ok: true, label: record.label });
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    return;
  }
  // 多服务器（core/servers.ts）：外壳把这个浏览器的订阅连同签名密钥转给嵌着的各台（web/lib/shell.js），
  // 各台直接推到手机上，不经过外壳。密钥只在加了别的服务器时给
  if (p === "/api/push/relay-key" && method === "GET") {
    if (!config().servers.list.length) throw new HttpError(404, "没有加别的服务器");
    sendJson(res, 200, vapidKeyPair());
    return;
  }
  if (p === "/api/push/relay" && method === "POST") {
    const body = await readJsonBody<{ subscription?: unknown; vapid?: unknown; via?: unknown }>(req);
    try {
      const record = addRelaySubscription(body, String(req.headers["user-agent"] ?? ""), user.id, config().servers.embedders);
      sendJson(res, 200, { ok: true, label: record.label });
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    return;
  }
  if (p === "/api/push/unsubscribe" && method === "POST") {
    const body = await readJsonBody<{ endpoint?: string }>(req);
    sendJson(res, 200, { ok: removeSubscription(String(body.endpoint ?? ""), pushOwnedBy(user.id)) });
    return;
  }
  if (p === "/api/push/test" && method === "POST") {
    const sent = await pushToAll(
      { title: "Agent Loft", body: "测试通知：能看到这条，说明通知已经通了。", tag: "test", url: "/" },
      pushOwnedBy(user.id),
    );
    if (sent === 0) throw new HttpError(502, "没有推送成功：还没有设备开启通知，或推送服务拒绝了（看服务日志）");
    sendJson(res, 200, { sent });
    return;
  }

  // ----- 定时任务 -----
  if (p.startsWith("/api/tasks") && (await handleTasksApi(req, res, p, user))) return;
  if (p.startsWith("/api/skills") && (await handleSkillsApi(req, res, url, user))) return;
  if ((p.startsWith("/api/experts") || p.startsWith("/api/mcp")) && (await handleExpertsApi(req, res, p, user))) return;
  if (p.startsWith("/api/terminals") && (await handleTerminalApi(req, res, p, user))) return;
  if ((p === "/api/remote" || p.startsWith("/api/desktop/")) && (await handleDesktopApi(req, res, p, user))) return;

  // ----- 目录选择器：列出或新建工作区内的子目录 -----
  if (p === "/api/dirs" && method === "GET") {
    const listing = listWorkspaceDirs(url.searchParams.get("path") ?? "");
    if (!listing) throw new HttpError(404, `目录不存在，或不在 ${config().workspaceRoot} 之内`);
    sendJson(res, 200, listing);
    return;
  }
  if (p === "/api/dirs" && method === "POST") {
    const body = await readJsonBody<{ path?: unknown; name?: unknown }>(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name === "." || name === ".." || /[\\/\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name) > 255) {
      throw new HttpError(400, "请输入有效的文件夹名称，不能包含斜杠或控制字符");
    }
    if (body.path !== undefined && typeof body.path !== "string") throw new HttpError(400, "目录路径必须是文字");
    const parent = resolveWorkspacePath(typeof body.path === "string" && body.path ? body.path : ".");
    if (!parent) throw new HttpError(404, `目录不存在，或不在 ${config().workspaceRoot} 之内`);
    const target = path.join(parent, name);
    try {
      fs.mkdirSync(target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new HttpError(409, "同名文件或文件夹已存在");
      if (code === "EACCES" || code === "EPERM") throw new HttpError(403, "没有权限在此目录新建文件夹");
      throw new HttpError(400, "无法新建文件夹，请检查名称和所在目录");
    }
    sendJson(res, 201, { path: target });
    return;
  }

  // ----- 会话 -----
  // 侧栏按页拉：scope=recent（最近）/ dir（某个项目目录）按树分页；bot（某个飞书机器人的全部聊天）平铺
  if (p === "/api/conversations/page" && method === "GET") {
    const all = hub.list(visible).filter((c) => !c.hidden);
    const scope = url.searchParams.get("scope");
    if (scope === "bot") {
      const bot = url.searchParams.get("bot") ?? "";
      sendJson(res, 200, { conversations: all.filter((c) => c.channel === "feishu" && c.channelId === bot).slice(0, 200), next: null });
      return;
    }
    if (scope !== "recent" && scope !== "dir") throw new HttpError(400, "scope 只能是 recent / dir / bot");
    const list = scope === "recent" ? all.filter(inRecent) : all.filter(inDir(url.searchParams.get("dir") ?? ""));
    const before = parseCursor(url.searchParams.get("at"), url.searchParams.get("key"));
    sendJson(res, 200, pageOf(list, before, clampLimit(url.searchParams.get("limit"), 10)));
    return;
  }
  // 搜索会话（侧栏「搜索」弹窗）：标题、目录名，再搜聊天内容（聊天记录索引，见 chat-history.ts）。
  // expert：只看这个专家的对话（内置的就是 claude / codex）
  if (p === "/api/conversations/search" && method === "GET") {
    const q = (url.searchParams.get("q") ?? "").slice(0, 200);
    const expert = url.searchParams.get("expert");
    const all = hub.list(visible).filter((c) => !c.hidden && (!expert || c.expert.id === expert));
    const keys = new Set(all.map((c) => c.key));
    let content: { key: string; text: string }[] = [];
    if (q.trim()) {
      try {
        // 一条对话可能命中很多句，多要一些，保证别的对话也排得上
        content = searchHistory(user.id, q, { limit: 300, skip: (k) => !keys.has(k) }).map((hit) => {
          const lower = q.trim().toLowerCase();
          const text = [hit.user, hit.assistant].find((t) => t?.toLowerCase().includes(lower)) ?? hit.user ?? hit.assistant ?? "";
          return { key: hit.key, text };
        });
      } catch {
        // 没有索引、读不了：只按标题搜
      }
    }
    sendJson(res, 200, { results: searchConvs(all, q, content) });
    return;
  }
  if (p === "/api/conversations" && method === "GET") {
    sendJson(res, 200, hub.list(visible));
    return;
  }
  if (p === "/api/conversations" && method === "POST") {
    // expert：新对话页上选的专家（内置的 claude / codex，或者自己的专家 id）。agent 是以前的叫法
    const body = await readJsonBody<{ expert?: string; agent?: string; cwd?: string }>(req);
    const enabled = hub.enabledAgents().map((d) => d.id);
    const wanted = body.expert ?? body.agent;
    let expertId = wanted && canUseExpert(user.id, wanted) ? wanted : enabled[0];
    if (!expertId) throw new HttpError(400, "没有可用的 agent");
    const custom = isBuiltin(expertId) ? undefined : getExpert(expertId);
    const agent = custom ? custom.engine : expertId;
    if (!enabled.includes(agent)) throw new HttpError(400, `${hub.label(agent)} 没有启用，用不了这个专家`);
    // 新对话发第一条消息前在页面上选的工作目录；和 /cd 一样只能在工作区之内。没选就用专家默认的
    let cwd: string | undefined;
    const rawCwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : custom?.cwd;
    if (rawCwd) {
      const resolved = resolveWorkspacePath(rawCwd);
      if (!resolved) throw new HttpError(400, `目录必须存在，且在 ${config().workspaceRoot} 之内`);
      cwd = resolved;
    }
    const key = `web:${crypto.randomBytes(6).toString("hex")}`;
    hub.ensure({ key, channel: "web", channelId: "web", defaultAgent: agent, ...(custom ? { expert: custom.id } : {}), ...(cwd ? { cwd } : {}), owner: user.id });
    sendJson(res, 200, hub.info(key));
    return;
  }

  const convMatch = /^\/api\/conversations\/([^/]+)(?:\/([a-z-]+))?$/.exec(p);
  if (convMatch) {
    const key = decodeURIComponent(convMatch[1]!);
    const sub = convMatch[2];
    const conv = conversationOr404(key);
    // 别人的会话：当它不存在
    if (!visible(conv)) throw new HttpError(404, "会话不存在");

    if ((sub === "cancel-queued" || sub === "rewind") && method === "POST") {
      const body = await readJsonBody<{ id?: unknown; anchor?: unknown; sessionId?: unknown }>(req);
      const id = typeof body.id === "string" ? body.id : undefined;
      const anchor = typeof body.anchor === "string" ? body.anchor : undefined;
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
      if (!(sub === "cancel-queued" ? id : id || anchor)) throw new HttpError(400, "缺少消息位置");
      try {
        const message = sub === "cancel-queued" ? hub.cancelQueued(key, id!) : await hub.rewind(key, { id, anchor, sessionId });
        sendJson(res, 200, { draft: editableDraft(key, user, message), queued: "queued" in message && message.queued, info: hub.info(key) });
      } catch (err) {
        throw new HttpError(409, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    if (!sub && method === "PATCH") {
      const body = await readJsonBody<{ title?: string; hidden?: boolean }>(req);
      updateConversation(key, {
        // 手动改过名，就不再拿 agent 生成的标题覆盖
        ...(typeof body.title === "string" ? { title: body.title.trim().slice(0, 80), titleAuto: false } : {}),
        ...(typeof body.hidden === "boolean" ? { hidden: body.hidden } : {}),
      });
      hub.emitEvent(key, { type: "meta" });
      sendJson(res, 200, hub.info(key));
      return;
    }
    if (!sub && method === "DELETE") {
      // 只是从列表里藏起来：agent 侧的会话记录还在，随时能从「历史会话」恢复
      await hub.drop(key, "会话已删除");
      updateConversation(key, { hidden: true });
      clearScheduled(key);
      hub.emitEvent(key, { type: "meta" });
      sendJson(res, 200, { ok: true });
      return;
    }
    // ----- 定时发送：列表随会话信息（info.scheduled）下发，这里只管增删 -----
    if (sub === "scheduled" && method === "POST") {
      const body = await readJsonBody<{ text?: string; at?: number }>(req);
      const text = typeof body.text === "string" ? body.text : "";
      const at = Number(body.at);
      if (!text.trim()) throw new HttpError(400, "定时发送的内容不能为空");
      if (!Number.isFinite(at) || at < Date.now() - 60_000) throw new HttpError(400, "发送时间要在现在之后");
      if (at > Date.now() + 30 * 86400_000) throw new HttpError(400, "最多只能排到 30 天以后");
      try {
        addScheduled(key, text, at);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
      hub.emitEvent(key, { type: "meta" });
      sendJson(res, 200, hub.info(key));
      return;
    }
    if (sub === "scheduled" && method === "DELETE") {
      const id = url.searchParams.get("id") ?? "";
      if (!removeScheduled(key, id)) throw new HttpError(404, "这条定时消息已经发出或取消了");
      hub.emitEvent(key, { type: "meta" });
      sendJson(res, 200, hub.info(key));
      return;
    }
    if (sub === "history" && method === "GET") {
      // 读历史是异步的。要保证「历史快照 + 进行中这一轮的事件 + 之后的补发」首尾相接、
      // 不重不漏，只在两种情况下接受这次读到的快照：
      //   a) 读的过程中这条会话没有任何新事件；
      //   b) 读之前和读之后是同一轮还在进行（快照里缺的部分由 live 事件补上）。
      // 其余情况（读的过程中有一轮结束了、或者开始了新的一轮）都重读。
      const turnStartSeq = () => hub.liveTurn(key)[0]?.seq ?? 0;
      let messages: Awaited<ReturnType<typeof hub.history>> = [];
      let consistent = false;
      for (let i = 0; i < 5 && !consistent; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 200));
        const before = hub.currentSeq();
        const startBefore = turnStartSeq();
        messages = await hub.history(key);
        const changed = (hub.eventsSince(key, before) ?? [null]).length > 0;
        const startAfter = turnStartSeq();
        consistent = !changed || (startBefore !== 0 && startBefore === startAfter);
      }
      // 拿不到一致的快照：宁可让客户端稍后重试，也不能返回一份缺了回复、游标却已越过它的快照
      if (!consistent) throw new HttpError(503, "这条会话正在快速变化，稍后重试");
      // 以下同步执行：live 和 seq 是同一时刻的，客户端从 seq 往后订阅正好接上
      const live = hub.liveTurn(key);
      const seq = hub.currentSeq();
      // 进行中的这一轮，agent 的记录里可能已经写进去了一部分，和 live 重复：
      // 记录里最后一条用户消息就是这一轮的那条时，从它起砍掉，交给 live 来画
      const liveUser = live.find((e) => e.ev.type === "user" && !e.ev.queued)?.ev;
      if (liveUser?.type === "user") {
        const anchor = live.findLast((e) => e.ev.type === "user_anchor" && e.ev.id === liveUser.id)?.ev;
        const lastUser = messages.map((m) => m.role).lastIndexOf("user");
        const norm = (t: string) => t.replace(/\s+/g, " ").trim();
        const want = norm(liveUser.text ?? "");
        const sameAnchor = anchor?.type === "user_anchor" && messages[lastUser]?.anchor === anchor.anchor;
        if (lastUser >= 0 && (sameAnchor || (want && norm(messages[lastUser]!.text).startsWith(want.slice(0, 200))))) {
          messages = messages.slice(0, lastUser);
        }
      }
      sendJson(res, 200, {
        info: hub.info(key),
        messages,
        live,
        // 进行中这一轮弹过的卡（已经处理了的也要）：重放到 ix 事件时放回原位
        interactions: live.flatMap((e) => (e.ev.type === "ix" ? [interactions.get(e.ev.id)].filter((i) => !!i) : [])),
        seq,
        pending: interactions.listPending(key),
        allowedAgents: allowedAgentsFor(key),
        serverTime: Date.now(),
      });
      return;
    }
    // agent 回复里提到的文件：只认回复里写过的路径，敏感文件（私钥、凭据…）不给
    if (sub === "file" && method === "GET") {
      const requested = url.searchParams.get("path") ?? "";
      const file = resolveReplyFile(requested, conv.cwd);
      if (!file || !(await replyMentions(key, requested))) throw new HttpError(404, "文件不存在，或者不能查看");
      serveReplyFile(req, res, file, { stat: url.searchParams.get("stat") === "1", download: url.searchParams.get("download") === "1" });
      return;
    }
    // 回复里的 HTML（Codex visualize 画的图表、agent 写的网页）：套好外壳放进沙箱显示，规矩和上面一样
    if (sub === "html" && method === "GET") {
      const requested = url.searchParams.get("path") ?? "";
      const file = resolveReplyFile(requested, conv.cwd);
      if (!file || !/\.html?$/i.test(file) || !(await replyMentions(key, requested))) throw new HttpError(404, "文件不存在，或者不能查看");
      if (fs.statSync(file).size > HTML_MAX) throw new HttpError(413, "文件太大，下载下来看吧");
      const doc = Buffer.from(htmlDocument(fs.readFileSync(file, "utf8"), path.basename(file)));
      // 要能嵌进对话里：去掉所有响应默认带的 X-Frame-Options（见 server.ts）
      res.removeHeader("X-Frame-Options");
      res.writeHead(200, {
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": HTML_CSP.replace("frame-ancestors 'self'", `frame-ancestors ${ownFrameAncestors(config().servers)}`),
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": doc.length,
        "Cache-Control": "private, no-cache",
      });
      res.end(doc);
      return;
    }
    if (sub === "upload" && method === "POST") {
      const data = await readBody(req, 50 * 1024 * 1024);
      const name = url.searchParams.get("name") ?? undefined;
      const type = req.headers["content-type"];
      const id = crypto.randomBytes(8).toString("hex");
      const attachment = saveBuffer({
        key,
        data,
        subdir: id,
        ...(name ? { name } : {}),
        ...(type && type !== "application/octet-stream" ? { mediaType: type.split(";")[0]! } : {}),
      });
      uploads.set(id, { key, attachment, at: Date.now() });
      sendJson(res, 200, { id, name: attachment.name, kind: attachment.kind, size: attachment.size });
      return;
    }
    if (sub === "fork" && method === "POST") {
      const body = await readJsonBody<{ anchor?: string }>(req);
      const anchor = typeof body.anchor === "string" && body.anchor ? body.anchor : undefined;
      const newKey = await hub.forkConversation(key, anchor, user.id);
      sendJson(res, 200, { info: hub.info(newKey) });
      return;
    }
    if (sub === "feishu" && method === "POST") {
      // 在飞书继续：把选中的飞书聊天挂到这条 Web 会话上。飞书机器人是管理员的
      if (!admin) throw new HttpError(403, "只有管理员能用飞书机器人");
      if (conv.channel !== "web" || conv.hidden) throw new HttpError(400, "只有 Web 会话能到飞书继续");
      const body = await readJsonBody<{ botId?: string; chatId?: string }>(req);
      const bot = feishuBots().find((b) => b.id === body.botId);
      if (!bot) throw new HttpError(404, "这个飞书机器人没有在运行");
      const chatId = String(body.chatId ?? "");
      // 只能挂到这个机器人聊过的聊天上，不能拿它往任意 chat_id 发消息
      if (!bot.hasChat(chatId)) {
        throw new HttpError(404, "这个机器人没在那个聊天里说过话");
      }
      sendJson(res, 200, { text: await bot.attachTo(bot.keyOf(chatId), key) });
      return;
    }
    if (sub === "sessions" && method === "GET") {
      sendJson(res, 200, await hub.sessions(key, url.searchParams.get("all") === "1", sessionVisibleTo(user)));
      return;
    }
    if (sub === "models" && method === "GET") {
      sendJson(res, 200, await hub.models(key));
      return;
    }
    if (sub === "status" && method === "GET") {
      sendJson(res, 200, { text: await hub.status(key), runtime: await hub.runtime(key) });
      return;
    }
    if (sub === "action" && method === "POST") {
      const body = await readJsonBody<{ action?: string; value?: string; cwd?: string }>(req);
      const value = String(body.value ?? "");
      let text: string;
      switch (body.action) {
        case "new":
          text = await hub.newSession(key, value || undefined);
          break;
        case "fork":
          text = await hub.fork(key);
          break;
        case "resume":
          text = (sessionVisibleTo(user)?.(value) ?? true)
            ? await hub.resume(key, value, body.cwd)
            : `找不到会话 ${value}。\n发 /sessions 看看有哪些可恢复的。`;
          break;
        case "model":
          text = await hub.setModel(key, value);
          break;
        case "effort":
          text = await hub.setEffort(key, value);
          break;
        // 换专家（开新会话）：只有飞书的对话能换，网页上的 hub 会拒绝
        case "agent":
          text = await hub.setExpert(key, value, allowedAgentsFor(key));
          break;
        case "stop":
          text = await hub.stop(key);
          break;
        // 打断并发送：value 是排队中那条消息的编号
        case "jump":
          text = await hub.jump(key, value);
          break;
        case "cd":
          text = await hub.cd(key, value);
          break;
        default:
          throw new HttpError(400, "未知操作");
      }
      // 飞书会话上的操作，在飞书里也说一声
      if (conv.channel !== "web") hub.notice(key, `💻 Web：${text}`);
      sendJson(res, 200, { text, info: hub.info(key) });
      return;
    }
  }

  // ----- 设置 -----
  if (p === "/api/config" && method === "GET") {
    sendJson(res, 200, { ...(publicConfig() as object), network: networkInfo(req) });
    return;
  }
  if (p === "/api/config" && method === "PUT") {
    const input = await readJsonBody<Partial<AppConfig>>(req);
    await applyListen(req, input.web);
    applyConfig(input, typeof req.headers.origin === "string" ? req.headers.origin : undefined);
    sendJson(res, 200, { ...(publicConfig() as object), network: networkInfo(req) });
    return;
  }
  // 侧栏的账号额度：各 agent 自己缓存（60 秒），这里并发问一遍，单个失败 / 超时不影响别的
  if (p === "/api/server/version" && method === "GET") {
    sendJson(res, 200, await versionInfo(url.searchParams.get("refresh") === "1"));
    return;
  }
  if (p === "/api/server/upgrade" && method === "POST") {
    sendJson(res, 200, await upgrade().catch((err) => {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }));
    return;
  }
  if (p === "/api/agents/codex/install" && method === "POST") {
    const result = await installCodex();
    if (result.ok) useInstalledCodex();
    invalidateHealth();
    sendJson(res, 200, result);
    return;
  }
  if (p === "/api/agents/health" && method === "GET") {
    sendJson(res, 200, { agents: await agentHealth(url.searchParams.get("refresh") === "1") });
    return;
  }
  if (p === "/api/usage" && method === "GET") {
    // 按天的 token / 费用账（设置 →「用量」）。?from=&to= 是 YYYY-MM-DD（含两头）。
    // 管理员看所有人的（只有数字，看不到内容），成员只看自己对话的
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    if (!day.test(from) || !day.test(to)) throw new HttpError(400, "from / to 要是 YYYY-MM-DD");
    const admin = isAdmin(user);
    const rows = dailyUsage(from, to, admin ? undefined : (owner) => ownedBy(user, owner));
    const names: Record<string, string> = {};
    for (const r of rows) if (r.owner && !(r.owner in names)) names[r.owner] = getUser(r.owner)?.name ?? "已删除的用户";
    sendJson(res, 200, { rows, users: names, admin });
    return;
  }
  if (p === "/api/quota" && method === "GET") {
    // ?agent=claude,codex：只问这几个。桌面端连着多台同账号的服务器时，同一个账号只在一台上问
    // 设置里关了查额度：不去问任何 agent
    if (!config().web.quotaEnabled) {
      sendJson(res, 200, { quotas: [], at: Date.now(), disabled: true });
      return;
    }
    const only = url.searchParams.get("agent")?.split(",").filter(Boolean);
    const results = await Promise.all(
      hub.enabledAgents().filter((d) => !only || only.includes(d.id)).map(async (d) => {
        if (!d.quota) return null;
        try {
          const quota = await Promise.race([
            d.quota(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000).unref()),
          ]);
          return quota ? { agent: d.id, label: d.label, ...quota } : null;
        } catch {
          return null;
        }
      }),
    );
    sendJson(res, 200, { quotas: results.filter(Boolean), at: Date.now() });
    return;
  }
  {
    // 设置页的模型下拉框：不需要会话。
    // 未启用的 agent 不去问 —— Codex 的 app-server 一问就会被拉起来常驻，违背「未启用」
    const m = /^\/api\/agents\/([a-z0-9_-]+)\/models$/.exec(p);
    if (m && method === "GET") {
      const driver = hub.enabledAgents().find((d) => d.id === m[1]);
      if (!driver) {
        sendJson(res, 409, { error: "未启用，启用并保存后可下拉选择" });
        return;
      }
      // defaults：没显式选模型 / 思考程度时实际会用的，输入框据此直接显示模型名而不是「默认」
      const defaults = await driver.defaults().catch(() => ({}));
      sendJson(res, 200, { models: await driver.catalog(), defaults });
      return;
    }
  }
  {
    // 命令表（含隐藏项）。带 key 时按那条会话的目录读（项目里可能有自己的命令），
    // Web 输入框补全用；不带 key 是设置页排序用。
    const m = /^\/api\/agents\/([a-z0-9_-]+)\/commands$/.exec(p);
    if (m && method === "GET") {
      if (!(AGENT_IDS as readonly string[]).includes(m[1]!)) {
        sendJson(res, 404, { error: `没有 agent「${m[1]}」` });
        return;
      }
      const found = getConversation(url.searchParams.get("key") ?? "");
      const conv = found && visible(found) ? found : undefined;
      const draftCwd = !conv && url.searchParams.get("cwd");
      const cwd = conv?.cwd ?? (draftCwd ? resolveWorkspacePath(draftCwd) : undefined);
      if (draftCwd && !cwd) throw new HttpError(404, "工作目录不存在，或不在工作区之内");
      const commands = await hub.commandCatalog(m[1]!, {
        ...(cwd ? { cwd } : {}),
        allowedAgents: hub.enabledAgents().map((d) => d.id),
        // 输入框（包括尚未创建的新对话）只列 Web 能用的；设置页仍列全部
        ...(conv || url.searchParams.get("channel") === "web" ? { channel: "web" } : {}),
        // 成员看不到机器上装的技能
        ...(admin ? {} : { member: true }),
      });
      sendJson(res, 200, { commands });
      return;
    }
  }
  if (p === "/api/password" && method === "POST") {
    // 改自己的密码：自己所有设备下线，当前这台换一个新的登录态
    const body = await readJsonBody<{ old?: string; password?: string }>(req);
    const left = takeAttempt(ip);
    if (left) throw new HttpError(429, `尝试次数太多，请 ${Math.ceil(left / 60000)} 分钟后再试`);
    if (!verifyPassword(String(body.old ?? ""), user.passwordHash)) throw new HttpError(403, "原密码不对");
    clearAttempts(ip);
    userOp(() => setUserPassword(user.id, String(body.password ?? "")));
    newSession(req, res, user.id);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (p === "/api/web-sessions" && method === "GET") {
    // 管理员看所有人的设备，成员只看自己的
    sendJson(res, 200, listWebSessions(admin ? undefined : user.id));
    return;
  }
  if (p === "/api/web-sessions/revoke" && method === "POST") {
    const body = await readJsonBody<{ id?: string }>(req);
    sendJson(res, 200, { ok: revokeSession(String(body.id ?? ""), admin ? undefined : user.id) });
    return;
  }

  // ----- 我的记忆：每个人只能看、改自己的 -----
  if (p === "/api/account/memory" && method === "GET") {
    const meta = readMeta(user.id);
    sendJson(res, 200, {
      ...readMemory(user.id),
      limits: MEMORY_LIMITS,
      // 等着整理的对话有几段、上次整理的结果（设置页显示）
      pending: pendingCount(user.id),
      ...(meta.lastCuration ? { lastCuration: meta.lastCuration } : {}),
    });
    return;
  }
  if (p === "/api/account/memory/curate" && method === "POST") {
    // 「现在整理」：聊完了的对话合起来整理一次。要等模型回来，可能要几十秒
    const log = await curateNow(user.id);
    sendJson(res, 200, log);
    return;
  }
  if (p === "/api/account/memory" && method === "PUT") {
    const body = await readJsonBody<{ enabled?: boolean; about?: string; curate?: Partial<CurateSettings>; chatHistory?: boolean }>(req);
    sendJson(
      res,
      200,
      memoryOp(user.id, () =>
        setMemoryOptions(user.id, {
          ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
          ...(typeof body.about === "string" ? { about: body.about } : {}),
          ...(body.curate && typeof body.curate === "object" ? { curate: body.curate } : {}),
          ...(typeof body.chatHistory === "boolean" ? { chatHistory: body.chatHistory } : {}),
        }),
        typeof body.enabled === "boolean" || typeof body.about === "string" || typeof body.chatHistory === "boolean",
      ),
    );
    return;
  }
  if (p === "/api/account/history" && method === "GET") {
    // 只给数量：索引里有多少句、来自多少段对话
    const records = readRecords(user.id);
    sendJson(res, 200, { count: records.length, conversations: new Set(records.map((r) => r.k)).size });
    return;
  }
  if (p === "/api/account/history" && method === "DELETE") {
    // 清掉聊天记录索引。不再回填：清了就是不想让以前的聊天被搜到，只记以后的
    purgeHistory(user.id);
    writeMeta(user.id, { backfilled: true, extracted: {} });
    sendJson(res, 200, { ok: true });
    return;
  }
  if (p === "/api/account/memory" && method === "DELETE") {
    memoryOp(user.id, () => clearMemory(user.id));
    sendJson(res, 200, readMemory(user.id));
    return;
  }
  if (p === "/api/account/memory/items" && method === "POST") {
    const body = await readJsonBody<{ text?: string }>(req);
    sendJson(res, 200, memoryOp(user.id, () => addMemoryItem(user.id, String(body.text ?? ""), "user")));
    return;
  }
  {
    const m = /^\/api\/account\/memory\/items\/(m_[a-f0-9]+)$/.exec(p);
    if (m && method === "PATCH") {
      const body = await readJsonBody<{ text?: string }>(req);
      sendJson(res, 200, memoryOp(user.id, () => updateMemoryItem(user.id, m[1]!, String(body.text ?? ""))));
      return;
    }
    if (m && method === "DELETE") {
      sendJson(res, 200, { ok: !!memoryOp(user.id, () => removeMemoryItem(user.id, m[1]!)) });
      return;
    }
  }

  // ----- 我的飞书账号绑定 -----
  if (p === "/api/account/feishu" && method === "GET") {
    sendJson(res, 200, {
      links: feishuLinksOf(user.id),
      // 能私聊的机器人（发 /bind 用）。机器人的配置细节照旧只给管理员
      bots: config().feishu.bots.filter((b) => b.enabled).map((b) => ({ id: b.id, name: b.name })),
    });
    return;
  }
  if (p === "/api/account/feishu/code" && method === "POST") {
    sendJson(res, 200, createLinkCode(user.id));
    return;
  }
  if (p === "/api/account/feishu" && method === "DELETE") {
    const body = await readJsonBody<{ botId?: string; openId?: string }>(req);
    const botId = String(body.botId ?? "");
    const ok = unlink(botId, String(body.openId ?? ""), user.id);
    if (ok) releaseFeishuChats(user.id, botId);
    sendJson(res, 200, { ok, links: feishuLinksOf(user.id) });
    return;
  }

  // ----- 用户管理（管理员） -----
  if (p === "/api/users" && method === "GET") {
    const devices = listWebSessions();
    sendJson(res, 200, {
      users: listUsers().map((u) => ({
        ...u,
        devices: devices.filter((d) => d.userId === u.id).length,
        // 只给数量：管理员不能看成员的记忆和绑定的是哪个飞书账号
        feishuLinks: listLinks(u.id).length,
      })),
      me: user.id,
    });
    return;
  }
  {
    // 管理员能做的只有「清掉」：清空某人的记忆、解除某人的飞书绑定。看不到内容
    const m = /^\/api\/users\/([A-Za-z0-9_]+)\/(memory|feishu)$/.exec(p);
    if (m && method === "DELETE") {
      const id = m[1]!;
      if (!getUser(id)) throw new HttpError(404, "用户不存在");
      if (m[2] === "memory") {
        clearMemory(id);
        hub.memoryChanged(id);
        sendJson(res, 200, { ok: true });
      } else {
        const n = unlinkUser(id);
        releaseFeishuChats(id);
        sendJson(res, 200, { ok: true, removed: n });
      }
      return;
    }
  }
  if (p === "/api/users" && method === "POST") {
    const body = await readJsonBody<{ name?: string; password?: string; role?: Role }>(req);
    sendJson(
      res,
      200,
      userOp(() => createUser({ name: String(body.name ?? ""), password: String(body.password ?? ""), role: body.role === "admin" ? "admin" : "member" })),
    );
    return;
  }
  const userMatch = /^\/api\/users\/([A-Za-z0-9_]+)$/.exec(p);
  if (userMatch) {
    const id = userMatch[1]!;
    if (!getUser(id)) throw new HttpError(404, "用户不存在");
    if (method === "PATCH") {
      const body = await readJsonBody<{ name?: string; role?: Role; disabled?: boolean; password?: string; remote?: boolean }>(req);
      if (id === user.id && (body.disabled === true || (body.role !== undefined && body.role !== "admin"))) {
        throw new HttpError(400, "不能停用自己，也不能取消自己的管理员");
      }
      // 一次改完：密码不合格时别的也不改。重置密码 / 停用会让他的设备全部下线
      const updated = userOp(() =>
        patchUser(id, {
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          ...(body.role === "admin" || body.role === "member" ? { role: body.role } : {}),
          ...(typeof body.disabled === "boolean" ? { disabled: body.disabled } : {}),
          ...(typeof body.password === "string" ? { password: body.password } : {}),
          ...(typeof body.remote === "boolean" ? { remote: body.remote } : {}),
        }),
      );
      // 管理员在用户列表里重置了自己的密码：当前这台换个新登录态，别把自己踢出去
      if (id === user.id && typeof body.password === "string") newSession(req, res, user.id);
      sendJson(res, 200, updated);
      return;
    }
    if (method === "DELETE") {
      if (id === user.id) throw new HttpError(400, "不能删除自己");
      // 升级前没记主人的推送订阅算在最早的管理员名下：删人之前先记下是谁
      const legacy = legacyOwnerId();
      const removed = userOp(() => removeUser(id));
      removeSubscriptionsOf((owner) => (owner ?? legacy) === id);
      revokeUserSessions(id);
      // 记忆和飞书绑定一起删：不像会话那样转给管理员（见 core/personal.ts）
      releaseFeishuChats(id);
      purgeUserData(id);
      hub.memoryChanged(id);
      sendJson(res, 200, removed);
      return;
    }
  }
  if (p === "/api/pairing" && method === "GET") {
    sendJson(res, 200, { pending: listPending(), approved: listApproved() });
    return;
  }
  if (p === "/api/pairing/approve" && method === "POST") {
    const body = await readJsonBody<{ code?: string }>(req);
    const result = approve(String(body.code ?? ""));
    if (!result.ok) throw new HttpError(404, "配对码不存在或已过期");
    sendJson(res, 200, result);
    return;
  }
  if (p === "/api/pairing/revoke" && method === "POST") {
    const body = await readJsonBody<{ channelId?: string; userId?: string }>(req);
    sendJson(res, 200, { ok: revoke(String(body.channelId ?? ""), String(body.userId ?? "")) });
    return;
  }
  if (p === "/api/claude/allowlist" && method === "GET") {
    sendJson(res, 200, listAllowlist());
    return;
  }
  if (p === "/api/claude/allowlist" && method === "PUT") {
    const body = await readJsonBody<{ list?: string[] }>(req);
    setAllowlist(Array.isArray(body.list) ? body.list.map(String) : []);
    sendJson(res, 200, listAllowlist());
    return;
  }
  if (p === "/api/feishu/slash" && method === "GET") {
    sendJson(res, 200, { bots: feishuBots().map((b) => ({ id: b.id, name: b.cfg.name, status: b.slash.status })) });
    return;
  }
  if (p === "/api/feishu/slash/sync" && method === "POST") {
    for (const b of feishuBots()) b.slash.request(0);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (p === "/api/feishu/targets" && method === "GET") {
    // 「在飞书继续」能选的地方：每个运行中的机器人，以及它聊过的聊天
    const bots = await Promise.all(
      feishuBots().map(async (b) => ({ id: b.id, name: b.cfg.name, state: b.status.state, chats: await b.knownChats() })),
    );
    sendJson(res, 200, { bots });
    return;
  }
  if (p === "/api/feishu/status" && method === "GET") {
    sendJson(res, 200, feishuBots().map((b) => ({ id: b.id, name: b.cfg.name, ...b.status })));
    return;
  }
  if (p === "/api/feishu/test" && method === "POST") {
    const body = await readJsonBody<{ id?: string; appId?: string; appSecret?: string; domain?: string }>(req);
    const old = config().feishu.bots.find((b) => b.id === body.id);
    const secret = !body.appSecret || body.appSecret.startsWith(MASK) ? old?.appSecret : body.appSecret;
    if (!body.appId || !secret) throw new HttpError(400, "缺少 App ID 或 App Secret");
    const probe = await new FeishuClient(body.appId, secret, body.domain === "lark" ? "lark" : "feishu", "测试").probe();
    sendJson(res, 200, probe);
    return;
  }
  if (p === "/api/feishu/register" && method === "POST") {
    const body = await readJsonBody<{ name?: string; agents?: string[] }>(req);
    sendJson(res, 200, await startRegistration(String(body.name ?? ""), Array.isArray(body.agents) ? body.agents : []));
    return;
  }
  const regMatch = /^\/api\/feishu\/register\/([a-f0-9]+)$/.exec(p);
  if (regMatch && method === "GET") {
    const reg = registrations.get(regMatch[1]!);
    if (!reg) throw new HttpError(404, "注册会话不存在或已过期");
    sendJson(res, 200, { status: reg.status, message: reg.message, botId: reg.botId });
    return;
  }
  if (p === "/api/system" && method === "GET") {
    sendJson(res, 200, {
      version: process.env.npm_package_version ?? "0.1.0",
      node: process.version,
      uptimeMs: Date.now() - startedAt,
      pid: process.pid,
      underSystemd: !!process.env.INVOCATION_ID,
    });
    return;
  }
  if (p === "/api/system/restart" && method === "POST") {
    if (!process.env.INVOCATION_ID) throw new HttpError(400, "当前不是以系统服务运行，重启后不会自动拉起。请在终端里手动重启。");
    sendJson(res, 200, { ok: true });
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 300);
    return;
  }

  throw new HttpError(404, "没有这个接口");
}
