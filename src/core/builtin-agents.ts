// 内置 Agent 的个人默认配置；与管理员管理的运行环境分开，按账号、引擎保存。
import path from "node:path";
import { EventEmitter } from "node:events";
import { dataDir, readJson, writeJsonAtomic } from "../home.js";
import { ENGINES, resolveMcp, type Engine } from "./experts.js";
import { canUseMcp, getMcp, isMachineId, machineName } from "./mcp.js";
import { activeSkills } from "./skills.js";
import { sessionSkills } from "./skill-runtime.js";
import { getUser } from "./users.js";
import type { SessionOptions } from "./types.js";
import { DEFAULT_PERMISSION_LEVELS, engineSupports, type PermissionLevel } from "./permission.js";

export type BuiltinAgentDefaults = {
  /** null = 全部已启用的个人技能；[] = 不加载个人技能 */
  skills: string[] | null;
  machineSkills: boolean;
  /** null = 沿用机器配置；[] = 不加载 MCP（系统工具除外） */
  mcp: string[] | null;
  /**
   * 这个人用这个引擎的对话默认按哪一级权限（没单独选过级别的对话都按它，专家照样按自己的权限封顶）。
   * null = 跟随引擎（Claude 逐次询问，Codex 按设置里的沙箱）。和技能、MCP 不同，自定义专家的对话也按它
   */
  permission: PermissionLevel | null;
};
type Defaults = Record<Engine, BuiltinAgentDefaults>;
const file = path.join(dataDir, "builtin-agents.json");
export const builtinAgentEvents = new EventEmitter<{ changed: [owner: string] }>();

// 对话列表里每条都要算默认权限，不能每次都读盘。只有本文件写它
let cache: Record<string, Partial<Defaults>> | null = null;
function readAll(): Record<string, Partial<Defaults>> {
  return (cache ??= readJson<Record<string, Partial<Defaults>>>(file, {}));
}
function writeAll(all: Record<string, Partial<Defaults>>): void {
  writeJsonAtomic(file, all);
  cache = all;
}

function storedPermission(value: unknown, engine: Engine, admin: boolean): PermissionLevel | null {
  if (!(DEFAULT_PERMISSION_LEVELS as readonly unknown[]).includes(value)) return null;
  const level = value as PermissionLevel;
  // 成员最高到自动改文件（见 hub.permissionMax）；管理员降级成成员后，以前存的高一级不再算数
  if (!engineSupports(engine, level) || (level === "auto" && !admin)) return null;
  return level;
}

export function builtinAgentDefaults(owner: string): Defaults {
  const admin = getUser(owner)?.role === "admin";
  const stored = readAll()[owner];
  const defaults = (engine: Engine): BuiltinAgentDefaults => ({
    skills: stored?.[engine]?.skills ?? null,
    machineSkills: admin && stored?.[engine]?.machineSkills !== false,
    mcp: stored?.[engine]?.mcp ?? (admin ? null : []),
    permission: storedPermission(stored?.[engine]?.permission, engine, admin),
  });
  return { claude: defaults("claude"), codex: defaults("codex"), workbuddy: defaults("workbuddy"), pi: defaults("pi"), dsh: defaults("dsh") };
}

function selection(value: unknown, what: string): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 200 || value.some((v) => typeof v !== "string" || v.length > 100)) throw new Error(`${what}必须是列表或 null`);
  return [...new Set(value as string[])];
}

export function setBuiltinAgentDefaults(owner: string, patch: unknown): Defaults {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Agent 配置格式不对");
  const user = getUser(owner);
  if (!user) throw new Error("用户不存在");
  const next = builtinAgentDefaults(owner);
  const available = new Set(activeSkills(owner).map((s) => s.id));
  for (const [engine, raw] of Object.entries(patch)) {
    if (!ENGINES.includes(engine as Engine) || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Agent 配置格式不对");
    const p = raw as Record<string, unknown>;
    const current = next[engine as Engine];
    if (p.skills !== undefined) {
      const ids = selection(p.skills, "技能");
      if (ids?.some((id) => !available.has(id))) throw new Error("只能选择自己已启用的技能");
      current.skills = ids;
    }
    if (p.machineSkills !== undefined) {
      if (typeof p.machineSkills !== "boolean") throw new Error("机器技能开关必须是布尔值");
      if (p.machineSkills && user.role !== "admin") throw new Error("只有管理员能加载机器上的技能");
      current.machineSkills = p.machineSkills;
    }
    if (p.mcp !== undefined) {
      const ids = selection(p.mcp, "MCP");
      if (ids === null && user.role !== "admin") throw new Error("只有管理员能沿用机器 MCP 配置");
      const names = new Set<string>();
      for (const id of ids ?? []) {
        const server = getMcp(id);
        const name = isMachineId(id) ? machineName(id) : server?.name;
        if (isMachineId(id) ? user.role !== "admin" || !name || !/^[A-Za-z0-9_-]{1,100}$/.test(name) : !canUseMcp(owner, server)) throw new Error("只能选择自己的或别人共享的 MCP（机器 MCP 仅管理员可选）");
        if (names.has(name!)) throw new Error(`MCP 服务名重复：${name}`);
        names.add(name!);
      }
      current.mcp = ids;
    }
    if (p.permission !== undefined) {
      if (p.permission !== null && !(DEFAULT_PERMISSION_LEVELS as readonly unknown[]).includes(p.permission)) throw new Error("默认权限只能是逐次询问、自动改文件或自动判断");
      const level = p.permission as PermissionLevel | null;
      if (level && !engineSupports(engine, level)) throw new Error("「自动判断」只有 Claude Code 能用");
      if (level === "auto" && user.role !== "admin") throw new Error("只有管理员能把「自动判断」设成默认");
      current.permission = level;
    }
  }
  const all = { ...readAll(), [owner]: next };
  writeAll(all);
  builtinAgentEvents.emit("changed", owner);
  return next;
}

export function builtinAgentSession(owner: string | undefined, engine: Engine): Pick<SessionOptions, "skills" | "builtinMcp"> {
  if (!owner || !getUser(owner)) return {};
  const prefs = builtinAgentDefaults(owner)[engine];
  const resolved = resolveMcp({ owner, engine, mcp: prefs.mcp ?? [] }, getUser(owner)?.role === "admin");
  return {
    skills: sessionSkills(owner, prefs.skills ?? undefined, prefs.machineSkills, `builtin-${engine}`),
    builtinMcp: { mcp: resolved.mcp, askMcp: resolved.ask, machineMcp: resolved.machine, inheritMachine: prefs.mcp === null },
  };
}

/** 对话没单独选过级别时按哪一级（没主人的对话没有默认） */
export function defaultPermissionOf(owner: string | undefined, engine: string): PermissionLevel | undefined {
  if (!owner || !getUser(owner) || !(ENGINES as readonly string[]).includes(engine)) return undefined;
  return builtinAgentDefaults(owner)[engine as Engine].permission ?? undefined;
}

export function deleteBuiltinAgentDefaults(owner: string): void {
  const all = { ...readAll() };
  if (!(owner in all)) return;
  delete all[owner];
  writeAll(all);
}

export function resetBuiltinAgentCacheForTest(): void {
  cache = null;
}
