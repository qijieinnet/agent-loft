// 技能怎么交到 agent 手上：开会话时挂哪些、注入哪些变量；消息里 @ 了技能时附上什么；
// 机器上原有的技能（~/.claude/skills、~/.agents/skills 这些）只给管理员。
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
 */
export function sessionSkills(owner: string | undefined): SessionSkills | undefined {
  if (!owner) return undefined;
  const user = getUser(owner);
  if (!user) return undefined;
  const admin = user.role === "admin";
  const skills = activeSkills(owner);
  const env = skillEnv(owner, skills);
  const prompt = varsPrompt(skills, env, owner);
  let pluginDir: string | undefined;
  if (skills.length) {
    try {
      pluginDir = syncPluginDir(owner, skills);
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

// ---------- @ 技能 ----------

export type MentionTarget = { name: string; description: string; kind: "loft" | "machine"; skillMd: string; agents?: ("claude" | "codex")[] };

/** 这个人能 @ 的技能：启用着的 agent-loft 技能；管理员再加上机器上原有的（同名时 agent-loft 的优先） */
export function mentionTargets(owner: string | undefined): MentionTarget[] {
  if (!owner) return [];
  const user = getUser(owner);
  if (!user) return [];
  const out: MentionTarget[] = activeSkills(owner).map((s) => ({
    name: s.name,
    description: s.description,
    kind: "loft",
    skillMd: path.join(skillDir(s.id), "SKILL.md"),
  }));
  if (user.role === "admin") {
    const taken = new Set(out.map((t) => t.name));
    for (const m of machineSkills()) {
      if (taken.has(m.name)) continue;
      taken.add(m.name);
      out.push({ name: m.name, description: m.description, kind: "machine", skillMd: path.join(m.dir, "SKILL.md"), agents: m.agents });
    }
  }
  return out;
}

/** 消息里 @ 到的技能名（前面是开头、空白或标点，不是邮箱里的 @），按出现顺序去重 */
export function parseMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|[^\w.@/-])@([a-z0-9][a-z0-9_-]*)/gi)) {
    const name = m[1]!.toLowerCase();
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

const INLINE_MAX = 30_000;

/**
 * 消息里 @ 了技能：附给 agent 的说明（包进 wrapContext 之前的那几行）。没 @ 到能用的就是 null。
 * 聊天模式没有工具，直接把 SKILL.md 的内容放进来。
 */
export function mentionContext(
  text: string,
  opts: { owner: string | undefined; agent: string; mode: "chat" | "work" },
): string[] | null {
  const names = parseMentions(text);
  if (!names.length) return null;
  const targets = mentionTargets(opts.owner);
  const hits = names.map((n) => targets.find((t) => t.name === n)).filter((t): t is MentionTarget => !!t);
  if (!hits.length) return null;
  if (opts.mode === "chat") {
    const lines = [
      `用户在这条消息里点名要用技能：${hits.map((t) => t.name).join("、")}。下面是技能的说明。现在是聊天模式，不能执行命令、读写文件：说明里能直接做的照着做，需要执行命令、读文件的步骤告诉用户发 /work 切到工作模式再来。`,
    ];
    let budget = INLINE_MAX;
    for (const t of hits) {
      let md = "";
      try {
        md = fs.readFileSync(t.skillMd, "utf8");
      } catch {
        md = "（读不到这个技能的 SKILL.md）";
      }
      if (md.length > budget) md = `${md.slice(0, Math.max(0, budget))}\n…（太长，后面省略）`;
      budget -= md.length;
      lines.push("", `### 技能 ${t.name}`, "", md.trim());
    }
    // 受保护的密钥走 skill_request（MCP 工具聊天模式下也有），调接口的技能在聊天模式也能用
    const mentioned = activeSkills(opts.owner!).filter((sk) => hits.some((t) => t.kind === "loft" && t.name === sk.name));
    const guarded = protectedLines(mentioned, opts.owner!);
    if (guarded.length) lines.push("", ...guarded);
    return lines;
  }
  if (opts.agent === "claude") {
    // Claude 认得的：agent-loft 的（插件里）和它自己目录里的；只在 Codex 目录里的它不认得，让它去读文件
    const known = hits.filter((t) => t.kind === "loft" || t.agents?.includes("claude"));
    const other = hits.filter((t) => !known.includes(t));
    const lines = [`用户在这条消息里点名要用技能：${hits.map((t) => t.name).join("、")}。`];
    if (known.length) {
      const refs = known.map((t) => (t.kind === "loft" ? `${PLUGIN_NAME}:${t.name}` : t.name));
      lines.push(`先用 Skill 工具调用 ${refs.join("、")}，再按技能的说明完成用户的要求。`);
    }
    if (other.length) lines.push("这些先完整读一遍 SKILL.md 再照着做（相对路径以 SKILL.md 所在目录为准）：", ...other.map((t) => `- ${t.name}：${t.skillMd}`));
    return lines;
  }
  return [
    `用户在这条消息里点名要用技能：${hits.map((t) => t.name).join("、")}。先完整读一遍对应的 SKILL.md，再照着做（相对路径以 SKILL.md 所在目录为准）：`,
    ...hits.map((t) => `- ${t.name}：${t.skillMd}`),
  ];
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

/** /skills 的回复：这条对话里能 @ 的技能 */
export function skillsText(owner: string | undefined): string {
  if (!owner) return "这条对话没有绑定 agent-loft 用户，用不了 agent-loft 的技能。飞书私聊里发 /bind 绑定账号后就能用。";
  const targets = mentionTargets(owner);
  const loft = targets.filter((t) => t.kind === "loft");
  const machine = targets.filter((t) => t.kind === "machine");
  const lines: string[] = [];
  if (loft.length) {
    lines.push(`**能用的技能（${loft.length} 个）**`, "", ...loft.map((t) => `- \`@${t.name}\` ${t.description}`));
  } else {
    lines.push("还没有启用任何技能。可以在网页「设置 → 技能」里新建、上传；也可以直接让 agent「把刚才的做法存成技能」。");
  }
  if (machine.length) lines.push("", `**本机技能（只有管理员能用，${machine.length} 个）**：${machine.map((t) => `\`@${t.name}\``).join(" ")}`);
  lines.push("", "在消息里写 @名字 点名使用；工作模式下 agent 也会自己挑合适的用。");
  return lines.join("\n");
}

/** 测试用 */
export function resetMachineCache(): void {
  machineCache = null;
}

