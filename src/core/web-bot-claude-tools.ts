import { sql, transaction } from "./db.js";
import { getBotProfile, requireBotEngine } from "./web-bot-profile.js";
import { getBot, requireOwner, WebBotError } from "./web-bots.js";

const choices = ["WebSearch", "WebFetch"] as const;
type Scope = "off" | "private" | "members";
type Grants = Record<typeof choices[number], Scope>;

function read(bot: string) {
  const row = sql("SELECT revision,settings FROM web_bot_claude_tools WHERE bot=?").get(bot);
  const settings: Grants = row ? JSON.parse(String(row.settings)) : { WebSearch: "off", WebFetch: "off" };
  return { settings, revision: Number(row?.revision ?? 0) };
}
export function claudeSettings(user: string, bot: string) {
  requireOwner(user, bot);
  return getBotProfile(user, bot).engine === "claude" ? read(bot) : null;
}
export function saveClaudeSettings(user: string, bot: string, data: Record<string, unknown>) {
  return transaction(() => {
    const old = claudeSettings(user, bot);
    requireBotEngine(user, "claude");
    if (!old || old.revision !== data.revision) throw new WebBotError(409, "引擎设置已更改。");
    const settings = data.settings as Grants | undefined;
    if (!settings || Object.keys(settings).length !== choices.length || choices.some(k => !["off","private","members"].includes(settings[k])))
      throw new WebBotError(400, "请选择有效的工具范围。");
    sql("INSERT INTO web_bot_claude_tools VALUES(?,?,?) ON CONFLICT(bot) DO UPDATE SET revision=excluded.revision,settings=excluded.settings")
      .run(bot, old.revision + 1, JSON.stringify(settings));
    return read(bot);
  });
}

export function claudeTurn(user: string, bot: string, shared: boolean) {
  const saved = read(bot);
  const privateOwner = !shared && getBot(user, bot).ownerId === user;
  return {
    names: choices.filter(k => saved.settings[k] === "members" || (privateOwner && saved.settings[k] === "private")),
    check() {
      if (read(bot).revision !== saved.revision) throw new WebBotError(409, "Claude 工具权限已更改，请重新发送。");
    },
  };
}
