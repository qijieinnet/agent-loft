// pi 的订阅账号登录（OAuth）搬到网页上：后台跑 ModelRuntime.login(provider, "oauth")，
// 它要的交互（选登录方式、填企业域名、粘贴回调地址）和给的提示（登录链接、设备码、进度）都记成一份状态，
// 网页轮询这份状态、把用户的回答交回来。整台服务器同一时间只有一个登录在跑。
//
// 服务器上通常没有浏览器：「浏览器登录」时 pi 在服务器的 127.0.0.1 上等回调，用户的浏览器在别的机器上回调不到，
// 这时 pi 会让人把浏览器最后跳到的地址（或授权码）粘贴回来 —— 网页上就是一个输入框。设备码方式不受影响。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AGENT_DIR, modelRuntime } from "./sdk.js";

export type OAuthPrompt = {
  id: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
};

export type OAuthNotice =
  | { type: "info"; message: string; links?: { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string }
  | { type: "progress"; message: string };

export type OAuthState = {
  provider: string;
  status: "running" | "done" | "error" | "cancelled";
  notices: OAuthNotice[];
  prompt?: OAuthPrompt;
  error?: string;
  startedAt: number;
};

type Job = {
  state: OAuthState;
  abort: AbortController;
  answer?: { id: string; resolve: (v: string) => void; reject: (e: Error) => void };
  timer: NodeJS.Timeout;
};

/** 登录最多等这么久（设备码一般 15 分钟过期） */
const LOGIN_TIMEOUT_MS = 15 * 60_000;
let job: Job | null = null;
const listeners = new Set<() => void>();

/** 登录成功了（体检缓存要作废、模型列表要刷新） */
export function onOAuthDone(fn: () => void): void {
  listeners.add(fn);
}

/** 只给网页看的那部分：别把 OAuth 返回的东西带出去（这里本来也没有） */
export function oauthState(): OAuthState | null {
  return job ? structuredClone(job.state) : null;
}

/** 有的服务商（OpenAI）登录要一个固定的「这台安装」的 id：第一次用时生成，存在 data/pi/device-id */
function deviceId(): string {
  const file = path.join(AGENT_DIR, "device-id");
  try {
    const v = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f-]{36}$/i.test(v)) return v;
  } catch {
    // 第一次
  }
  const id = randomUUID();
  fs.mkdirSync(AGENT_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${id}\n`, { mode: 0o600 });
  return id;
}

/** 只放行 http(s) 链接：网页上会直接做成可点的链接 */
function safeUrl(url: string): string | undefined {
  return /^https?:\/\//i.test(url) ? url : undefined;
}

function finish(j: Job, status: OAuthState["status"], error?: string): void {
  if (j.state.status !== "running") return;
  clearTimeout(j.timer);
  j.state.status = status;
  delete j.state.prompt;
  if (error) j.state.error = error;
  j.answer?.reject(new Error(status === "cancelled" ? "已取消" : (error ?? "已结束")));
  j.answer = undefined;
  if (status === "done") for (const fn of listeners) fn();
}

export async function startOAuth(providerId: string): Promise<OAuthState> {
  const rt = await modelRuntime();
  const provider = rt.getProvider(providerId);
  const oauth = (provider as { auth?: { oauth?: unknown } } | undefined)?.auth?.oauth;
  if (!provider || !oauth) throw new Error(`${provider?.name ?? providerId} 不支持订阅账号登录`);
  if (job) cancelOAuth();
  const abort = new AbortController();
  const j: Job = {
    state: { provider: providerId, status: "running", notices: [], startedAt: Date.now() },
    abort,
    timer: setTimeout(() => {
      abort.abort();
      finish(j, "error", "登录超时了，重新开始");
    }, LOGIN_TIMEOUT_MS),
  };
  j.timer.unref?.();
  job = j;
  void rt
    .login(
      providerId,
      "oauth",
      {
        signal: abort.signal,
        prompt: (p) =>
          new Promise<string>((resolve, reject) => {
            if (j.state.status !== "running") return reject(new Error("已结束"));
            const id = randomUUID();
            j.state.prompt = {
              id,
              type: p.type,
              message: p.message,
              ...("placeholder" in p && p.placeholder ? { placeholder: p.placeholder } : {}),
              ...(p.type === "select" ? { options: p.options.map((o) => ({ id: o.id, label: o.label, ...(o.description ? { description: o.description } : {}) })) } : {}),
            };
            const clear = () => {
              if (j.state.prompt?.id === id) delete j.state.prompt;
              if (j.answer?.id === id) j.answer = undefined;
            };
            j.answer = {
              id,
              resolve: (v) => {
                clear();
                resolve(v);
              },
              reject: (e) => {
                clear();
                reject(e);
              },
            };
            // pi 自己撤掉这个问题（比如回调先到了，粘贴框就不用了）
            p.signal?.addEventListener("abort", () => j.answer?.id === id && j.answer.reject(new Error("aborted")), { once: true });
          }),
        notify: (e) => {
          if (j.state.status !== "running") return;
          const links = e.type === "info" ? (e.links ?? []).filter((l) => safeUrl(l.url)).map((l) => ({ url: l.url, ...(l.label ? { label: l.label } : {}) })) : [];
          const n: OAuthNotice | null =
            e.type === "auth_url"
              ? safeUrl(e.url)
                ? { type: "auth_url", url: e.url, ...(e.instructions ? { instructions: e.instructions } : {}) }
                : null
              : e.type === "device_code"
                ? safeUrl(e.verificationUri)
                  ? { type: "device_code", userCode: e.userCode, verificationUri: e.verificationUri }
                  : null
                : e.type === "info"
                  ? { type: "info", message: e.message, ...(links.length ? { links } : {}) }
                  : e.type === "progress"
                    ? { type: "progress", message: e.message }
                    : null;
          if (!n) return;
          // 进度只留最新一条，别越积越长
          if (n.type === "progress") j.state.notices = j.state.notices.filter((x) => x.type !== "progress");
          j.state.notices.push(n);
        },
      },
      { getDeviceId: deviceId, agentName: "agent-loft" },
    )
    .then(() => finish(j, "done"))
    .catch((err) => finish(j, abort.signal.aborted ? "cancelled" : "error", err instanceof Error ? err.message : String(err)));
  return oauthState()!;
}

/** 网页交回的回答：要对得上当前这个问题（id），对不上说明问题已经换了 */
export function answerOAuth(promptId: string, value: string): void {
  const a = job?.answer;
  if (!job || job.state.status !== "running" || !a || a.id !== promptId) throw new Error("这个问题已经过期了，刷新一下");
  const p = job.state.prompt;
  if (p?.type === "select" && !p.options?.some((o) => o.id === value)) throw new Error("选项不对");
  a.resolve(value);
}

export function cancelOAuth(): void {
  if (!job) return;
  const j = job;
  j.abort.abort();
  finish(j, "cancelled");
}

/** 测试用 */
export function resetOAuth(): void {
  if (job) cancelOAuth();
  job = null;
}
