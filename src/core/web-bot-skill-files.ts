import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { sql, transaction } from "./db.js";
import { machineSkills } from "./skill-runtime.js";
import { cleanRelPath, listAllSkills, readFiles, parseSkillMd, readSkillMd, SKILL_LIMITS } from "./skills.js";
import { getUser } from "./users.js";
import { getBotProfile } from "./web-bot-profile.js";
import { saveBotExtension } from "./web-bot-extensions.js";
import { requireOwner, WebBotError } from "./web-bots.js";
import { readZip, type ZipEntry } from "./zip.js";

async function sources(user: string, bot: string) {
  requireOwner(user, bot);
  const engine = getBotProfile(user, bot).engine;
  const library = listAllSkills().filter(s => s.owner === user || s.visibility === "all").map(s => ({
    id: s.id, name: s.name, description: s.description, origin: "技能库", dir: "",
  }));
  if (getUser(user)?.role !== "admin" || engine === "pi") return library;
  const machine = new Map(machineSkills().filter(s => s.agents.includes(engine)).map(s => [s.dir, { name: s.name, description: s.description }]));
  if (engine === "codex") {
    try {
      const { appServer } = await import("../agents/codex/app-server.js");
      const list = await appServer.call<{ data: { skills: { path: string; name: string; description: string; scope: string }[] }[] }>(
        "skills/list", { cwds: [os.homedir()] });
      for (const { skills } of list.data) for (const skill of skills) {
        if (skill.scope !== "repo" && path.isAbsolute(skill.path) && path.basename(skill.path) === "SKILL.md")
          machine.set(path.dirname(skill.path), { name: skill.name, description: skill.description });
      }
    } catch { /* The local skill directories remain importable if the engine is offline. */ }
  }
  requireOwner(user, bot);
  if (getUser(user)?.role !== "admin" || getBotProfile(user, bot).engine !== engine) throw new WebBotError(409, "引擎或权限已更改。");
  return [...library, ...Array.from(machine, ([dir, skill]) => ({
    id: "machine-" + createHash("sha256").update(dir).digest("hex"), ...skill, origin: engine, dir,
  }))];
}
export async function botSkillSources(user: string, bot: string) {
  return (await sources(user, bot)).map(({ dir: _dir, ...entry }) => entry);
}

function readDirectory(dir: string) {
  const files: ZipEntry[] = [];
  let total = 0;
  function walk(relative: string) {
    for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || ["__pycache__", "node_modules"].includes(entry.name)) continue;
      const name = path.posix.join(relative, entry.name);
      if (name.length > 200 || name.split("/").length > 8) throw new Error("技能包目录过深。");
      if (entry.isDirectory()) { walk(name); continue; }
      if (!entry.isFile()) throw new Error("技能包包含链接或特殊文件。");
      const file = path.join(dir, name);
      const size = fs.statSync(file).size;
      total += size;
      if (size > SKILL_LIMITS.fileBytes || total > SKILL_LIMITS.totalBytes || files.length >= SKILL_LIMITS.files)
        throw new Error("技能包超过文件数量或大小限制。");
      files.push({ path: name, data: fs.readFileSync(file) });
    }
  }
  walk("");
  return files;
}

