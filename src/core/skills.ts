// 技能（skill）：一份 SKILL.md 加上它附带的脚本、资料，agent 需要时照着做。和 Claude Code / Codex 自己的
// skill 是同一种格式，只是由 agent-loft 按人管理：
//   - 谁都能建（网页上写、上传技能包，或者让 agent 在对话里生成），建的人是作者；
//   - 作者决定谁看得到：只有自己 / 指定的几个人 / 所有人，看得到的人可以安装。网页上已经不再提供分享和技能广场
//     （新建的都是仅自己），这套数据留着是为了以前分享、安装过的照常能用；
//   - 安装的是作者那一份本身，不是副本：作者改了，装了的人下一条消息起就用上新的；
//   - 技能可以声明要用的环境变量（API 地址、密钥之类），值由每个用户自己填，只注入到他自己的会话里。
//
// 存储（data/skills/）：
//   index.json            所有技能的元数据
//   files/<技能 id>/       SKILL.md 和附带文件
//   users/<用户 id>.json   这个人装了哪些、停用了哪些、变量的值
//   plugins/<用户 id>/     给 Claude 挂的插件目录，里面是指向 files/ 的链接（skill-runtime.ts 生成）
//
// 只有主进程读写这些文件（agent 的技能工具经 tasks-bridge 转过来），所以缓存在内存里。
// 和多用户一样是「信任型」的：工作模式下 agent 能读到这里的所有文件，包括别人的变量值。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { dataDir, readJson, writeJsonAtomic } from "../home.js";

export type SkillVisibility = "private" | "users" | "all";

export type SkillVar = {
  /** 环境变量名，大写字母、数字、下划线 */
  name: string;
  description: string;
  /** 密钥之类：网页上不回显，只显示填没填 */
  secret: boolean;
  required: boolean;
  /**
   * 受保护的密钥（secret 且给了 hosts）：不放进环境变量，agent 看不到值，只能用 skill_request 工具
   * 让 agent-loft 代发请求（写 {{NAME}}，发出去时才换成真值），而且只发往这些地址。
   * 写法：api.example.com、*.example.com、192.168.8.2:8080。实际放行的是用户填值时确认过的那一份（见 approved）。
   */
  hosts?: string[];
};

export type Skill = {
  id: string;
  /** 小写字母、数字和 -，全局唯一，建好后不能改（Claude 里叫 loft:<name>，输入框里 @<name>） */
  name: string;
  description: string;
  owner: string;
  visibility: SkillVisibility;
  /** visibility 是 users 时：给哪些用户 */
  sharedWith: string[];
  vars: SkillVar[];
  source: "manual" | "upload" | "agent";
  createdAt: number;
  updatedAt: number;
};

export type UserSkillPrefs = {
  /** 装了的别人的技能（自己的不用装） */
  installed: string[];
  /** 停用的（自己的或者装了的）：不注入会话，@ 不到 */
  disabled: string[];
  /** 变量的值：按变量名存，几个技能用同一个变量名（比如 GITHUB_TOKEN）就共用一个值 */
  vars: Record<string, string>;
  /**
   * 受保护的密钥，用户填值时确认过可以发往哪些地址。作者后来改了 hosts 不会自动放行新地址
   * （装的是作者那一份本身，改了也跟着变 —— 偏偏这一项不能跟着变），要用户再确认一次。
   */
  approved: Record<string, string[]>;
};

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const VAR_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

export const SKILL_LIMITS = {
  description: 1024,
  skillMd: 100_000,
  files: 200,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 5 * 1024 * 1024,
  vars: 20,
  varValue: 4000,
  perUser: 100,
};

/**
 * 这些变量名不让技能用：要么是 agent 自己要用的（换掉就能劫持它的账号、模型或者加载的代码），
 * 要么会被 agent-loft 从子进程环境里剔掉（agent-env.ts）。
 */
