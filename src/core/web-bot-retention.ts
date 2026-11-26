// Domain deletion is explicit: shared records belong to the conversation; private threads belong to one account.
import { sql, transaction } from "./db.js";

type RemainingAccount = { id: string; disabled?: boolean };

const deliveryTables = ["web_bot_routines", "bot_reminders", "bot_reminder_actions", "bot_inbox", "bot_notice_events", "bot_notice_devices"] as const;

/** End outstanding deliveries and authorizations when a member leaves or the owner closes sharing. */
export function clearRevokedActivities(bot: string, owner: string, removedMember?: string) {
  const threads = "SELECT id FROM web_bot_threads WHERE bot=?" + (removedMember ? "" : " AND private_user IS NOT ?");
  const parameters = removedMember ? [bot, removedMember] : [bot, owner];
  for (const table of deliveryTables) {
    sql(`DELETE FROM ${table} WHERE threadId IN (${threads})` + (removedMember ? " AND userId=?" : "")).run(...parameters);
  }
  sql(`DELETE FROM web_bot_followup_hooks WHERE followup IN (SELECT id FROM web_bot_followups WHERE thread IN (${threads}))`
    + (removedMember ? " AND user=?" : "")).run(...parameters);
  sql(`DELETE FROM web_bot_memories WHERE pending=1 AND thread IN (${threads})`
    + (removedMember ? " AND author=?" : "")).run(...parameters);
  if (!removedMember) sql(`DELETE FROM bot_device_reads WHERE threadId IN (${threads})`).run(...parameters);
}

function eraseThread(thread: string) {
  const today = new Date().setHours(0, 0, 0, 0);
  // Deleting a conversation must not buy another batch of model calls for the same day.
  sql("DELETE FROM web_bot_deleted_turns WHERE at<?").run(today);
  sql(`INSERT INTO web_bot_deleted_turns(user,at) SELECT authorId,createdAt FROM web_bot_messages
    WHERE thread=? AND role='user' AND createdAt>=?`).run(thread, today);
  sql("DELETE FROM web_bot_tool_attempts WHERE message IN (SELECT id FROM web_bot_messages WHERE thread=?)").run(thread);
  sql("DELETE FROM web_bot_images WHERE message IN (SELECT id FROM web_bot_messages WHERE thread=?)").run(thread);
  sql("DELETE FROM web_bot_messages WHERE thread=?").run(thread);
  sql("DELETE FROM web_bot_memories WHERE thread=?").run(thread);
  sql(`INSERT INTO web_bot_deleted_turns(user,at)
    SELECT a.actor,a.at FROM web_bot_delegation_attempts a JOIN web_bot_delegations d ON d.id=a.job
    WHERE (d.thread=? OR d.targetThread=?) AND a.at>=?`).run(thread, thread, today);
  sql(`DELETE FROM web_bot_delegation_attempts WHERE job IN
    (SELECT id FROM web_bot_delegations WHERE thread=? OR targetThread=?)`).run(thread, thread);
  sql("DELETE FROM web_bot_delegations WHERE thread=? OR targetThread=?").run(thread, thread);
  for (const table of ["web_bot_followup_events", "web_bot_followup_hooks", "web_bot_followup_inputs"] as const)
    sql(`DELETE FROM ${table} WHERE followup IN (SELECT id FROM web_bot_followups WHERE thread=?)`).run(thread);
  sql("DELETE FROM web_bot_followup_requests WHERE thread=?").run(thread);
  sql("DELETE FROM web_bot_followups WHERE thread=?").run(thread);
  for (const table of [...deliveryTables, "bot_device_reads"])
    sql(`DELETE FROM ${table} WHERE threadId=?`).run(thread);
  sql("DELETE FROM usage_sessions WHERE session_id=?").run("bot:" + thread);
  sql("DELETE FROM web_bot_archives WHERE thread=?").run(thread);
  sql("DELETE FROM web_bot_threads WHERE id=?").run(thread);
}

/** Called inside the same transaction that verifies ownership or deletes the account. */
export function eraseBot(bot: string) {
  for (const row of sql("SELECT id FROM web_bot_threads WHERE bot=?").all(bot)) eraseThread(String(row.id));
  sql("DELETE FROM web_bot_members WHERE bot=?").run(bot);
  sql("DELETE FROM web_bot_claude_tools WHERE bot=?").run(bot);
  sql("DELETE FROM web_bot_codex_tools WHERE bot=?").run(bot);
  sql("DELETE FROM web_bot_extensions WHERE bot=?").run(bot);
  sql("DELETE FROM web_bot_profiles WHERE bot=?").run(bot);
  sql("DELETE FROM web_bot_invites WHERE bot=?").run(bot);
  sql("DELETE FROM web_bots WHERE id=?").run(bot);
}

