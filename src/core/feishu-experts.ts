// 飞书机器人的专家选择与兼容旧的按引擎配置。无效、删除或撤回共享的专家不能退回内置 Agent。
import type { FeishuBotConfig } from "./config.js";
import { getExpert, isBuiltin } from "./experts.js";
import { getUser } from "./users.js";

export function botExpertEngine(id: string): string | undefined {
  if (isBuiltin(id)) return id;
  const expert = getExpert(id);
  const creator = expert && getUser(expert.owner);
  return expert?.shared && creator && !creator.disabled ? expert.engine : undefined;
}

export function botExpertIds(cfg: FeishuBotConfig): string[] | undefined {
  return cfg.experts?.filter((id) => !!botExpertEngine(id));
}

export function botAgentIds(cfg: FeishuBotConfig): string[] {
  return cfg.experts === undefined ? cfg.agents : [...new Set(cfg.experts.map(botExpertEngine).filter((id): id is string => !!id))];
}

/** 配置接口严格校验；引擎随专家推导，前端不需要再额外勾底层 Agent。 */
export function botExpertSelection(experts: unknown, defaultExpert: unknown): Pick<FeishuBotConfig, "experts" | "defaultExpert" | "agents" | "defaultAgent"> {
  if (!Array.isArray(experts) || !experts.length || experts.length > 200 || experts.some((id) => typeof id !== "string" || !botExpertEngine(id))) throw new Error("至少选择一个内置专家或仍在共享的专家");
  const selected = [...new Set(experts as string[])];
  const first = typeof defaultExpert === "string" && selected.includes(defaultExpert) ? defaultExpert : selected[0]!;
  const agents = [...new Set(selected.map((id) => botExpertEngine(id)!))];
  return { experts: selected, defaultExpert: first, agents, defaultAgent: botExpertEngine(first)! };
}
