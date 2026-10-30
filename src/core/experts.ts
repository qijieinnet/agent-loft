// 专家：一份配置 —— 用哪个引擎（Claude / Codex）、什么提示词、能做什么（联网 / 读文件 / 改文件 / 跑命令）、
// 挂哪些技能和 MCP、能把活派给哪些子智能体。新建对话、定时任务时选一个专家，对话从头到尾都是它，
// 中途不能换（飞书里换专家等于开新会话）。
//
// 两个内置专家 claude、codex 不存成自定义专家：保留原装提示词和工具，技能 / MCP 默认项由 builtin-agents.ts 按人保存。
// 对话和任务里没写 expert 的，专家就是它的 agent —— 升级前的数据不用迁移。
//
// 自定义专家每人管自己的，不分享。存储：data/experts.json，只有主进程读写。
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { dataDir, readJson, writeJsonAtomic } from "../home.js";
import { resolveWorkspacePath } from "./config.js";
import { claudeMachineMcp, getMcp, isMachineId, machineName, specOf, type McpSpec } from "./mcp.js";
import { activeSkills, canSee, getSkill } from "./skills.js";
import { getUser } from "./users.js";

export type Engine = "claude" | "codex";
export const ENGINES: readonly Engine[] = ["claude", "codex"];

/** 一级包含一级：能跑命令就等于能改任何文件 */
export type ExpertAccess = "web" | "read" | "edit" | "exec";
export const ACCESS_LEVELS: readonly ExpertAccess[] = ["web", "read", "edit", "exec"];
export const ACCESS_LABEL: Record<ExpertAccess, string> = {
  web: "只能联网",
  read: "能读文件",
  edit: "能改文件",
  exec: "能跑命令",
};

export type QuickPrompt = { title: string; prompt: string };

export type Expert = {
  id: string;
  owner: string;
  name: string;
  description: string;
  /** emoji（以前的图标；有头像时用头像） */
  icon: string;
  /** 头像：用户上传的图片，前端缩成小图后的 data URL（data:image/...;base64,...）。空 = 没有 */
  avatar?: string;
  color: string;
  welcome: string;
  quickPrompts: QuickPrompt[];
  engine: Engine;
  model?: string;
  effort?: string;
  prompt: string;
  /** 只对 Claude：lean = 只用专家自己的提示词（省 token）；claude_code = Claude Code 原装提示词后面追加 */
  basePrompt: "lean" | "claude_code";
  access: ExpertAccess;
  /** 新建对话、任务时默认的工作目录（能读文件时才有意义）。空 = 工作区根目录 */
  cwd?: string;
  webSearch: boolean;
  webFetch: boolean;
  /** 技能 id（core/skills.ts） */
  skills: string[];
  /** MCP id（core/mcp.ts），机器上的写成 machine:<名字>（只有管理员能选） */
  mcp: string[];
  /** 子智能体：别的专家的 id。只有 Claude 支持 */
  subagents: string[];
  /** 带不带主人的个人记忆 */
  memory: boolean;
  /** 每存一次加一 */
  rev: number;
  createdAt: number;
  updatedAt: number;
};

export const BUILTIN_IDS: readonly Engine[] = ENGINES;

export function isBuiltin(id: string): id is Engine {
  return (BUILTIN_IDS as readonly string[]).includes(id);
}

export const EXPERT_LIMITS = {
  perUser: 50,
  name: 40,
  description: 500,
  welcome: 500,
  prompt: 20_000,
  quickPrompts: 8,
  quickTitle: 40,
  quickPrompt: 2000,
  /** 头像 data URL 的长度（前端缩到 128px，正常几 KB 到几十 KB） */
  avatar: 300_000,
};

/** 头像的地址（给前端用；带版本号，换了头像就是新地址） */
export const avatarUrl = (e: Pick<Expert, "id" | "rev" | "avatar">): string => (e.avatar ? `/api/experts/${e.id}/avatar?v=${e.rev}` : "");

/** 头像 data URL 拆成类型和内容 */
export function avatarImage(e: Pick<Expert, "avatar">): { type: string; data: Buffer } | undefined {
  const m = e.avatar ? /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(e.avatar) : null;
  return m ? { type: m[1]!, data: Buffer.from(m[2]!, "base64") } : undefined;
}

