// WorkBuddy（腾讯 CodeBuddy Code）官方 Agent SDK：@tencent-ai/agent-sdk。
//
// 两种用法，按「账号站点」选：
//   workbuddy（默认）：调本机 WorkBuddy 桌面版自带的 CLI。那份 CLI 带着 WorkBuddy 的产品配置
//     （站点 www.workbuddy.cn、数据目录 ~/.workbuddy、WorkBuddy 的模型），账号就是 WorkBuddy 的账号。
//     SDK 自带的那份是通用版 CodeBuddy，连的是 copilot.tencent.com / codebuddy.ai，和 WorkBuddy 账号不通。
//   internal / external / ioa：用 SDK 自带的 CLI，连 CodeBuddy 国内版、国际版、腾讯 iOA。
//
// 桌面版的登录态由它的主进程保管，不会交给单独跑的 CLI，所以在 agent-loft 里还要再登一次（同一个账号）。
// SDK 的登录接口不替你存盘：令牌在返回值里（userinfo.token），由这边存起来（data/workbuddy-auth.json，0600），
// 每次起 CLI 时用 CODEBUDDY_AUTH_TOKEN 交给它（实测：不传的话刚登完也照样报未登录）。
//
// SDK 包很大（近 200MB），按需 import：没启用 WorkBuddy 的机器启动时不加载它。
// 接口和 Claude Agent SDK 几乎一样，但没有 listSessions、getSessionMessages，会话记录得自己读（见 history.ts）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthEnvironment, Options, Query, UserMessage } from "@tencent-ai/agent-sdk";
import { agentEnvironment } from "../../core/agent-env.js";
import { config } from "../../core/config.js";
import { dataDir, readJson, writeJsonAtomic } from "../../home.js";

type Sdk = typeof import("@tencent-ai/agent-sdk");
let sdk: Promise<Sdk> | null = null;

export function loadSdk(): Promise<Sdk> {
  sdk ??= import("@tencent-ai/agent-sdk").catch((err) => {
    sdk = null;
    throw err;
  });
  return sdk;
}

/** 账号在哪个站点：WorkBuddy（桌面版的 CLI）、CodeBuddy 国内版、国际版、腾讯 iOA */
export type WorkBuddyEnvironment = "workbuddy" | "internal" | "external" | "ioa";
export const WORKBUDDY_ENVIRONMENTS: readonly WorkBuddyEnvironment[] = ["workbuddy", "internal", "external", "ioa"];
export const ENVIRONMENT_LABEL: Record<WorkBuddyEnvironment, string> = {
  workbuddy: "WorkBuddy（www.workbuddy.cn）",
  internal: "CodeBuddy 国内版（copilot.tencent.com）",
  external: "CodeBuddy 国际版（codebuddy.ai）",
  ioa: "腾讯 iOA",
};

export function environment(): WorkBuddyEnvironment {
  const env = config().agents.workbuddy.environment;
  return WORKBUDDY_ENVIRONMENTS.includes(env) ? env : "workbuddy";
}

/** WorkBuddy 桌面版里 CLI 的常见位置（Linux deb / AppImage 解包、macOS、Windows） */
function desktopCandidates(): string[] {
  const rel = ["resources", "app.asar.unpacked", "cli", "bin", "codebuddy"];
  const local = process.env.LOCALAPPDATA;
  return [
    path.join("/opt/WorkBuddy", ...rel),
    path.join("/usr/lib/workbuddy", ...rel),
    path.join("/Applications/WorkBuddy.app/Contents", ...rel.map((p) => (p === "resources" ? "Resources" : p))),
    path.join(os.homedir(), "Applications/WorkBuddy.app/Contents", ...rel.map((p) => (p === "resources" ? "Resources" : p))),
    ...(local ? [path.join(local, "Programs", "WorkBuddy", ...rel)] : []),
  ];
}

/** 桌面版的 CLI：设置里填了就用填的，否则在常见位置找。找不到返回 undefined */
export function desktopCli(): string | undefined {
  const configured = config().agents.workbuddy.cliPath?.trim();
  if (configured) return fs.existsSync(configured) ? configured : undefined;
  return desktopCandidates().find((p) => fs.existsSync(p));
}

