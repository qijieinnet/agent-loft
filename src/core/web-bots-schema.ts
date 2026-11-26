export const webBotSchema = `
  CREATE TABLE IF NOT EXISTS web_bots (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, default_bot INTEGER NOT NULL,
    shared_thread TEXT, created INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS web_bots_default ON web_bots(owner) WHERE default_bot = 1;
  CREATE TABLE IF NOT EXISTS web_bot_members (
    bot TEXT NOT NULL, user TEXT NOT NULL, access_id TEXT NOT NULL, PRIMARY KEY(bot, user)
  );
  CREATE INDEX IF NOT EXISTS web_bot_members_user ON web_bot_members(user);
  CREATE TABLE IF NOT EXISTS web_bot_threads (id TEXT PRIMARY KEY, bot TEXT NOT NULL, private_user TEXT);
  CREATE UNIQUE INDEX IF NOT EXISTS web_bot_private_thread ON web_bot_threads(bot, private_user) WHERE private_user IS NOT NULL;
  CREATE TABLE IF NOT EXISTS web_bot_archives (
    thread TEXT PRIMARY KEY, owner TEXT NOT NULL, archivedAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS web_bot_archives_owner ON web_bot_archives(owner,archivedAt);
  CREATE TABLE IF NOT EXISTS web_bot_retired_users (user TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS web_bot_deleted_turns (user TEXT NOT NULL, at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS web_bot_deleted_turns_user ON web_bot_deleted_turns(user,at);
  CREATE TABLE IF NOT EXISTS web_bot_invites (
    digest TEXT PRIMARY KEY, bot TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL, ownerRevision INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS web_bot_messages (
    id INTEGER PRIMARY KEY, thread TEXT NOT NULL, role TEXT NOT NULL, authorId TEXT, authorName TEXT,
    text TEXT NOT NULL, createdAt INTEGER NOT NULL, images TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL, requestId TEXT, worker INTEGER, authorAccess TEXT
  );
  CREATE INDEX IF NOT EXISTS web_bot_messages_thread ON web_bot_messages(thread, id);
  CREATE UNIQUE INDEX IF NOT EXISTS web_bot_turn_request ON web_bot_messages(thread, authorId, requestId) WHERE role='user';
  CREATE UNIQUE INDEX IF NOT EXISTS web_bot_turn_pending ON web_bot_messages(thread) WHERE status='pending';
  CREATE INDEX IF NOT EXISTS web_bot_turns_by_day ON web_bot_messages(authorId,createdAt) WHERE role='user';
  -- Before explicit ownership transfer was introduced the owner of an archived conversation never changed.
  INSERT OR IGNORE INTO web_bot_archives(thread,owner,archivedAt)
    SELECT t.id,b.owner,coalesce((SELECT max(createdAt) FROM web_bot_messages WHERE thread=t.id),b.created)
    FROM web_bot_threads t JOIN web_bots b ON b.id=t.bot
    WHERE t.private_user IS NULL AND t.id IS NOT b.shared_thread
      AND NOT EXISTS (SELECT 1 FROM web_bot_archives a WHERE a.thread=t.id);
  CREATE TABLE IF NOT EXISTS web_bot_images (message INTEGER PRIMARY KEY, content TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS web_bot_tool_attempts (
    message INTEGER NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(message, fingerprint)
  );
  CREATE TABLE IF NOT EXISTS web_bot_calls (
    id TEXT PRIMARY KEY, message INTEGER NOT NULL, service TEXT NOT NULL, name TEXT NOT NULL,
    status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', args TEXT, expires INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS web_bot_calls_message ON web_bot_calls(message);
  CREATE TRIGGER IF NOT EXISTS web_bot_calls_end AFTER UPDATE OF status ON web_bot_messages
    WHEN OLD.status='pending' AND NEW.status<>'pending' BEGIN
      UPDATE web_bot_calls SET args=NULL,status=CASE WHEN status='running' THEN 'unknown' ELSE 'cancelled' END
        WHERE message=NEW.id AND status IN ('pending','approved','ready','running');
    END;
  CREATE TABLE IF NOT EXISTS web_bot_call_images(call TEXT PRIMARY KEY, data BLOB NOT NULL);
  CREATE TRIGGER IF NOT EXISTS web_bot_call_image_delete AFTER DELETE ON web_bot_calls BEGIN
    DELETE FROM web_bot_call_images WHERE call=OLD.id;
  END;
  CREATE TRIGGER IF NOT EXISTS web_bot_calls_delete AFTER DELETE ON web_bot_messages BEGIN
    DELETE FROM web_bot_calls WHERE message=OLD.id;
  END;
  CREATE TABLE IF NOT EXISTS web_bot_claude_tools (bot TEXT PRIMARY KEY, revision INTEGER NOT NULL, settings TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS web_bot_codex_tools (bot TEXT PRIMARY KEY, revision INTEGER NOT NULL, settings TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS web_bot_extensions (
    id TEXT PRIMARY KEY, bot TEXT NOT NULL, revision INTEGER NOT NULL, config TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS web_bot_skill_files (
    extension TEXT NOT NULL, path TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(extension,path)
  );
  CREATE TRIGGER IF NOT EXISTS web_bot_skill_delete AFTER DELETE ON web_bot_extensions BEGIN
    DELETE FROM web_bot_skill_files WHERE extension=OLD.id;
  END;
  CREATE INDEX IF NOT EXISTS web_bot_extensions_bot ON web_bot_extensions(bot);
  CREATE TABLE IF NOT EXISTS web_bot_profiles (
    bot TEXT PRIMARY KEY, responsibility TEXT NOT NULL, style TEXT NOT NULL, model TEXT NOT NULL, engine TEXT NOT NULL DEFAULT 'pi',
    capabilities TEXT NOT NULL, revision INTEGER NOT NULL, remindersResumedAt INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS web_bot_memories (
    id TEXT PRIMARY KEY, thread TEXT NOT NULL, text TEXT NOT NULL, author TEXT NOT NULL,
    authorAccess TEXT NOT NULL, createdAt INTEGER NOT NULL, pending INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS web_bot_memories_thread ON web_bot_memories(thread,createdAt,id);

  CREATE TABLE IF NOT EXISTS web_bot_routines (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, threadId TEXT NOT NULL, accessId TEXT NOT NULL,
    mode TEXT NOT NULL, prompt TEXT NOT NULL, schedule TEXT NOT NULL, timezone TEXT NOT NULL,
    smart INTEGER NOT NULL, nextAt INTEGER, revision INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS web_bot_routines_due ON web_bot_routines(nextAt) WHERE nextAt IS NOT NULL;
  CREATE INDEX IF NOT EXISTS web_bot_routines_user ON web_bot_routines(userId,threadId);
  CREATE TABLE IF NOT EXISTS web_bot_routine_runs (
    routine TEXT NOT NULL, dueAt INTEGER NOT NULL, status TEXT NOT NULL, result TEXT NOT NULL DEFAULT '',
    messageId INTEGER, PRIMARY KEY(routine,dueAt)
  );
  CREATE TABLE IF NOT EXISTS web_bot_routine_manual (
    routine TEXT NOT NULL, requestId TEXT NOT NULL, dueAt INTEGER NOT NULL,
    PRIMARY KEY(routine,requestId), UNIQUE(routine,dueAt)
  );
  CREATE TRIGGER IF NOT EXISTS web_bot_manual_delete AFTER DELETE ON web_bot_routines BEGIN
    DELETE FROM web_bot_routine_manual WHERE routine=OLD.id;
  END;
  CREATE TABLE IF NOT EXISTS web_bot_files (
    message INTEGER NOT NULL, slot INTEGER NOT NULL, name TEXT NOT NULL, mediaType TEXT NOT NULL,
    data BLOB NOT NULL, extracted TEXT, PRIMARY KEY(message,slot)
  );
  CREATE TRIGGER IF NOT EXISTS web_bot_files_delete AFTER DELETE ON web_bot_messages BEGIN
    DELETE FROM web_bot_files WHERE message=OLD.id;
  END;
  CREATE TABLE IF NOT EXISTS web_bot_message_sources (
    reply INTEGER NOT NULL, source INTEGER NOT NULL, PRIMARY KEY(reply,source)
  );
  CREATE INDEX IF NOT EXISTS web_bot_message_sources_source ON web_bot_message_sources(source);
  CREATE TRIGGER IF NOT EXISTS web_bot_sources_delete AFTER DELETE ON web_bot_messages BEGIN
    DELETE FROM web_bot_message_sources WHERE reply=OLD.id OR source=OLD.id;
  END;
  CREATE INDEX IF NOT EXISTS web_bot_routine_running ON web_bot_routine_runs(messageId) WHERE status='running';
  CREATE TRIGGER IF NOT EXISTS web_bot_routine_access AFTER UPDATE OF access_id ON web_bot_members
  WHEN OLD.access_id<>NEW.access_id BEGIN
    DELETE FROM web_bot_routines WHERE userId=OLD.user AND accessId=OLD.access_id
      AND threadId IN (SELECT id FROM web_bot_threads WHERE bot=OLD.bot);
  END;
  CREATE TRIGGER IF NOT EXISTS web_bot_routine_delete AFTER DELETE ON web_bot_routines BEGIN
    DELETE FROM web_bot_routine_runs WHERE routine=OLD.id;
  END;

  CREATE TABLE IF NOT EXISTS web_bot_followups (
    id TEXT PRIMARY KEY, thread TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
    creatorId TEXT NOT NULL, creatorAccess TEXT NOT NULL, assigneeId TEXT NOT NULL, assigneeAccess TEXT NOT NULL,
    latest TEXT NOT NULL, question TEXT, revision INTEGER NOT NULL, updatedAt INTEGER NOT NULL, decisionExpiresAt INTEGER
  );
  CREATE INDEX IF NOT EXISTS web_bot_followups_thread ON web_bot_followups(thread,updatedAt DESC);
  CREATE INDEX IF NOT EXISTS web_bot_followups_assignee ON web_bot_followups(assigneeId,updatedAt DESC) WHERE status='waiting';
  CREATE TABLE IF NOT EXISTS web_bot_followup_events (
    followup TEXT NOT NULL, revision INTEGER NOT NULL, at INTEGER NOT NULL, actor TEXT NOT NULL, text TEXT NOT NULL,
    PRIMARY KEY(followup,revision)
  );
  CREATE TABLE IF NOT EXISTS web_bot_followup_requests (
    user TEXT NOT NULL, access TEXT NOT NULL, thread TEXT NOT NULL, request TEXT NOT NULL, followup TEXT NOT NULL,
    PRIMARY KEY(user,access,thread,request)
  );
  CREATE TABLE IF NOT EXISTS web_bot_followup_hooks (
    followup TEXT PRIMARY KEY, digest TEXT NOT NULL, user TEXT NOT NULL, access TEXT NOT NULL, lastState TEXT
  );
  CREATE TABLE IF NOT EXISTS web_bot_followup_inputs (followup TEXT NOT NULL, event TEXT NOT NULL, PRIMARY KEY(followup,event));
`;
