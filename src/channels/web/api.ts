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
import {
  createUser,
  getUser,
  isAdmin,
  legacyOwnerId,
  listUsers,
  removeUser,
  verifyLogin,
  verifyPassword,
  type Role,
  type User,
} from "../../core/users.js";
import type { SavedAttachment } from "../../core/types.js";
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
import { purgeHistory, readMeta, readRecords, writeMeta } from "../../core/chat-history.js";
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
import { clientIp, cookies, HttpError, isHttps, readBody, readJsonBody, SECURITY_HEADERS, sendJson } from "./http.js";
import { addSubscription, listSubscriptions, pushToAll, removeSubscription, removeSubscriptionsOf, vapidPublicKey } from "./push.js";

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
  };
}

function applyConfig(input: Partial<AppConfig>): void {
  const current = config();
  const next = structuredClone(current);
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
      workspaceRoot: config().workspaceRoot,
      quotaRefreshMin: config().web.quotaRefreshMin,
      quotaEnabled: config().web.quotaEnabled,
      conversations: hub.list(visible),
      pending: interactions.listPending().filter((i) => visible(getConversation(i.convKey))),
      user: publicMe(user),
      serverTime: Date.now(),
    });
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

  // ----- 目录选择器：列工作区内的子目录 -----
  if (p === "/api/dirs" && method === "GET") {
    const listing = listWorkspaceDirs(url.searchParams.get("path") ?? "");
    if (!listing) throw new HttpError(404, `目录不存在，或不在 ${config().workspaceRoot} 之内`);
    sendJson(res, 200, listing);
    return;
  }

  // ----- 会话 -----
  if (p === "/api/conversations" && method === "GET") {
    sendJson(res, 200, hub.list(visible));
    return;
  }
  if (p === "/api/conversations" && method === "POST") {
    const body = await readJsonBody<{ agent?: string; cwd?: string; mode?: string }>(req);
    const enabled = hub.enabledAgents().map((d) => d.id);
    const agent = body.agent && enabled.includes(body.agent) ? body.agent : enabled[0];
    if (!agent) throw new HttpError(400, "没有可用的 agent");
    // 新对话发第一条消息前在页面上选的工作目录；和 /cd 一样只能在工作区之内
    let cwd: string | null = null;
    if (typeof body.cwd === "string" && body.cwd.trim()) {
      cwd = resolveWorkspacePath(body.cwd.trim());
      if (!cwd) throw new HttpError(400, `目录必须存在，且在 ${config().workspaceRoot} 之内`);
    }
    const key = `web:${crypto.randomBytes(6).toString("hex")}`;
    hub.ensure({ key, channel: "web", channelId: "web", defaultAgent: agent, owner: user.id });
    if (cwd && cwd !== config().workspaceRoot) updateConversation(key, { cwd, cwdExplicit: true });
    // 新对话页上选的模式
    if (body.mode === "chat") updateConversation(key, { mode: "chat" });
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
      const liveUser = live.find((e) => e.ev.type === "user")?.ev as { text?: string } | undefined;
      if (liveUser) {
        const lastUser = messages.map((m) => m.role).lastIndexOf("user");
        const norm = (t: string) => t.replace(/\s+/g, " ").trim();
        const want = norm(liveUser.text ?? "");
        if (lastUser >= 0 && want && norm(messages[lastUser]!.text).startsWith(want.slice(0, 200))) {
          messages = messages.slice(0, lastUser);
        }
      }
      sendJson(res, 200, {
        info: hub.info(key),
        messages,
        live,
        seq,
        pending: interactions.listPending(key),
        allowedAgents: allowedAgentsFor(key),
        serverTime: Date.now(),
      });
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
        case "agent":
          text = await hub.setAgent(key, value, allowedAgentsFor(key));
          break;
        case "stop":
          text = await hub.stop(key);
          break;
        case "cd":
          text = await hub.cd(key, value);
          break;
        case "mode":
          if (value !== "chat" && value !== "work") throw new HttpError(400, "模式只能是 chat 或 work");
          text = await hub.setMode(key, value);
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
    applyConfig(input);
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
      const commands = await hub.commandCatalog(m[1]!, {
        ...(conv ? { cwd: conv.cwd } : {}),
        allowedAgents: hub.enabledAgents().map((d) => d.id),
        // 带 key 是输入框补全：只列 Web 能用的；不带是设置页排序，全列
        ...(conv ? { channel: "web" } : {}),
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
      const body = await readJsonBody<{ name?: string; role?: Role; disabled?: boolean; password?: string }>(req);
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
