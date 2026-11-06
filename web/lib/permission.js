// 权限级别的显示文案和上限换算（级别的含义见服务端 core/permission.ts）
export const PERMISSION_ORDER = ["ask", "edit", "auto", "full"];

export const PERMISSIONS = {
  ask: { label: "逐次询问", short: "询问", desc: "改文件、跑命令都先问你" },
  edit: { label: "自动改文件", short: "自动改文件", desc: "工作目录内改文件不再询问，其余照常问" },
  auto: { label: "自动判断", short: "自动判断", desc: "Claude 逐个判断安不安全，安全的直接做，拿不准再问你" },
  full: { label: "完全允许", short: "完全允许", desc: "不再询问，可以跑任意命令、改任意文件" },
};

/** 能设成默认的级别（完全允许只对一次任务说，不能默认） */
export const DEFAULT_LEVELS = ["ask", "edit", "auto"];

export const PLAN_INFO = { label: "计划模式", desc: "先只读、出方案，你批准了再按上面的权限动手" };

/** 专家的权限 → 最高能选到哪一级 */
export function capOfAccess(access) {
  return !access || access === "exec" ? "full" : access === "edit" ? "edit" : "ask";
}

export function minPermission(a, b) {
  return PERMISSION_ORDER[Math.min(PERMISSION_ORDER.indexOf(a), PERMISSION_ORDER.indexOf(b))];
}

/** 自动判断只有 Claude 有 */
export function engineSupports(agent, level) {
  return level !== "auto" || agent === "claude";
}

/** 不超过 max、这个引擎认的级别。agent 不给就不按引擎筛 */
export function permissionsUpTo(max, agent) {
  return PERMISSION_ORDER.slice(0, PERMISSION_ORDER.indexOf(max) + 1).filter((l) => !agent || engineSupports(agent, l));
}

/** 新对话没选级别时按哪一级：设置里定的默认，封顶后引擎不认就降到自动改文件（和服务端 hub.effectivePermission 一致） */
export function defaultPermissionFor(agent, max, defaults) {
  const wanted = defaults?.[agent];
  if (!wanted || !PERMISSIONS[wanted]) return null;
  const capped = minPermission(wanted, max);
  return engineSupports(agent, capped) ? capped : "edit";
}

export const FULL_WARNING = {
  title: "切换为「完全允许」？",
  sub: "agent 的操作不再询问：可以跑任意命令、改写或删除这台机器上的任意文件。",
  message: "只在你信任当前任务时使用。提问和标了「调用前询问」的 MCP 仍会询问。",
  confirmText: "完全允许",
  danger: true,
};
