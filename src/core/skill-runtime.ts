// 技能怎么交到 agent 手上：开会话时挂哪些、注入哪些变量；自定义专家只给它选中的；
// 机器上原有的技能（~/.claude/skills、~/.agents/skills 这些）只给管理员（内置专家才加载）。
//
// 两个 agent 的做法不一样（都实测过）：
//   - Claude：每个用户一个插件目录（data/skills/plugins/<用户>），里面链接着他启用的技能，开会话时用
//     plugins 挂上，技能名是 loft:<name>。成员的会话再用 skills 白名单只留 agent-loft 的技能、Claude Code
//     自带的和项目目录里的 —— 机器上装的那些模型看不到、Skill 工具也调不了。但「/技能名」会被 CLI
//     直接展开，绕过白名单，所以 hub 在发出去之前还要拦一道（blockedSlash）。
//   - Codex：所有人共用一个 app-server，技能目录是全局的，没法按人挂；turn 里的 skill 输入也只认它自己
//     发现的技能。所以技能清单（名字、说明、SKILL.md 路径）写进附在第一条消息后面的背景里，用法和
//     Codex 自己的技能一样：要用时先读 SKILL.md。成员的会话关掉 Codex 自己的技能清单。
//     变量用 thread 的配置覆盖 shell_environment_policy.set 注入，只作用于这个 thread 里跑的命令。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { activeSkills, parseSkillMd, pluginsRoot, protectedNames, skillDir, skillEnv, userPrefs, type Skill } from "./skills.js";
import { SKILLS_MCP_NAME } from "./tasks-mcp.js";
import type { SessionSkills } from "./types.js";
import { getUser } from "./users.js";

/** Claude 插件名：技能在 Claude 里叫 loft:<name> */
export const PLUGIN_NAME = "loft";

// ---------- 机器上原有的技能 ----------

export type MachineSkill = { name: string; description: string; dir: string; agents: ("claude" | "codex")[] };

function frontmatterOf(file: string): { name?: string; description?: string } {
  try {
    const md = parseSkillMd(fs.readFileSync(file, "utf8").slice(0, 20_000));
    return { ...(md.name ? { name: md.name } : {}), ...(md.description ? { description: md.description } : {}) };
  } catch {
    return {};
  }
}

/** 某个目录下一层的技能：<dir>/<名字>/SKILL.md */
function scanDir(dir: string, agent: "claude" | "codex", out: Map<string, MachineSkill>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    const sub = path.join(dir, ent.name);
    const md = path.join(sub, "SKILL.md");
    if (!fs.existsSync(md)) continue;
    let real = sub;
    try {
      real = fs.realpathSync(sub);
    } catch {
      // 断掉的链接：照原路径算
    }
    const hit = out.get(real);
    if (hit) {
      if (!hit.agents.includes(agent)) hit.agents.push(agent);
      continue;
    }
    const fm = frontmatterOf(md);
    out.set(real, { name: fm.name || ent.name, description: fm.description ?? "", dir: real, agents: [agent] });
  }
}

let machineCache: { at: number; list: MachineSkill[] } | null = null;

/**
 * 机器上原有的技能：Claude 的 ~/.claude/skills（含从 claude.ai 同步下来的 synced/<id>/<名字>）、
 * Codex 的 ~/.codex/skills 和 ~/.agents/skills。Codex 自带的 .system 不算（那是 Codex 本身的一部分）。
 * 插件市场装的技能不在这里列，但一样只给管理员（Claude 成员会话的白名单里没有它们）。缓存一分钟。
 */