const RESERVED_VAR =
  /^(PATH|HOME|USER|LOGNAME|SHELL|PWD|LANG|TERM|TMPDIR|TZ|EDITOR|VISUAL|PAGER|HOSTNAME|SSH_AUTH_SOCK|HTTPS?_PROXY|NO_PROXY|ALL_PROXY|BASH_ENV|ENV|ZDOTDIR|PROMPT_COMMAND|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PERL5LIB|PERL5OPT|RUBYOPT|RUBYLIB|GIT_(DIR|WORK_TREE|SSH|SSH_COMMAND|EXEC_PATH|ASKPASS|EDITOR|PAGER|TEMPLATE_DIR|CONFIG\w*))$|^(LC_|LD_|DYLD_|NODE_|NPM_|ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|AGENT_LOFT_|IM_AGENT_|FEISHU_|LARK_|BRIDGE_|TELEGRAM_|XDG_)/;

const root = path.join(dataDir, "skills");
const indexPath = path.join(root, "index.json");
const filesRoot = path.join(root, "files");
const usersRoot = path.join(root, "users");
export const pluginsRoot = path.join(root, "plugins");

/** 技能有变化。users：受影响的人（作者和装了的人），他们空闲的会话要换上新的 */
export const skillEvents = new EventEmitter<{ changed: [users: string[]] }>();

let cache: Skill[] | null = null;

function load(): Skill[] {
  cache ??= readJson<Skill[]>(indexPath, []).filter((s) => s && typeof s.id === "string" && SKILL_NAME.test(s.name) && typeof s.owner === "string");
  return cache;
}

function saveIndex(): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  writeJsonAtomic(indexPath, load());
}

const checkId = (id: string, what: string) => {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(id)) throw new Error(`${what} id 不合法`);
  return id;
};

export function skillDir(id: string): string {
  return path.join(filesRoot, checkId(id, "技能"));
}

// ---------- 每个人的设置 ----------

function prefsPath(userId: string): string {
  return path.join(usersRoot, `${checkId(userId, "用户")}.json`);
}

export function userPrefs(userId: string): UserSkillPrefs {
  const raw = readJson<Partial<UserSkillPrefs>>(prefsPath(userId), {});
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const vars: Record<string, string> = {};
  if (raw.vars && typeof raw.vars === "object") {
    for (const [k, v] of Object.entries(raw.vars)) if (VAR_NAME.test(k) && typeof v === "string") vars[k] = v;
  }
  const approved: Record<string, string[]> = {};
  if (raw.approved && typeof raw.approved === "object") {
    for (const [k, v] of Object.entries(raw.approved)) if (VAR_NAME.test(k)) approved[k] = strings(v);
  }
  return { installed: strings(raw.installed), disabled: strings(raw.disabled), vars, approved };
}

function savePrefs(userId: string, prefs: UserSkillPrefs): void {
  fs.mkdirSync(usersRoot, { recursive: true, mode: 0o700 });
  writeJsonAtomic(prefsPath(userId), prefs);
}

// ---------- 查询 ----------

export type Viewer = { id: string; role: "admin" | "member" };

export function listAllSkills(): Skill[] {
  return load();
}

export function getSkill(id: string): Skill | undefined {
  return load().find((s) => s.id === id);
}

export function findSkillByName(name: string): Skill | undefined {
  const n = name.toLowerCase();
  return load().find((s) => s.name === n);
}

/** 看得到：自己的、公开的、指名给他的 */
export function canSee(viewer: Pick<Viewer, "id">, skill: Skill): boolean {
  return skill.owner === viewer.id || skill.visibility === "all" || (skill.visibility === "users" && skill.sharedWith.includes(viewer.id));
}

/** 能改、能删：只有作者。管理员能下架（删）别人公开或分享出来的，但不能改内容 */
export function canDelete(viewer: Viewer, skill: Skill): boolean {
  return skill.owner === viewer.id || (viewer.role === "admin" && skill.visibility !== "private");
}

