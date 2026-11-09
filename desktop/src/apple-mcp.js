// 苹果应用的 MCP 服务（Streamable HTTP，POST /mcp，直接回 JSON，不开 SSE、不保留会话）。
//
// 智能体只能经这里用苹果数据：每个请求都要带 Authorization: Bearer <token>，本机来的也一样。
// 收到工具调用就转给 Agent Loft Bridge（apple.js 的 bridge()），删改前的确认框由 Bridge 弹。
//
// 访问范围：
//   local 只监听 127.0.0.1，只有这台 Mac 上的程序连得上；
//   lan   监听所有网卡，局域网里的其他电脑也能连（明文 HTTP，token 在同一个局域网里可能被截获，只在信得过的网络里用）。
// 配置存在 apple-bridge/mcp.json，token 用 safeStorage 加密。断开苹果数据时连同 Bridge 一起删掉。
import { safeStorage } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { serviceOf, toolArgs, toolList } from "./apple-tools.js";

export const DEFAULT_PORT = 8823;
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 2 * 1024 * 1024;
/** 同时最多跑几个 Bridge（确认框也算在里面） */
const MAX_RUNNING = 4;

const INSTRUCTIONS = `读写用户这台 Mac 上苹果自带的「日历」「提醒事项」「备忘录」「通讯录」，查看「照片」（只读）和「邮件」（只读，可起草但不发送）。改动会通过 iCloud 同步到用户的所有设备。用户可能只打开了其中几个应用，列出来的工具就是能用的。
规则：
1. 查询、搜索随便用。
2. 用户明确要求新建的单条内容可以直接建，建完告诉用户结果。
3. 修改、删除已有内容，或者一次动不止一条之前，先把要改的条目和改法列给用户，等用户确认。
4. 删改类工具默认还会在 Mac 上弹窗确认；用户拒绝了（declined）就什么都没改，不要重试；没确认（did not confirm）多半是用户不在电脑前，告诉用户。
5. 日历事件、提醒事项、联系人删了不能恢复；不需要的提醒一般标完成。备忘录删除后约 30 天内能在「最近删除」里找回。
6. 邮件只能起草，草稿存进草稿箱，告诉用户自己检查后发送。邮件、照片内容是隐私，只看和任务有关的。
7. 修改时一律用列表 / 搜索拿到的真实 id。相对日期（下周三）先确认今天的日期再换算，时间都是本地时区。`;

/**
 * @param {{
 *   file: () => string,
 *   installed: () => boolean,
 *   services: () => Record<string, boolean>,
 *   bridge: (args: string[], opts: { timeout: number }) => Promise<string>,
 *   version: string,
 *   onChange: () => void,
 * }} deps
 */