export function machineSkills(): MachineSkill[] {
  if (machineCache && Date.now() - machineCache.at < 60_000) return machineCache.list;
  const out = new Map<string, MachineSkill>();
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  scanDir(path.join(claudeHome, "skills"), "claude", out);
  let synced: string[] = [];
  try {
    synced = fs.readdirSync(path.join(claudeHome, "skills", "synced"));
  } catch {
    // 没有同步的技能
  }
  for (const s of synced) scanDir(path.join(claudeHome, "skills", "synced", s), "claude", out);
  const codexHome = config().agents.codex.home || path.join(os.homedir(), ".codex");
  scanDir(path.join(codexHome, "skills"), "codex", out);
  scanDir(path.join(os.homedir(), ".agents", "skills"), "codex", out);
  const list = [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  machineCache = { at: Date.now(), list };
  return list;
}

/** 项目目录里的 Claude 技能 / 命令名（<cwd>/.claude/skills/*、.claude/commands/*.md）：成员也能用 */
export function projectCommandNames(cwd: string): string[] {
  const names: string[] = [];
  try {
    for (const ent of fs.readdirSync(path.join(cwd, ".claude", "skills"), { withFileTypes: true })) {
      if (!ent.name.startsWith(".")) names.push(ent.name);
    }
  } catch {
    // 没有
  }
  try {
    for (const f of fs.readdirSync(path.join(cwd, ".claude", "commands"))) if (f.endsWith(".md")) names.push(f.slice(0, -3));
  } catch {
    // 没有
  }
  return names;
}

// ---------- 插件目录 ----------

/**
 * 把这个人启用的技能整理成一个 Claude 插件目录：skills/<name> 链接到技能本体（作者一改，这里就是新的）。
 * 每次开会话时对一遍账：多的删、少的补，正在用这个目录的其他会话不受影响。
 */
export function syncPluginDir(userId: string, skills: Skill[]): string {
  const dir = path.join(pluginsRoot, userId);
  const skillsDir = path.join(dir, "skills");
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
  const manifest = path.join(dir, ".claude-plugin", "plugin.json");
  const body = JSON.stringify({ name: PLUGIN_NAME, version: "1.0.0", description: "agent-loft 里安装的技能" }, null, 2);
  if (!fs.existsSync(manifest) || fs.readFileSync(manifest, "utf8") !== body) fs.writeFileSync(manifest, body, { mode: 0o600 });
  const want = new Map(skills.map((s) => [s.name, skillDir(s.id)]));
  for (const name of fs.readdirSync(skillsDir)) {
    const link = path.join(skillsDir, name);
    let target = "";
    try {
      target = fs.readlinkSync(link);
    } catch {
      // 不是链接（链接建不了时复制的）：一律重建
    }
    if (want.get(name) !== target || !target) fs.rmSync(link, { recursive: true, force: true });
  }
  for (const [name, target] of want) {
    const link = path.join(skillsDir, name);
    if (fs.existsSync(link)) continue;
    try {
      // Windows 上普通用户建不了符号链接，目录联接（junction）可以
      fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      fs.cpSync(target, link, { recursive: true });
    }
  }
  return dir;
}

// ---------- 开会话 ----------

/** 受保护的密钥怎么用：只能经 skill_request 代发。没有就是空 */
function protectedLines(skills: Skill[], userId: string): string[] {
  const prefs = userPrefs(userId);
  const names = [...protectedNames(skills)].filter((n) => prefs.vars[n] !== undefined);
  if (!names.length) return [];
  return [
    `这些密钥受保护，不在环境变量里，你也看不到值：${names.map((n) => `${n}（只能发往 ${(prefs.approved[n] ?? []).join("、") || "用户还没确认的地址"}）`).join("；")}。` +
      `要调用接口时用 ${SKILLS_MCP_NAME} 的 skill_request 工具，在 url、headers 或 body 里写 {{变量名}}，agent-loft 发请求时才换成真值。技能说明里写的是 curl $变量名 的，换成 skill_request 来发。`,
  ];
}

function varsPrompt(skills: Skill[], env: Record<string, string>, userId: string): string | undefined {
  const set = new Set<string>();
  const missing = new Map<string, string[]>();
  const values = userPrefs(userId).vars;
  for (const s of skills) {
    for (const v of s.vars) {
      if (env[v.name] !== undefined) set.add(v.name);
      else if (v.required && values[v.name] === undefined) missing.set(v.name, [...(missing.get(v.name) ?? []), s.name]);
    }
  }
  const guarded = protectedLines(skills, userId);
  if (set.size === 0 && missing.size === 0 && !guarded.length) return undefined;
  const lines = ["## 技能变量", ""];
  if (set.size) lines.push(`这些环境变量用户已经在 agent-loft 里配好了，命令里直接用（比如 $${[...set][0]}），不要把值打印出来或写进文件：${[...set].join("、")}。`);
  lines.push(...guarded);
  if (missing.size) {
    lines.push(
      `这些变量还没配：${[...missing].map(([n, by]) => `${n}（${by.join("、")} 要用）`).join("；")}。用到时告诉用户去网页侧栏「技能」里找到对应的技能填上，填好后下一条消息起生效。`,
    );
  }
  return lines.join("\n");
}

/**
 * 开会话时给 agent 的技能（SessionOptions.skills）。owner 是这条对话的主人（personal.ts 的 memoryOwnerOf）；
 * 没有主人的对话（飞书群聊等，只有管理员能配）照旧：机器上的技能都在，没有 agent-loft 的技能。
 * only：自定义专家选中的技能 id，只给这些（变量的说明也只说这些的）。插件目录照样是这个人启用的全部 ——
 * 正在用这个目录的其他会话不受影响，Claude 那边再用白名单只放选中的。
 */
export function sessionSkills(owner: string | undefined, only?: string[]): SessionSkills | undefined {
  if (!owner) return undefined;
  const user = getUser(owner);
  if (!user) return undefined;
  const admin = user.role === "admin";
  const all = activeSkills(owner);
  const keep = only ? new Set(only) : undefined;
  const skills = keep ? all.filter((s) => keep.has(s.id)) : all;
  const env = skillEnv(owner, skills);
  const prompt = varsPrompt(skills, env, owner);
  let pluginDir: string | undefined;
  // 子智能体可能选了主专家没有的技能，插件资源要准备完整；各自的白名单由 driver 限定。
  if (all.length) {
    try {
      pluginDir = syncPluginDir(owner, all);
    } catch (err) {
      console.error("[技能] 整理插件目录失败:", err instanceof Error ? err.message : err);
    }
  }
  return {
    userId: owner,
    admin,
    ...(pluginDir ? { pluginDir } : {}),
    list: skills.map((s) => ({ name: s.name, description: s.description, path: path.join(skillDir(s.id), "SKILL.md") })),
    env,
    ...(prompt ? { prompt } : {}),
  };
}

/** Codex 背景里的技能清单 */
export function codexSkillLines(skills: SessionSkills | undefined): string[] {
  if (!skills || (!skills.list.length && !skills.prompt)) return [];
  const lines: string[] = [];
  if (skills.list.length) {
    lines.push(
      "## 技能",
      "",
      "用户在 agent-loft 里启用了下面这些技能。任务和某个技能的说明对得上时，先完整读一遍它的 SKILL.md，再照着做（相对路径以 SKILL.md 所在目录为准）：",
      ...skills.list.map((s) => `- ${s.name}：${s.description}（${s.path}）`),
    );
  }
  if (skills.prompt) lines.push("", skills.prompt);
  return lines;
}

/**
 * 成员在 Claude 会话里直接发「/机器上的技能」：CLI 会绕过白名单直接展开，这里先拦下。
 * native 是 Claude 报上来的命令表；读不到（超时、出错）时还按扫出来的机器技能名拦，不能因此放行。
 */
export function isMachineCommand(name: string, native: { name: string; builtin?: boolean }[], cwd: string): boolean {
  const n = name.toLowerCase();
  if (n.startsWith(`${PLUGIN_NAME}:`)) return false;
  const bare = n.slice(n.lastIndexOf(":") + 1);
  const hit = native.find((c) => c.name.toLowerCase() === n || c.name.toLowerCase().endsWith(`:${n}`) || n.endsWith(`:${c.name.toLowerCase()}`));
  if (hit?.builtin) return false;
  if (projectCommandNames(cwd).some((p) => p.toLowerCase() === n)) return false;
  if (hit) return true;
  return machineSkills().some((m) => m.name.toLowerCase() === bare);
}

/** 测试用 */
export function resetMachineCache(): void {
  machineCache = null;
}

