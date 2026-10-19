/**
 * 交给 agent 子进程的环境变量。
 *
 * agent 可能会跑用户项目里的脚本，那些脚本也可能读 FEISHU_APP_ID 之类的变量 ——
 * 我们自己的凭据不能漏进去。复制而不是改 process.env：本进程还要用它们。
 */
export function agentEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([name]) => !/^(FEISHU_|LARK_|BRIDGE_|IM_AGENT_|TELEGRAM_)/i.test(name)),
  );
}
