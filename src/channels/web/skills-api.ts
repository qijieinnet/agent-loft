// 技能页面的接口：/api/skills。看得到的技能（自己的、公开的、指名给自己的）、安装 / 停用、变量、上传。
// 只有作者能改；管理员能删别人公开或分享出来的（下架），但看不到、删不了别人私有的。
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { machineSkills } from "../../core/skill-runtime.js";
import {
  canDelete,
  canSee,
  createSkill,
  declaredHosts,
  deleteSkill,
  getSkill,
  installCount,
  installSkill,
  listAllSkills,
  listFiles,
  parseSkillMd,
  prepareUpload,
  readSkillFile,
  readSkillMd,
  setSkillEnabled,
  setSkillVars,
  SKILL_LIMITS,
  updateSkill,
  userPrefs,
  type Skill,
  type SkillInput,
} from "../../core/skills.js";
import { readZip } from "../../core/zip.js";
import { getUser, isAdmin, listUsers, type User } from "../../core/users.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";

function view(s: Skill, user: User) {
  const prefs = userPrefs(user.id);
  const mine = s.owner === user.id;
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    owner: s.owner,
    ownerName: getUser(s.owner)?.name ?? "（已删除的用户）",
    mine,
    visibility: s.visibility,
    // 分享给了谁只有作者看得到
    ...(mine ? { sharedWith: s.sharedWith, installs: installCount(s.id) } : {}),
    vars: s.vars,
    source: s.source,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    installed: mine || prefs.installed.includes(s.id),
    enabled: !prefs.disabled.includes(s.id),
    canDelete: canDelete({ id: user.id, role: user.role }, s),
  };
}

/**
 * 变量：值按名字存；密钥（任何一个看得到的技能把它标成密钥）不回显，只说填没填。
 * 受保护的密钥再带上确认过的地址（hosts），作者后来加了没确认过的地址就列在 pending 里。
 */
function varsView(user: User, skills: Skill[]) {
  const secret = new Set(skills.flatMap((s) => s.vars.filter((v) => v.secret).map((v) => v.name)));
  const prefs = userPrefs(user.id);
  const mineOrInstalled = skills.filter((s) => s.owner === user.id || prefs.installed.includes(s.id));
  return Object.fromEntries(
    Object.entries(prefs.vars).map(([k, v]) => {
      const declared = declaredHosts(mineOrInstalled, k);
      const approved = prefs.approved[k] ?? [];
      const pending = declared.filter((h) => !approved.includes(h));
      return [
        k,
        {
          set: true,
          ...(secret.has(k) ? {} : { value: v }),
          ...(declared.length ? { hosts: approved } : {}),
          ...(pending.length ? { pending } : {}),
        },
      ];
    }),
  );
}

type UploadBody = { zip?: string; files?: { path?: string; data?: string }[] };

/** 上传：zip（.zip / .skill）或者一堆文件（选文件夹 / 单个 SKILL.md），内容都是 base64 */
function uploadOf(raw: UploadBody | undefined): ReturnType<typeof prepareUpload> | undefined {
  if (!raw) return undefined;
  if (typeof raw.zip === "string") {
    const entries = readZip(Buffer.from(raw.zip, "base64"), SKILL_LIMITS.totalBytes * 2, SKILL_LIMITS.files * 2);
    return prepareUpload(entries);
  }
  if (Array.isArray(raw.files)) {
    if (raw.files.length > SKILL_LIMITS.files * 2) throw new Error(`文件太多（最多 ${SKILL_LIMITS.files} 个）`);
    return prepareUpload(raw.files.map((f) => ({ path: String(f.path ?? ""), data: Buffer.from(String(f.data ?? ""), "base64") })));
  }
  throw new Error("上传的内容不对");
}

const bad = (err: unknown) => (err instanceof HttpError ? err : new HttpError(400, err instanceof Error ? err.message : String(err)));

