// dsh 的报错翻译成人话（口径同 claude/errors.ts）
import type { Diagnosis } from "../../core/types.js";

const KEY_HINT = "在服务器上运行 dsh web，打开它的网页填 DeepSeek API Key；或者给 agent-loft 服务设 DEEPSEEK_API_KEY 环境变量。";

export function diagnose(err: unknown): Diagnosis {
  const raw = err instanceof Error ? err.message : String(err);
  const text = raw.toLowerCase();
  if ((err as NodeJS.ErrnoException)?.code === "ENOENT" || text.includes("spawn dsh enoent") || text.includes("enoent")) {
    return {
      kind: "cli_missing",
      chatMessage: "这台服务器上没找到 dsh，我暂时无法工作。请机器主人安装：npm install -g @deepseek-ai/dsh",
      consoleHint: "找不到 dsh：npm install -g @deepseek-ai/dsh；以系统服务运行时 PATH 很短，在 设置 → Agent → dsh 里填绝对路径。",
    };
  }
  if (text.includes("api key") || text.includes("api_key") || text.includes("401") || text.includes("unauthorized") || text.includes("authentication") || text.includes("credential")) {
    return {
      kind: "auth_missing",
      chatMessage: "dsh 还没配 DeepSeek 的 API Key（或 Key 失效了），我暂时无法工作。\n请机器主人到 设置 → Agent → dsh 查看怎么配。",
      consoleHint: `dsh 凭据有问题：${KEY_HINT}`,
    };
  }
  if (text.includes("insufficient balance") || text.includes("402") || text.includes("余额")) {
    return { kind: "rate_limit", chatMessage: "DeepSeek 账户余额不足，充值后再试。", consoleHint: `DeepSeek 余额不足：${raw}` };
  }
  if (text.includes("rate limit") || text.includes("429") || text.includes("too many requests")) {
    return { kind: "rate_limit", chatMessage: "DeepSeek 请求太频繁了，稍后再试，或者换个模型。", consoleHint: `dsh 限流：${raw}` };
  }
  if (text.includes("not resumable") || text.includes("no adapter registered")) {
    return {
      kind: "session_missing",
      chatMessage: "这条 dsh 会话恢复不了（可能是在 dsh 网页里用别家模型建的，或者记录坏了）。发 /new 开个新会话吧。",
      consoleHint: raw,
    };
  }
  if (text === "interrupted" || text.includes("cancelled") || text.includes("aborted")) {
    return { kind: "turn_aborted", chatMessage: "这一轮已中断。", consoleHint: raw };
  }
  if (text.includes("dsh 进程退出")) {
    return { kind: "unknown", chatMessage: `dsh 进程意外退出了，这一轮没有完成。再发一次会自动重新拉起。\n${raw.slice(0, 300)}`, consoleHint: raw };
  }
  return { kind: "unknown", chatMessage: `dsh 出错了：${raw.slice(0, 300)}`, consoleHint: raw };
}
