// agent-im doctor：配置 / agent / 飞书连通性体检。
import { spawnSync } from "node:child_process";
import { config, loadConfig } from "../core/config.js";
import { FeishuClient } from "../channels/feishu/client.js";
import { configPath } from "../home.js";

loadConfig();
const cfg = config();
const ok = (s: string) => console.log(`  ✅ ${s}`);
const bad = (s: string) => console.log(`  ❌ ${s}`);
const warn = (s: string) => console.log(`  ⚠️  ${s}`);

console.log(`配置文件：${configPath}`);
console.log(`工作目录：${cfg.workspaceRoot}`);

console.log("\nAgent");
if (cfg.agents.claude.enabled) {
  const r = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (r.status === 0) ok(`Claude Code ${r.stdout.trim()}`);
  else warn("没找到 claude 命令（SDK 自带运行时，通常不影响；登录态需要先在终端 claude 里登录过）");
} else warn("Claude 未启用");
if (cfg.agents.codex.enabled) {
  const r = spawnSync(cfg.agents.codex.path, ["--version"], { encoding: "utf8" });
  if (r.status === 0) ok(`Codex ${r.stdout.trim()}（沙箱 ${cfg.agents.codex.sandbox}）`);
  else bad(`找不到 ${cfg.agents.codex.path}，到设置里填 codex 的绝对路径`);
} else warn("Codex 未启用");

console.log("\n飞书机器人");
if (cfg.feishu.bots.length === 0) warn("还没有配置飞书机器人（Web 设置页可以扫码创建）");
for (const bot of cfg.feishu.bots) {
  const probe = await new FeishuClient(bot.appId, bot.appSecret, bot.domain, bot.name).probe();
  const line = `${bot.name}（${bot.appId}，agent：${bot.agents.join("、")}）${bot.enabled ? "" : " [未启用]"}`;
  if (probe.ok) ok(line);
  else bad(`${line}：${probe.message}`);
  if (bot.allowFrom.length === 0) warn(`${bot.name} 的白名单为空：只能靠配对使用`);
}

console.log("\nWeb");
console.log(`  ${cfg.web.enabled ? `http://${cfg.web.host}:${cfg.web.port}` : "未启用"}${cfg.web.passwordHash ? "" : "（还没设密码，首次打开需要启动日志里的设置码）"}`);