const storePath = path.join(dataDir, "experts.json");
/** 头像图片单独放：<专家 id>.<扩展名>。experts.json 里只记文件名，免得几十 KB 的 base64 每次都跟着整个重写 */
const avatarDir = path.join(dataDir, "expert-avatars");
const AVATAR_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const EXT_TYPE = Object.fromEntries(Object.entries(AVATAR_EXT).map(([t, e]) => [e, t]));

/** 存在 experts.json 里的样子：头像换成文件名 */
type StoredExpert = Omit<Expert, "avatar"> & { avatar?: string; avatarFile?: string };

/** 专家改了 / 删了。owner：谁的。用着它的会话空闲下来要换上新的 */
export const expertEvents = new EventEmitter<{ changed: [owner: string, id: string] }>();

let cache: Expert[] | null = null;

function readAvatar(file: string): string | undefined {
  const type = EXT_TYPE[path.extname(file).slice(1)];
  if (!type || path.basename(file) !== file) return undefined;
  try {
    return `data:${type};base64,${fs.readFileSync(path.join(avatarDir, file)).toString("base64")}`;
  } catch {
    return undefined;
  }
}

function load(): Expert[] {
  if (cache) return cache;
  let legacy = false;
  cache = readJson<StoredExpert[]>(storePath, [])
    .filter((e) => e && typeof e.id === "string" && typeof e.owner === "string" && !isBuiltin(e.id))
    .map(({ avatarFile, avatar: inline, ...e }) => {
      // 以前头像的 data URL 直接存在 experts.json 里：读进来照用，下面存一次就拆出去
      if (inline) legacy = true;
      const avatar = inline || (avatarFile ? readAvatar(avatarFile) : undefined);
      return { ...e, ...(avatar ? { avatar } : {}) };
    });
  if (legacy) save();
  return cache;
}

function save(): void {
  const list = load();
  const keep = new Set<string>();
  const stored: StoredExpert[] = list.map(({ avatar, ...e }) => {
    const img = avatarImage({ ...(avatar ? { avatar } : {}) });
    if (!img) return e;
    const file = `${e.id}.${AVATAR_EXT[img.type]}`;
    keep.add(file);
    const target = path.join(avatarDir, file);
    let same = false;
    try {
      same = fs.readFileSync(target).equals(img.data);
    } catch {
      // 还没有
    }
    if (!same) {
      fs.mkdirSync(avatarDir, { recursive: true, mode: 0o700 });
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, img.data, { mode: 0o600 });
      fs.renameSync(tmp, target);
    }
    return { ...e, avatarFile: file };
  });
  writeJsonAtomic(storePath, stored);
  // 删掉的专家、换了格式的头像留下的旧图片
  let files: string[] = [];
  try {
    files = fs.readdirSync(avatarDir);
  } catch {
    // 目录还没有
  }
  for (const f of files) if (!keep.has(f)) fs.rmSync(path.join(avatarDir, f), { force: true });
}

export function resetExpertCache(): void {
  cache = null;
}

export function listExperts(owner: string): Expert[] {
  return load()
    .filter((e) => e.owner === owner)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function getExpert(id: string): Expert | undefined {
  return load().find((e) => e.id === id);
}

/** 谁都能用的（内置）或者是他自己的 */
export function canUseExpert(owner: string | undefined, id: string): boolean {
  if (isBuiltin(id)) return true;
  const e = getExpert(id);
  return !!e && !!owner && e.owner === owner;
}

export const accessRank = (a: ExpertAccess) => ACCESS_LEVELS.indexOf(a);

// ---------- 校验 ----------

export type ExpertInput = Partial<Record<keyof Omit<Expert, "id" | "owner" | "rev" | "createdAt" | "updatedAt">, unknown>>;

const text = (v: unknown, max: number, what: string): string => {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length > max) throw new Error(`${what}太长（最多 ${max} 个字）`);
  return s;
};
const ids = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string"))] : []);

