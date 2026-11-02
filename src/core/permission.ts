// 对话的权限级别：agent 干活时哪些操作要先问用户。两个引擎共用同一套级别（映射见各自的 session.ts）：
//
//   ask  逐次询问    Claude：default；         Codex：只读沙箱（写文件要批准）
//   edit 自动改文件  Claude：acceptEdits；     Codex：工作区可写沙箱
//   full 完全允许    Claude：default + 全放行；Codex：无沙箱 + 全放行
//
// 不选级别（undefined）= 老行为：Claude 逐次询问，Codex 按设置里的沙箱。老对话、老任务都不受影响。
//
// 完全允许不用 Claude 的 bypassPermissions：那会让 canUseTool 变成死代码，提问卡和「调用前询问」的 MCP 都走不到。
// Codex 也不用 approvalPolicy: never：实测 on-request 配无沙箱一样不弹审批，还留着 MCP 审批这条路。
import type { ExpertAccess } from "./experts.js";

export const PERMISSION_LEVELS = ["ask", "edit", "full"] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export const PERMISSION_LABEL: Record<PermissionLevel, string> = {
  ask: "逐次询问",
  edit: "自动改文件",
  full: "完全允许",
};

export function isPermissionLevel(v: unknown): v is PermissionLevel {
  return typeof v === "string" && (PERMISSION_LEVELS as readonly string[]).includes(v);
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
