// 权限级别的显示文案和上限换算（级别的含义见服务端 core/permission.ts）
export const PERMISSION_ORDER = ["ask", "edit", "full"];

export const PERMISSIONS = {
  ask: { label: "逐次询问", short: "询问", desc: "改文件、跑命令都先问你" },
  edit: { label: "自动改文件", short: "自动改文件", desc: "工作目录内改文件不再询问，其余照常问" },
  full: { label: "完全允许", short: "完全允许", desc: "不再询问，可以跑任意命令、改任意文件" },
};

/** 专家的权限 → 最高能选到哪一级 */
export function capOfAccess(access) {
  return !access || access === "exec" ? "full" : access === "edit" ? "edit" : "ask";
}

export function minPermission(a, b) {
  return PERMISSION_ORDER[Math.min(PERMISSION_ORDER.indexOf(a), PERMISSION_ORDER.indexOf(b))];
}

/** 不超过 max 的级别 */
export function permissionsUpTo(max) {
  return PERMISSION_ORDER.slice(0, PERMISSION_ORDER.indexOf(max) + 1);
}

export const FULL_WARNING = {
  title: "切换为「完全允许」？",
  sub: "agent 的操作不再询问：可以跑任意命令、改写或删除这台机器上的任意文件。",
  message: "只在你信任当前任务时使用。提问和标了「调用前询问」的 MCP 仍会询问。",
  confirmText: "完全允许",
  danger: true,
};
