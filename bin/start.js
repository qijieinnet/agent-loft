// 每个服务在自己的进程里初始化驱动、监听端口和清理资源。
import { fork } from "node:child_process";

export async function startServices(args) {
  const mode = args[0] ?? process.env.AGENT_LOFT_WEB_MODE ?? "both";
  if (args.length > 1 || !["both", "system", "bot"].includes(mode)) {
    throw new Error("用法：agent-loft start [both|system|bot]");
  }
  if (mode !== "both") {
    process.env.AGENT_LOFT_WEB_MODE = mode;
    await import("../src/main.ts");
    return;
  }

  const children = new Set();
  const health = new Map();
  let stopping = false;
  function stop() {
    stopping = true;
    for (const child of children) child.kill("SIGTERM");
  }
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const results = await Promise.all(["system", "bot"].map(service => new Promise(resolve => {
      const child = fork(new URL("./worker.js", import.meta.url), [], {
        execArgv: [], stdio: ["inherit", "inherit", "inherit", "ipc"],
        env: { ...process.env, AGENT_LOFT_WEB_MODE: service, AGENT_LOFT_MANAGED_PAIR: "1" },
      });
      children.add(child);
      child.on("message", message => {
        if (message?.type === "restart-services" && service === "system") return stop();
        if (message?.type !== "upgrade-health" || !process.send) return;
        health.set(service, message);
        if (message.error || health.size === 2) process.send(message);
      });
      child.on("error", error => console.error(`[${service}] 启动失败：${error.message}`));
      child.once("close", (code, signal) => {
        children.delete(child);
        if (!stopping) {
          console.error(`[${service}] 服务已退出（${signal ?? code}）`);
          if (!health.has(service) && process.env.AGENT_LOFT_UPGRADE_TRIAL) {
            process.send?.({ type: "upgrade-health", error: service + " 启动验证前退出" });
          }
        }
        resolve(code ?? 1);
      });
    })));
    if (!stopping && results.some(code => code !== 0)) process.exitCode = 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
