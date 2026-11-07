// 对话的权限级别：agent 干活时哪些操作要先问用户。两个引擎共用同一套级别（映射见各自的 session.ts）：
//
//   ask  逐次询问    Claude：default；         Codex：只读沙箱（写文件要批准）
//   edit 自动改文件  Claude：acceptEdits；     Codex：工作区可写沙箱
//   auto 自动判断    Claude：auto（分类器逐个判断，拿不准再问）；Codex 没有，按自动改文件算
//   full 完全允许    Claude：default + 全放行；Codex：无沙箱 + 全放行
//
// 不选级别（undefined）= 按主人在设置里定的默认（见 builtin-agents.ts），没定就是老行为：
// Claude 逐次询问，Codex 按设置里的沙箱。老对话、老任务都不受影响。
//
// 完全允许不用 Claude 的 bypassPermissions：那会让 canUseTool 变成死代码，提问卡和「调用前询问」的 MCP 都走不到。
// Codex 也不用 approvalPolicy: never：实测 on-request 配无沙箱一样不弹审批，还留着 MCP 审批这条路。
//
// 计划模式（先出方案、批准了再动手）不是一个级别，是和级别叠加的开关，见 store.ts 的 Conversation.plan。
import type { ExpertAccess } from "./experts.js";

export const PERMISSION_LEVELS = ["ask", "edit", "auto", "full"] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export const PERMISSION_LABEL: Record<PermissionLevel, string> = {
  ask: "逐次询问",
  edit: "自动改文件",
  auto: "自动判断",
  full: "完全允许",
};

/** 能当默认权限的级别：完全允许是对一次任务说的，不能默认放开 */
export const DEFAULT_PERMISSION_LEVELS = ["ask", "edit", "auto"] as const;

export function isPermissionLevel(v: unknown): v is PermissionLevel {
  return typeof v === "string" && (PERMISSION_LEVELS as readonly string[]).includes(v);
}

/** 这个引擎认不认这一级：自动判断只有 Claude 有（WorkBuddy、pi 也按自动改文件算） */
export function engineSupports(agent: string, level: PermissionLevel): boolean {
  return level !== "auto" || agent === "claude";
}

/** 引擎不认的级别降到它认的最近一级（Codex 的自动判断按自动改文件算） */
export function forEngine(agent: string, level: PermissionLevel): PermissionLevel {
  return engineSupports(agent, level) ? level : "edit";
}

export function minPermission(a: PermissionLevel, b: PermissionLevel): PermissionLevel {
  return PERMISSION_LEVELS.indexOf(a) <= PERMISSION_LEVELS.indexOf(b) ? a : b;
}

export function exceedsPermission(level: PermissionLevel, max: PermissionLevel): boolean {
  return PERMISSION_LEVELS.indexOf(level) > PERMISSION_LEVELS.indexOf(max);
}

/** 专家的权限决定它最高能到哪一级：不能跑命令的放开「全部允许」也没有意义，Codex 的沙箱也不能超过它 */
export function permissionCapOfAccess(access: ExpertAccess): PermissionLevel {
  return access === "exec" ? "full" : access === "edit" ? "edit" : "ask";
}

/** 设置里的 Codex 沙箱换算成级别：显示「现在实际是哪一级」、给成员定上限时用 */
export function permissionOfSandbox(sandbox: string): PermissionLevel {
  return sandbox === "danger-full-access" ? "full" : sandbox === "read-only" ? "ask" : "edit";
}
