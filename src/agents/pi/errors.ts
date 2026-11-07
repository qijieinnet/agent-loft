// pi 的报错翻译成人话（口径同 claude/errors.ts）
import type { Diagnosis } from "../../core/types.js";
import { NO_PROVIDER } from "./constants.js";

const KEY_HINT = "到 设置 → Agent → pi 的「模型服务商」里填 API Key（凭据存在 agent-loft 的 data/pi/auth.json）。";

export function diagnose(err: unknown): Diagnosis {
  const raw = err instanceof Error ? err.message : String(err);
  const text = raw.toLowerCase();
  if (raw.includes(NO_PROVIDER) || text.includes("no api key") || text.includes("no model") || text.includes("not configured")) {
    return { kind: "auth_missing", chatMessage: `${NO_PROVIDER}。`, consoleHint: `pi 没有可用的模型：${KEY_HINT}` };
  }
  if (text.includes("401") || text.includes("unauthorized") || text.includes("invalid api key") || text.includes("invalid_api_key") || text.includes("authentication") || text.includes("incorrect api key")) {
    return {
      kind: "auth_missing",
      chatMessage: "pi 用的这家模型服务商不认这个 API Key（填错了或已失效）。\n请机器主人到 设置 → Agent → pi 重新填。",
      consoleHint: `pi 服务商鉴权失败：${raw}。${KEY_HINT}`,
    };
  }
  if (text.includes("cannot find package") || text.includes("err_module_not_found") || text.includes("需要 node")) {
    return {
      kind: "cli_missing",
      chatMessage: `pi 的 SDK 没法加载，我暂时无法工作：${raw.slice(0, 200)}`,
      consoleHint: "在 agent-loft 目录里运行 npm install（pi 需要 Node 22.19 以上），再重启服务。",
    };
  }
  if (text.includes("rate limit") || text.includes("429") || text.includes("quota") || text.includes("insufficient") || text.includes("balance") || text.includes("余额") || text.includes("额度")) {
    return { kind: "rate_limit", chatMessage: "pi 用的模型服务商额度用完了、余额不足或请求太频繁，稍后再试，或者换个模型。", consoleHint: `pi 额度 / 限流：${raw}` };
  }
  if (text.includes("context") && (text.includes("too long") || text.includes("overflow") || text.includes("maximum"))) {
    return { kind: "context_overflow", chatMessage: "上下文太长了，发 /compact 压缩一下，或者 /new 开新会话。", consoleHint: raw };
  }
  if (text.includes("aborted") || text.includes("interrupted")) {
    return { kind: "turn_aborted", chatMessage: "这一轮已中断。", consoleHint: raw };
  }
  return { kind: "unknown", chatMessage: `pi 出错了：${raw.slice(0, 300)}`, consoleHint: raw };
}
