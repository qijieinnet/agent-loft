import { sql } from "./db.js";
import { getBot, WebBotError, type BotImage } from "./web-bots.js";

export function listBotArchives(user: string, bot: string) {
  getBot(user, bot);
  return sql(`SELECT a.thread AS id,a.archivedAt,
    (SELECT count(*) FROM web_bot_messages m WHERE m.thread=t.id) AS messages
    FROM web_bot_archives a JOIN web_bot_threads t ON t.id=a.thread
    WHERE a.owner=? AND t.bot=? ORDER BY a.archivedAt DESC,a.rowid DESC`).all(user, bot);
}

// Keeping the archiving owner's identity here prevents a successor or a new group reading older shared generations.
export function requireBotArchive(user: string, bot: string, thread: string) {
  getBot(user, bot);
  if (!sql(`SELECT 1 FROM web_bot_archives a JOIN web_bot_threads t ON t.id=a.thread
      JOIN web_bots b ON b.id=t.bot
      WHERE a.owner=? AND t.bot=? AND t.id=? AND t.private_user IS NULL AND t.id IS NOT b.shared_thread`).get(user, bot, thread)) {
    throw new WebBotError(404, "找不到有权查看的共享归档。");
  }
}

export function readBotArchive(user: string, bot: string, thread: string, section: string, before: number) {
  requireBotArchive(user, bot, thread);
  let statement;
  switch (section) {
    case "messages":
      statement = sql(`SELECT id AS cursor,createdAt AS at,coalesce(authorName,'Bot') AS label,text,
        json_array_length(images)>0 AS image FROM web_bot_messages WHERE thread=? AND id<? ORDER BY id DESC LIMIT 41`);
      break;
    case "memories":
      statement = sql(`SELECT rowid AS cursor,createdAt AS at,'共享记忆' AS label,text FROM web_bot_memories
        WHERE thread=? AND pending=0 AND rowid<? ORDER BY rowid DESC LIMIT 41`);
      break;
    case "followups":
      statement = sql(`SELECT e.rowid AS cursor,e.at AS at,f.title AS label,e.text AS text,e.actor AS actor
        FROM web_bot_followup_events e JOIN web_bot_followups f ON f.id=e.followup
        WHERE f.thread=? AND e.rowid<? ORDER BY e.rowid DESC LIMIT 41`);
      break;
    default: throw new WebBotError(400, "无法识别归档类别。");
  }
  const rows = statement.all(thread, before);
  const items = rows.slice(0,40);
  return { items, nextBefore: rows.length > items.length ? Number(items.at(-1)?.cursor) : null };
}

export function readArchivedPhoto(user: string, bot: string, thread: string, message: number): BotImage {
  requireBotArchive(user, bot, thread);
  const row = sql(`SELECT i.content FROM web_bot_images i JOIN web_bot_messages m ON m.id=i.message
    WHERE m.thread=? AND m.id=?`).get(thread, message);
  if (!row) throw new WebBotError(404, "找不到归档内的照片。");
  return (JSON.parse(String(row.content)) as BotImage[])[0]!;
}