function validate(owner: string, input: ExpertInput, prev?: Expert, selfId?: string): Omit<Expert, "id" | "owner" | "rev" | "createdAt" | "updatedAt"> {
  const pick = <K extends keyof ExpertInput>(k: K): unknown => (input[k] === undefined && prev ? prev[k as keyof Expert] : input[k]);
  const user = getUser(owner);
  if (!user) throw new Error("用户不存在");
  const admin = user.role === "admin";

  const name = text(pick("name"), EXPERT_LIMITS.name, "名字");
  if (!name) throw new Error("给专家起个名字");
  const engine = pick("engine");
  if (engine !== "claude" && engine !== "codex") throw new Error("引擎只能是 Claude 或 Codex");
  if (prev && prev.engine !== engine) throw new Error("建好之后不能换引擎（用这个专家的对话都是这个引擎的会话）");
  const access = pick("access");
  if (!ACCESS_LEVELS.includes(access as ExpertAccess)) throw new Error("权限不对");

  const quickRaw = pick("quickPrompts");
  const quickPrompts: QuickPrompt[] = [];
  if (Array.isArray(quickRaw)) {
    if (quickRaw.length > EXPERT_LIMITS.quickPrompts) throw new Error(`快捷提问最多 ${EXPERT_LIMITS.quickPrompts} 个`);
    for (const q of quickRaw as Record<string, unknown>[]) {
      const prompt = text(q?.prompt, EXPERT_LIMITS.quickPrompt, "快捷提问");
      if (!prompt) continue;
      quickPrompts.push({ title: text(q?.title, EXPERT_LIMITS.quickTitle, "快捷提问的标题") || prompt.slice(0, 20), prompt });
    }
  }

  const color = text(pick("color"), 20, "颜色");
  if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error("颜色要写成 #rrggbb");

  let cwd: string | undefined;
  const cwdRaw = text(pick("cwd"), 4096, "工作目录");
  if (cwdRaw && access !== "web") {
    const resolved = resolveWorkspacePath(cwdRaw);
    if (!resolved) throw new Error("工作目录必须存在，且在工作区之内");
    cwd = resolved;
  }

  // 技能：自己看得到的
  const skills = ids(pick("skills")).filter((id) => {
    const s = getSkill(id);
    return !!s && canSee({ id: owner }, s);
  });

  // MCP：自己的；机器上的只有管理员能选
  const mcp = ids(pick("mcp")).filter((id) => (isMachineId(id) ? admin && machineName(id).length > 0 : getMcp(id)?.owner === owner));

  // 子智能体：自己的 Claude 专家，权限不能比自己高，不能是自己
  const subRaw = engine === "claude" ? ids(pick("subagents")) : [];
  const subagents: string[] = [];
  for (const id of subRaw) {
    if (id === selfId) throw new Error("子智能体不能是它自己");
    const sub = getExpert(id);
    if (!sub || sub.owner !== owner) continue;
    if (sub.engine !== "claude") throw new Error(`「${sub.name}」是 Codex 专家，子智能体只能用 Claude 专家`);
    if (accessRank(sub.access) > accessRank(access as ExpertAccess)) {
      throw new Error(`「${sub.name}」的权限（${ACCESS_LABEL[sub.access]}）比这个专家高，子智能体的权限不能超过主专家`);
    }
    subagents.push(id);
  }

  // 头像：没传就沿用；传空字符串就是去掉
  const avatarRaw = pick("avatar");
  const avatar = typeof avatarRaw === "string" ? avatarRaw.trim() : "";
  if (avatar) {
    if (avatar.length > EXPERT_LIMITS.avatar) throw new Error("头像图片太大");
    if (!avatarImage({ avatar })) throw new Error("头像只能是 PNG、JPEG、WebP 或 GIF 图片");
  }

  const model = text(pick("model"), 100, "模型");
  const effort = text(pick("effort"), 20, "思考程度");
  return {
    name,
    description: text(pick("description"), EXPERT_LIMITS.description, "说明"),
    icon: text(pick("icon"), 16, "图标"),
    ...(avatar ? { avatar } : {}),
    color,
    welcome: text(pick("welcome"), EXPERT_LIMITS.welcome, "欢迎语"),
    quickPrompts,
    engine,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    prompt: text(pick("prompt"), EXPERT_LIMITS.prompt, "提示词"),
    basePrompt: pick("basePrompt") === "claude_code" && engine === "claude" ? "claude_code" : "lean",
    access: access as ExpertAccess,
    ...(cwd ? { cwd } : {}),
    webSearch: pick("webSearch") !== false,
    webFetch: pick("webFetch") !== false,
    skills,
    mcp,
    subagents,
    memory: pick("memory") !== false,
  };
}

