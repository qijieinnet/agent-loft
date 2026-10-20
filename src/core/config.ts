// 配置：一个 JSON 文件，由 Web 设置页读写，也可以手改。
//
// 和旧桥接器的 .env 不同，这里的配置在运行中会变（Web 上改完立即生效），
// 所以对外是「读当前值 + 订阅变化」，而不是一个启动时冻结的常量。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { configPath, ensureDirs, readJson, writeJsonAtomic } from "../home.js";
import type { CommandPrefs } from "./command-catalog.js";


export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type FeishuBotConfig = {
  /** 内部 id，会话键里会用到，创建后不要改 */
  id: string;
  name: string;
  enabled: boolean;
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
  /** owner 白名单（open_id）。配对批准的人另存在 data/pairing-<id>.json */
  allowFrom: string[];
  /** 这个机器人能用哪些 agent。只有一个就是「一个机器人一个 agent」 */
  agents: string[];
  /** 新会话默认用哪个 agent，必须在 agents 里 */
  defaultAgent: string;
};

export type AppConfig = {
  /** 所有会话的默认工作目录；/cd 只能在它之内 */
  workspaceRoot: string;
  approvalTimeoutMs: number;
  sessionTtlMs: number;
  agents: {
    claude: { enabled: boolean; defaultModel: string; defaultEffort: string };
    codex: {
      enabled: boolean;
      /** codex 可执行文件，systemd 下 PATH 很短，最好写绝对路径 */
      path: string;
      /** 留空用 ~/.codex */
      home: string;
      sandbox: SandboxMode;
      defaultModel: string;
      defaultEffort: string;
    };
  };
  web: {
    enabled: boolean;
    host: string;
    port: number;
    /** scrypt 哈希，空 = 还没设密码（首次访问需要终端里打印的设置码） */
    passwordHash: string;
    /**
     * 可信反向代理的 IP。只有从这些地址来的连接，才采信 X-Forwarded-* 头 ——
     * 否则直连的人随手伪造一个 X-Forwarded-For 就能绕过登录限流。
     * 反代（比如 Lucky）不在本机时，把它的 IP 加进来。
     */
    trustedProxies: string[];
  };
  /** 输入「/」时命令列表的顺序和隐藏项，按 agent 分开（设置 → 命令） */
  commands: { claude: CommandPrefs; codex: CommandPrefs };
  feishu: {
    /** 长连接掉线多久就重建，0 关闭 */
    watchdogMs: number;
    bots: FeishuBotConfig[];
  };
};

export const AGENT_IDS = ["claude", "codex"] as const;

export function defaultConfig(): AppConfig {
  return {
    workspaceRoot: process.env.HOME ? path.join(process.env.HOME, "project") : process.cwd(),
    approvalTimeoutMs: 30 * 60 * 1000,
    sessionTtlMs: 12 * 60 * 60 * 1000,
    agents: {
      claude: { enabled: true, defaultModel: "", defaultEffort: "" },
      codex: {
        enabled: true,
        path: "codex",
        home: "",
        sandbox: "workspace-write",
        defaultModel: "",
        defaultEffort: "",
      },
    },
    web: { enabled: true, host: "0.0.0.0", port: 8800, passwordHash: "", trustedProxies: ["127.0.0.1", "::1"] },
    commands: { claude: { order: [], hidden: [] }, codex: { order: [], hidden: [] } },
    feishu: { watchdogMs: 10 * 60 * 1000, bots: [] },
  };
}

/** 递归补齐缺省字段：老配置文件缺新字段时不至于整个崩掉。 */
function mergeDefaults<T>(base: T, value: unknown): T {
  if (Array.isArray(base)) return (Array.isArray(value) ? value : base) as T;
  if (typeof base !== "object" || base === null) {
    return (value === undefined || value === null || typeof value !== typeof base ? base : value) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  for (const key of Object.keys(out)) out[key] = mergeDefaults(out[key], v[key]);
  return out as T;
}

function normalizeBot(raw: Partial<FeishuBotConfig>): FeishuBotConfig {
  const agents = (raw.agents ?? []).filter((a) => (AGENT_IDS as readonly string[]).includes(a));
  const list = agents.length > 0 ? agents : ["claude"];
  return {
    id: raw.id?.trim() || `bot_${crypto.randomBytes(3).toString("hex")}`,
    name: raw.name?.trim() || "飞书机器人",
    enabled: raw.enabled !== false,
    appId: raw.appId?.trim() ?? "",
    appSecret: raw.appSecret?.trim() ?? "",
    domain: raw.domain === "lark" ? "lark" : "feishu",
    allowFrom: (raw.allowFrom ?? [])
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.startsWith("ou_")),
    agents: list,
    defaultAgent: raw.defaultAgent && list.includes(raw.defaultAgent) ? raw.defaultAgent : list[0]!,
  };
}

let current: AppConfig | null = null;
const listeners = new Set<(next: AppConfig, prev: AppConfig) => void>();

