// 把 SDK / CLI 抛出的原始错误翻译成人能看懂、且知道下一步做什么的提示。
//
// 原则：聊天里给一句人话 + 一条明确动作；终端给完整修复步骤。
// 不要把 SDK 堆栈直接甩给用户 —— 那既吓人又没有信息量。

export type DiagnosisKind =
  | "auth_expired"
  | "auth_missing"
  | "cli_missing"
  | "rate_limit"
  | "billing"
  | "turn_aborted"
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
  "  1) npm i -g @anthropic-ai/claude-code",
  "  2) claude          # 然后用 /login 登录",
  '  3) claude -p "回复 OK"   # 验证认证是否恢复',
  "  4) 重启 agent-loft：agent-loft service restart",
].join("\n");

export function diagnose(err: unknown): Diagnosis {
  const raw = err instanceof Error ? err.message : String(err);
  const text = raw.toLowerCase();

  if (
    text.includes("oauth session expired") ||
    text.includes("could not be refreshed") ||
    text.includes("failed to authenticate")
  ) {
    return {
      kind: "auth_expired",
      chatMessage:
        "Claude 的登录状态已过期，我暂时无法工作。\n请机器主人在终端重新登录（`claude` → `/login`），完成后我就能继续。",
      consoleHint: `Claude Code 登录已过期，需要重新登录：\n${LOGIN_STEPS}`,
      fatal: true,
    };
  }

  if (
    text.includes("invalid api key") ||
    text.includes("authentication_error") ||
    text.includes("unauthorized")
  ) {
    return {
      kind: "auth_missing",
      chatMessage:
        "Claude 的凭证无效，我暂时无法工作。\n请机器主人检查登录状态或 ANTHROPIC_API_KEY。",
      consoleHint: `Claude 凭证无效。若用订阅账号，重新登录：\n${LOGIN_STEPS}\n若用 API key，检查 ANTHROPIC_API_KEY 是否正确。`,
      fatal: true,
    };
  }

  if (
    text.includes("enoent") ||
    text.includes("command not found") ||
    text.includes("spawn") ||
    text.includes("could not find claude")
  ) {
    return {
      kind: "cli_missing",
      chatMessage:
        "本机还没装好 Claude Code，我暂时无法工作。\n请机器主人先完成安装。",
      consoleHint: `找不到可用的 Claude Code。安装并登录：\n${LOGIN_STEPS}`,
      fatal: true,
    };
  }

  if (text.includes("rate limit") || text.includes("usage limit")) {
    return {
      kind: "rate_limit",
      chatMessage: "Claude 的用量已达上限，请稍后再试。",
      consoleHint: "已达用量上限。等配额恢复，或换用额度更充足的账号 / API key。",
      fatal: false,
    };
  }

  // CLI 在一轮结束时发现 transcript 收尾不自洽（典型形态：最后一条是用户侧
  // 消息，而助手那边还停在 tool_use），就判为 error_during_execution。
  // 也就是工具调用循环跑到一半被打断了 —— /stop、审批超时、CLI 进程挂掉都算。
  // SDK 会把它包成 Error("Claude Code returned an error result: …") 抛出来。
  if (
    text.includes("error_during_execution") ||
    text.includes("returned an error result")
  ) {
    return {
      kind: "turn_aborted",
      chatMessage:
        "这一轮没能正常收尾，多半是工具跑到一半被打断了（/stop、审批超时，或 Claude Code 自己退出了）。\n上下文没丢，把刚才的需求再说一遍就行。",
      consoleHint:
        "一轮执行被中途打断（error_during_execution）。\n" +
        "常见原因：用户发了 /stop、审批超时按拒绝处理、或 Claude Code 进程退出。\n" +
        "偶发不用管，下一条消息会带着原 sessionId 重新拉起。\n" +
        "如果反复出现，去 ~/.claude/projects 下看对应会话的 jsonl 尾部，确认是不是每次都断在同一个工具上。",
      fatal: false,
    };
  }

  if (text.includes("credit balance") || text.includes("billing")) {
    return {
      kind: "billing",
      chatMessage: "Claude 账户余额不足，请机器主人处理后再试。",
      consoleHint: "账户余额不足，请到 Claude 控制台充值或检查订阅状态。",
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

