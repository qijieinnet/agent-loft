// 内置 Agent 的个人默认配置；与管理员管理的运行环境分开，按账号、引擎保存。
import path from "node:path";
import { EventEmitter } from "node:events";
import { dataDir, readJson, writeJsonAtomic } from "../home.js";
import { ENGINES, resolveMcp, type Engine } from "./experts.js";
import { getMcp, isMachineId, machineName } from "./mcp.js";
import { activeSkills } from "./skills.js";
import { sessionSkills } from "./skill-runtime.js";
import { getUser } from "./users.js";
import type { SessionOptions } from "./types.js";

export type BuiltinAgentDefaults = {
  /** null = 全部已启用的个人技能；[] = 不加载个人技能 */
  skills: string[] | null;
  machineSkills: boolean;
  /** null = 沿用机器配置；[] = 不加载 MCP（系统工具除外） */
  mcp: string[] | null;
};
type Defaults = Record<Engine, BuiltinAgentDefaults>;
const file = path.join(dataDir, "builtin-agents.json");
export const builtinAgentEvents = new EventEmitter<{ changed: [owner: string] }>();

export function builtinAgentDefaults(owner: string): Defaults {
  const admin = getUser(owner)?.role === "admin";
  const stored = readJson<Record<string, Partial<Defaults>>>(file, {})[owner];
  const defaults = (engine: Engine): BuiltinAgentDefaults => ({
    skills: stored?.[engine]?.skills ?? null,
    machineSkills: admin && stored?.[engine]?.machineSkills !== false,
    mcp: stored?.[engine]?.mcp ?? (admin ? null : []),
  });
  return { claude: defaults("claude"), codex: defaults("codex") };
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
        if (isMachineId(id) ? user.role !== "admin" || !name || !/^[A-Za-z0-9_-]{1,100}$/.test(name) : !server || server.owner !== owner) throw new Error("只能选择自己的 MCP（机器 MCP 仅管理员可选）");
        if (names.has(name!)) throw new Error(`MCP 服务名重复：${name}`);
        names.add(name!);
      }
      current.mcp = ids;
    }
  }
  const all = readJson<Record<string, Defaults>>(file, {});
  all[owner] = next;
  writeJsonAtomic(file, all);
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

export function deleteBuiltinAgentDefaults(owner: string): void {
  const all = readJson<Record<string, Defaults>>(file, {});
  if (!(owner in all)) return;
  delete all[owner];
  writeJsonAtomic(file, all);
}
