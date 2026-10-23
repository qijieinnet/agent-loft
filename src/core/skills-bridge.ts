// 主进程这头的技能工具：agent 在对话里帮用户建、改技能（mcp/tasks-server.ts 以 skills 工具集拉起，
// 经 tasks-bridge 的 unix socket 转到这里）。身份校验在 tasks-bridge 里做过了。
//
// 规矩和定时任务一样：
//   - 只碰得到这条对话主人自己的技能；能读别人的（看得到的）但改不了；
//   - 建、改都弹授权卡让用户确认：技能会在以后的会话里被照着执行，网页里藏的指令不能就这么写进去；
//   - 新建的技能只有自己看得到，要分享让用户自己去「技能」页面设置。
import { hub } from "./hub.js";
import { interactions } from "./interactions.js";
import { config } from "./config.js";
import { TASK_TOOL_TIMEOUT_SEC } from "./tasks-mcp.js";
import {
  activeSkills,
  canSee,
  cleanVars,
  createSkill,
  findSkillByName,
  hostAllowed,
  isProtected,
  protectedNames,
  listFiles,
  readSkillFile,
  readSkillMd,
  updateSkill,
  userPrefs,
  type FileChanges,
  type Skill,
} from "./skills.js";
import { getUser } from "./users.js";

type Reply = { text: string; isError?: boolean };
const fail = (text: string): Reply => ({ text, isError: true });

export const SKILL_TOOL_NAMES = ["list_skills", "get_skill", "create_skill", "update_skill", "skill_request"];

// ---------- skill_request：替 agent 发带密钥的请求 ----------

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
const RESPONSE_MAX = 256 * 1024;
const PLACEHOLDER = /\{\{\s*([A-Z][A-Z0-9_]{1,63})\s*\}\}/g;

/** 响应里出现了密钥的值（接口回显、报错里带着）：换掉，别让它回到模型手里 */
function redact(text: string, secrets: [string, string][]): string {
  let out = text;
  for (const [name, value] of secrets) if (value.length >= 4) out = out.split(value).join(`[已隐藏 ${name}]`);
  return out;
}

/**
 * 按 agent 给的 url / headers / body 发一个 HTTP 请求，里面的 {{NAME}} 换成用户填的变量值。
 * 受保护的密钥只能发往用户确认过的地址（换完之后的地址：密钥塞进主机名里也逃不掉检查），
 * 不跟随跳转（跳到别处会把带着密钥的请求带过去），响应里出现的变量值一律抹掉。
 */
