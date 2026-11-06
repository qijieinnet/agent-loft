// WorkBuddy 的报错翻译成人话（口径同 claude/errors.ts）
import type { Diagnosis } from "../../core/types.js";

const LOGIN_HINT = "到 设置 → Agent → WorkBuddy 点「登录 WorkBuddy」，在浏览器里登录；或者给服务设 CODEBUDDY_API_KEY 环境变量。";

export function diagnose(err: unknown): Diagnosis {
  const raw = err instanceof Error ? err.message : String(err);
  const text = raw.toLowerCase();
  if (text.includes("authentication required") || text.includes("/login") || text.includes("unauthorized") || text.includes("invalid api key") || text.includes("token expired")) {
    return {
      kind: "auth_missing",
      chatMessage: "WorkBuddy 还没登录（或登录已过期），我暂时无法工作。\n请机器主人到 设置 → Agent → WorkBuddy 重新登录。",
      consoleHint: `WorkBuddy 未登录：${LOGIN_HINT}`,
    };
  }
  if (text.includes("cannot find package") || text.includes("cli not found") || text.includes("err_module_not_found")) {
    return {
      kind: "cli_missing",
      chatMessage: "WorkBuddy 的 SDK 没装好，我暂时无法工作。请机器主人在 agent-loft 目录里重新 npm install。",
      consoleHint: "找不到 @tencent-ai/agent-sdk：在 agent-loft 目录里运行 npm install，再重启服务。",
    };
  }
  if (text.includes("rate limit") || text.includes("429") || text.includes("quota") || text.includes("credit") || text.includes("额度") || text.includes("积分")) {
    return {
      kind: "rate_limit",
      chatMessage: "WorkBuddy 的额度用完了或请求太频繁，稍后再试，或者换个模型。",
      consoleHint: `WorkBuddy 额度 / 限流：${raw}`,
    };
  }
  if (text.includes("aborted") || text.includes("interrupted")) {
    return { kind: "turn_aborted", chatMessage: "这一轮已中断。", consoleHint: raw };
  }
  return { kind: "unknown", chatMessage: `WorkBuddy 出错了：${raw.slice(0, 300)}`, consoleHint: raw };
}