/** 处理了就返回 true */
export async function handleSkillsApi(req: IncomingMessage, res: ServerResponse, url: URL, user: User): Promise<boolean> {
  const method = req.method ?? "GET";
  const p = url.pathname;
  const viewer = { id: user.id, role: user.role };

  if (p === "/api/skills" && method === "GET") {
    const visible = listAllSkills().filter((s) => canSee(viewer, s));
    sendJson(res, 200, {
      skills: visible.map((s) => view(s, user)),
      vars: varsView(user, visible),
      // 分享给谁：列出其他还能登录的用户
      users: listUsers()
        .filter((u) => !u.disabled && u.id !== user.id)
        .map((u) => ({ id: u.id, name: u.name })),
      ...(isAdmin(user) ? { machine: machineSkills().map((m) => ({ name: m.name, description: m.description, dir: m.dir, agents: m.agents })) } : {}),
      limits: SKILL_LIMITS,
    });
    return true;
  }

  // 管理员看机器上原有技能的 SKILL.md
  if (p === "/api/skills/machine" && method === "GET") {
    if (!isAdmin(user)) throw new HttpError(403, "只有管理员能看机器上的技能");
    const m = machineSkills().find((x) => x.name === url.searchParams.get("name"));
    if (!m) throw new HttpError(404, "没有这个技能");
    let md = "";
    try {
      md = fs.readFileSync(path.join(m.dir, "SKILL.md"), "utf8");
    } catch {
      md = "（读不到 SKILL.md）";
    }
    sendJson(res, 200, { ...m, skillMd: md });
    return true;
  }

  if (p === "/api/skills/vars" && method === "PUT") {
    const body = await readJsonBody<{ values?: Record<string, unknown>; approve?: unknown }>(req);
    try {
      setSkillVars(user.id, body.values ?? {}, Array.isArray(body.approve) ? body.approve.map(String) : []);
    } catch (err) {
      throw bad(err);
    }
    sendJson(res, 200, { vars: varsView(user, listAllSkills().filter((s) => canSee(viewer, s))) });
    return true;
  }

  if (p === "/api/skills" && method === "POST") {
    const body = await readJsonBody<SkillInput & { upload?: UploadBody }>(req, 16 * 1024 * 1024);
    let skill: Skill;
    try {
      const upload = uploadOf(body.upload);
      const { upload: _u, ...input } = body;
      skill = createSkill(user.id, input, upload ? "upload" : "manual", upload);
    } catch (err) {
      throw bad(err);
    }
    sendJson(res, 200, view(skill, user));
    return true;
  }

  const m = /^\/api\/skills\/(s_[a-f0-9]+)(?:\/(install|enable|file))?$/.exec(p);
  if (!m) return false;
  const skill = getSkill(m[1]!);
  if (!skill || !canSee(viewer, skill)) throw new HttpError(404, "这个技能不存在");

  if (!m[2] && method === "GET") {
    const md = parseSkillMd(readSkillMd(skill.id));
    sendJson(res, 200, { ...view(skill, user), body: md.body, extra: md.extra, files: listFiles(skill.id) });
    return true;
  }
  if (m[2] === "file" && method === "GET") {
    const data = readSkillFile(skill.id, url.searchParams.get("path") ?? "");
    if (!data) throw new HttpError(404, "没有这个文件");
    // 只当文本看：二进制的给个提示
    const text = data.includes(0) ? null : data.toString("utf8");
    sendJson(res, 200, { text, size: data.length });
    return true;
  }
  if (m[2] === "install" && method === "POST") {
    const body = await readJsonBody<{ on?: boolean }>(req);
    try {
      installSkill(user.id, skill.id, body.on !== false);
    } catch (err) {
      throw bad(err);
    }
    sendJson(res, 200, view(skill, user));
    return true;
  }
  if (m[2] === "enable" && method === "POST") {
    const body = await readJsonBody<{ on?: boolean }>(req);
    setSkillEnabled(user.id, skill.id, body.on !== false);
    sendJson(res, 200, view(skill, user));
    return true;
  }
  if (!m[2] && method === "PATCH") {
    if (skill.owner !== user.id) throw new HttpError(403, "只有作者能修改技能内容和共享范围");
    const body = await readJsonBody<SkillInput & { upload?: UploadBody }>(req, 16 * 1024 * 1024);
    let updated: Skill;
    try {
      const upload = uploadOf(body.upload);
      const { upload: _u, name: _n, ...input } = body;
      updated = updateSkill(user.id, skill.id, input, upload ? { upload } : {});
    } catch (err) {
      throw bad(err);
    }
    sendJson(res, 200, view(updated, user));
    return true;
  }
  if (!m[2] && method === "DELETE") {
    try {
      deleteSkill(viewer, skill.id);
    } catch (err) {
      throw bad(err);
    }
    sendJson(res, 200, { ok: true });
    return true;
  }
  return false;
}