/** 这个人此刻能用的技能：自己的和装了的，看得到、没停用。按名字排 */
export function activeSkills(userId: string): Skill[] {
  const prefs = userPrefs(userId);
  const installed = new Set(prefs.installed);
  const disabled = new Set(prefs.disabled);
  return load()
    .filter((s) => (s.owner === userId || (installed.has(s.id) && canSee({ id: userId }, s))) && !disabled.has(s.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 装了这个技能的人（不含作者） */
function installersOf(id: string): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(usersRoot);
  } catch {
    return [];
  }
  return names
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .filter((u) => userPrefs(u).installed.includes(id));
}

export function installCount(id: string): number {
  return installersOf(id).length;
}

function affected(skill: Skill): string[] {
  return [...new Set([skill.owner, ...installersOf(skill.id)])];
}

// ---------- SKILL.md ----------

export type ParsedSkillMd = { name?: string; description?: string; extra: string[]; body: string };

function unquote(v: string): string {
  const t = v.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/**
 * 拆开 SKILL.md：frontmatter 里的 name、description 拿出来（支持 | > 多行写法），其余的键原样留在 extra 里，
 * 改写时放回去（allowed-tools、metadata 之类，agent 自己认）。
 */
export function parseSkillMd(text: string): ParsedSkillMd {
  const src = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { extra: [], body: src.trim() };
  const lines = m[1]!.split("\n");
  const out: ParsedSkillMd = { extra: [], body: src.slice(m[0].length).trim() };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const kv = /^(name|description):(.*)$/.exec(line);
    if (!kv) {
      out.extra.push(line);
      continue;
    }
    let value = kv[2]!.trim();
    // 续行：缩进的行都算这个键的
    const cont: string[] = [];
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) cont.push(lines[++i]!.trim());
    if (/^[|>][+-]?$/.test(value)) value = cont.join(value.startsWith("|") ? "\n" : " ");
    else if (cont.length) value = [value, ...cont].join(" ");
    out[kv[1] as "name" | "description"] = unquote(value);
  }
  return out;
}

export function composeSkillMd(name: string, description: string, body: string, extra: string[] = []): string {
  const fm = [`name: ${name}`, `description: ${JSON.stringify(description)}`, ...extra.filter((l) => l.trim())];
  return `---\n${fm.join("\n")}\n---\n\n${body.trim()}\n`;
}

// ---------- 校验 ----------

function cleanName(raw: unknown): string {
  const name = String(raw ?? "").trim().toLowerCase();
  if (!SKILL_NAME.test(name)) throw new Error(`技能名「${name || "（空）"}」不合规：只能用小写字母、数字和 -，以字母或数字开头，最长 48 个字符`);
  return name;
}

function cleanDescription(raw: unknown): string {
  const d = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!d) throw new Error("要写一句说明：agent 靠它判断什么时候用这个技能");
  if (d.length > SKILL_LIMITS.description) throw new Error(`说明最多 ${SKILL_LIMITS.description} 个字`);
  return d;
}

export function cleanVars(raw: unknown): SkillVar[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("变量格式不对");
  if (raw.length > SKILL_LIMITS.vars) throw new Error(`一个技能最多声明 ${SKILL_LIMITS.vars} 个变量`);
  const out: SkillVar[] = [];
  for (const r of raw as Partial<SkillVar>[]) {
    const name = String(r?.name ?? "").trim();
    if (!VAR_NAME.test(name)) throw new Error(`变量名「${name || "（空）"}」不合规：大写字母开头，只能用大写字母、数字和 _，2～64 个字符`);
    if (RESERVED_VAR.test(name)) throw new Error(`${name} 是系统或 agent 自己要用的变量，换个名字（比如加上技能的前缀）`);
    if (out.some((v) => v.name === name)) throw new Error(`变量 ${name} 重复了`);
    const secret = r?.secret === true;
    const hosts = secret ? cleanHosts(r?.hosts, name) : [];
    out.push({
      name,
      description: String(r?.description ?? "").trim().slice(0, 200),
      secret,
      required: r?.required === true,
      ...(hosts.length ? { hosts } : {}),
    });
  }
  return out;
}

const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

/** 「允许发往的地址」：去掉协议和路径，只留主机（和端口）。写了 https://api.x.com/v1 也认 */
function cleanHosts(raw: unknown, name: string): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,，、]+/) : [];
  const out: string[] = [];
  for (const item of list) {
    const h = String(item ?? "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "");
    if (!h) continue;
    if (!HOST.test(h)) throw new Error(`${name} 允许发往的地址「${h}」不合规：写域名或 IP，可以带端口，比如 api.example.com、*.example.com、192.168.8.2:8080`);
    if (!out.includes(h)) out.push(h);
  }
  if (out.length > 10) throw new Error(`${name} 允许发往的地址最多 10 个`);
  return out;
}

