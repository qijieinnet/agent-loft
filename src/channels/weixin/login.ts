// 微信扫码登录：Web 上发起，服务端在后台轮询，页面每隔两秒来取一次状态。
//
// 手机可能要求输入屏幕上显示的数字（need_verifycode），这时轮询停下来等页面把数字交上来。
// 手机上提示「运行环境存在风险」时服务端不会有任何状态变化，所以这种情况只能靠界面上的说明。
import crypto from "node:crypto";
import QRCode from "qrcode";
import { bindWeixinAccount, getWeixinAccount } from "../../core/weixin-accounts.js";
import { DEFAULT_ILINK_BASE_URL, fetchQrCode, pollQrStatus } from "./client.js";

export type LoginState = "wait" | "scaned" | "need_verifycode" | "verify_wrong" | "confirmed" | "already" | "failed";

export type LoginView = { id: string; state: LoginState; qrUrl: string; qrSvg: string; message?: string };

type Session = LoginView & {
  userId: string;
  stop: AbortController;
  verifyCode?: string;
  /** 等验证码时挂在这里，交上来就继续 */
  wake?: () => void;
};

/** 官方插件的上限：一轮登录最多 8 分钟，二维码最多换 3 次 */
const LOGIN_TIMEOUT_MS = 8 * 60_000;
const MAX_QR_REFRESH = 3;
/** 结束之后留一会儿，页面还要来取结果 */
const KEEP_FINISHED_MS = 5 * 60_000;

const sessions = new Map<string, Session>();

const svgOf = (url: string): Promise<string> => QRCode.toString(url, { type: "svg", margin: 1, width: 240 });

const view = ({ id, state, qrUrl, qrSvg, message }: Session): LoginView => ({ id, state, qrUrl, qrSvg, ...(message ? { message } : {}) });

function finish(session: Session, state: LoginState, message?: string): void {
  session.state = state;
  if (message) session.message = message;
  session.wake?.();
  setTimeout(() => sessions.delete(session.id), KEEP_FINISHED_MS).unref?.();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(session: Session, qrcodeFirst: string): Promise<void> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let qrcode = qrcodeFirst;
  let baseUrl = DEFAULT_ILINK_BASE_URL;
  let refreshes = 1;
  const signal = session.stop.signal;

  const refresh = async (): Promise<boolean> => {
    refreshes++;
    if (refreshes > MAX_QR_REFRESH) return false;
    const account = getWeixinAccount(session.userId);
    const next = await fetchQrCode(account ? [account.botToken] : []);
    qrcode = next.qrcode;
    baseUrl = DEFAULT_ILINK_BASE_URL;
    session.qrUrl = next.qrcodeUrl;
    session.qrSvg = await svgOf(next.qrcodeUrl);
    session.state = "wait";
    return true;
  };

  while (Date.now() < deadline && !signal.aborted) {
    const code: string | undefined = session.verifyCode;
    const status = await pollQrStatus(baseUrl, qrcode, code, signal);
    switch (status.status) {
      case "wait":
        break;
      case "scaned":
        // 带着验证码还能回 scaned：数字对了
        session.verifyCode = undefined;
        session.state = "scaned";
        break;
      case "scaned_but_redirect":
        if (status.redirect_host) baseUrl = `https://${status.redirect_host}`;
        session.state = "scaned";
        break;
      case "need_verifycode":
        session.state = code ? "verify_wrong" : "need_verifycode";
        session.verifyCode = undefined;
        await new Promise<void>((resolve) => {
          session.wake = resolve;
          const left = Math.max(0, deadline - Date.now());
          setTimeout(resolve, left).unref?.();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        session.wake = undefined;
        continue;
      case "expired":
      case "verify_code_blocked": {
        const blocked = status.status === "verify_code_blocked";
        session.verifyCode = undefined;
        if (!(await refresh())) {
          finish(session, "failed", blocked ? "数字多次输入错误，请稍后再试。" : "二维码多次过期，请重新开始。");
          return;
        }
        if (blocked) session.message = "数字多次输入错误，已换了一个二维码。";
        break;
      }
      case "binded_redirect": {
        // 服务端认出这个微信已经连着这台 agent-loft：不发新凭据。本地有记录就算成功，没有就只能先在手机上断开
        if (getWeixinAccount(session.userId)) finish(session, "already", "这个微信已经连接，不需要重复连接。");
        else finish(session, "failed", "微信认为已经连接过，但这里没有凭据。请先在手机微信的 ClawBot 里断开连接，再重新扫码。");
        return;
      }
      case "confirmed": {
        if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id) {
          // 没有 ilink_user_id 就没法确认后面的消息是不是扫码人发的，不能先连上再说
          finish(session, "failed", "微信没有返回完整的连接信息，无法确认扫码人身份。");
          return;
        }
        bindWeixinAccount({
          userId: session.userId,
          botId: status.ilink_bot_id,
          botToken: status.bot_token,
          baseUrl: status.baseurl || DEFAULT_ILINK_BASE_URL,
          ilinkUserId: status.ilink_user_id,
        });
        finish(session, "confirmed");
        return;
      }
    }
    await sleep(1000);
  }
  if (!signal.aborted) finish(session, "failed", "等待超时，请重新开始。");
}

/** 发起一次登录。同一个人再发起，上一轮作废 */
export async function startWeixinLogin(userId: string): Promise<LoginView> {
  for (const s of sessions.values()) {
    if (s.userId === userId) {
      s.stop.abort();
      sessions.delete(s.id);
    }
  }
  const account = getWeixinAccount(userId);
  const qr = await fetchQrCode(account ? [account.botToken] : []);
  const session: Session = {
    id: crypto.randomBytes(8).toString("hex"),
    userId,
    state: "wait",
    qrUrl: qr.qrcodeUrl,
    qrSvg: await svgOf(qr.qrcodeUrl),
    stop: new AbortController(),
  };
  sessions.set(session.id, session);
  void run(session, qr.qrcode).catch((err) => {
    if (session.stop.signal.aborted) return;
    console.error("[微信] 扫码登录失败:", err instanceof Error ? err.message : err);
    finish(session, "failed", "连接微信失败，请检查网络后重试。");
  });
  return view(session);
}

/** 只有发起的人能看 */
export function weixinLoginStatus(id: string, userId: string): LoginView | undefined {
  const session = sessions.get(id);
  return session?.userId === userId ? view(session) : undefined;
}

export function submitWeixinVerifyCode(id: string, userId: string, code: string): boolean {
  const session = sessions.get(id);
  if (session?.userId !== userId || (session.state !== "need_verifycode" && session.state !== "verify_wrong")) return false;
  session.verifyCode = code;
  session.state = "scaned";
  session.wake?.();
  return true;
}

export function cancelWeixinLogin(id: string, userId: string): void {
  const session = sessions.get(id);
  if (session?.userId !== userId) return;
  session.stop.abort();
  sessions.delete(id);
}

export function stopWeixinLogins(): void {
  for (const s of sessions.values()) s.stop.abort();
  sessions.clear();
}
