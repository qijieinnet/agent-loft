import { nativeOptions, type BotNativeOption } from "./web-bot-native-catalog.js";
import fs from "node:fs";
import path from "node:path";
import { sql, transaction } from "./db.js";
import { getUser } from "./users.js";
import { getBotProfile, requireBotEngine } from "./web-bot-profile.js";
import { getBot, requireOwner, WebBotError } from "./web-bots.js";

type Settings = {
  revision: number;
  extra?: BotNativeOption[];
  webSearch: "off" | "private" | "members";
  terminal: boolean;
  edit: boolean;
  directory: string;
};
const defaults: Settings = { revision: 0, webSearch: "off", terminal: false, edit: false, directory: "" };

function read(bot: string): Settings {
  const row = sql("SELECT revision,settings FROM web_bot_codex_tools WHERE bot=?").get(bot);
  return row ? { ...JSON.parse(String(row.settings)), revision: Number(row.revision) } : { ...defaults };
}
function directory(value: unknown): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.length > 4096)
    throw new WebBotError(400, "请填写服务器上已有目录的绝对路径。");
  let real;
  try {
    real = fs.realpathSync(value);
    if (!fs.statSync(real).isDirectory()) throw new Error();
  } catch { throw new WebBotError(400, "目录不存在或服务无法访问。"); }
  if (real === path.parse(real).root || /[*?\[\]{}\x00-\x1f]/.test(real))
    throw new WebBotError(400, "请选择具体的目录，路径不能含有通配符。");
  return real;
}

export function botCodexSettings(user: string, bot: string) {
  requireOwner(user, bot);
  return getBotProfile(user, bot).engine === "codex" ? read(bot) : null;
}

export function saveBotCodexSettings(user: string, bot: string, input: Record<string, unknown>) {
  return transaction(() => {
    const old = botCodexSettings(user, bot);
    if (!old) throw new WebBotError(409, "请先在 Bot 资料中选择 Codex 引擎。");
    requireBotEngine(user, "codex");
    if (input.revision !== old.revision) throw new WebBotError(409, "工具设置已更新，请重新打开。");
    const { webSearch, terminal, edit } = input;
    if ((webSearch !== "off" && webSearch !== "private" && webSearch !== "members") ||
        typeof terminal !== "boolean" || typeof edit !== "boolean")
      throw new WebBotError(400, "请选择有效的 Codex 工具权限。");
    const extra = input.extra ?? old.extra ?? [];
    if (!Array.isArray(extra) || extra.length > Object.keys(nativeOptions).length || extra.some(id => typeof id !== "string" || !Object.hasOwn(nativeOptions, id)))
      throw new WebBotError(400, "引擎能力选项无效。");
    if (extra.includes("multi_agent")) throw new WebBotError(400, "Codex 子智能体需要持久会话。");
    if ((terminal || edit || extra.length) && getUser(user)?.role !== "admin")
      throw new WebBotError(403, "本机工具需要管理员授权。");
    const settings = { webSearch, terminal, edit, extra: [...new Set(extra)] as BotNativeOption[], directory: terminal || edit || extra.includes("view_image") ? directory(input.directory) : "" };
    const revision = old.revision + 1;
    sql("INSERT INTO web_bot_codex_tools(bot,revision,settings) VALUES(?,?,?) ON CONFLICT(bot) DO UPDATE SET revision=excluded.revision,settings=excluded.settings")
      .run(bot, revision, JSON.stringify(settings));
    return { ...settings, revision };
  });
}

/** Normal Bot chat only. Delegations and background completions have no native grants. */
export function botCodexTurn(user: string, bot: string, shared: boolean) {
  const saved = read(bot);
  const owner = getBot(user, bot).ownerId;
  const personal = owner === user && !shared;
  const extra = personal && getUser(user)?.role === "admin" ? (saved.extra ?? []).filter(id => id !== "multi_agent") : [];
  const local = personal && getUser(user)?.role === "admin" && (saved.terminal || saved.edit || extra.includes("view_image"));
  const webSearch = saved.webSearch === "members" || (personal && saved.webSearch === "private");
  function check() {
    if (read(bot).revision !== saved.revision || (extra.length && getUser(user)?.role !== "admin") || (local && (getUser(user)?.role !== "admin" || directory(saved.directory) !== saved.directory)))
      throw new WebBotError(409, "Codex 工具权限或工作目录已更改，请重新发送。");
  }
  return { check, tools: local || webSearch || extra.length ? { webSearch, ...(extra.length ? { extra } : {}), terminal: local && saved.terminal,
    edit: local && saved.edit, directory: local ? saved.directory : undefined } : undefined };
}
