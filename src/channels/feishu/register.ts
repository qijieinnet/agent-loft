// 飞书应用注册：OAuth device-code flow。
//
// 扫码后一次拿全 appId / appSecret / 扫码人的 open_id，用户不用去开发者后台
// 手抄任何东西。协议端点与字段取自飞书 accounts 域的 app registration 接口。
import QRCode from "qrcode";

export type FeishuDomain = "feishu" | "lark";

const ACCOUNTS_URL: Record<FeishuDomain, string> = {
  feishu: "https://accounts.feishu.cn",
  lark: "https://accounts.larksuite.com",
};
const REGISTRATION_PATH = "/oauth/v1/app/registration";
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_EXPIRE_SECONDS = 600;

export type RegistrationResult = {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
  openId?: string;
};

export type BeginResult = {
  deviceCode: string;
  qrUrl: string;
  userCode: string;
  interval: number;
  expireIn: number;
};

export type PollOutcome =
  | { status: "success"; result: RegistrationResult }
  | { status: "access_denied" }
  | { status: "expired" }
  | { status: "timeout" }
  | { status: "error"; message: string };

type InitResponse = { nonce?: string; supported_auth_methods?: string[] };
type BeginResponse = {
  device_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  user_code: string;
  interval: number;
  expire_in: number;
};
type PollResponse = {
  client_id?: string;
  client_secret?: string;
  user_info?: { open_id?: string; tenant_brand?: FeishuDomain };
  error?: string;
  error_description?: string;
};

async function post<T>(domain: FeishuDomain, body: Record<string, string>): Promise<T> {
  const res = await fetch(`${ACCOUNTS_URL[domain]}${REGISTRATION_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // 待授权/错误状态也会以 4xx + JSON body 返回，所以不按状态码抛错。
  return (await res.json()) as T;
}

/** 第一步：确认当前环境支持 client_secret 认证。 */
export async function initRegistration(domain: FeishuDomain = "feishu"): Promise<void> {
  const res = await post<InitResponse>(domain, { action: "init" });
  if (!res.supported_auth_methods?.includes("client_secret")) {
    throw new Error("当前环境不支持 client_secret 认证方式");
  }
}

/** 第二步：开始设备码流程，拿到给用户扫的二维码地址。 */
export async function beginRegistration(domain: FeishuDomain = "feishu"): Promise<BeginResult> {
  const res = await post<BeginResponse>(domain, {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  });

  const url = new URL(res.verification_uri_complete);
  // 只接受飞书/Lark 自家域名，避免响应被污染后把用户引到别处
  if (!/(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname)) {
    throw new Error(`拒绝非飞书域名的验证地址：${url.hostname}`);
  }

  return {
    deviceCode: res.device_code,
    qrUrl: url.toString(),
    userCode: res.user_code,
    interval: Number.isFinite(res.interval) ? res.interval : DEFAULT_POLL_INTERVAL_SECONDS,
    expireIn: Number.isFinite(res.expire_in) ? res.expire_in : DEFAULT_EXPIRE_SECONDS,
  };
}

const sleep = (seconds: number) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(1, seconds) * 1000));

/** 第三步：轮询直到用户在手机上确认。会根据 tenant_brand 自动切换 feishu/lark 域。 */
export async function pollRegistration(params: {
  deviceCode: string;
  interval: number;
  expireIn: number;
  domain?: FeishuDomain;
  onTick?: (secondsLeft: number) => void;
}): Promise<PollOutcome> {
  let domain: FeishuDomain = params.domain ?? "feishu";
  let interval = params.interval;
  let domainSwitched = false;
  const deadline = Date.now() + params.expireIn * 1000;

  while (Date.now() < deadline) {
    let res: PollResponse;
    try {
      res = await post<PollResponse>(domain, {
        action: "poll",
        device_code: params.deviceCode,
        tp: "ob_cli_app",
      });
    } catch {
      await sleep(interval); // 网络抖动，继续轮询
      continue;
    }

    // 租户在 Lark 侧时自动换域重试一次
    if (!domainSwitched && res.user_info?.tenant_brand === "lark") {
      domain = "lark";
      domainSwitched = true;
      continue;
    }

    if (res.client_id && res.client_secret) {
      return {
        status: "success",
        result: {
          appId: res.client_id,
          appSecret: res.client_secret,
          domain,
          ...(res.user_info?.open_id ? { openId: res.user_info.open_id } : {}),
        },
      };
    }

    if (res.error === "slow_down") interval += 5;
    else if (res.error === "access_denied") return { status: "access_denied" };
    else if (res.error === "expired_token") return { status: "expired" };
    else if (res.error && res.error !== "authorization_pending") {
      return { status: "error", message: `${res.error}: ${res.error_description ?? "未知错误"}` };
    }

    params.onTick?.(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
    await sleep(interval);
  }

  return { status: "timeout" };
}

/** 终端里打印二维码。必须无边框输出，加了装饰框会破坏识别。 */
export async function printQrCode(url: string): Promise<void> {
  const output = await QRCode.toString(url, { type: "terminal", small: true });
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}

/** 给 Web 页面用的二维码（SVG 字符串）。 */
export async function qrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { type: "svg", margin: 1, width: 240 });
}
