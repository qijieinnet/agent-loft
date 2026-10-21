// 服务端自升级：查 npm 上的最新版本，npm install -g 升级，跑在系统服务下就自动重启。
//
// 只支持 npm 全局安装（npm install -g agent-loft）：从源码跑的（git clone）该用 git pull，
// 别的装法不知道怎么升级，都不碰。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, saveConfig } from "./config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readPackage(): { name: string; version: string } {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
}

/** 当前进程跑的版本（升级后磁盘上的文件变了，进程里的还是旧的，直到重启） */
export const RUNNING_VERSION = readPackage().version;
const NAME = readPackage().name;

/** npm 和 node 放在一起（官方安装包、Homebrew、fnm、nvm 都是），用同一套，装到同一个地方 */
function npmBin(): string {
  const beside = path.join(path.dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
  return fs.existsSync(beside) ? beside : "npm";
}

function npmEnv(): NodeJS.ProcessEnv {
  // 系统服务下 PATH 很短：npm 是个 node 脚本，得让它找得到 node
  return { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}` };
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(cmd, args, { env: npmEnv(), stdio: ["ignore", "pipe", "pipe"] });
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

/** 由谁托管：launchd 会把标签放进 XPC_SERVICE_NAME，systemd 会设 INVOCATION_ID */
export function serviceManager(): "launchd" | "systemd" | null {
  const xpc = process.env.XPC_SERVICE_NAME ?? "";
  if (/^com\.(agent-loft|im-agent)/.test(xpc)) return "launchd";
  if (process.env.INVOCATION_ID) return "systemd";
  return null;
}

/**
 * npm 全局安装的目录结构：<prefix>/lib/node_modules/agent-loft，命令链接在 <prefix>/bin/agent-loft
 * （Windows 上是 <prefix>/node_modules/agent-loft 和 <prefix>/agent-loft.cmd）。
 * 按结构认，不去问 npm root -g：npm 会把输出里像密钥的串（比如路径里的 UUID）打成 ***。
 */
function globalPrefix(): string | null {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  };
  const self = real(root);
  if (!self || path.basename(path.dirname(self)) !== "node_modules") return null;
  if (process.platform === "win32") {
    const prefix = path.dirname(path.dirname(self));
    return fs.existsSync(path.join(prefix, `${NAME}.cmd`)) ? prefix : null;
  }
  if (path.basename(path.dirname(path.dirname(self))) !== "lib") return null;
  const prefix = path.dirname(path.dirname(path.dirname(self)));
  const link = real(path.join(prefix, "bin", NAME));
  return link && link === real(path.join(self, "bin/cli.js")) ? prefix : null;
}

/** 怎么装的：npm 全局安装才能在线升级 */
async function installKind(): Promise<"npm-global" | "source" | "unknown"> {
  if (fs.existsSync(path.join(root, ".git"))) return "source";
  return globalPrefix() ? "npm-global" : "unknown";
}

let latestCache: { at: number; version: string | null; error?: string } | null = null;

/** npm 上的最新版。用 npm view 而不是直接请求 registry.npmjs.org：用户配的镜像源（npmmirror 等）照样生效 */
async function latestVersion(refresh: boolean): Promise<{ version: string | null; error?: string }> {
  if (!refresh && latestCache && Date.now() - latestCache.at < 30 * 60_000) return latestCache;
  const r = await run(npmBin(), ["view", NAME, "version"], 30_000);
  const version = r.code === 0 ? r.out.split("\n").find((l) => /^\d+\.\d+\.\d+/.test(l.trim()))?.trim() : undefined;
  latestCache = version ? { at: Date.now(), version } : { at: Date.now(), version: null, error: r.out.slice(-300) || "查询失败" };
  return latestCache;
}

/** "0.2.10" > "0.2.9" */
export function newer(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

export type VersionInfo = {
  version: string;
  latest: string | null;
  latestError?: string;
  updateAvailable: boolean;
  installKind: "npm-global" | "source" | "unknown";
  service: "launchd" | "systemd" | null;
  canUpgrade: boolean;
  /** 不能在线升级时说明原因和手动办法 */
  reason?: string;
  upgrading: boolean;
};

let upgrading = false;

export async function versionInfo(refresh = false): Promise<VersionInfo> {
  const [kind, latest] = await Promise.all([installKind(), latestVersion(refresh)]);
  const updateAvailable = !!latest.version && newer(latest.version, RUNNING_VERSION);
  const reason =
    kind === "source"
      ? "从源码运行的，用 git pull 更新后重启"
      : kind === "unknown"
        ? "不是用 npm install -g 装的，没法在线升级"
        : undefined;
  return {
    version: RUNNING_VERSION,
    latest: latest.version,
    ...(latest.error ? { latestError: latest.error } : {}),
    updateAvailable,
    installKind: kind,
    service: serviceManager(),
    canUpgrade: kind === "npm-global",
    ...(reason ? { reason } : {}),
    upgrading,
  };
}

/**
 * 升级到最新版。跑在 launchd / systemd 下的，回完话就退出，由它们拉起新版本；
 * 前台手动跑的（agent-loft start）没人拉起，只能请用户自己重启。
 */
export async function upgrade(): Promise<{ from: string; to: string; restarting: boolean; output: string }> {
  if (upgrading) throw new Error("正在升级，稍等");
  const info = await versionInfo(true);
  if (!info.canUpgrade) throw new Error(info.reason ?? "没法在线升级");
  if (!info.latest) throw new Error(`查不到最新版本：${info.latestError ?? ""}`);
  if (!info.updateAvailable) throw new Error(`已经是最新版本 ${RUNNING_VERSION}`);
  upgrading = true;
  try {
    // 明确指定 prefix：装回原来那个位置，不受当前 npm 配置影响
    const prefix = globalPrefix()!;
    const r = await run(npmBin(), ["install", "-g", "--prefix", prefix, `${NAME}@${info.latest}`, "--no-audit", "--no-fund"], 10 * 60_000);
    const installed = readPackage().version;
    if (r.code !== 0 || installed !== info.latest) {
      throw new Error(`npm install 失败：${r.out.slice(-600) || `退出码 ${r.code}`}`);
    }
    const restarting = !!info.service;
    if (restarting) {
      console.log(`[升级] 已装好 ${installed}，退出进程，由 ${info.service} 拉起新版本`);
      setTimeout(() => process.exit(0), 1500).unref();
    }
    return { from: RUNNING_VERSION, to: installed, restarting, output: r.out.slice(-2000) };
  } finally {
    upgrading = false;
  }
}

/** 在服务端这台机器上安装 Codex：有 Homebrew 用它，否则用 npm。登录要在浏览器里点，这里不管。 */
export async function installCodex(): Promise<{ ok: boolean; via: string; output: string }> {
  const brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find((p) => fs.existsSync(p));
  const r =
    process.platform === "darwin" && brew
      ? await run(brew, ["install", "--cask", "codex"], 10 * 60_000)
      : await run(npmBin(), ["install", "-g", "@openai/codex", "--no-audit", "--no-fund"], 10 * 60_000);
  return { ok: r.code === 0, via: process.platform === "darwin" && brew ? "Homebrew" : "npm", output: r.out.slice(-2000) };
}

/**
 * 装好 Codex 之后：配置里的 codex（默认就是 "codex"）在服务的 PATH 里找不到的话，
 * 换成刚装好的那个的绝对路径。改配置会让 codex app-server 按新路径重拉。
 */
export function useInstalledCodex(): void {
  const cfg = config();
  if (spawnSync(cfg.agents.codex.path, ["--version"], { env: npmEnv(), timeout: 10_000 }).status === 0) return;
  const found = [path.join(path.dirname(process.execPath), "codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"].find((p) => fs.existsSync(p));
  if (!found) return;
  const next = structuredClone(cfg);
  next.agents.codex.path = found;
  saveConfig(next);
  console.log(`[codex] 已装好，路径改成 ${found}`);
}
