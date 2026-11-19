import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_LOFT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "loft-sync-test-"));
const { sql } = await import("../src/core/db.js");
const mem = await import("../src/core/memory.js");
const chats = await import("../src/core/chat-history.js");
const sums = await import("../src/core/memory-summaries.js");
const sync = await import("../src/core/memory-sync-store.js");
const { issueInvite, redeem, authenticate, revoke } = await import("../src/core/memory-sync.js");
const users = await import("../src/core/users.js");

test("offline replicas merge, replay, redact deletions and search full source-owned chats", () => {
  const relay = "relay",
    alice = "alice",
    bob = "bob";
  for (const u of [relay, alice, bob]) mem.setMemoryOptions(u, { enabled: true });
  const local = mem.addMemoryItem(relay, "original", "user");
  // Independent legacy entries may share an ID, but must remain distinct after bootstrap.
  mem.importMemory(alice, { format: mem.EXPORT_FORMAT, items: [{ ...local, text: "unrelated" }] });
  for (const u of [relay, alice, bob]) sync.activate(u);
  function push(u: string) {
    const batch = sync.staged(u);
    sync.acceptPush(relay, sync.account(u)!.device, batch);
    sync.acceptPush(relay, sync.account(u)!.device, batch);
    sync.acknowledge(u, batch);
  }
  function pull(u: string) {
    for (;;) {
      const page = sync.feed(relay, sync.account(u)!.cursor);
      assert.equal(sync.receive(u, page.docs, page.cursor), true);
      if (!page.docs.length) break;
    }
  }
  push(alice);
  push(bob);
  pull(alice);
  pull(bob);
  for (const u of [relay, alice, bob]) assert.equal(mem.readMemory(u).items.length, 2);
  const a = mem.readMemory(alice).items.find((i) => i.text === "original")!;
  const b = mem.readMemory(bob).items.find((i) => i.text === "original")!;
  mem.updateMemoryItem(alice, a.id, "east");
  mem.updateMemoryItem(bob, b.id, "west");
  push(alice);
  push(bob);
  pull(alice);
  pull(bob);
  for (const u of [relay, alice, bob]) {
    assert.equal(
      mem.readMemory(u).items.some((i) => i.text === "original"),
      true,
    );
    assert.deepEqual(sync.syncConflicts(u)[0]!.choices, ["east", "west"]);
  }
  const conflict = sync.syncConflicts(bob)[0]!;
  sync.resolveConflict(bob, conflict.gid, conflict.choices, "accepted");
  push(bob);
  pull(alice);
  pull(bob);
  assert.equal(mem.getMemoryItem(alice, a.id)!.text, "accepted");
  assert.equal(sync.syncConflicts(relay).length, 0);
  mem.updateMemoryItem(alice, a.id, "stale offline edit");
  mem.purgeMemoryItem(relay, local.id);
  push(alice);
  pull(alice);
  pull(bob);
  for (const u of [relay, alice, bob]) {
    assert.deepEqual(
      mem.readMemory(u).items.map((i) => i.text),
      ["unrelated"],
    );
    assert.equal(sql("SELECT body FROM sync_doc WHERE gid=? AND user_id=?").get(conflict.gid, u)!.body, null);
  }

  const k = "web:collision";
  const long = "开头".repeat(5500) + " veryuniqueword " + "结尾".repeat(8500);
  for (const u of [alice, bob]) chats.appendRecords(u, [{ k, a: "claude", r: "a", t: u === alice ? long : "different source", ts: 2 }]);
  sums.upsertSummary(alice, { kind: "conv", scope: k, title: "summary", text: "source synopsis", fromTs: 1, toTs: 2 });
  push(alice);
  push(bob);
  pull(bob);
  const hit = chats.searchHistory(bob, "veryuniqueword")[0]!;
  assert.notEqual(hit.key, k);
  assert.equal(chats.readConversationRecords(bob, hit.key).rows[0]!.t, long);
  assert.equal(sums.readSummary(bob, "conv", hit.key)?.text, "source synopsis");
  assert.equal(
    chats.pendingConversations(bob, 0).some((p) => p.key === hit.key),
    false,
  );
  chats.replaceConversationRecords(alice, k, []);
  push(alice);
  pull(bob);
  assert.equal(chats.searchHistory(bob, "veryuniqueword").length, 0);
  assert.equal(sums.readSummary(bob, "conv", hit.key), undefined);
  assert.equal(chats.readConversationRecords(bob, k).total, 1);
});

test("one-time pairing binds an account, revocation stops a credential", () => {
  const u = users.createUser({ name: "sync-owner", password: "password-1" });
  const { code } = issueInvite(u.id);
  const device = sync.randomId();
  const { token } = redeem(code, device);
  assert.deepEqual({ ...authenticate(token) }, { user_id: u.id, device });
  assert.throws(() => redeem(code, sync.randomId()));
  revoke(u.id, device);
  assert.equal(authenticate(token), undefined);
});

test("loss of an acknowledgement followed by a second offline edit replays exactly the first operation", () => {
  const client = "lostack",
    relay = "retryrelay";
  const device = sync.randomId();
  const item = mem.addMemoryItem(client, "first", "agent");
  sync.activate(client, device);
  sync.activate(relay);
  const sent = sync.preparePush(client);
  sync.acceptPush(relay, device, sent);
  mem.updateMemoryItem(client, item.id, "second");
  const retry = sync.preparePush(client);
  assert.equal(JSON.stringify(retry), JSON.stringify(sent));
  sync.acceptPush(relay, device, retry);
  sync.acknowledge(client, retry);
  const next = sync.preparePush(client);
  assert.equal(next[0]?.base?.text, "first");
  sync.acceptPush(relay, device, next);
  sync.acknowledge(client, next);
  assert.deepEqual(
    mem.readMemory(relay).items.map((i) => i.text),
    ["second"],
  );
  assert.deepEqual(sync.syncConflicts(relay), []);
  const remote = mem.readMemory(relay).items[0]!;
  mem.setMemoryTier(relay, remote.id, "core", { actor: "user" });
  mem.removeMemoryItem(client, item.id, { actor: "auto" });
  const remove = sync.preparePush(client);
  sync.acceptPush(relay, device, remove);
  assert.equal(mem.readMemory(relay).items[0]!.locked, true);
  assert.equal(mem.listMemoryItems(relay, "trash").length, 0);
});

test("a stale offline edit cannot change the text a user restores from trash", () => {
  const relay = "trashrelay",
    client = "trashclient";
  const before = mem.addMemoryItem(relay, "kept in trash", "user");
  sync.activate(relay);
  sync.activate(client);
  const snapshot = sync.feed(relay, 0);
  sync.receive(client, snapshot.docs, snapshot.cursor);
  const copy = mem.readMemory(client).items[0]!;
  mem.updateMemoryItem(client, copy.id, "stale");
  mem.removeMemoryItem(relay, before.id);
  sync.acceptPush(relay, sync.account(client)!.device, sync.staged(client));
  assert.equal(mem.listMemoryItems(relay, "trash")[0]!.text, "kept in trash");
  assert.equal(mem.restoreMemoryItem(relay, before.id).text, "kept in trash");
});
