// Agent 环境体检：装没装、登没登录、怎么修。给 Web 设置页和桌面端的「Agent 环境」用。
//
// 修复办法只给命令（给人看、给人复制），这里不替人执行：安装要联网、登录要在浏览器里点，
// 都得在用户眼皮底下的终端里做。
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { agentEnvironment } from "../core/agent-env.js";
import { config } from "../core/config.js";
import { withProbe } from "./claude/probe.js";
import { onLoginDone, readAccount } from "./workbuddy/account.js";
import { desktopCli, ENVIRONMENT_LABEL, environment } from "./workbuddy/sdk.js";

const require = createRequire(import.meta.url);

export type AgentFix = {
  action: "install" | "login";
  /** 能在网页上直接完成（WorkBuddy 的浏览器登录）：设置页给按钮，不用去终端 */
  web?: boolean;
  title: string;
  /** 每一条是一种做法，任选其一（比如 Homebrew 和 npm 两种装法） */
  commands: string[];
  note?: string;
};

export type AgentHealth = {
  id: "claude" | "codex" | "workbuddy";
  label: string;
  enabled: boolean;
  installed: boolean;
  version?: string;
  /** null：判断不了（探测出错、超时） */
  loggedIn: boolean | null;
  account?: string;
  problem?: string;
  fix?: AgentFix;
};

function run(cmd: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(cmd, args, { env: agentEnvironment(env ?? process.env), stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: -1, out: err instanceof Error ? err.message : String(err) });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, out: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out: out.trim() });
    });
  });
}

function timeout<T>(ms: number, what: string): Promise<T> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}超时`)), ms).unref());
}

function quote(p: string): string {
  return /^[\w./-]+$/.test(p) ? p : `"${p.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** 登录用哪个 claude：系统里装了 Claude Code 就用它，否则用 SDK 自带的那份（同一个程序） */