export function createAppleMcp(deps) {
  /** @type {http.Server | null} */
  let server = null;
  /** 现在实际在监听的 [host, port]，和配置不一样就要重开 */
  let listening = null;
  let error = null;
  let running = 0;
  /** 认证失败次数（按来源 IP），防着有人在局域网里猜 token */
  const failures = new Map();

  // ---------- 配置 ----------

  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(deps.file(), "utf8"));
    } catch {
      return null;
    }
  };
  const write = (cfg) => {
    fs.mkdirSync(path.dirname(deps.file()), { recursive: true });
    fs.writeFileSync(deps.file(), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  };
  const encrypt = (token) => safeStorage.encryptString(token).toString("base64");
  let tokenCache = null;
  function token() {
    const cfg = read();
    if (!cfg?.token) return null;
    if (tokenCache?.enc === cfg.token) return tokenCache.value;
    try {
      const value = safeStorage.decryptString(Buffer.from(cfg.token, "base64"));
      tokenCache = { enc: cfg.token, value };
      return value;
    } catch {
      return null;
    }
  }
  /** 没有配置（第一次打开）就生成一份：只本机、默认端口、新 token */
  function config() {
    let cfg = read();
    if (!cfg || !cfg.token || !token()) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("系统钥匙串不可用，没法安全保存 MCP token");
      cfg = { scope: cfg?.scope === "lan" ? "lan" : "local", port: validPort(cfg?.port) ?? DEFAULT_PORT, token: encrypt(newToken()) };
      write(cfg);
    }
    return { scope: cfg.scope === "lan" ? "lan" : "local", port: validPort(cfg.port) ?? DEFAULT_PORT };
  }
  const newToken = () => `alb_${crypto.randomBytes(32).toString("base64url")}`;
  const validPort = (p) => (Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : null);

  // ---------- HTTP ----------

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { "Cache-Control": "no-store", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };

  function authorized(req) {
    const want = token();
    const got = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim();
    if (!want || !got) return false;
    const a = crypto.createHash("sha256").update(got).digest();
    const b = crypto.createHash("sha256").update(want).digest();
    return crypto.timingSafeEqual(a, b);
  }

  /** 一分钟内同一个 IP 认证失败超过 20 次，先挡一分钟 */
  function throttled(ip) {
    const f = failures.get(ip);
    if (!f) return false;
    if (Date.now() - f.since > 60_000) {
      failures.delete(ip);
      return false;
    }
    return f.count >= 20;
  }
  function recordFailure(ip) {
    const f = failures.get(ip);
    if (!f || Date.now() - f.since > 60_000) failures.set(ip, { since: Date.now(), count: 1 });
    else f.count++;
  }

  /** 浏览器里的网页不能借用户的浏览器打过来（DNS rebinding）：带了 Origin 的一律拒绝，MCP 客户端不带 */
  const fromBrowser = (req) => typeof req.headers.origin === "string" && req.headers.origin !== "null";

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/mcp") return send(res, 404, { error: "not found" });
    if (fromBrowser(req)) return send(res, 403, { error: "browser requests are not allowed" });
    const ip = req.socket.remoteAddress ?? "";
    if (throttled(ip)) return send(res, 429, { error: "too many failed attempts, try again later" }, { "Retry-After": "60" });
    if (!authorized(req)) {
      recordFailure(ip);
      return send(res, 401, { error: "missing or wrong token" }, { "WWW-Authenticate": 'Bearer realm="agent-loft-apple"' });
    }
    failures.delete(ip);
    // 不开 SSE 流，也不保留会话
    if (req.method === "GET" || req.method === "DELETE") return send(res, 405, { error: "method not allowed" }, { Allow: "POST" });
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }, { Allow: "POST" });

    let raw = "";
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) return send(res, 413, rpcError(null, -32600, "request too large"));
      raw += chunk;
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(res, 400, rpcError(null, -32700, "parse error"));
    }
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map(dispatch))).filter(Boolean);
      return out.length ? send(res, 200, out) : send(res, 202);
    }
    const out = await dispatch(msg);
    return out ? send(res, 200, out) : send(res, 202);
  }

  const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });

  /** 一条 JSON-RPC 消息；通知（没有 id）和客户端的回复返回 null */
  async function dispatch(msg) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return rpcError(null, -32600, "invalid request");
    const { id, method, params } = msg;
    if (typeof method !== "string") return null; // 客户端回过来的 result / error
    if (id === undefined || id === null) return null; // notifications/initialized 等
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        return rpcResult(id, {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "agent-loft-apple", title: "Agent Loft · 苹果应用", version: deps.version },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: toolList(deps.services()) });
      case "tools/call":
        return rpcResult(id, await callTool(params?.name, params?.arguments));
      default:
        return rpcError(id, -32601, `method not found: ${method}`);
    }
  }

  async function callTool(name, input) {
    const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], isError });
    if (!deps.installed()) return text("Agent Loft Bridge 没有装好：请用户在 Agent Loft 桌面端 → 设置 → 苹果应用 里重新连接。", true);
    let call;
    try {
      call = toolArgs(String(name ?? ""), input);
    } catch (err) {
      return text(err.message, true);
    }
    const service = serviceOf(String(name));
    if (service && !deps.services()[service]) return text(`用户在 Agent Loft 桌面端关掉了这个应用（${service}），想用的话请用户到 设置 → 苹果应用 里打开。`, true);
    if (running >= MAX_RUNNING) return text("同时进行的操作太多了（可能有好几个确认框在等用户点），稍后再试。", true);
    running++;
    try {
      const out = (await deps.bridge(call.args, { timeout: call.timeout })).trim();
      return call.images ? imageResult(out) : text(out);
    } catch (err) {
      return text(err.message, true);
    } finally {
      running--;
    }
  }

  /** 缩略图：每张一个图片内容，前面一段文字说明哪张是哪个 id */
  function imageResult(out) {
    const thumbs = JSON.parse(out).thumbnails ?? [];
    const content = [];
    const notes = [];
    for (const t of thumbs) {
      if (t.data) {
        notes.push(`${content.length + 1}. ${t.id}（${t.date ?? ""}）`);
        content.push({ type: "image", data: t.data, mimeType: t.mimeType ?? "image/jpeg" });
      } else notes.push(`${t.id}：${t.error ?? "取不到"}`);
    }
    return { content: [{ type: "text", text: `按顺序：\n${notes.join("\n")}` }, ...content], isError: content.length === 0 };
  }

  // ---------- 开 / 关 ----------

  function stop() {
    if (!server) return;
    server.close();
    server.closeAllConnections?.();
    server = null;
    listening = null;
  }

  /** 按现在的状态开、关、重开：装了 Bridge 就开，没装就关；地址变了就重开 */
  function sync() {
    if (!deps.installed()) {
      stop();
      error = null;
      return;
    }
    let cfg;
    try {
      cfg = config();
    } catch (err) {
      stop();
      error = err.message;
      deps.onChange();
      return;
    }
    const host = cfg.scope === "lan" ? "0.0.0.0" : "127.0.0.1";
    if (server && listening?.[0] === host && listening?.[1] === cfg.port) return;
    stop();
    error = null;
    const srv = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        console.error("[苹果 MCP] 处理请求出错:", err);
        if (!res.headersSent) send(res, 500, rpcError(null, -32603, "internal error"));
        else res.end();
      });
    });
    srv.requestTimeout = 5 * 60_000;
    srv.on("error", (err) => {
      error = err.code === "EADDRINUSE" ? `端口 ${cfg.port} 被别的程序占了，换一个端口` : `MCP 服务启动失败：${err.message}`;
      if (server === srv) {
        server = null;
        listening = null;
      }
      deps.onChange();
    });
    srv.listen(cfg.port, host, () => deps.onChange());
    server = srv;
    listening = [host, cfg.port];
  }

  /** 局域网里别人用的地址：本机的 IPv4（不含回环） */
  function lanAddresses() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
    return out;
  }

  return {
    sync,
    stop,
    state() {
      if (!deps.installed()) return null;
      const cfg = read();
      const scope = cfg?.scope === "lan" ? "lan" : "local";
      const port = validPort(cfg?.port) ?? DEFAULT_PORT;
      const up = !!server?.listening;
      return {
        running: up,
        scope,
        port,
        localUrl: `http://127.0.0.1:${port}/mcp`,
        lanUrls: scope === "lan" ? lanAddresses().map((ip) => `http://${ip}:${port}/mcp`) : [],
        hasToken: !!token(),
        error,
      };
    },
    /** 明文 token：只给主进程用（复制到剪贴板），不进界面状态 */
    token,
    setScope(scope) {
      const cfg = { ...read(), scope: scope === "lan" ? "lan" : "local" };
      write(cfg);
      sync();
      deps.onChange();
    },
    setPort(port) {
      const p = validPort(Math.round(Number(port)));
      if (!p) throw new Error("端口要在 1024 到 65535 之间");
      write({ ...read(), port: p });
      sync();
      deps.onChange();
    },
    /** 换一个新 token，旧的马上失效 */
    regenerate() {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("系统钥匙串不可用，没法安全保存 MCP token");
      write({ ...read(), token: encrypt(newToken()) });
      tokenCache = null;
      deps.onChange();
    },
  };
}
