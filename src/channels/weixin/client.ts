// 微信 iLink Bot 协议的薄客户端。协议见腾讯的 docs/protocol.md：
// https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
//
// 几条和普通 HTTP 接口不一样的地方：
//   - HTTP 200 不代表成功，业务结果看 ret / errcode；
//   - sendmessage 返回 ret=0 也只表示「接口受理了」，不保证手机收到。微信可能静默限制账号或消息，
//     这时通常没有 message_id（见 Tencent/openclaw-weixin#278、#280）；
//   - message_id 是 uint64，超过 JS 安全整数，要在 JSON.parse 之前转成字符串。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ILINK_BASE_URL = process.env.AGENT_LOFT_ILINK_BASE_URL || "https://ilinkai.weixin.qq.com";

/** 对齐的官方插件协议版本。服务端可能按它判断能力，所以这里写协议版本，不写 agent-loft 自己的版本 */
const PROTOCOL_VERSION = "2.4.10";
const ILINK_APP_ID = "bot";
const BOT_TYPE = "3";

const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const LIGHT_TIMEOUT_MS = 10_000;

/** 会话已失效（bot_token 不能用了），要重新扫码 */
export const SESSION_EXPIRED = -14;

function clientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((p) => parseInt(p, 10));
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function loftVersion(): string {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    return (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: string }).version ?? "0";
  } catch {
    return "0";
  }
}

const baseInfo = { channel_version: PROTOCOL_VERSION, bot_agent: `agent-loft/${loftVersion()}` };

function commonHeaders(): Record<string, string> {
  return { "iLink-App-Id": ILINK_APP_ID, "iLink-App-ClientVersion": String(clientVersion(PROTOCOL_VERSION)) };
}