export function handOverBot(bot: string, successor: string) {
  // Skills belong to the Bot. Executable commands and credentials were authorized by its previous owner.
  sql("DELETE FROM web_bot_claude_tools WHERE bot=?").run(bot);
  sql("DELETE FROM web_bot_codex_tools WHERE bot=?").run(bot);
  sql("DELETE FROM web_bot_extensions WHERE bot=? AND json_extract(config,'$.kind') <> 'skill'").run(bot);
  // A transferred default no longer occupies the former owner's or successor's private default slot.
  sql("UPDATE web_bots SET owner=?,default_bot=0 WHERE id=?").run(successor, bot);
  // Permanently revoke links signed solely through the previous ownership, even if ownership later returns.
  sql(`DELETE FROM web_bot_followup_hooks WHERE followup IN (
    SELECT h.followup FROM web_bot_followup_hooks h JOIN web_bot_followups f ON f.id=h.followup
    JOIN web_bot_threads t ON t.id=f.thread WHERE t.bot=? AND t.private_user IS NULL
      AND h.user<>? AND (f.creatorId<>h.user OR f.creatorAccess<>h.access))`).run(bot, successor);
  sql("DELETE FROM web_bot_invites WHERE bot=?").run(bot);
}

/** Caller holds the write lock. Only people already in a shared Bot may inherit it. */
export function purgeBotAccount(user: string, remaining: RemainingAccount[]) {
  const accounts = new Map(remaining.map(account => [account.id, account]));
  for (const row of sql("SELECT id FROM web_bots WHERE owner=?").all(user)) {
    const bot = String(row.id);
    const group = sql("SELECT user FROM web_bot_members WHERE bot=? AND user<>? ORDER BY rowid").all(bot, user)
      .flatMap(row => accounts.get(String(row.user)) ?? []);
    // Keep an all-disabled team's data: its new owner can use the Bot when their account is enabled again.
    const next = group.find(account => !account.disabled) ?? group[0];
    if (next) handOverBot(bot, next.id);
    else eraseBot(bot);
  }
  // Rejoining a Bot formerly preserved one's private history. Account deletion removes those threads too.
  const privateRecords = sql(`SELECT id FROM web_bot_threads WHERE private_user=?
    UNION SELECT thread FROM web_bot_archives WHERE owner=?`).all(user, user);
  for (const row of privateRecords) eraseThread(String(row.id));
  sql(`DELETE FROM web_bot_invites WHERE bot IN (SELECT bot FROM web_bot_members WHERE user=?)`).run(user);
  sql("DELETE FROM web_bot_members WHERE user=?").run(user);
  sql("DELETE FROM web_bot_memories WHERE author=? AND pending=1").run(user);
  sql("DELETE FROM web_bot_followup_requests WHERE user=?").run(user);
  sql("DELETE FROM web_bot_followup_hooks WHERE user=?").run(user);
  sql("DELETE FROM web_bot_delegations WHERE actor=?").run(user);
  sql("DELETE FROM web_bot_delegation_attempts WHERE actor=?").run(user);
  sql("DELETE FROM web_bot_deleted_turns WHERE user=?").run(user);
  for (const table of deliveryTables) sql(`DELETE FROM ${table} WHERE userId=?`).run(user);
  sql("INSERT OR IGNORE INTO web_bot_retired_users(user) VALUES(?)").run(user);
}

// Recovers pre-fix orphaned data as well as a crash after users.json was written and before SQLite committed.
export function recoverRemovedBotAccounts(readAccounts: () => RemainingAccount[]) {
  transaction(() => {
    const known = sql(`SELECT owner AS id FROM web_bots UNION SELECT user FROM web_bot_members
      UNION SELECT private_user FROM web_bot_threads WHERE private_user IS NOT NULL UNION SELECT owner FROM web_bot_archives
      UNION SELECT author FROM web_bot_memories WHERE pending=1 UNION SELECT user FROM web_bot_followup_hooks
      UNION SELECT user FROM web_bot_followup_requests UNION SELECT actor FROM web_bot_delegations
      UNION SELECT actor FROM web_bot_delegation_attempts UNION SELECT user FROM web_bot_deleted_turns
      ${deliveryTables.map(table => "UNION SELECT userId FROM " + table).join(" ")}`).all();
    if (!known.length) return;
    const accounts = readAccounts();
    if (!accounts.length) return;
    const ids = new Set(accounts.map(account => account.id));
    for (const { id } of known) if (!ids.has(String(id))) purgeBotAccount(String(id), accounts);
  });
}
