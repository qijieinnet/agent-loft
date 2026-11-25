import { claudeSettings } from "./web-bot-claude-tools.js";
import { skillManifest } from "./web-bot-skill-files.js";
import { randomUUID } from "node:crypto";
import { sql, transaction } from "./db.js";
import { botCodexSettings } from "./web-bot-codex-tools.js";
import { getUser } from "./users.js";
import { getBot, requireOwner, WebBotError } from "./web-bots.js";

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };
type Skill = { kind: "skill"; name: string; instructions: string; enabled: boolean };
const grantModes = ["private", "members", "ask-private", "ask-members"] as const;
type ToolGrant = typeof grantModes[number];
export type Connection = {
  kind: "http" | "stdio"; name: string; endpoint: string; args: string[];
  secret: string; catalog: ToolSpec[]; grants: Record<string, ToolGrant>;
};
type Extension = Skill | Connection;
type Entry = { id: string; revision: number; config: Extension };
type Input = Record<string, unknown>;

function invalid(message: string): never { throw new WebBotError(400, message); }
function string(value: unknown, limit: number, label: string) {
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0")) invalid(label + "无效或过长。");
  return value.trim();
}
function entries(bot: string): Entry[] {
  return sql("SELECT id,revision,config FROM web_bot_extensions WHERE bot=? ORDER BY rowid").all(bot)
    .map(row => ({ id: String(row.id), revision: Number(row.revision), config: JSON.parse(String(row.config)) }));
}
function publicEntry({ id, revision, config }: Entry) {
  if (config.kind === "skill") return { id, revision, ...config, files: skillManifest(id) };
  const { secret, catalog, ...settings } = config;
  return { id, revision, ...settings, hasSecret: !!secret, catalog: catalog.map(({ name, description }) => ({ name, description })) };
}
export function listBotExtensions(user: string, bot: string) {
  requireOwner(user, bot);
  return { entries: entries(bot).map(publicEntry), claude: claudeSettings(user, bot), codex: botCodexSettings(user, bot), canUseLocal: getUser(user)?.role === "admin" };
}
function existing(user: string, bot: string, id: string, revision: unknown) {
  requireOwner(user, bot);
  const row = sql("SELECT revision,config FROM web_bot_extensions WHERE bot=? AND id=?").get(bot, id);
  if (!row) throw new WebBotError(404, "这个配置已移除。");
  const entry: Entry = { id, revision: Number(row.revision), config: JSON.parse(String(row.config)) };
  if (entry.revision !== revision) throw new WebBotError(409, "配置已经更改，请重新打开设置。");
  return entry;
}
function connection(input: Input, user: string, previous?: Connection): Connection {
  const { kind } = input;
  if (kind !== "http" && kind !== "stdio") invalid("请选择连接方式。");
  const endpoint = string(input.endpoint, 2048, "连接地址或命令");
  const args = input.args ?? [];
  if (!Array.isArray(args) || args.length > 32 || args.some(arg => typeof arg !== "string" || arg.length > 1024 || arg.includes("\0"))) invalid("启动参数无效。");
  if (kind === "http") {
    const url = URL.parse(endpoint);
    if (!url || url.username || url.password || url.hash || !["http:", "https:"].includes(url.protocol) || args.length) invalid("请填写有效的 HTTP(S) MCP 地址。");
    if (getUser(user)?.role !== "admin" && url.protocol !== "https:") invalid("请使用 HTTPS 地址。");
  } else if (getUser(user)?.role !== "admin") throw new WebBotError(403, "本机 MCP 命令需要管理员配置。");
  const same = previous?.kind === kind && previous.endpoint === endpoint && JSON.stringify(args) === JSON.stringify(previous.args);
  const secret = input.secret === undefined && same ? previous.secret : input.secret ?? "";
  if (typeof secret !== "string" || secret.length > 8192) invalid("连接凭据无效。");
  if (kind === "http" && /[\r\n]/.test(secret)) invalid("令牌不能包含换行。");
  if (kind === "stdio" && secret) {
    let env;
    try { env = JSON.parse(secret); } catch { invalid("环境变量请填写 JSON 对象。"); }
    if (!env || typeof env !== "object" || Array.isArray(env) || Object.entries(env).some(([k,v]) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) || typeof v !== "string" || v.includes("\0"))) invalid("环境变量的值必须是字符串。");
  }
  const retain = same && previous.secret === secret;
  return { kind, name: string(input.name, 80, "名称"), endpoint, args, secret,
    catalog: retain ? previous.catalog : [], grants: retain ? previous.grants : {} };
}
function persist(bot: string, config: Extension, previous?: Entry) {
  const active = [...entries(bot).filter(e => e.id !== previous?.id).map(e => e.config), config];
  const characters = active.reduce((sum, item) => sum + (item.kind === "skill" ? (item.enabled ? item.instructions.length : 0)
    : JSON.stringify(item.catalog.filter(t => Object.hasOwn(item.grants, t.name))).length), 0);
  if (characters > 96000) invalid("已启用的技能和工具说明过长，请停用部分内容后再保存。");
  const id = previous?.id ?? randomUUID(), revision = (previous?.revision ?? 0) + 1;
  sql("INSERT INTO web_bot_extensions(id,bot,revision,config) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,config=excluded.config")
    .run(id, bot, revision, JSON.stringify(config));
  return publicEntry({ id, revision, config });
}
export function saveBotExtension(user: string, bot: string, input: Input, id?: string) {
  return transaction(() => {
    requireOwner(user, bot);
    const previous = id ? existing(user, bot, id, input.revision) : undefined;
    if (!previous && entries(bot).length >= 24) invalid("每个 Bot 最多保存 24 个技能和连接。");
    if (previous && previous.config.kind !== input.kind) invalid("连接类型已更改，请重新添加。");
    if (input.kind === "skill") {
      if (typeof input.enabled !== "boolean") invalid("请选择技能状态。");
      return persist(bot, { kind: "skill", name: string(input.name, 80, "名称"),
        instructions: string(input.instructions, 96000, "技能说明"), enabled: input.enabled }, previous);
    }
    return persist(bot, connection(input, user, previous?.config.kind !== "skill" ? previous?.config : undefined), previous);
  });
}
export function removeBotExtension(user: string, bot: string, id: string, revision: unknown) {
  transaction(() => {
    existing(user, bot, id, revision);
    sql("DELETE FROM web_bot_extensions WHERE bot=? AND id=?").run(bot, id);
  });
}
export function saveToolGrants(user: string, bot: string, id: string, input: Input) {
  return transaction(() => {
    const entry = existing(user, bot, id, input.revision);
    const grants = input.grants;
    if (entry.config.kind === "skill" || !grants || typeof grants !== "object" || Array.isArray(grants)) invalid("请选择工具权限。");
    const names = new Set(entry.config.catalog.map(tool => tool.name));
    const selected = Object.entries(grants);
    if (selected.length > 64 || selected.some(([key, value]) => !names.has(key) || !grantModes.includes(value as ToolGrant))) invalid("工具权限无效，请重新读取列表。");
    return persist(bot, { ...entry.config, grants: Object.fromEntries(selected) }, entry);
  });
}
export async function discoverBotTools(user: string, bot: string, id: string, revision: unknown) {
  const check = () => existing(user, bot, id, revision);
  const { config } = check();
  if (config.kind === "skill") invalid("请选择 MCP 连接。");
  const { listTools } = await import("./web-bot-mcp.js");
  const catalog = await listTools(config, () => { check(); return getUser(user)?.role === "admin"; });
  return transaction(() => {
    const entry = check();
    const names = new Set(catalog.map(tool => tool.name));
    const grants = Object.fromEntries(Object.entries(config.grants).filter(([name]) => names.has(name)));
    return persist(bot, { ...config, catalog, grants }, entry);
  });
}
export function extensionsForTurn(user: string, bot: string, shared: boolean) {
  const owner = getBot(user, bot).ownerId;
  const list = entries(bot);
  const tools = list.flatMap(({ id, config }) => config.kind === "skill" ? [] : config.catalog
    .filter(({ name }) => Object.hasOwn(config.grants, name) && (config.grants[name]?.endsWith("members") || (!shared && user === owner)))
    .map(spec => ({ id, service: config.name, ask: config.grants[spec.name]?.startsWith("ask-"), ...spec })));
  const skills = list.flatMap(({ id, config }) => {
    if (config.kind !== "skill" || !config.enabled) return [];
    const files = skillManifest(id);
    return [{ name: config.name, instructions: config.instructions, ...(files.length ? { id, files } : {}) }];
  });
  // Compare immutable entry identities and revisions, including removal and subsequent recreation.
  const version = list.map(e => e.id + "/" + e.revision).join(",");
  const check = () => {
    const rows = sql("SELECT id,revision FROM web_bot_extensions WHERE bot=? ORDER BY rowid").all(bot);
    if (getBot(user, bot).ownerId !== owner || rows.map(e => e.id + "/" + e.revision).join(",") !== version)
      throw new WebBotError(409, "技能或工具设置已更改，请重新发送。");
  };
  async function call(id: string, name: string, args: Record<string, unknown>, signal: AbortSignal, checkAccess: () => void, beforeDispatch: () => void, confirm?: () => Promise<void>) {
    const tool = tools.find(t => t.id === id && t.name === name);
    if (!tool) throw new WebBotError(403, "这个对话没有使用该工具的权限。");
    const { config } = list.find(e => e.id === id)!;
    if (config.kind === "skill") invalid("请选择工具。");
    if (tool.ask) {
      if (!confirm) throw new WebBotError(403, "此工具需要发起人逐次确认。");
      checkAccess(); check();
      await confirm();
    }
    const { callTool } = await import("./web-bot-mcp.js");
    return callTool(config, name, args, signal, () => {
      checkAccess(); check();
      return getUser(owner)?.role === "admin";
    }, beforeDispatch);
  }
  return { tools, skills, check, call };
}