/** 用哪个 CLI：WorkBuddy 站点用桌面版的（找不到就报错，不悄悄换成 CodeBuddy 的），别的用 SDK 自带的 */
export function cliPath(): string | undefined {
  if (environment() !== "workbuddy") return undefined;
  const found = desktopCli();
  if (!found) throw new Error("找不到 WorkBuddy 桌面版的 CLI：先装好 WorkBuddy 桌面版，或者在 设置 → Agent → WorkBuddy 里填 CLI 路径");
  return found;
}

// ---------- 登录令牌 ----------

type SavedAuth = { token: string; user: string; at: number };
const authFile = path.join(dataDir, "workbuddy-auth.json");

/** 各站点的令牌分开存：换了站点就是另一个账号 */
export function savedAuth(env = environment()): SavedAuth | undefined {
  const all = readJson<Record<string, SavedAuth>>(authFile, {});
  const a = all[env];
  return a && typeof a.token === "string" && a.token ? a : undefined;
}

export function saveAuth(env: WorkBuddyEnvironment, auth: SavedAuth | null): void {
  const all = readJson<Record<string, SavedAuth>>(authFile, {});
  if (auth) all[env] = auth;
  else delete all[env];
  writeJsonAtomic(authFile, all, 0o600);
}

/**
 * 交给 CLI 的环境变量。CodeBuddy 的站点由 CODEBUDDY_INTERNET_ENVIRONMENT 决定：国际版不设，国内版 internal，iOA 是 ioa；
 * WorkBuddy 的站点写在桌面版 CLI 自己的产品配置里，什么都不设。服务进程里设了 CODEBUDDY_API_KEY 的话 CLI 自己会用。
 */
export function workbuddyEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env = environment();
  const base = agentEnvironment();
  delete base.CODEBUDDY_INTERNET_ENVIRONMENT;
  const site = env === "internal" || env === "ioa" ? { CODEBUDDY_INTERNET_ENVIRONMENT: env } : {};
  // 服务进程自己设了 API Key / 令牌的，以它为准
  const token = base.CODEBUDDY_API_KEY || base.CODEBUDDY_AUTH_TOKEN ? undefined : savedAuth(env)?.token;
  return { ...base, ...site, ...(token ? { CODEBUDDY_AUTH_TOKEN: token } : {}), ...extra };
}

/** 每个 query / 会话都要带的：用哪个 CLI、站点、环境变量 */
export function baseOptions(extraEnv?: Record<string, string>): Pick<Options, "environment" | "env" | "pathToCodebuddyCode"> {
  const env = environment();
  const cli = cliPath();
  return {
    ...(env === "workbuddy" ? {} : { environment: env as AuthEnvironment }),
    ...(cli ? { pathToCodebuddyCode: cli } : {}),
    env: workbuddyEnv(extraEnv),
  };
}

/**
 * CLI 的配置和会话记录目录。桌面版的 CLI 单独跑时也用 ~/.codebuddy（~/.workbuddy 是桌面版主程序给它另设的，
 * 这边不设：不和桌面版抢同一份数据）
 */
export function codebuddyHome(): string {
  return process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), ".codebuddy");
}

/** 永远不产出消息的输入流：只问控制请求（模型列表、账号）用 */
async function* silence(): AsyncGenerator<UserMessage> {
  await new Promise<never>(() => {});
}

/** 「探针」：拉一个不发消息的 CLI 进程，问完控制请求就关。不发消息就不耗额度 */
export async function withProbe<T>(fn: (q: Query) => Promise<T>, cwd = os.homedir()): Promise<T> {
  const { query } = await loadSdk();
  const abort = new AbortController();
  const q = query({ prompt: silence(), options: { cwd, ...baseOptions(), abortController: abort } });
  try {
    return await fn(q);
  } finally {
    abort.abort();
  }
}

/**
 * query 运行时报的模型是 { id, name }，类型声明里写的是 { value, displayName }，V2 会话给的是 { modelId, name }：都认
 */
export function modelOf(m: unknown): { id: string; label: string; description?: string } | null {
  const r = (m ?? {}) as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : typeof r.modelId === "string" ? r.modelId : typeof r.value === "string" ? r.value : "";
  if (!id) return null;
  const label = typeof r.name === "string" && r.name ? r.name : typeof r.displayName === "string" && r.displayName ? r.displayName : id;
  const description = typeof r.description === "string" && r.description ? r.description : undefined;
  return { id, label, ...(description ? { description } : {}) };
}