/** 受保护的密钥：不进环境变量，只能经 skill_request 发往确认过的地址 */
export function isProtected(v: SkillVar): boolean {
  return v.secret && !!v.hosts?.length;
}

/** 这个地址在不在允许的列表里：api.x.com 不限端口，带端口的要端口也对上，*.x.com 匹配子域名 */
export function hostAllowed(allowed: string[], url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return allowed.some((entry) => {
    const [h, p] = entry.split(":") as [string, string | undefined];
    if (p && p !== port) return false;
    return h.startsWith("*.") ? host.endsWith(h.slice(1)) && host.length > h.length - 1 : host === h;
  });
}

function cleanVisibility(raw: unknown, sharedWith: unknown, owner: string): { visibility: SkillVisibility; sharedWith: string[] } {
  const visibility = (["private", "users", "all"] as const).find((v) => v === raw) ?? "private";
  const list = Array.isArray(sharedWith) ? [...new Set(sharedWith.filter((u): u is string => typeof u === "string" && u !== owner))] : [];
  if (visibility === "users" && list.length === 0) throw new Error("选「指定用户」时至少勾一个人");
  return { visibility, sharedWith: visibility === "users" ? list : [] };
}

/** 包里的相对路径：统一成 /，不许绝对路径、..、空段；隐藏的 .git 之类丢掉 */
function cleanRelPath(raw: string): string | null {
  const p = raw.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!p || p.startsWith("/") || /^[A-Za-z]:/.test(p)) throw new Error(`文件路径不合规：${raw}`);
  const parts = p.split("/");
  if (parts.some((s) => s === ".." || s === "" || s === ".")) throw new Error(`文件路径不合规：${raw}`);
  if (parts.some((s) => s === "__MACOSX" || s === ".DS_Store" || s === ".git" || s === "Thumbs.db")) return null;
  if (parts.length > 8 || p.length > 200) throw new Error(`文件路径太深或太长：${raw}`);
  return p;
}

export type SkillFiles = Map<string, Buffer>;

/**
 * 整理上传的一堆文件：路径校验、去掉共同的顶层目录（打包时常常多包一层）、找到 SKILL.md、
 * 读可选的 agent-loft.json（{ "vars": [...] } 声明变量）。返回的 files 里不含这两个。
 */
export function prepareUpload(entries: { path: string; data: Buffer }[]): { md: ParsedSkillMd; files: SkillFiles; vars?: SkillVar[] } {
  const cleaned: { path: string; data: Buffer }[] = [];
  for (const e of entries) {
    const p = cleanRelPath(e.path);
    if (p) cleaned.push({ path: p, data: e.data });
  }
  if (cleaned.length === 0) throw new Error("没有文件");
  // 全都在同一个顶层目录下、且根上没有 SKILL.md：去掉那一层
  const tops = new Set(cleaned.map((e) => (e.path.includes("/") ? e.path.split("/")[0] : "")));
  if (tops.size === 1 && !tops.has("")) {
    const top = [...tops][0]!;
    for (const e of cleaned) e.path = e.path.slice(top.length + 1);
  }
  const mdEntry = cleaned.find((e) => e.path.toLowerCase() === "skill.md");
  if (!mdEntry) throw new Error("包里要有 SKILL.md（放在最外层）");
  const files: SkillFiles = new Map();
  let vars: SkillVar[] | undefined;
  for (const e of cleaned) {
    if (e === mdEntry) continue;
    if (e.path === "agent-loft.json") {
      try {
        vars = cleanVars((JSON.parse(e.data.toString("utf8")) as { vars?: unknown }).vars);
      } catch (err) {
        throw new Error(`agent-loft.json 有问题：${err instanceof Error ? err.message : err}`);
      }
      continue;
    }
    files.set(e.path, e.data);
  }
  return { md: parseSkillMd(mdEntry.data.toString("utf8")), files, ...(vars ? { vars } : {}) };
}

