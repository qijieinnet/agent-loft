// 入口：拉起 agent 驱动、飞书机器人和 Web 服务。
import { config, loadConfig, onConfigChange } from "./core/config.js";
import { hub } from "./core/hub.js";
import { flushStore, getConversation, isExpired } from "./core/store.js";
import { sweepUploads } from "./core/uploads.js";
import { ClaudeDriver } from "./agents/claude/driver.js";
import { CodexDriver } from "./agents/codex/driver.js";
import { agentHealth } from "./agents/health.js";
import { startFeishu, stopFeishu } from "./channels/feishu/index.js";
import { startWeb, stopWeb } from "./channels/web/server.js";
import { home } from "./home.js";
import { startMemoryCurator } from "./core/memory-curator.js";
import { startScheduler, stopScheduler } from "./core/scheduled.js";

async function startDriver(id: "claude" | "codex"): Promise<void> {
  const driver = hub.driver(id);
  if (!driver) return;
  try {
    await driver.start();
  } catch (err) {
    const diagnosis = driver.diagnose(err);
    console.error(`[${id}] 启动失败：${diagnosis.consoleHint}`);
  }
}

async function main(): Promise<void> {
  loadConfig();
  console.log(`[启动] agent-loft，配置目录 ${home}`);

  hub.registerDriver(new ClaudeDriver());
  hub.registerDriver(new CodexDriver());
  if (config().agents.claude.enabled) await startDriver("claude");
  if (config().agents.codex.enabled) await startDriver("codex");
  // Web 上新启用了 Codex：现拉 app-server
  onConfigChange((next, prev) => {
    if (next.agents.codex.enabled && !prev.agents.codex.enabled) void startDriver("codex");
  });

  sweepUploads((key) => {
    const conv = getConversation(key);
    return !!conv && !isExpired(conv);
  });

  // 聊天记录索引和聊完后的记忆整理
  startMemoryCurator();

  startFeishu();
  if (config().web.enabled) await startWeb();
  // 定时发送：等 agent 和渠道都起来了再开始，服务停着时到点的这时补发
  startScheduler((m) => {
    if (!getConversation(m.key)) return;
    hub.send(m.key, { text: m.text, attachments: [] }, { channel: "schedule", channelId: "schedule", name: "定时发送" });
    hub.emitEvent(m.key, { type: "meta" });
  });
  // 先查一遍 agent 装没装、登没登录，网页打开时新对话里就只列出能用的
  void agentHealth().catch(() => {});

  console.log(`[启动] workspace=${config().workspaceRoot}`);
  if (config().workspaceRoot === process.cwd()) {
    console.warn("[启动] ⚠️ 工作目录就是 agent-loft 自身目录，agent 会在它的代码里干活。到设置里改 workspaceRoot。");
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[退出] 收到 ${signal}，正在收尾…`);
    const force = setTimeout(() => process.exit(0), 8000);
    force.unref();
    stopScheduler();
    stopFeishu();
    await stopWeb();
    await hub.shutdown().catch(() => {});
    flushStore();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("exit", (code) => console.log(`[退出] agent-loft 结束，退出码 ${code}`));
  process.on("unhandledRejection", (err) => console.error("[未处理的异常]", err));
}

void main();
