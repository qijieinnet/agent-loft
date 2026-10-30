import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import type { DailyRow } from "../src/core/usage.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "loft-usage-api-"));
process.env.AGENT_LOFT_HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, "claude-custom");
process.env.CODEX_HOME = path.join(home, "codex-custom");
// 本机默认目录也隔离，测试不会读取真正的会话记录。
mock.method(os, "homedir", () => home);
const { config, loadConfig, saveConfig } = await import("../src/core/config.js");
const { createUser } = await import("../src/core/users.js");
const { createSession } = await import("../src/channels/web/auth.js");
const { startWeb, stopWeb } = await import("../src/channels/web/server.js");
const { recordUsage, dayOf } = await import("../src/core/usage.js");
const { closeDatabaseForTest } = await import("../src/core/db.js");
loadConfig();

test("用量接口合并服务器本机记录，保持来源、去重和成员隔离", { timeout: 20000 }, async (t) => {
  t.after(async () => {
    await stopWeb();
    closeDatabaseForTest();
    mock.restoreAll();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((err) => err ? reject(err) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  saveConfig({ ...structuredClone(config()), web: { ...config().web, host: "127.0.0.1", port, quotaEnabled: false } });
  const admin = createUser({ name: "admin", password: "password-1", role: "admin" });
  const alice = createUser({ name: "alice", password: "password-2" });
  const bob = createUser({ name: "bob", password: "password-3" });
  const cookie = (id: string) => `aim_session=${createSession(id, "127.0.0.1", "test")}`;
  const adminCookie = cookie(admin.id), aliceCookie = cookie(alice.id);
  const today = dayOf(Date.now());
  const timestamp = new Date().toISOString();
  const tokens = { input: 7, cacheRead: 0, cacheWrite: 0, output: 3 };
  recordUsage("loft-alice", tokens, false, { agent: "codex", owner: alice.id, model: "gpt-6.1-sol" });
  recordUsage("loft-bob", tokens, false, { agent: "codex", owner: bob.id, model: "gpt-6.1-sol" });
  const write = (rel: string, records: unknown[]) => {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  };
  const claude = (id: string, entrypoint: string) => ({
    type: "assistant", entrypoint, timestamp, requestId: id,
    message: { id, model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 20 } },
  });
  write("claude-custom/projects/p/desktop.jsonl", [claude("desktop", "claude-desktop"), claude("sdk", "sdk-ts")]);
  write(".claude/projects/p/cli.jsonl", [claude("cli", "cli"), claude("desktop", "claude-desktop")]);
  const codex = (id: string, originator: string) => [
    { type: "session_meta", payload: { id, originator } },
    { type: "turn_context", payload: { model: "gpt-6.1-sol" } },
    { timestamp, type: "event_msg", payload: { type: "token_count", info: {
      total_token_usage: { total_tokens: 1020 },
      last_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 20 },
    } } },
  ];
  const desktop = codex("desktop-session", "Codex Desktop");
  write("codex-custom/sessions/desktop.jsonl", desktop);
  // 同一会话在归档里也有一份，只统计一次。
  write("codex-custom/archived_sessions/desktop.jsonl", desktop);
  // 不同会话恰好时间、累计值相同，也要各算各的。
  write("codex-custom/archived_sessions/cli.jsonl", codex("cli-session", "codex_cli_rs"));
  write("codex-custom/sessions/loft.jsonl", codex("loft-alice", "agent-loft"));
  await startWeb();
  const query = (auth = "", from = today, to = today) => fetch(`${base}/api/usage?from=${from}&to=${to}`, { headers: { Cookie: auth } });
  type Result = { rows: DailyRow[]; users: Record<string, string>; admin: boolean; localUsageIncluded: boolean };
  const read = async (auth: string) => {
    const res = await query(auth);
    assert.equal(res.status, 200);
    return await res.json() as Result;
  };

  assert.equal((await query()).status, 401);
  assert.equal((await query(adminCookie, "bad")).status, 400);
  const result = await read(adminCookie);
  assert.equal(result.admin, true);
  assert.equal(result.localUsageIncluded, true);
  assert.equal(result.rows.length, 6);
  assert.deepEqual(result.users, { [alice.id]: "alice", [bob.id]: "bob" });
  const direct = result.rows.filter((r) => r.source);
  assert.equal(direct.length, 4);
  assert.ok(direct.every((r) => !r.owner && r.estimated && r.costUsd! > 0));
  assert.equal(direct.find((r) => r.agent === "codex" && r.source === "desktop")!.input, 200);
  assert.equal(direct.find((r) => r.agent === "codex" && r.source === "cli")!.output, 20);
  assert.equal(direct.find((r) => r.agent === "claude" && r.source === "desktop")!.output, 20);
  assert.deepEqual(await read(adminCookie), result, "刷新不重复累加");

  const member = await read(aliceCookie);
  assert.equal(member.localUsageIncluded, false);
  assert.equal(member.admin, false);
  assert.equal(member.rows.length, 1);
  assert.equal(member.rows[0]!.owner, alice.id);
  assert.equal(member.rows[0]!.input, 7);
  assert.equal(member.rows[0]!.source, undefined);
  assert.deepEqual(member.users, { [alice.id]: "alice" });
  assert.deepEqual((await (await query(adminCookie, "2000-01-01", "2000-01-31")).json() as Result).rows, []);
});