function checkSizes(md: string, files: SkillFiles): void {
  if (md.length > SKILL_LIMITS.skillMd) throw new Error(`SKILL.md 太长（最多 ${SKILL_LIMITS.skillMd} 个字符）`);
  if (files.size + 1 > SKILL_LIMITS.files) throw new Error(`文件太多（最多 ${SKILL_LIMITS.files} 个）`);
  let total = Buffer.byteLength(md);
  for (const [p, data] of files) {
    if (data.length > SKILL_LIMITS.fileBytes) throw new Error(`${p} 太大（单个文件最多 ${SKILL_LIMITS.fileBytes / 1024 / 1024}MB）`);
    total += data.length;
  }
  if (total > SKILL_LIMITS.totalBytes) throw new Error(`技能太大（合计最多 ${SKILL_LIMITS.totalBytes / 1024 / 1024}MB）`);
}

// ---------- 文件 ----------

/** 整个目录换成新的：先写到旁边，再换名字，写一半失败不会留下半截技能 */
function replaceFiles(id: string, md: string, files: SkillFiles): void {
  const dir = skillDir(id);
  const tmp = `${dir}.new-${process.pid}`;
  const old = `${dir}.old-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(tmp, "SKILL.md"), md, { mode: 0o600 });
  for (const [rel, data] of files) {
    const target = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    // 脚本要能直接执行：看着像脚本的给执行权限
    const exec = /\.(sh|py|js|mjs|rb|pl)$/.test(rel) || data.subarray(0, 2).toString() === "#!";
    fs.writeFileSync(target, data, { mode: exec ? 0o700 : 0o600 });
  }
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(dir)) fs.renameSync(dir, old);
  fs.renameSync(tmp, dir);
  fs.rmSync(old, { recursive: true, force: true });
}

/** 技能目录里现有的文件（不含 SKILL.md），相对路径 → 内容 */
export function readFiles(id: string): SkillFiles {
  const dir = skillDir(id);
  const out: SkillFiles = new Map();
  const walk = (rel: string) => {
    for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && p !== "SKILL.md") out.set(p, fs.readFileSync(path.join(dir, p)));
    }
  };
  try {
    walk("");
  } catch {
    // 目录没了：当作没有附带文件
  }
  return out;
}

export function listFiles(id: string): { path: string; size: number }[] {
  return [...readFiles(id)].map(([p, d]) => ({ path: p, size: d.length })).sort((a, b) => a.path.localeCompare(b.path));
}

export function readSkillMd(id: string): string {
  try {
    return fs.readFileSync(path.join(skillDir(id), "SKILL.md"), "utf8");
  } catch {
    return "";
  }
}

/** 读一个附带文件（文本），给网页预览和 agent 的 get_skill 用 */
export function readSkillFile(id: string, rel: string): Buffer | undefined {
  try {
    const p = cleanRelPath(rel);
    return p ? fs.readFileSync(path.join(skillDir(id), p)) : undefined;
  } catch {
    // 路径不合规、文件不存在：都当没有
    return undefined;
  }
}

// ---------- 增删改 ----------

export type SkillInput = {
  name?: unknown;
  description?: unknown;
  /** SKILL.md 正文（不含 frontmatter） */
  body?: unknown;
  vars?: unknown;
  visibility?: unknown;
  sharedWith?: unknown;
};

function newId(): string {
  return `s_${crypto.randomBytes(5).toString("hex")}`;
}

/**
 * 新建。upload 给了就以包里的为准（名字、说明没另外给时从 SKILL.md 的 frontmatter 里取）；
 * 否则用 body 写一份新的 SKILL.md。
 */
export function createSkill(
  owner: string,
  input: SkillInput,
  source: Skill["source"],
  upload?: ReturnType<typeof prepareUpload>,
): Skill {
  if (load().filter((s) => s.owner === owner).length >= SKILL_LIMITS.perUser) throw new Error(`每人最多建 ${SKILL_LIMITS.perUser} 个技能`);
  const name = cleanName(input.name ?? upload?.md.name);
  if (findSkillByName(name)) throw new Error(`已经有叫 ${name} 的技能了（可能是别人建的），换个名字`);
  const description = cleanDescription(input.description ?? upload?.md.description);
  const body = String(input.body ?? upload?.md.body ?? "").trim();
  if (!body) throw new Error("技能的正文（告诉 agent 怎么做）不能为空");
  const files = upload?.files ?? new Map();
  const md = composeSkillMd(name, description, body, upload?.md.extra);
  checkSizes(md, files);
  const vars = input.vars !== undefined ? cleanVars(input.vars) : (upload?.vars ?? []);
  const now = Date.now();
  const skill: Skill = {
    id: newId(),
    name,
    description,
    owner,
    ...cleanVisibility(input.visibility, input.sharedWith, owner),
    vars,
    source,
    createdAt: now,
    updatedAt: now,
  };
  replaceFiles(skill.id, md, files);
  load().push(skill);
  saveIndex();
  skillEvents.emit("changed", [owner]);
  return skill;
}

export type FileChanges = { write?: SkillFiles; remove?: string[] };

/**
 * 作者改自己的技能。upload：整包换掉（名字不变，包里的 name 忽略）；
 * files：只增改 / 删除其中几个文件（agent 的 update_skill 用）。
 */
export function updateSkill(
  actor: string,
  id: string,
  input: SkillInput,
  opts: { upload?: ReturnType<typeof prepareUpload>; files?: FileChanges } = {},
): Skill {
  const skill = getSkill(id);
  if (!skill || skill.owner !== actor) throw new Error("这个技能不存在，或者不是你建的");
  const before = affected(skill);
  const current = parseSkillMd(readSkillMd(id));
  const upload = opts.upload;
  const description = input.description !== undefined ? cleanDescription(input.description) : upload?.md.description ? cleanDescription(upload.md.description) : skill.description;
  const body = input.body !== undefined ? String(input.body).trim() : (upload?.md.body ?? current.body);
  if (!body) throw new Error("技能的正文不能为空");
  // 先把要改的元数据都校验一遍：不合规就整个不改，别落得文件换了、设置没换
  const vars = input.vars !== undefined ? cleanVars(input.vars) : upload?.vars;
  const visibility = input.visibility !== undefined ? cleanVisibility(input.visibility, input.sharedWith ?? skill.sharedWith, skill.owner) : undefined;
  const contentChanged = input.description !== undefined || input.body !== undefined || !!upload || !!opts.files;
  if (contentChanged) {
    let files = upload ? upload.files : readFiles(id);
    if (opts.files) {
      files = new Map(files);
      for (const p of opts.files.remove ?? []) {
        const rel = cleanRelPath(p);
        if (rel) files.delete(rel);
      }
      for (const [p, data] of opts.files.write ?? []) {
        const rel = cleanRelPath(p);
        if (!rel || rel.toLowerCase() === "skill.md") continue;
        files.set(rel, data);
      }
    }
    const md = composeSkillMd(skill.name, description, body, upload ? upload.md.extra : current.extra);
    checkSizes(md, files);
    replaceFiles(id, md, files);
  }
  skill.description = description;
  if (vars) skill.vars = vars;
  if (visibility) Object.assign(skill, visibility);
  skill.updatedAt = Date.now();
  saveIndex();
  // 改之前装着的人也要通知：可能刚被取消了分享
  skillEvents.emit("changed", [...new Set([...before, ...affected(skill)])]);
  return skill;
}

export function deleteSkill(viewer: Viewer, id: string): void {
  const skill = getSkill(id);
  if (!skill || !canSee(viewer, skill) || !canDelete(viewer, skill)) throw new Error("这个技能不存在，或者你不能删它");
  const users = affected(skill);
  cache = load().filter((s) => s.id !== id);
  saveIndex();
  fs.rmSync(skillDir(id), { recursive: true, force: true });
  for (const u of users) {
    const prefs = userPrefs(u);
    if (!prefs.installed.includes(id) && !prefs.disabled.includes(id)) continue;
    savePrefs(u, { ...prefs, installed: prefs.installed.filter((x) => x !== id), disabled: prefs.disabled.filter((x) => x !== id) });
  }
  skillEvents.emit("changed", users);
}

export function installSkill(userId: string, id: string, on: boolean): void {
  const skill = getSkill(id);
  if (!skill || !canSee({ id: userId }, skill)) throw new Error("这个技能不存在");
  if (skill.owner === userId) throw new Error("自己的技能不用安装");
  const prefs = userPrefs(userId);
  const has = prefs.installed.includes(id);
  if (has === on) return;
  savePrefs(userId, {
    ...prefs,
    installed: on ? [...prefs.installed, id] : prefs.installed.filter((x) => x !== id),
    disabled: prefs.disabled.filter((x) => x !== id),
  });
  skillEvents.emit("changed", [userId]);
}

export function setSkillEnabled(userId: string, id: string, on: boolean): void {
  const prefs = userPrefs(userId);
  const has = prefs.disabled.includes(id);
  if (has === !on) return;
  savePrefs(userId, { ...prefs, disabled: on ? prefs.disabled.filter((x) => x !== id) : [...prefs.disabled, id] });
  skillEvents.emit("changed", [userId]);
}

/** 这个人自己的和装了的技能（含停用的）：填变量、确认地址都按这些算 */
function ownedOrInstalled(userId: string): Skill[] {
  const installed = new Set(userPrefs(userId).installed);
  return load().filter((s) => s.owner === userId || (installed.has(s.id) && canSee({ id: userId }, s)));
}

/** 这些技能里，这个变量声明过的允许地址（几个技能都声明了就合起来） */
export function declaredHosts(skills: Skill[], name: string): string[] {
  const out = new Set<string>();
  for (const s of skills) for (const v of s.vars) if (v.name === name && isProtected(v)) v.hosts!.forEach((h) => out.add(h));
  return [...out];
}

/**
 * 改变量的值。null / 空字符串 = 删掉。填了受保护密钥的值，就等于确认了它现在声明的地址；
 * approve 里的变量名：值不变，只把地址确认成现在声明的（作者改过地址之后）。
 */
export function setSkillVars(userId: string, patch: Record<string, unknown>, approve: string[] = []): void {
  const prefs = userPrefs(userId);
  const vars = { ...prefs.vars };
  const approved = { ...prefs.approved };
  const skills = ownedOrInstalled(userId);
  for (const [k, v] of Object.entries(patch)) {
    if (!VAR_NAME.test(k) || RESERVED_VAR.test(k)) throw new Error(`变量名 ${k} 不合规`);
    if (v === null || v === undefined || v === "") {
      delete vars[k];
      delete approved[k];
      continue;
    }
    const s = String(v);
    if (s.length > SKILL_LIMITS.varValue) throw new Error(`${k} 的值太长（最多 ${SKILL_LIMITS.varValue} 个字符）`);
    vars[k] = s;
    const hosts = declaredHosts(skills, k);
    if (hosts.length) approved[k] = hosts;
    else delete approved[k];
  }
  for (const k of approve) {
    if (vars[k] === undefined) continue;
    const hosts = declaredHosts(skills, k);
    if (hosts.length) approved[k] = hosts;
  }
  savePrefs(userId, { ...prefs, vars, approved });
  skillEvents.emit("changed", [userId]);
}

/** 受保护的变量名：任何一个启用着的技能把它声明成受保护，就不进环境变量 */
export function protectedNames(skills: Skill[]): Set<string> {
  return new Set(skills.flatMap((s) => s.vars.filter(isProtected).map((v) => v.name)));
}

/** 这个人的会话要注入的环境变量：只给他启用着的技能声明过的、他填了值的；受保护的密钥不放 */
export function skillEnv(userId: string, skills: Skill[] = activeSkills(userId)): Record<string, string> {
  const vars = userPrefs(userId).vars;
  const guarded = protectedNames(skills);
  const out: Record<string, string> = {};
  for (const s of skills) for (const v of s.vars) if (vars[v.name] !== undefined && !guarded.has(v.name)) out[v.name] = vars[v.name]!;
  return out;
}

/** 删用户：他建的技能（装了的人也就没了）、他的设置一起删 */
export function purgeUserSkills(userId: string): void {
  for (const s of load().filter((x) => x.owner === userId)) {
    try {
      deleteSkill({ id: userId, role: "member" }, s.id);
    } catch {
      // 已经没了
    }
  }
  fs.rmSync(prefsPath(userId), { force: true });
  fs.rmSync(path.join(pluginsRoot, checkId(userId, "用户")), { recursive: true, force: true });
}

/** 测试用：丢掉内存里的缓存 */
export function resetSkillCache(): void {
  cache = null;
}
