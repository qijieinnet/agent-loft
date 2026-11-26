// 直接加载当前版本的服务，版本选择和升级监督由上层 CLI 负责。
import { register } from "tsx/esm/api";
process.once("disconnect", () => process.kill(process.pid, "SIGTERM"));
register();
try {
  await import("../src/main.ts");
} catch (error) {
  console.error(`[${process.env.AGENT_LOFT_WEB_MODE}] 启动失败：`, error);
  process.exit(1);
}
