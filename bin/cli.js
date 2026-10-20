#!/usr/bin/env node
// 统一入口：agent-loft <start|import|pair|passwd|service|doctor>
//
// 源码是 TypeScript，用 tsx 的 ESM loader 直接加载，装完即可运行，不需要先 build。
import { register } from "tsx/esm/api";

const COMMANDS = {
  start: "../src/main.ts",
  import: "../src/cli/import.ts",
  pair: "../src/cli/pair.ts",
  passwd: "../src/cli/passwd.ts",
  service: "../src/cli/service.ts",
  doctor: "../src/cli/doctor.ts",
};

const USAGE = `agent-loft —— 用飞书 / Web 驱动本机的 Claude Code 和 Codex

用法：
  agent-loft start            启动（默认命令）
  agent-loft import           从旧的 feishu-claude-bridge / feishu-codex-bridge 导入配置和会话
  agent-loft pair ...         配对管理：list | approve <配对码> | revoke <机器人id> <open_id>
  agent-loft passwd           重置 Web 登录密码
  agent-loft service ...      开机自启：install | uninstall | restart | status
  agent-loft doctor           体检：配置 / agent / 飞书连通性

配置目录：~/.agent-loft（可用 AGENT_LOFT_HOME 覆盖；已有旧的 ~/.im-agent 会继续沿用）
`;

const [, , rawCommand, ...rest] = process.argv;
const command = rawCommand ?? "start";

if (command === "-h" || command === "--help" || command === "help") {
  process.stdout.write(USAGE);
  process.exit(0);
}

const target = COMMANDS[command];
if (!target) {
  process.stderr.write(`未知命令：${command}\n\n${USAGE}`);
  process.exit(1);
}

process.argv = [process.argv[0], process.argv[1], ...rest];

register();
try {
  await import(new URL(target, import.meta.url).href);
} catch (err) {
  if (process.env.AGENT_LOFT_DEBUG || process.env.IM_AGENT_DEBUG) throw err;
  process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
}