export async function importBotSkill(user: string, bot: string, input: Record<string, unknown>) {
  requireOwner(user, bot);
  let files: ZipEntry[];
  try {
    if (typeof input.source === "string") {
      const source = (await sources(user, bot)).find(s => s.id === input.source);
      if (!source) throw new WebBotError(404, "技能来源已不可用。");
      files = source.dir ? readDirectory(source.dir) : [
        { path: "SKILL.md", data: Buffer.from(readSkillMd(source.id)) },
        ...Array.from(readFiles(source.id), ([path, data]) => ({ path, data })),
      ];
    } else if (typeof input.zip === "string") {
      files = readZip(Buffer.from(input.zip, "base64"), SKILL_LIMITS.totalBytes, 2 * SKILL_LIMITS.files);
    } else throw new Error("请选择 ZIP 或 .skill 文件。");
    files = files.flatMap(f => {
      const relative = cleanRelPath(f.path);
      return relative ? [{ ...f, path: relative }] : [];
    });
    if (!files.length || files.length > SKILL_LIMITS.files) throw new Error("文件数量超出限制。");
    const prefix = files[0]!.path.split("/")[0] + "/";
    if (/^[^./\\][^/\\]*\/$/.test(prefix) && files.every(f => f.path.startsWith(prefix))) files = files.map(f => ({ ...f, path: f.path.slice(prefix.length) }));
    const names = new Set<string>();
    let total = 0;
    for (const file of files) {
      const parts = file.path.split("/");
      if (parts.some(p => /[\\:*?\[\]{}\x00-\x1f]/.test(p)) ||
          parts.length > 8 || file.path.length > 200 || names.has(file.path)) throw new Error("技能包文件路径无效或重复。");
      names.add(file.path);
      total += file.data.length;
      if (file.data.length > SKILL_LIMITS.fileBytes || total > SKILL_LIMITS.totalBytes) throw new Error("技能文件过大。");
    }
    if (files.some(f => f.path.split("/").slice(0,-1).some((_,i,parts) => names.has(parts.slice(0,i+1).join("/")))))
      throw new Error("技能包文件与目录重名。");
    const md = files.find(f => f.path === "SKILL.md");
    if (!md) throw new Error("技能包根目录需要 SKILL.md。");
    const instructions = new TextDecoder("utf-8", { fatal: true }).decode(md.data);
    const name = parseSkillMd(instructions).name || String(input.name || "导入的技能");
    return transaction(() => {
      const skill = saveBotExtension(user, bot, { kind: "skill", name, enabled: true, instructions });
      for (const file of files) if (file !== md) sql("INSERT INTO web_bot_skill_files VALUES(?,?,?)").run(skill.id, file.path, file.data);
      return { ...skill, files: skillManifest(skill.id) };
    });
  } catch (err) {
    if (err instanceof WebBotError) throw err;
    throw new WebBotError(400, err instanceof Error ? err.message : "无法导入技能包。");
  }
}

export function skillManifest(id: string) {
  return sql("SELECT path,length(data) AS bytes FROM web_bot_skill_files WHERE extension=? ORDER BY path").all(id)
    .map(f => ({ path: String(f.path), bytes: Number(f.bytes) }));
}

export function readSkillPage(id: string, file: string, offset = 0) {
  const row = sql("SELECT data FROM web_bot_skill_files WHERE extension=? AND path=?").get(id, file);
  if (!row || !Number.isSafeInteger(offset) || offset < 0) throw new WebBotError(400, "技能文件或偏移无效。");
  const data = Buffer.from(row.data as Uint8Array);
  let body: string, encoding: string;
  try { body = new TextDecoder("utf-8", { fatal: true }).decode(data); encoding = "text"; }
  catch { body = data.toString("base64"); encoding = "base64"; }
  if (offset > body.length) throw new WebBotError(400, "技能文件偏移超出范围。");
  const end = offset + 8000;
  return { encoding, text: body.slice(offset, end), nextOffset: end < body.length ? end : null };
}

/** Private, short-lived, read-only sandbox mount for a Bot with an explicit terminal grant. */
export function mountBotSkills(skills: { id?: string; instructions: string }[]) {
  const bundled = skills.filter(s => s.id);
  if (!bundled.length) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loft-bot-skills-"));
  const close = () => fs.rmSync(root, { recursive: true, force: true });
  try {
    for (const skill of bundled) {
      const dir = path.join(root, skill.id!);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "SKILL.md"), skill.instructions);
      for (const row of sql("SELECT path,data FROM web_bot_skill_files WHERE extension=?").all(skill.id!)) {
        const file = path.join(dir, String(row.path));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const data = Buffer.from(row.data as Uint8Array);
        fs.writeFileSync(file, data, { mode: data[0] === 35 && data[1] === 33 ? 0o700 : 0o600 });
      }
    }
    return { root, close };
  } catch (err) { close(); throw err; }
}
