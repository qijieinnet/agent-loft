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
import { getConversation, updateConversation } from "../../core/store.js";
import { resolveUploadFile, saveBuffer, sniff } from "../../core/uploads.js";
import type { SavedAttachment } from "../../core/types.js";
import { listAllowlist, setAllowlist } from "../../agents/claude/permissions.js";
import { agentAvailability, agentHealth, invalidateHealth } from "../../agents/health.js";
import { installCodex, upgrade, useInstalledCodex, versionInfo } from "../../core/upgrade.js";
import { feishuBots } from "../feishu/index.js";
import { beginRegistration, initRegistration, pollRegistration, qrSvg } from "../feishu/register.js";
import { FeishuClient } from "../feishu/client.js";
import {
  checkSetupToken,
  clearAttempts,
  createSession,
  destroySession,
  hasPassword,
  listSessions as listWebSessions,
  takeAttempt,
  revokeSession,
  setPassword,
  validateSession,
  verifyPassword,
} from "./auth.js";
import { clientIp, cookies, HttpError, isHttps, readBody, readJsonBody, SECURITY_HEADERS, sendJson } from "./http.js";
import { addSubscription, listSubscriptions, pushToAll, removeSubscription, vapidPublicKey } from "./push.js";

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

function serveUpload(res: ServerResponse, requested: string, download: boolean): void {
  const file = requested ? resolveUploadFile(requested) : undefined;
  if (!file) throw new HttpError(404, "文件不存在（可能会话重置时已清理）");
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
    web: { ...cfg.web, passwordHash: undefined, hasPassword: !!config().web.passwordHash },
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
    const { passwordHash: _ignored, ...web } = input.web as AppConfig["web"];
    next.web = { ...next.web, ...web, passwordHash: current.web.passwordHash };
    const q = Number(next.web.quotaRefreshMin);
    next.web.quotaRefreshMin = Number.isFinite(q) ? Math.max(0, Math.min(1440, Math.round(q))) : 10;
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
  return !!validateSession(cookies(req)[COOKIE]);
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
    sendJson(res, 200, { authed: authed(req), needsSetup: !hasPassword() });
    return;
  }
  if (p === "/api/setup" && method === "POST") {
    if (hasPassword()) throw new HttpError(400, "已经设置过密码了");
    const body = await readJsonBody<{ token?: string; password?: string }>(req);
    const left = takeAttempt(ip);
    if (left) throw new HttpError(429, `尝试次数太多，请 ${Math.ceil(left / 60000)} 分钟后再试`);
    if (!checkSetupToken(String(body.token ?? ""))) {
      throw new HttpError(403, "设置码不对。它打印在 agent-loft 的启动日志里");
    }
    setPassword(String(body.password ?? ""));
    clearAttempts(ip);
    setCookie(req, res, createSession(ip, String(req.headers["user-agent"] ?? "")), 30 * 24 * 3600);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (p === "/api/login" && method === "POST") {
    const body = await readJsonBody<{ password?: string }>(req);
    const left = takeAttempt(ip);
    if (left) throw new HttpError(429, `尝试次数太多，请 ${Math.ceil(left / 60000)} 分钟后再试`);
    if (!hasPassword() || !verifyPassword(String(body.password ?? ""), config().web.passwordHash)) {
      throw new HttpError(403, "密码不对");
    }
    clearAttempts(ip);
    setCookie(req, res, createSession(ip, String(req.headers["user-agent"] ?? "")), 30 * 24 * 3600);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (p === "/api/logout" && method === "POST") {
    destroySession(cookies(req)[COOKIE]);
    setCookie(req, res, "", 0);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!authed(req)) throw new HttpError(401, "请先登录");

  // ----- 附件预览 / 下载：只给上传目录里的文件 -----
  if (p === "/api/file" && method === "GET") {
    serveUpload(res, url.searchParams.get("path") ?? "", url.searchParams.get("download") === "1");
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
      bots: config().feishu.bots.map((b) => ({ id: b.id, name: b.name, agents: b.agents, enabled: b.enabled })),
      workspaceRoot: config().workspaceRoot,
      quotaRefreshMin: config().web.quotaRefreshMin,
      conversations: hub.list(),
      pending: interactions.listPending(),
      serverTime: Date.now(),
    });
    return;
  }

  // ----- 系统通知（Web Push） -----
  if (p === "/api/push" && method === "GET") {
    sendJson(res, 200, { publicKey: vapidPublicKey(), subscriptions: listSubscriptions() });
    return;
  }
  if (p === "/api/push/subscribe" && method === "POST") {
    const body = await readJsonBody<{ subscription?: unknown }>(req);
    try {
      const record = addSubscription(body.subscription, String(req.headers["user-agent"] ?? ""));
      sendJson(res, 200, { ok: true, label: record.label });
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    return;
  }
  if (p === "/api/push/unsubscribe" && method === "POST") {
    const body = await readJsonBody<{ endpoint?: string }>(req);
    sendJson(res, 200, { ok: removeSubscription(String(body.endpoint ?? "")) });
    return;
  }
  if (p === "/api/push/test" && method === "POST") {
    const sent = await pushToAll({ title: "Agent Loft", body: "测试通知：能看到这条，说明通知已经通了。", tag: "test", url: "/" });
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
    sendJson(res, 200, hub.list());
    return;
  }
  if (p === "/api/conversations" && method === "POST") {
    const body = await readJsonBody<{ agent?: string; cwd?: string }>(req);
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
    hub.ensure({ key, channel: "web", channelId: "web", defaultAgent: agent });
    if (cwd && cwd !== config().workspaceRoot) updateConversation(key, { cwd, cwdExplicit: true });
    sendJson(res, 200, hub.info(key));
    return;
  }

  const convMatch = /^\/api\/conversations\/([^/]+)(?:\/([a-z-]+))?$/.exec(p);
  if (convMatch) {
    const key = decodeURIComponent(convMatch[1]!);
    const sub = convMatch[2];
    const conv = conversationOr404(key);

    if (!sub && method === "PATCH") {
      const body = await readJsonBody<{ title?: string; hidden?: boolean }>(req);
      updateConversation(key, {
        ...(typeof body.title === "string" ? { title: body.title.trim().slice(0, 80) } : {}),
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
      hub.emitEvent(key, { type: "meta" });
      sendJson(res, 200, { ok: true });
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
      const newKey = await hub.forkConversation(key, anchor);
      sendJson(res, 200, { info: hub.info(newKey) });
      return;
    }
    if (sub === "sessions" && method === "GET") {
      sendJson(res, 200, await hub.sessions(key, url.searchParams.get("all") === "1"));
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
          text = await hub.resume(key, value, body.cwd);
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
    sendJson(res, 200, publicConfig());
    return;
  }
  if (p === "/api/config" && method === "PUT") {
    applyConfig(await readJsonBody<Partial<AppConfig>>(req));
    sendJson(res, 200, publicConfig());
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
      const conv = getConversation(url.searchParams.get("key") ?? "");
      const commands = await hub.commandCatalog(m[1]!, {
        ...(conv ? { cwd: conv.cwd } : {}),
        allowedAgents: hub.enabledAgents().map((d) => d.id),
      });
      sendJson(res, 200, { commands });
      return;
    }
  }
  if (p === "/api/password" && method === "POST") {
    const body = await readJsonBody<{ old?: string; password?: string }>(req);
    const left = takeAttempt(ip);
    if (left) throw new HttpError(429, `尝试次数太多，请 ${Math.ceil(left / 60000)} 分钟后再试`);
    if (!verifyPassword(String(body.old ?? ""), config().web.passwordHash)) throw new HttpError(403, "原密码不对");
    clearAttempts(ip);
    setPassword(String(body.password ?? ""));
    setCookie(req, res, createSession(ip, String(req.headers["user-agent"] ?? "")), 30 * 24 * 3600);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (p === "/api/web-sessions" && method === "GET") {
    sendJson(res, 200, listWebSessions());
    return;
  }
  if (p === "/api/web-sessions/revoke" && method === "POST") {
    const body = await readJsonBody<{ id?: string }>(req);
    sendJson(res, 200, { ok: revokeSession(String(body.id ?? "")) });
    return;
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