export function loadConfig(): AppConfig {
  if (current) return current;
  ensureDirs();
  const raw = readJson<unknown>(configPath, null);
  const merged = mergeDefaults(defaultConfig(), raw);
  merged.workspaceRoot = path.resolve(merged.workspaceRoot);
  merged.feishu.bots = merged.feishu.bots.map(normalizeBot);
  current = merged;
  if (!raw) writeJsonAtomic(configPath, merged);
  watchExternalEdits();
  return current;
}

/**
 * 配置文件被别的进程改了（手改、或终端里跑了 im-agent passwd）：重新读进来。
 * 自己保存触发的变更内容一致，比较后直接跳过。
 */
let watching = false;
function watchExternalEdits(): void {
  if (watching) return;
  watching = true;
  let timer: NodeJS.Timeout | null = null;
  try {
    fs.watch(path.dirname(configPath), { persistent: false }, (_event, file) => {
      if (file !== path.basename(configPath)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const raw = readJson<unknown>(configPath, null);
        if (!raw || !current) return;
        const next = mergeDefaults(defaultConfig(), raw);
        next.workspaceRoot = path.resolve(next.workspaceRoot);
        next.feishu.bots = next.feishu.bots.map(normalizeBot);
        if (JSON.stringify(next) === JSON.stringify(current)) return;
        const prev = current;
        current = next;
        console.log("[配置] 检测到配置文件被修改，已重新加载");
        for (const listener of listeners) {
          try {
            listener(next, prev);
          } catch (err) {
            console.error("[配置] 变更回调出错:", err);
          }
        }
      }, 200);
    });
  } catch {
    // 监听不了就算了，重启后生效
  }
}

/** 当前配置。别缓存返回值里的子对象：保存后整个对象会被换掉。 */
export function config(): AppConfig {
  return current ?? loadConfig();
}

export function saveConfig(next: AppConfig): AppConfig {
  const prev = config();
  const normalized = mergeDefaults(defaultConfig(), next);
  normalized.workspaceRoot = path.resolve(normalized.workspaceRoot);
  normalized.feishu.bots = normalized.feishu.bots.map(normalizeBot);
  writeJsonAtomic(configPath, normalized);
  current = normalized;
  for (const listener of listeners) {
    try {
      listener(normalized, prev);
    } catch (err) {
      console.error("[配置] 变更回调出错:", err);
    }
  }
  return normalized;
}

export function onConfigChange(listener: (next: AppConfig, prev: AppConfig) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 把用户给的目录限制在 workspaceRoot 之内，防止 /cd 跳到任意路径。
 *
 * 必须比较真实路径：工作区里一个指向外面的符号链接，字符串上在里面，实际在外面。
 * 目标还必须存在且是目录 —— 不存在的目录拉不起 agent。
 */
export function resolveWorkspacePath(input: string, base?: string): string | null {
  const root = config().workspaceRoot;
  const target = path.resolve(base ?? root, input);
  if (!inside(root, target)) return null;
  try {
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(target);
    if (!inside(realRoot, realTarget) || !fs.statSync(realTarget).isDirectory()) return null;
    // 用工作区根目录的写法返回：根目录本身是符号链接时，存下来的路径仍然落在根目录之内
    return path.join(root, path.relative(realRoot, realTarget));
  } catch {
    return null;
  }
}

export type WorkspaceDirListing = {
  root: string;
  /** 绝对路径（工作区根目录的写法） */
  path: string;
  /** 相对工作区根目录，根目录本身是 "" */
  rel: string;
  dirs: { name: string; hidden: boolean }[];
  /** 子目录太多，只列了前一部分 */
  truncated: boolean;
};

const MAX_LISTED_DIRS = 500;

/**
 * 列出工作区内某个目录下的子目录，给 Web 的目录选择器用。只列目录不列文件；
 * 指向工作区外面（或已经失效）的符号链接不列 —— 列出来也 /cd 不进去。
 */
export function listWorkspaceDirs(input: string): WorkspaceDirListing | null {
  const root = config().workspaceRoot;
  const resolved = resolveWorkspacePath(input || ".");
  if (!resolved) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs: { name: string; hidden: boolean }[] = [];
  for (const entry of entries) {
    const ok = entry.isDirectory() || (entry.isSymbolicLink() && resolveWorkspacePath(path.join(resolved, entry.name)) !== null);
    if (ok) dirs.push({ name: entry.name, hidden: entry.name.startsWith(".") });
  }
  dirs.sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.name.localeCompare(b.name));
  return {
    root,
    path: resolved,
    rel: path.relative(root, resolved),
    dirs: dirs.slice(0, MAX_LISTED_DIRS),
    truncated: dirs.length > MAX_LISTED_DIRS,
  };
}

export function isInsideWorkspace(dir: string): boolean {
  return resolveWorkspacePath(dir) === path.resolve(dir);
}
