// 把 app-server / codex 抛出的原始错误翻译成人能看懂、且知道下一步做什么的提示。
//
// 原则：聊天里给一句人话 + 一条明确动作；终端给完整修复步骤。
// 不要把原始错误直接甩给用户 —— 那既吓人又没有信息量。
import { config } from "../../core/config.js";

export type DiagnosisKind =
  | "auth_expired"
  | "auth_missing"
  | "cli_missing"
  | "runtime_missing"
  | "rate_limit"
  | "billing"
  | "turn_aborted"
  | "protocol"
  | "unknown";

export type Diagnosis = {
  kind: DiagnosisKind;
  /** 发到聊天里的简短说明 */
  chatMessage: string;
  /** 打在终端的修复步骤 */
  consoleHint: string;
  /** 是否属于「配置好之前重试也没用」的问题 */
  fatal: boolean;
};

const LOGIN_STEPS = [
  "  1) codex login      # 用 ChatGPT 账号登录，或配 OPENAI_API_KEY",
  "  2) codex doctor     # 确认认证与运行时都正常",
  '  3) codex exec "回复 OK"   # 验证真的能跑',
  "  4) 重启agent-im",
].join("\n");

export function diagnose(err: unknown): Diagnosis {
  const raw = err instanceof Error ? err.message : String(err);
  const text = raw.toLowerCase();

  if (
    text.includes("not logged in") ||
    text.includes("session expired") ||
    text.includes("token has expired") ||
    text.includes("refresh token")
  ) {
    return {
      kind: "auth_expired",
      chatMessage:
        "Codex 的登录状态已过期，我暂时无法工作。\n请机器主人在终端重新登录（`codex login`），完成后我就能继续。",
      consoleHint: `Codex 登录已过期，需要重新登录：\n${LOGIN_STEPS}`,
      fatal: true,
    };
  }

  if (
    text.includes("unauthorized") ||
    text.includes("invalid api key") ||
    text.includes("401")
  ) {
    return {
      kind: "auth_missing",
      chatMessage:
        "Codex 的凭证无效，我暂时无法工作。\n请机器主人检查登录状态或 OPENAI_API_KEY。",
      consoleHint: `Codex 凭证无效。若用 ChatGPT 账号，重新登录：\n${LOGIN_STEPS}\n若用 API key，检查 OPENAI_API_KEY 是否正确。`,
      fatal: true,
    };
  }

  // 本机没装 codex，或装在 PATH 之外（服务托管时的经典症状）
  if (
    text.includes("enoent") ||
    text.includes("command not found") ||
    text.includes("无法启动") ||
    text.includes("spawn")
  ) {
    return {
      kind: "cli_missing",
      chatMessage: "本机还没装好 Codex，我暂时无法工作。\n请机器主人先完成安装。",
      consoleHint:
        `找不到可执行的 \`${config().agents.codex.path}\`。\n` +
        "  1) npm i -g @openai/codex   # 或用你惯用的安装方式\n" +
        "  2) command -v codex          # 确认它在 PATH 里\n" +
        "  3) 装在非标准位置的话，在 .env 里设 BRIDGE_CODEX_PATH 指到绝对路径\n" +
        `${LOGIN_STEPS}`,
    fatal: true,
    };
  }

  // codex 把执行器做成了单独下载的运行时二进制，CDN 拉不到时它就跑不了命令。
  // 症状很隐蔽：模型照样回话，但每次要执行命令都失败。
  if (text.includes("code-mode host") || text.includes("codex-code-mode-host")) {
    return {
      kind: "runtime_missing",
      chatMessage:
        "Codex 能说话，但执行不了命令 —— 本机缺少它的运行时组件。\n请机器主人跑一次 `codex doctor` 看看。",
      consoleHint:
        "Codex 的命令执行器（code-mode host）没能启动，通常是运行时二进制没下下来。\n" +
        "  1) codex doctor    # 看 reachability 一节，多半是 CDN 拉不通\n" +
        "  2) 确认能访问 chatgpt.com，必要时配好代理后重试\n" +
        "  3) codex update    # 让它重新拉一次运行时",
      fatal: false,
    };
  }

  if (text.includes("rate limit") || text.includes("usage limit") || text.includes("429")) {
    return {
      kind: "rate_limit",
      chatMessage: "Codex 的用量已达上限，请稍后再试。",
      consoleHint: "已达用量上限。等配额恢复，或换用额度更充足的账号 / API key。",
      fatal: false,
    };
  }

  if (text.includes("quota") || text.includes("billing") || text.includes("credit")) {
    return {
      kind: "billing",
      chatMessage: "Codex 账户余额或配额不足，请机器主人处理后再试。",
      consoleHint: "余额 / 配额不足，去 OpenAI 控制台检查订阅与用量。",
      fatal: false,
    };
  }

  if (text.includes("interrupt") || text.includes("aborted") || text.includes("cancel")) {
    return {
      kind: "turn_aborted",
      chatMessage:
        "这一轮被中断了（/stop、审批超时，或 Codex 自己停了）。\n上下文没丢，把刚才的需求再说一遍就行。",
      consoleHint:
        "一轮执行被中途打断。常见原因：用户发了 /stop、审批超时按拒绝处理。\n偶发不用管，下一条消息会带着原 threadId 继续。",
      fatal: false,
    };
  }

  // app-server 标着 experimental，协议跟着 codex 版本走，没有版本协商。
  // 方法名对不上多半就是 codex 升级过了。
  if (text.includes("method not found") || text.includes("-32601")) {
    return {
      kind: "protocol",
      chatMessage: "agent-im和本机 Codex 的协议对不上了，请机器主人升级agent-im。",
      consoleHint:
        "app-server 拒绝了某个方法，多半是 codex 升级后协议变了。\n" +
        "  1) agent-im doctor   # 会比对版本\n" +
        "  2) fcx upgrade                  # 升级agent-im",
      fatal: false,
    };
  }

  return {
    kind: "unknown",
    // 未知错误才把原文带给用户 —— 有原文总比一句「出错了」强
    chatMessage: `出错了：${raw}`,
    consoleHint: raw,
    fatal: false,
  };
}

/** 同一类问题只在终端刷一次完整指引，避免每条消息都刷屏 */
const announced = new Set<DiagnosisKind>();

