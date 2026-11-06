// WorkBuddy 的账号：查登没登录、网页登录。
//
// 登录用 SDK 的 unstable_v2_authenticate：CLI 给一个登录链接，用户在自己的浏览器里打开、登录完，
// 拿到的令牌由这边保存（见 sdk.ts 的 saveAuth），之后起 CLI 时交给它。不用到服务器的终端里操作。
// 同一时间只跑一个登录流程；再点一次「登录」就复用还没过期的那个链接。
import { baseOptions, environment, loadSdk, savedAuth, saveAuth, withProbe, workbuddyEnv } from "./sdk.js";

export type WorkBuddyAccount = { loggedIn: boolean; account?: string };

/** 读账号：没登录时 accountInfo 是个空对象 */
export async function readAccount(): Promise<WorkBuddyAccount> {
  const info = (await withProbe((q) => q.accountInfo())) as Record<string, unknown>;
  const pick = (k: string) => (typeof info[k] === "string" && info[k] ? (info[k] as string) : undefined);
  const who = pick("email") ?? pick("userName") ?? pick("userNickname") ?? pick("organization");
  const apiKey = pick("apiKeySource");
  const token = pick("tokenSource");
  // 用令牌登录时 CLI 的 accountInfo 是空的（实测），以这边存的为准
  const saved = savedAuth();
  const envKey = process.env.CODEBUDDY_API_KEY || process.env.CODEBUDDY_AUTH_TOKEN;
  const loggedIn = !!(who || apiKey || (token && token !== "none") || saved || envKey);
  const account = who
    ? `${who}${pick("subscriptionType") ? `（${pick("subscriptionType")}）` : ""}`
    : apiKey
      ? `API Key（${apiKey}）`
      : saved
        ? saved.user
        : envKey
          ? "环境变量里的 API Key"
          : undefined;
  return { loggedIn, ...(account ? { account } : {}) };
}

export type LoginState =
  | { status: "idle" }
  | { status: "waiting"; url: string; startedAt: number }
  | { status: "done"; user: string; at: number }
  | { status: "failed"; error: string; at: number };

const LOGIN_TIMEOUT = 5 * 60_000;
/** CLI 自己只等 1 分钟：这之后再点登录要换新链接，不能复用 */
const LINK_TTL = 55_000;
let state: LoginState = { status: "idle" };
let onDone: (() => void) | null = null;

export function loginState(): LoginState {
  return state;
}

/** 登录成功后要做的（清体检缓存之类），由调用方注册 */
export function onLoginDone(fn: () => void): void {
  onDone = fn;
}

/** 开始登录，拿到链接就返回（不等用户登完）。已经在等的就直接给那个链接 */
export async function startLogin(): Promise<string> {
  if (state.status === "waiting" && Date.now() - state.startedAt < LINK_TTL) return state.url;
  const { unstable_v2_authenticate } = await loadSdk();
  return new Promise<string>((resolve, reject) => {
    let gotUrl = false;
    const site = environment();
    const { environment: authEnv, pathToCodebuddyCode } = baseOptions();
    unstable_v2_authenticate({
      ...(authEnv ? { environment: authEnv } : {}),
      ...(pathToCodebuddyCode ? { pathToCodebuddyCode } : {}),
      env: workbuddyEnv() as Record<string, string>,
      timeout: LOGIN_TIMEOUT,
      onAuthUrl: (s) => {
        gotUrl = true;
        state = { status: "waiting", url: s.authUrl, startedAt: Date.now() };
        resolve(s.authUrl);
      },
    })
      .then((r) => {
        const u = r.userinfo;
        const user = u.userNickname || u.userName || u.userId;
        if (u.token) saveAuth(site, { token: u.token, user, at: Date.now() });
        state = { status: "done", user, at: Date.now() };
        console.log(`[workbuddy] 已登录：${state.user}`);
        onDone?.();
      })
      .catch((err) => {
        const raw = err instanceof Error ? err.message : String(err);
        // CLI 发出登录链接后只等 1 分钟（它自己定的，SDK 的 timeout 管不到），超时报的是 canceled / Authentication failed
        const msg = /cancel|authentication failed/i.test(raw) ? "1 分钟内没有完成登录，链接已失效" : raw;
        state = { status: "failed", error: msg, at: Date.now() };
        if (!gotUrl) reject(err instanceof Error ? err : new Error(msg));
      });
  });
}

export async function logout(): Promise<void> {
  const { unstable_v2_logout } = await loadSdk();
  const { environment: authEnv, pathToCodebuddyCode } = baseOptions();
  saveAuth(environment(), null);
  await unstable_v2_logout({ ...(authEnv ? { environment: authEnv } : {}), ...(pathToCodebuddyCode ? { pathToCodebuddyCode } : {}), env: workbuddyEnv() as Record<string, string> }).catch(() => {});
  state = { status: "idle" };
  onDone?.();
}
