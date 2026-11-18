// 入口：拉起 agent 驱动、飞书机器人和 Web 服务。
import { config, loadConfig, onConfigChange } from "./core/config.js";
import { hub } from "./core/hub.js";
import { flushStore, getConversation } from "./core/store.js";
import { backfillLibrary, startLibraryCapture, tidyLibrary } from "./core/library.js";
import { ClaudeDriver } from "./agents/claude/driver.js";
import { CodexDriver } from "./agents/codex/driver.js";
import { WorkBuddyDriver } from "./agents/workbuddy/driver.js";
import { PiDriver } from "./agents/pi/driver.js";
import { DshDriver } from "./agents/dsh/driver.js";
import { agentHealth } from "./agents/health.js";
import { startFeishu, stopFeishu } from "./channels/feishu/index.js";
import { startWeixin, stopWeixin } from "./channels/weixin/index.js";
import { startWeb, stopWeb } from "./channels/web/server.js";
import { home } from "./home.js";
import { startMemoryCurator } from "./core/memory-curator.js";
import { backupBeforeMigration, startBackups } from "./core/backup.js";
import { purgeHiddenConversationsOnce } from "./core/personal.js";
import { buildHistoryIndex } from "./core/chat-history.js";
import { migrateAllMemoryItems, migrateMemoryDefault } from "./core/memory.js";
import { listUsers } from "./core/users.js";
import { startScheduler, stopScheduler } from "./core/scheduled.js";
import { startTaskRunner, stopTaskRunner } from "./core/task-runner.js";
import { startTasksBridge, stopTasksBridge } from "./core/tasks-bridge.js";

async function startDriver(id: "claude" | "codex" | "workbuddy" | "pi" | "dsh"): Promise<void> {
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
  hub.registerDriver(new WorkBuddyDriver());
  hub.registerDriver(new PiDriver());
  hub.registerDriver(new DshDriver());
  if (config().agents.claude.enabled) await startDriver("claude");
  if (config().agents.codex.enabled) await startDriver("codex");
  if (config().agents.workbuddy.enabled) void startDriver("workbuddy");
  if (config().agents.pi.enabled) void startDriver("pi");
  if (config().agents.dsh.enabled) void startDriver("dsh");
  // Web 上新启用了 Codex：现拉 app-server；WorkBuddy、pi 预先加载 SDK
  onConfigChange((next, prev) => {
    if (next.agents.codex.enabled && !prev.agents.codex.enabled) void startDriver("codex");
    if (next.agents.workbuddy.enabled && !prev.agents.workbuddy.enabled) void startDriver("workbuddy");
    if (next.agents.pi.enabled && !prev.agents.pi.enabled) void startDriver("pi");
    if (next.agents.dsh.enabled && !prev.agents.dsh.enabled) void startDriver("dsh");
  });

  // 资料库：升级时把已有的附件收进来（只一次），再清掉对话没了的、上传了一直没发的
  const backfilled = backfillLibrary();
  if (backfilled) console.log(`[资料库] 已收录上传目录里原有的 ${backfilled} 个文件`);
  tidyLibrary();
  startLibraryCapture();

  // 聊天记录索引和聊完后的记忆整理
  // 记忆条目搬表之前留一份备份，之后每天备份一次
  let backedUp = true;
  try {
    backupBeforeMigration();
  } catch (err) {
    backedUp = false;
    console.error("[备份] 升级前的备份失败，这次先不清已删除对话的记录，下次启动再试:", err);
  }
  migrateMemoryDefault(listUsers().map((u) => u.id));
  try {
    migrateAllMemoryItems();
    if (backedUp) {
      const purged = purgeHiddenConversationsOnce();
      if (purged) console.log(`[记忆] 清掉了 ${purged} 段已删除对话的聊天记录索引`);
    }
  } catch (err) {
    // 迁移失败不能让服务起不来：条目在第一次读到时还会再搬一次
    console.error("[记忆] 升级迁移出错:", err);
  }
  // 第一次升级要给全部老聊天建全文索引，放后台分批做；没建完时搜索会自己补上
  void buildHistoryIndex()
    .then((n) => n && console.log(`[记忆] 全文索引补上了 ${n} 句聊天`))
    .catch((err) => console.error("[记忆] 建全文索引失败:", err));
  startMemoryCurator();
  startBackups();

  startFeishu();
  startWeixin();
  if (config().web.enabled) await startWeb();
  // 定时发送：等 agent 和渠道都起来了再开始，服务停着时到点的这时补发
  startScheduler((m) => {
    if (!getConversation(m.key)) return;
    hub.send(m.key, { text: m.text, attachments: [] }, { channel: "schedule", channelId: "schedule", name: "定时发送" });
    hub.emitEvent(m.key, { type: "meta" });
  });
  // 定时任务：agent 用的工具通道先开，再开始按点运行（停机期间错过的补跑）
  startTasksBridge();
  startTaskRunner();
  // 先查一遍 agent 装没装、登没登录，网页打开时新对话里就只列出能用的
  void agentHealth().catch(() => {});
  // 读一次 Claude 的命令表：成员会话的技能白名单要带上 Claude Code 自带的那些（见 claude/session.ts 的 claudeBuiltins）
  if (config().agents.claude.enabled) {
    setTimeout(() => void hub.driver("claude")?.commands?.(config().workspaceRoot).catch(() => {}), 5000).unref();
  }

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
    stopWeixin();
    await stopWeb();
    await hub.shutdown().catch(() => {});
    // hub 收尾时会把正在跑的定时任务记成中断，所以放在它后面
    stopTaskRunner();
    stopTasksBridge();
    flushStore();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("exit", (code) => console.log(`[退出] agent-loft 结束，退出码 ${code}`));
  process.on("unhandledRejection", (err) => console.error("[未处理的异常]", err));
}

void main();
