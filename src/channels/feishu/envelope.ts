// 卡片按钮里携带的交互信封。
//
// 信任模型：信封本身是明文、不签名，它不是凭证，只是「这张卡片期望由谁、在哪、
// 在什么期限前点」的声明。真正的信任锚在服务端：
//   1. 飞书回调里的 operator.open_id 由平台签发，客户端伪造不了；
//   2. 请求 id 必须命中服务端的待处理表，且点击者要通过授权判断。
// 所以信封挡的是「同群别人替你点」「过期后补点」「卡片被转发到别的会话点」。
//
// ask 的 v 是「点完之后该是选中(1)还是未选中(0)」，而不是「切换」：飞书会重投回调，
// 切换语义在重投下不幂等。
import type { ApprovalDecision } from "../../core/types.js";

export const ENVELOPE_VERSION = "aim2";

/** k 是会话键：卡片回调里拿不到 thread_id，凡是作用于某条会话的动作都得带上它。 */
export type EnvelopeAction =
  | { a: "approval"; r: string; d: ApprovalDecision }
  | { a: "ask"; r: string; q: number; o: number; v: 0 | 1 }
  | { a: "ask-submit"; r: string }
  | { a: "ask-skip"; r: string }
  | { a: "model"; m: string; k: string }
  | { a: "effort"; f: string; k: string }
  | { a: "agent"; g: string; k: string }
  | { a: "resume"; s: string; k: string; c?: string }
  /** 命令列表卡上的「执行」：c 是命令名，不带斜杠 */
  | { a: "cmd"; c: string; k: string };

export type CardEnvelope = EnvelopeAction & {
  oc: typeof ENVELOPE_VERSION;
  /** 期望的点击人 open_id；不带表示任何授权用户都能点（比如 Web 上发起的那一轮） */
  u?: string;
  /** 期望的会话 chat_id */
  h?: string;
  /** 过期时间戳（ms） */
  e: number;
};

export type CardCtx = { operatorOpenId?: string; chatId?: string; expiresAt: number };

export type DecodeFailure = "malformed" | "stale" | "wrong_user" | "wrong_conversation" | "not_allowed";

export function createEnvelope(action: EnvelopeAction, ctx: CardCtx): CardEnvelope {
  return {
    oc: ENVELOPE_VERSION,
    ...action,
    ...(ctx.operatorOpenId ? { u: ctx.operatorOpenId } : {}),
    ...(ctx.chatId ? { h: ctx.chatId } : {}),
    e: ctx.expiresAt,
  } as CardEnvelope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeEnvelope(params: {
  value: unknown;
  operatorOpenId: string | undefined;
  chatId: string | undefined;
  isAllowed: (openId: string | undefined) => boolean;
  now?: number;
}): { ok: true; envelope: CardEnvelope } | { ok: false; reason: DecodeFailure } {
  const { value, operatorOpenId, chatId, isAllowed, now = Date.now() } = params;
  if (!isRecord(value) || value.oc !== ENVELOPE_VERSION || typeof value.a !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (typeof value.e !== "number" || !Number.isFinite(value.e)) return { ok: false, reason: "malformed" };
  if (value.e < now) return { ok: false, reason: "stale" };
  const operator = operatorOpenId?.trim().toLowerCase();
  if (typeof value.u === "string" && value.u.trim().toLowerCase() !== operator) {
    return { ok: false, reason: "wrong_user" };
  }
  if (typeof value.h === "string" && value.h.trim() !== (chatId ?? "").trim()) {
    return { ok: false, reason: "wrong_conversation" };
  }
  if (!validAction(value)) return { ok: false, reason: "malformed" };
  // 白名单是最后也是最硬的一道
  if (!isAllowed(operatorOpenId)) return { ok: false, reason: "not_allowed" };
  return { ok: true, envelope: value as CardEnvelope };
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length < 512;
const idx = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 100;

/** 每种动作的字段逐个验类型：信封是明文，别让一个畸形的值流进 agent。 */
function validAction(v: Record<string, unknown>): boolean {
  switch (v.a) {
    case "approval":
      return str(v.r) && (v.d === "allow-once" || v.d === "allow-always" || v.d === "deny");
    case "ask":
      return str(v.r) && idx(v.q) && idx(v.o) && (v.v === 0 || v.v === 1);
    case "ask-submit":
    case "ask-skip":
      return str(v.r);
    case "model":
      return str(v.m) && str(v.k);
    case "effort":
      return str(v.f) && str(v.k);
    case "agent":
      return str(v.g) && str(v.k);
    case "resume":
      return str(v.s) && str(v.k) && (v.c === undefined || str(v.c));
    case "cmd":
      // 只放行命令名该有的字符（skill 名会带冒号），别让参数、换行之类混进来
      return str(v.c) && /^[\w:.-]+$/.test(v.c) && str(v.k);
    default:
      return false;
  }
}

export const DECODE_FAILURE_TEXT: Record<DecodeFailure, string> = {
  malformed: "这个按钮的数据已损坏（或来自旧版本的卡片），请重新发起操作。",
  stale: "这张卡片已过期，请重新发起操作。",
  wrong_user: "这张卡片不是发给你的，只有发起人本人可以操作。",
  wrong_conversation: "这张卡片属于另一个会话，不能在这里操作。",
  not_allowed: "你不在这台机器的授权名单里。",
};