export async function skillRequest(userId: string, args: Record<string, unknown>): Promise<Reply> {
  const prefs = userPrefs(userId);
  const skills = activeSkills(userId);
  const guarded = protectedNames(skills);
  const declared = new Set(skills.flatMap((sk) => sk.vars.map((v) => v.name)));
  const method = String(args.method ?? "GET").toUpperCase();
  if (!METHODS.includes(method)) return fail(`method 只能是 ${METHODS.join("、")}`);
  const rawHeaders = args.headers && typeof args.headers === "object" ? (args.headers as Record<string, unknown>) : {};
  const body = args.body === undefined || args.body === null ? undefined : String(args.body);

  const used = new Set<string>();
  const missing = new Set<string>();
  const fillIn = (text: string, encode: boolean) =>
    text.replace(PLACEHOLDER, (m, name: string) => {
      used.add(name);
      const value = declared.has(name) ? prefs.vars[name] : undefined;
      if (value === undefined) {
        missing.add(name);
        return m;
      }
      return encode ? encodeURIComponent(value) : value;
    });
  let url: URL;
  try {
    url = new URL(fillIn(String(args.url ?? ""), true));
  } catch {
    return fail("url 不是合法的地址。");
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHeaders)) headers[k] = fillIn(String(v), false);
  const filledBody = body === undefined ? undefined : fillIn(body, false);
  if (missing.size) {
    return fail(`这些变量用户还没配（或者没有启用着的技能声明过）：${[...missing].join("、")}。请用户去网页侧栏「技能」里填好，下一条消息起可用。`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return fail("只支持 http 和 https。");
  for (const name of used) {
    if (!guarded.has(name)) continue;
    const allowed = prefs.approved[name] ?? [];
    if (!hostAllowed(allowed, url)) {
      return fail(
        allowed.length
          ? `${name} 只能发往 ${allowed.join("、")}，这次的地址是 ${url.host}，没有发出去。`
          : `${name} 允许发往的地址用户还没确认（技能作者可能改过），请用户去网页侧栏「技能」里确认一下。`,
      );
    }
  }

  const secrets: [string, string][] = Object.entries(prefs.vars).filter(([k]) => declared.has(k));
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      ...(filledBody !== undefined && method !== "GET" && method !== "HEAD" ? { body: filledBody } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return fail(`请求失败：${redact(err instanceof Error ? err.message : String(err), secrets)}`);
  }
  const lines = [`HTTP ${res.status} ${res.statusText}`];
  for (const h of ["content-type", "location", "retry-after"]) {
    const v = res.headers.get(h);
    if (v) lines.push(`${h}: ${redact(v, secrets)}`);
  }
  if (res.status >= 300 && res.status < 400) lines.push("（没有跟随跳转：要的话用 location 里的地址再发一次）");
  const type = res.headers.get("content-type") ?? "";
  const buf = await readCapped(res, RESPONSE_MAX);
  const textual = !type || /text|json|xml|javascript|csv|yaml|x-www-form-urlencoded/i.test(type);
  if (method === "HEAD") return { text: lines.join("\n") };
  if (!textual) return { text: `${lines.join("\n")}\n\n（二进制内容，${buf.length} 字节，没有返回）` };
  const text = redact(buf.toString("utf8"), secrets);
  return { text: `${lines.join("\n")}\n\n${text}${buf.length >= RESPONSE_MAX ? "\n…（响应太长，只返回了前 256KB）" : ""}`, ...(res.ok ? {} : { isError: true }) };
}

async function readCapped(res: Response, max: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    size += value.length;
    if (size >= max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, max);
}

async function confirm(convKey: string, title: string, detail: string): Promise<boolean> {
  const timeout = Math.min(config().approvalTimeoutMs, (TASK_TOOL_TIMEOUT_SEC - 60) * 1000);
  const outcome = await interactions.create(convKey, { kind: "approval", title, detail }, timeout, hub.liveSessionId(convKey));
  return outcome.settlement === "allow-once" || outcome.settlement === "allow-always" || outcome.settlement === "allow-session";
}

/** agent 给的文件：[{ path, content }]，content 是文本 */
function filesArg(raw: unknown): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (raw === undefined) return out;
  if (!Array.isArray(raw)) throw new Error("files 要是数组：[{ path, content }]");
  for (const f of raw as { path?: unknown; content?: unknown }[]) {
    const p = String(f?.path ?? "").trim();
    if (!p) throw new Error("files 里每一项都要有 path");
    out.set(p, Buffer.from(String(f?.content ?? ""), "utf8"));
  }
  return out;
}

function quote(text: string, max = 1500): string {
  const t = text.length > max ? `${text.slice(0, max)}\n…（共 ${text.length} 字，后面省略）` : text;
  return t.split("\n").map((l) => `> ${l}`).join("\n");
}

function cardOf(fields: { name: string; description?: string; body?: string; files?: string[]; removed?: string[]; vars?: Skill["vars"] }): string {
  const lines = [`**技能**：${fields.name}`];
  if (fields.description) lines.push(`**说明**：${fields.description}`);
  if (fields.vars?.length) lines.push(`**要用的变量**：${fields.vars.map((v) => `${v.name}${v.secret ? "（密钥）" : ""}`).join("、")}`);
  if (fields.files?.length) lines.push(`**写入文件**：${fields.files.join("、")}`);
  if (fields.removed?.length) lines.push(`**删除文件**：${fields.removed.join("、")}`);
  if (fields.body) lines.push("", "**SKILL.md 正文**：", "", quote(fields.body));
  return lines.join("\n");
}

function describe(s: Skill, userId: string): string {
  const vars = userPrefs(userId).vars;
  const v = s.vars.length
    ? ` · 变量 ${s.vars.map((x) => `${x.name}${vars[x.name] !== undefined ? "（已配）" : x.required ? "（未配，必填）" : "（未配）"}${isProtected(x) ? `（受保护，只能用 skill_request 发往 ${x.hosts!.join("、")}）` : ""}`).join("、")}`
    : "";
  return `- ${s.name}：${s.description}${s.owner === userId ? "（自己建的）" : `（${getUser(s.owner)?.name ?? "别人"}建的）`}${v}`;
}