export function claudeBinary(): string {
  if (spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).stdout.trim()) return "claude";
  try {
    const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`;
    return path.join(path.dirname(require.resolve(pkg)), "claude");
  } catch {
    return "claude";
  }
}

async function claudeHealth(): Promise<AgentHealth> {
  const base = { id: "claude" as const, label: "Claude Code", enabled: config().agents.claude.enabled, installed: true };
  const loginFix: AgentFix = {
    action: "login",
    title: "登录 Claude",
    commands: [quote(claudeBinary())],
    note: "打开后输入 /login，按提示在浏览器里登录，完成后输入 /exit。用 API Key 的话，把 ANTHROPIC_API_KEY 写进服务端的环境变量也行。",
  };
  try {
    const info = await Promise.race([withProbe((q) => q.accountInfo()), timeout<never>(25_000, "读取 Claude 账号")]);
    const thirdParty = info.apiProvider && info.apiProvider !== "firstParty";
    const loggedIn = !!(info.email || info.apiKeySource || thirdParty || (info.tokenSource && info.tokenSource !== "none"));
    const account = info.email
      ? `${info.email}${info.subscriptionType ? `（${info.subscriptionType}）` : ""}`
      : info.apiKeySource
        ? `API Key（${info.apiKeySource}）`
        : thirdParty
          ? String(info.apiProvider)
          : undefined;
    return { ...base, loggedIn, ...(account ? { account } : {}), ...(loggedIn ? {} : { fix: loginFix }) };
  } catch (err) {
    return { ...base, loggedIn: null, problem: err instanceof Error ? err.message : String(err), fix: loginFix };
  }
}

async function codexHealth(): Promise<AgentHealth> {
  const cfg = config().agents.codex;
  const base = { id: "codex" as const, label: "Codex", enabled: cfg.enabled };
  const env = { ...process.env, ...(cfg.home ? { CODEX_HOME: cfg.home } : {}) };
  const ver = await run(cfg.path, ["--version"], 10_000, env);
  if (ver.code !== 0) {
    return {
      ...base,
      installed: false,
      loggedIn: null,
      problem: `找不到 ${cfg.path}`,
      fix: {
        action: "install",
        title: "安装 Codex",
        commands: ["brew install --cask codex", "npm install -g @openai/codex"],
        note: "有 Homebrew 用第一条，否则用第二条（需要 Node.js）。agent-loft 以系统服务运行时 PATH 很短，装好后在下面把「codex 可执行文件」填成绝对路径（终端里 command -v codex 可以查到）。",
      },
    };
  }
  const version = ver.out.split("\n")[0]?.trim();
  const st = await run(cfg.path, ["login", "status"], 10_000, env);
  const loggedIn = st.code === 0 && !/not logged in/i.test(st.out);
  return {
    ...base,
    installed: true,
    ...(version ? { version } : {}),
    loggedIn,
    ...(loggedIn ? { account: st.out.split("\n")[0]?.trim() } : {}),
    ...(loggedIn ? {} : { fix: { action: "login" as const, title: "登录 Codex", commands: [`${quote(cfg.path)} login`], note: "会打开浏览器，用 ChatGPT 账号登录；也可以 codex login --with-api-key 用 API Key。" } }),
  };
}

/** WorkBuddy：SDK 自带 CLI，装了 agent-loft 就有；登录在网页上点 */
async function workbuddyHealth(): Promise<AgentHealth> {
  const base = { id: "workbuddy" as const, label: "WorkBuddy", enabled: config().agents.workbuddy.enabled };
  const site = ENVIRONMENT_LABEL[environment()];
  const loginFix: AgentFix = {
    action: "login",
    web: true,
    title: "登录 WorkBuddy",
    commands: [],
    note: `点下面的按钮会打开 ${site} 的登录页，在浏览器里登录完回到这里点「重新检查」。也可以给 agent-loft 服务设 CODEBUDDY_API_KEY 环境变量用 API Key。`,
  };
  let version: string | undefined;
  try {
    // package.json 不在包的 exports 里，从入口（lib/index.js）往上找
    const v = (require(path.join(path.dirname(require.resolve("@tencent-ai/agent-sdk")), "..", "package.json")) as { version?: string }).version;
    version = v ? `SDK ${v}` : undefined;
  } catch {
    return {
      ...base,
      installed: false,
      loggedIn: null,
      problem: "找不到 @tencent-ai/agent-sdk",
      fix: { action: "install", title: "安装 WorkBuddy SDK", commands: ["npm install"], note: "在 agent-loft 的目录里运行，装好后重启服务。" },
    };
  }
  if (environment() === "workbuddy") {
    const cli = desktopCli();
    if (!cli) {
      return {
        ...base,
        installed: false,
        loggedIn: null,
        problem: config().agents.workbuddy.cliPath ? `找不到 ${config().agents.workbuddy.cliPath}` : "没找到 WorkBuddy 桌面版",
        fix: {
          action: "install",
          title: "安装 WorkBuddy 桌面版",
          commands: [],
          note: "agent-loft 调用的是 WorkBuddy 桌面版自带的 CLI（账号站点 www.workbuddy.cn）。在这台服务器上装好桌面版（workbuddy.cn 下载）；装在别处的话，在下面填「CLI 路径」（桌面版目录里的 resources/app.asar.unpacked/cli/bin/codebuddy）。不想装桌面版可以把账号站点换成 CodeBuddy。",
        },
      };
    }
    version = "WorkBuddy 桌面版 CLI";
  }
  try {
    const acct = await Promise.race([readAccount(), timeout<never>(25_000, "读取 WorkBuddy 账号")]);
    return {
      ...base,
      installed: true,
      ...(version ? { version } : {}),
      loggedIn: acct.loggedIn,
      account: acct.account ? `${acct.account} · ${site}` : acct.loggedIn ? site : undefined,
      ...(acct.loggedIn ? {} : { fix: loginFix }),
    };
  } catch (err) {
    return { ...base, installed: true, ...(version ? { version } : {}), loggedIn: null, problem: err instanceof Error ? err.message : String(err), fix: loginFix };
  }
}

let cache: { at: number; value: AgentHealth[] } | null = null;
// 网页上登录完：下次体检别用缓存
onLoginDone(() => {
  cache = null;
});

/**
 * 不等体检、立刻给出的「这个 agent 能不能用」：用最近一次体检的结果（多旧都算），
 * 结果超过 5 分钟就顺手在后台再查一次。还没查过返回 null（当作能用，不挡人）。
 * 新对话里只列出能用的 agent，没装、没登录的不出现。
 */
export function agentAvailability(id: AgentHealth["id"]): { available: boolean; reason?: string } | null {
  if (!cache || Date.now() - cache.at > 5 * 60_000) void agentHealth().catch(() => {});
  const h = cache?.value.find((a) => a.id === id);
  if (!h) return null;
  if (!h.installed) return { available: false, reason: "未安装" };
  if (h.loggedIn === false) return { available: false, reason: "未登录" };
  return { available: true };
}

/** 装了 / 登录了什么之后，下次体检不用缓存 */
export function invalidateHealth(): void {
  cache = null;
}
let inflight: Promise<AgentHealth[]> | null = null;

/** 两个 agent 一起查，结果缓存一分钟；refresh 跳过缓存（点了「重新检查」） */
export function agentHealth(refresh = false): Promise<AgentHealth[]> {
  if (!refresh && cache && Date.now() - cache.at < 60_000) return Promise.resolve(cache.value);
  // WorkBuddy 没启用就不去起它的 CLI（包很大，拉起要几秒）
  const workbuddy = () =>
    config().agents.workbuddy.enabled
      ? workbuddyHealth()
      : Promise.resolve<AgentHealth>({ id: "workbuddy", label: "WorkBuddy", enabled: false, installed: true, loggedIn: null });
  inflight ??= Promise.all([claudeHealth(), codexHealth(), workbuddy()])
    .then((value) => {
      cache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
