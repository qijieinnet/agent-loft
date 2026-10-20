// 从旧桥接器导入：feishu-claude-bridge（~/.feishu-claude-bridge）和 feishu-codex-bridge（~/.feishu-codex-bridge）。
//
// 导入飞书机器人凭据、白名单、配对、会话绑定（飞书群里接着原来的会话聊）、
// Claude 的「总是允许」名单，以及工作目录 / 默认模型 / 沙箱等设置。
//
// 用法：
//   agent-loft import                        两个都导
//   agent-loft import --only codex           只导其中一个
//   agent-loft import --disabled             导入但先不启用机器人（新旧并行时避免抢同一个机器人的消息）
//   agent-loft import --dry-run              只看会导入什么
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, loadConfig, saveConfig, type FeishuBotConfig } from "../core/config.js";
import { getConversation, putConversation, type Conversation } from "../core/store.js";
import { addApproved } from "../core/pairing.js";
import { listAllowlist, setAllowlist } from "../agents/claude/permissions.js";
import { readJson } from "../home.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const only = value("only");
const dryRun = flag("dry-run");
const disabled = flag("disabled");

function parseEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

type OldBinding = {
  sessionId?: string;
  threadId?: string;
  cwd: string;
  cwdExplicit?: boolean;
  model?: string;
  effort?: string;
  updatedAt: number;
};

function importOne(kind: "claude" | "codex"): void {
  const dir = path.join(os.homedir(), kind === "claude" ? ".feishu-claude-bridge" : ".feishu-codex-bridge");
  const env = parseEnv(path.join(dir, ".env"));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
    console.log(`- ${dir} 没有可用的配置，跳过`);
    return;
  }
  const cfg = structuredClone(config());
  const botId = `${kind}_bot`;
  const existing = cfg.feishu.bots.find((b) => b.appId === env.FEISHU_APP_ID);
  const id = existing?.id ?? botId;
  const bot: FeishuBotConfig = {
    id,
    name: existing?.name ?? (kind === "claude" ? "Claude 机器人" : "Codex 机器人"),
    enabled: !disabled,
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    domain: env.FEISHU_DOMAIN === "lark" ? "lark" : "feishu",
    allowFrom: (env.FEISHU_ALLOW_FROM ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.startsWith("ou_")),
    agents: existing?.agents ?? [kind],
    defaultAgent: existing?.defaultAgent ?? kind,
  };
  console.log(`- 飞书机器人「${bot.name}」 appId=${bot.appId} agent=${bot.agents.join(",")} 白名单 ${bot.allowFrom.length} 人${disabled ? "（暂不启用）" : ""}`);

  if (env.BRIDGE_WORKSPACE_ROOT) cfg.workspaceRoot = env.BRIDGE_WORKSPACE_ROOT;
  if (env.BRIDGE_APPROVAL_TIMEOUT_MS) cfg.approvalTimeoutMs = Number(env.BRIDGE_APPROVAL_TIMEOUT_MS);
  if (env.BRIDGE_SESSION_TTL_MS) cfg.sessionTtlMs = Number(env.BRIDGE_SESSION_TTL_MS);
  if (kind === "claude") {
    if (env.BRIDGE_DEFAULT_MODEL) cfg.agents.claude.defaultModel = env.BRIDGE_DEFAULT_MODEL;
  } else {
    if (env.BRIDGE_CODEX_PATH) cfg.agents.codex.path = env.BRIDGE_CODEX_PATH;
    if (env.BRIDGE_CODEX_HOME) cfg.agents.codex.home = env.BRIDGE_CODEX_HOME;
    if (env.BRIDGE_SANDBOX) cfg.agents.codex.sandbox = env.BRIDGE_SANDBOX as typeof cfg.agents.codex.sandbox;
    if (env.BRIDGE_DEFAULT_MODEL) cfg.agents.codex.defaultModel = env.BRIDGE_DEFAULT_MODEL;
    if (env.BRIDGE_DEFAULT_EFFORT) cfg.agents.codex.defaultEffort = env.BRIDGE_DEFAULT_EFFORT;
  }
  cfg.feishu.bots = [...cfg.feishu.bots.filter((b) => b.id !== id), bot];

  const sessions = readJson<Record<string, OldBinding>>(path.join(dir, "data", "sessions.json"), {});
  const pairing = readJson<{ approved?: string[] }>(path.join(dir, "data", "pairing.json"), {});
  const allowlist = kind === "claude" ? readJson<string[]>(path.join(dir, "data", "allowlist.json"), []) : [];
  console.log(`  会话 ${Object.keys(sessions).length} 条，配对用户 ${pairing.approved?.length ?? 0} 人${kind === "claude" ? `，总是允许 ${allowlist.length} 条` : ""}`);
  if (dryRun) return;

  saveConfig(cfg);
  for (const [oldKey, b] of Object.entries(sessions)) {
    const key = `feishu:${id}:${oldKey}`;
    if (getConversation(key)) continue;
    const sessionId = b.sessionId ?? b.threadId;
    const conv: Conversation = {
      key,
      channel: "feishu",
      channelId: id,
      agent: kind,
      cwd: b.cwd || config().workspaceRoot,
      ...(b.cwdExplicit ? { cwdExplicit: true } : {}),
      perAgent: {
        [kind]: {
          ...(sessionId ? { sessionId } : {}),
          ...(b.model ? { model: b.model } : {}),
          ...(b.effort ? { effort: b.effort } : {}),
        },
      },
      activeAt: b.updatedAt || Date.now(),
      createdAt: b.updatedAt || Date.now(),
    };
    putConversation(conv);
  }
  for (const userId of pairing.approved ?? []) addApproved(id, userId);
  if (allowlist.length) setAllowlist([...listAllowlist(), ...allowlist]);
}

loadConfig();

// 正在运行的实例内存里有一份会话缓存，下次写盘会把这里导入的覆盖掉
async function instanceRunning(): Promise<boolean> {
  const { host, port } = config().web;
  if (!config().web.enabled) return false;
  try {
    await fetch(`http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/api/me`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}
if (!dryRun && !flag("force") && (await instanceRunning())) {
  throw new Error("agent-loft 正在运行。请先停止它再导入（agent-loft service 管理的话：systemctl --user stop agent-loft），导完再启动。");
}

console.log(dryRun ? "将要导入（dry-run，不落盘）：" : "导入中：");
if (!only || only === "claude") importOne("claude");
if (!only || only === "codex") importOne("codex");
console.log(
  dryRun
    ? "\n去掉 --dry-run 正式导入。"
    : "\n完成。注意：同一个飞书机器人不能被两个程序同时连接，正式切换前请先停掉旧的桥接器服务：\n  systemctl --user disable --now feishu-claude-bridge feishu-codex-bridge",
);
