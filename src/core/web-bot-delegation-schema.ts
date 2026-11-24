export const webBotDelegationSchema = `
  CREATE TABLE IF NOT EXISTS web_bot_delegations (
    id TEXT PRIMARY KEY, actor TEXT NOT NULL, thread TEXT NOT NULL, sourceAccess TEXT NOT NULL,
    target TEXT NOT NULL, targetThread TEXT NOT NULL, targetAccess TEXT NOT NULL,
    sourceRevision INTEGER NOT NULL, targetRevision INTEGER NOT NULL, task TEXT NOT NULL, request TEXT NOT NULL,
    status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, worker INTEGER, deadline INTEGER,
    createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, resultMessageId INTEGER, error TEXT,
    UNIQUE(actor,thread,sourceAccess,request)
  );
  CREATE INDEX IF NOT EXISTS web_bot_delegations_queue ON web_bot_delegations(status,updatedAt);
  CREATE INDEX IF NOT EXISTS web_bot_delegations_thread ON web_bot_delegations(actor,thread,updatedAt DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS web_bot_delegations_results ON web_bot_delegations(resultMessageId) WHERE resultMessageId IS NOT NULL;
  CREATE TABLE IF NOT EXISTS web_bot_delegation_attempts (
    job TEXT NOT NULL, attempt INTEGER NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(job,attempt)
  );
  CREATE INDEX IF NOT EXISTS web_bot_delegation_budget ON web_bot_delegation_attempts(actor,at);
`;