export function createExpert(owner: string, input: ExpertInput): Expert {
  if (listExperts(owner).length >= EXPERT_LIMITS.perUser) throw new Error(`每人最多 ${EXPERT_LIMITS.perUser} 个专家`);
  const id = `e_${crypto.randomBytes(6).toString("hex")}`;
  const now = Date.now();
  const expert: Expert = { id, owner, ...validate(owner, input, undefined, id), rev: 1, createdAt: now, updatedAt: now };
  load().push(expert);
  save();
  expertEvents.emit("changed", owner, id);
  return expert;
}

export function updateExpert(owner: string, id: string, input: ExpertInput): Expert {
  const list = load();
  const idx = list.findIndex((e) => e.id === id && e.owner === owner);
  if (idx < 0) throw new Error("这个专家不存在");
  const prev = list[idx]!;
  // 不展开 prev：清空了的可选项（目录、模型）不能被旧值补回来。没传的字段 validate 已经按 prev 取了
  const next: Expert = { id, owner, ...validate(owner, input, prev, id), rev: prev.rev + 1, createdAt: prev.createdAt, updatedAt: Date.now() };
  list[idx] = next;
  save();
  expertEvents.emit("changed", owner, id);
  return next;
}

export function deleteExpert(owner: string, id: string): void {
  const list = load();
  const idx = list.findIndex((e) => e.id === id && e.owner === owner);
  if (idx < 0) throw new Error("这个专家不存在");
  list.splice(idx, 1);
  // 别的专家把它当子智能体的，一并去掉
  for (const e of list) {
    if (e.subagents.includes(id)) {
      e.subagents = e.subagents.filter((s) => s !== id);
      e.rev += 1;
      expertEvents.emit("changed", e.owner, e.id);
    }
  }
  save();
  expertEvents.emit("changed", owner, id);
}

export function purgeUserExperts(owner: string): void {
  const list = load();
  const kept = list.filter((e) => e.owner !== owner);
  if (kept.length === list.length) return;
  cache = kept;
  save();
}

// ---------- 开会话时 ----------

/** sse 只有 Claude 机器上的配置里会出现 */
export type ResolvedMcp = McpSpec | { type: "sse"; url: string; headers: Record<string, string> };

/** 一个子智能体（只有 Claude） */
export type SubagentRuntime = {
  /** 子智能体的名字（Agent 工具里的 subagent_type）：专家名转成的短名，同一个专家里不重复 */
  key: string;
  name: string;
  description: string;
  prompt: string;
  access: ExpertAccess;
  webSearch: boolean;
  webFetch: boolean;
  model?: string;
  /** 技能名（loft:<name>） */
  skills: string[];
  mcp: Record<string, ResolvedMcp>;
};

/** 交给 driver 的专家（SessionOptions.expert）。内置专家不给 */
export type ExpertRuntime = {
  id: string;
  rev: number;
  name: string;
  prompt: string;
  basePrompt: "lean" | "claude_code";
  access: ExpertAccess;
  webSearch: boolean;
  webFetch: boolean;
  /** 选中的技能 id；SessionOptions.skills 已经按它筛过 */
  skills: string[];
  /** 选中的 MCP：服务名 → 启动参数 */
  mcp: Record<string, ResolvedMcp>;
  /** 调用前要询问的 MCP 服务名 */
  askMcp: string[];
  /** 选中的机器上的 MCP 名字（Codex：除了这些，机器上的都关掉） */
  machineMcp: string[];
  subagents: SubagentRuntime[];
  memory: boolean;
};