export async function skillToolCall(userId: string, convKey: string, tool: string, args: Record<string, unknown>): Promise<Reply> {
  if (tool === "skill_request") return skillRequest(userId, args);
  if (tool === "list_skills") {
    const list = activeSkills(userId);
    if (!list.length) return { text: "用户在 agent-loft 里还没有启用任何技能。" };
    return { text: `用户启用着的技能（${list.length} 个）：\n${list.map((s) => describe(s, userId)).join("\n")}` };
  }

  const name = String(args.name ?? "").trim().toLowerCase();
  if (!name) return fail("要给 name（技能名）。");

  if (tool === "get_skill") {
    const s = findSkillByName(name);
    if (!s || !canSee({ id: userId }, s)) return fail(`没有叫 ${name} 的技能（或者用户看不到它）。`);
    const file = typeof args.file === "string" && args.file.trim() ? args.file.trim() : "";
    if (file) {
      const data = readSkillFile(s.id, file);
      if (!data) return fail(`${name} 里没有文件 ${file}。`);
      return { text: data.toString("utf8").slice(0, 100_000) };
    }
    const files = listFiles(s.id);
    return {
      text: [
        describe(s, userId),
        "",
        "SKILL.md：",
        "",
        readSkillMd(s.id),
        ...(files.length ? ["", `附带文件（用 file 参数读）：${files.map((f) => `${f.path}（${f.size} 字节）`).join("、")}`] : []),
      ].join("\n"),
    };
  }

  if (tool === "create_skill") {
    let files: Map<string, Buffer>;
    let vars: Skill["vars"];
    try {
      files = filesArg(args.files);
      vars = cleanVars(args.vars);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    const description = String(args.description ?? "").trim();
    const body = String(args.body ?? "").trim();
    if (findSkillByName(name)) return fail(`已经有叫 ${name} 的技能了（可能是别人建的），换个名字；要改自己的用 update_skill。`);
    const ok = await confirm(convKey, `新建技能「${name}」`, `${cardOf({ name, description, body, files: [...files.keys()], vars })}\n\n建好后只有你自己看得到，可以在网页侧栏「技能」里修改、分享给别人。`);
    if (!ok) return fail("用户没有同意，技能没有建。");
    try {
      const skill = createSkill(userId, { name, description, body, vars }, "agent", files.size ? { md: { extra: [], body }, files } : undefined);
      return {
        text: `已建好技能 ${skill.name}（只有用户自己看得到）。这一轮结束后会话会自动重新加载，之后就能用了；用户也可以在输入框里 @${skill.name} 点名用它。${skill.vars.length ? `它要用的变量请用户去网页侧栏「技能」里填：${skill.vars.map((v) => v.name).join("、")}。` : ""}`,
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  if (tool === "update_skill") {
    const s = findSkillByName(name);
    if (!s || s.owner !== userId) return fail(`${name} 不存在，或者不是用户自己建的（只能改自己的技能）。`);
    let changes: FileChanges;
    let vars: Skill["vars"] | undefined;
    try {
      const write = filesArg(args.files);
      const remove = Array.isArray(args.delete_files) ? args.delete_files.map(String) : [];
      changes = { ...(write.size ? { write } : {}), ...(remove.length ? { remove } : {}) };
      vars = args.vars !== undefined ? cleanVars(args.vars) : undefined;
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    const description = typeof args.description === "string" ? args.description.trim() : undefined;
    const body = typeof args.body === "string" ? args.body.trim() : undefined;
    if (description === undefined && body === undefined && !changes.write && !changes.remove && !vars) return fail("没有要改的内容。");
    const ok = await confirm(
      convKey,
      `修改技能「${name}」`,
      `${cardOf({
        name,
        ...(description ? { description } : {}),
        ...(body ? { body } : {}),
        ...(changes.write ? { files: [...changes.write.keys()] } : {}),
        ...(changes.remove ? { removed: changes.remove } : {}),
        ...(vars ? { vars } : {}),
      })}${s.visibility !== "private" ? "\n\n这个技能分享给了别人，改了之后装了它的人也会用上新的。" : ""}`,
    );
    if (!ok) return fail("用户没有同意，技能没有改。");
    try {
      updateSkill(
        userId,
        s.id,
        { ...(description !== undefined ? { description } : {}), ...(body !== undefined ? { body } : {}), ...(vars ? { vars } : {}) },
        changes.write || changes.remove ? { files: changes } : {},
      );
      return { text: `已更新技能 ${name}，这一轮结束后会话会自动重新加载。` };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
  return fail(`没有工具 ${tool}`);
}