function jsonHeaders(token?: string): Record<string, string> {
  const uin = crypto.randomBytes(4).readUInt32BE(0);
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(String(uin), "utf8").toString("base64"),
    ...commonHeaders(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** 业务层失败：HTTP 通了，但 ret / errcode 不是 0 */
export class IlinkError extends Error {
  constructor(
    readonly endpoint: string,
    readonly ret: number | undefined,
    readonly errcode: number | undefined,
    readonly errmsg: string | undefined,
  ) {
    super(`${endpoint} ret=${ret ?? "-"} errcode=${errcode ?? "-"} ${errmsg ?? ""}`.trim());
    this.name = "IlinkError";
  }

  get sessionExpired(): boolean {
    return this.ret === SESSION_EXPIRED || this.errcode === SESSION_EXPIRED;
  }
}

/** 把 uint64 的消息编号转成字符串再解析。JSON 字符串里的引号都带转义，这个正则碰不到正文 */
export function parseIlinkJson<T>(raw: string): T {
  const text = raw.trim();
  if (!text) return {} as T;
  return JSON.parse(text.replace(/"(message_id|msg_id|svr_id)"(\s*:\s*)(\d+)/g, '"$1"$2"$3"')) as T;
}

function endpointUrl(baseUrl: string, endpoint: string): string {
  return new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

async function request<T>(url: string, init: RequestInit, label: string, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, { ...init, signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
  const raw = await res.text();
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
  return parseIlinkJson<T>(raw);
}

export type WeixinMessageItem = {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
};

export type WeixinMessage = {
  message_id?: string | number;
  from_user_id?: string;
  to_user_id?: string;
  group_id?: string;
  message_type?: number;
  item_list?: WeixinMessageItem[];
  context_token?: string;
};

type BaseResp = { ret?: number; errcode?: number; errmsg?: string };
export type GetUpdatesResp = BaseResp & { msgs?: WeixinMessage[]; get_updates_buf?: string; longpolling_timeout_ms?: number };
type SendResp = BaseResp & { message_id?: string };
type ConfigResp = BaseResp & { typing_ticket?: string };

export const isTimeout = (err: unknown): boolean => err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");

export class IlinkClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private post<T>(endpoint: string, body: object, label: string, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    return request<T>(
      endpointUrl(this.baseUrl, `ilink/bot/${endpoint}`),
      { method: "POST", headers: jsonHeaders(this.token), body: JSON.stringify({ ...body, base_info: baseInfo }) },
      label,
      timeoutMs,
      signal,
    );
  }

  /** 长轮询。业务错误原样返回，由轮询循环决定退避还是暂停 */
  getUpdates(buf: string, timeoutMs = LONG_POLL_TIMEOUT_MS, signal?: AbortSignal): Promise<GetUpdatesResp> {
    return this.post<GetUpdatesResp>("getupdates", { get_updates_buf: buf }, "getupdates", timeoutMs, signal);
  }

  /** 发一条文字。ret 不是 0 时抛 IlinkError。confirmed=false：接口受理了但没给 message_id，可能没送到 */
  async sendText(params: { to: string; text: string; contextToken: string; clientId: string }): Promise<{ confirmed: boolean; messageId?: string }> {
    const resp = await this.post<SendResp>(
      "sendmessage",
      {
        msg: {
          from_user_id: "",
          to_user_id: params.to,
          client_id: params.clientId,
          message_type: 2,
          message_state: 2,
          context_token: params.contextToken,
          item_list: [{ type: 1, text_item: { text: params.text } }],
        },
      },
      "sendmessage",
      API_TIMEOUT_MS,
    );
    if ((resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0)) {
      throw new IlinkError("sendmessage", resp.ret, resp.errcode, resp.errmsg);
    }
    return resp.message_id ? { confirmed: true, messageId: String(resp.message_id) } : { confirmed: false };
  }

  async typingTicket(userId: string, contextToken: string): Promise<string | undefined> {
    const resp = await this.post<ConfigResp>("getconfig", { ilink_user_id: userId, context_token: contextToken }, "getconfig", LIGHT_TIMEOUT_MS);
    return resp.ret === 0 || resp.ret === undefined ? resp.typing_ticket || undefined : undefined;
  }

  async sendTyping(userId: string, ticket: string, typing: boolean): Promise<void> {
    await this.post("sendtyping", { ilink_user_id: userId, typing_ticket: ticket, status: typing ? 1 : 2 }, "sendtyping", LIGHT_TIMEOUT_MS);
  }

  async notifyStart(): Promise<void> {
    await this.post("msg/notifystart", {}, "notifystart", LIGHT_TIMEOUT_MS);
  }

  async notifyStop(): Promise<void> {
    await this.post("msg/notifystop", {}, "notifystop", LIGHT_TIMEOUT_MS);
  }
}

export function newClientId(): string {
  return `agent-loft:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

// ---------- 扫码登录 ----------

export type QrCode = { qrcode: string; qrcodeUrl: string };

export type QrStatus = {
  status: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect" | "need_verifycode" | "verify_code_blocked" | "binded_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
};

/** localTokens：这个用户手上已有的 bot token，服务端据此判断是不是重复绑定 */
export async function fetchQrCode(localTokens: string[], baseUrl = DEFAULT_ILINK_BASE_URL): Promise<QrCode> {
  const resp = await request<{ qrcode?: string; qrcode_img_content?: string }>(
    endpointUrl(baseUrl, `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`),
    { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ local_token_list: localTokens.slice(0, 10) }) },
    "get_bot_qrcode",
    API_TIMEOUT_MS,
  );
  if (!resp.qrcode || !resp.qrcode_img_content) throw new Error("微信没有返回二维码");
  return { qrcode: resp.qrcode, qrcodeUrl: resp.qrcode_img_content };
}

/** 长轮询扫码状态。超时和网络错误都当作还在等：手机上的操作不会因为这边断一下就没了 */
export async function pollQrStatus(baseUrl: string, qrcode: string, verifyCode?: string, signal?: AbortSignal): Promise<QrStatus> {
  const query = `qrcode=${encodeURIComponent(qrcode)}${verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : ""}`;
  try {
    return await request<QrStatus>(
      endpointUrl(baseUrl, `ilink/bot/get_qrcode_status?${query}`),
      { method: "GET", headers: commonHeaders() },
      "get_qrcode_status",
      LONG_POLL_TIMEOUT_MS,
      signal,
    );
  } catch (err) {
    if (signal?.aborted) throw err;
    return { status: "wait" };
  }
}