/** 专家选中的 MCP 解析成启动参数。机器上的：Claude 读 ~/.claude.json，Codex 只要名字（由它自己按 config.toml 起） */
export function resolveMcp(expert: Pick<Expert, "owner" | "engine" | "mcp">, admin: boolean): { mcp: Record<string, ResolvedMcp>; ask: string[]; machine: string[] } {
  const mcp: Record<string, ResolvedMcp> = {};
  const ask: string[] = [];
  const machine: string[] = [];
  const claudeMachine = admin && expert.engine === "claude" && expert.mcp.some(isMachineId) ? claudeMachineMcp() : {};
  for (const id of expert.mcp) {
    if (isMachineId(id)) {
      if (!admin) continue;
      const name = machineName(id);
      if (expert.engine === "codex") machine.push(name);
      else if (claudeMachine[name]) mcp[name] = claudeMachine[name]!;
      continue;
    }
    const s = getMcp(id);
    if (!s || s.owner !== expert.owner) continue;
    mcp[s.name] = specOf(s);
    if (s.ask) ask.push(s.name);
  }
  return { mcp, ask, machine };
}

/** 专家名转成子智能体的短名：Agent 工具里模型用它来点名 */
function subagentKey(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30) || "expert";
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}-${i}`;
  taken.add(key);
  return key;
}

/**
 * 按专家配置拼出交给 driver 的样子。prompt：子智能体的完整提示词怎么拼（core/expert-prompt.ts 给）。
 * 子智能体的权限封顶在主专家的权限：主专家后来降了权限也不会被子智能体绕过去。
 */
export function expertRuntime(expert: Expert, subPrompt: (sub: Expert, access: ExpertAccess) => string): ExpertRuntime {
  const admin = getUser(expert.owner)?.role === "admin";
  const active = new Map(activeSkills(expert.owner).map((s) => [s.id, s]));
  const { mcp, ask, machine } = resolveMcp(expert, admin);
  const taken = new Set<string>();
  const subagents: SubagentRuntime[] = [];
  if (expert.engine === "claude") {
    for (const id of expert.subagents) {
      const sub = getExpert(id);
      if (!sub || sub.owner !== expert.owner || sub.engine !== "claude" || sub.id === expert.id) continue;
      const access = accessRank(sub.access) > accessRank(expert.access) ? expert.access : sub.access;
      const subMcp = resolveMcp(sub, admin).mcp;
      subagents.push({
        key: subagentKey(sub.name, taken),
        name: sub.name,
        description: sub.description || sub.name,
        prompt: subPrompt(sub, access),
        access,
        webSearch: sub.webSearch,
        webFetch: sub.webFetch,
        ...(sub.model ? { model: sub.model } : {}),
        skills: sub.skills.map((s) => active.get(s)?.name).filter((n): n is string => !!n),
        mcp: subMcp,
      });
    }
  }
  return {
    id: expert.id,
    rev: expert.rev,
    name: expert.name,
    prompt: expert.prompt,
    basePrompt: expert.engine === "claude" ? expert.basePrompt : "lean",
    access: expert.access,
    webSearch: expert.webSearch,
    webFetch: expert.webFetch,
    skills: expert.skills.filter((id) => active.has(id)),
    mcp,
    askMcp: ask,
    machineMcp: machine,
    subagents,
    memory: expert.memory,
  };
}

// ---------- 模板 ----------

/** 「从模板新建」：和以前的聊天模式一样的效果 */
export const EXPERT_TEMPLATES: { id: string; label: string; expert: ExpertInput }[] = [
  {
    id: "chat",
    label: "聊天助手（以前的聊天模式）",
    expert: {
      name: "聊天助手",
      description: "日常聊天、查资料。只能联网搜索，不碰本机文件，每轮开销小",
      icon: "💬",
      engine: "claude",
      basePrompt: "lean",
      access: "web",
      webSearch: true,
      webFetch: true,
      memory: true,
      prompt: "你是用户的私人 AI 助手。用用户使用的语言回答，自然、直接、简洁；需要时用 Markdown 排版（列表、表格、代码块）。",
      welcome: "想聊点什么？",
    },
  },
];
