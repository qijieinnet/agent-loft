import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { codexSource, costOf, localUsage, parseClaude, parseCodex, priceOf } from "../src/core/local-usage.js";

const line = (o: unknown) => JSON.stringify(o);

function claudeLine({ id = "msg_1", req = "req_1", entrypoint = "claude-desktop", model = "claude-opus-5-5", ts = "2026-10-29T03:00:00.000Z", usage = {} } = {}) {
  return line({
    type: "assistant",
    entrypoint,
    timestamp: ts,
    requestId: req,
    message: {
      id,
      model,
      usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 50, ...usage },
    },
  });
}

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loft-usage-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (rel: string, lines: string[]) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join("\n") + "\n");
  };
  return { dir, write, dirs: { claude: [path.join(dir, "claude")], codex: [path.join(dir, "codex")] } };
}

test("Claude：跳过 Agent SDK（agent-loft）和占位消息，区分桌面端和 CLI，拆出 1 小时缓存写入", () => {
  const events = parseClaude(
    [
      claudeLine({ id: "a", usage: { cache_creation: { ephemeral_1h_input_tokens: 150, ephemeral_5m_input_tokens: 50 }, speed: "fast" } }),
      claudeLine({ id: "b", entrypoint: "cli" }),
      claudeLine({ id: "c", entrypoint: "sdk-ts" }),
      claudeLine({ id: "d", model: "<synthetic>" }),
      line({ type: "user", message: { content: "hi" } }),
      "{broken",
    ].join("\n"),
  );
  assert.equal(events.length, 2);
  const [a, b] = events as [NonNullable<typeof events[0]>, NonNullable<typeof events[0]>];
  assert.deepEqual(a.slice(2), ["desktop", "claude-opus-5-5", 10, 1000, 50, 150, 50, 0, 1]);
  assert.equal(b[2], "cli");
});

test("Codex：跳过 agent-loft 跑的，同一次请求重复报的只算一遍，input 里扣掉缓存", () => {
  const meta = (originator: string) => line({ type: "session_meta", payload: { originator } });
  const ctx = line({ type: "turn_context", payload: { model: "gpt-6.1-sol" } });
  const tc = (ts: string, total: number, last: unknown) =>
    line({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: total }, last_token_usage: last } } });
  const last = { input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5 };
  const text = [meta("Codex Desktop"), ctx, tc("2026-10-29T01:00:00Z", 1020, last), tc("2026-10-29T01:00:01Z", 1020, last), tc("2026-10-29T01:01:00Z", 2040, last)].join("\n");
  const events = parseCodex(text);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0]!.slice(2), ["desktop", "gpt-6.1-sol", 200, 800, 0, 0, 20, 5, 0]);
  assert.deepEqual(parseCodex(text.replace("Codex Desktop", "agent-loft")), []);
  assert.equal(codexSource("codex_exec"), "cli");
  assert.equal(codexSource("codex_vscode"), "other");
});

test("单价：认带后缀的模型名，Claude 缓存写入按 1.25 / 2 倍、快速模式两倍，Haiku 5.5 长提示词另一档", () => {
  assert.deepEqual(priceOf("claude", "claude-opus-5-5[1m]"), [4, 0.2, 20]);
  assert.deepEqual(priceOf("claude", "claude-haiku-4-5-20251001"), [1, 0.1, 5]);
  assert.equal(priceOf("claude", "claude-unknown"), undefined);
  assert.ok(priceOf("codex", "gpt-6.1-sol-2026-09-01"));
  // 1M 输入 × $4 + 1M 5 分钟写入 × $5 + 1M 1 小时写入 × $8 + 1M 输出 × $20 = $37
  const e: Parameters<typeof costOf>[1] = ["k", 0, "cli", "claude-opus-5-5", 1e6, 0, 1e6, 1e6, 1e6, 0, 0];
  assert.equal(costOf("claude", e), 37);
  assert.equal(costOf("claude", [e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8], e[9], 1]), 74);
  // 提示词 20 万 token 超过 10 万：按 $0.5 / $2.5
  assert.equal(costOf("claude", ["k", 0, "cli", "claude-haiku-5-5", 2e5, 0, 0, 0, 1e6, 0, 0]), 0.1 + 2.5);
  assert.equal(costOf("claude", ["k", 0, "cli", "nope", 1e6, 0, 0, 0, 0, 0, 0]), 0);
});

test("按日期合计：跨文件去重、只要这段时间的，按 agent + 来源 + 模型分开", async (t) => {
  const { write, dirs } = fixture(t);
  const today = "2026-10-29T03:00:00.000Z";
  write("claude/p1/s1.jsonl", [claudeLine({ id: "a", ts: today }), claudeLine({ id: "a", ts: today }), claudeLine({ id: "b", ts: today, entrypoint: "cli" })]);
  // 恢复的会话把 a 抄了一遍；c 是很早以前的
  write("claude/p1/s2.jsonl", [claudeLine({ id: "a", ts: today }), claudeLine({ id: "c", ts: "2026-01-01T03:00:00.000Z" })]);
  write("codex/2026/10/29/r.jsonl", [
    line({ type: "session_meta", payload: { originator: "codex_exec" } }),
    line({ type: "turn_context", payload: { model: "gpt-6.1-sol" } }),
    line({
      timestamp: today,
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: { total_tokens: 30 }, last_token_usage: { input_tokens: 10, output_tokens: 20 } } },
    }),
  ]);
  const day = new Date(today);
  const ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  const rows = await localUsage(ymd, ymd, dirs);
  const by = Object.fromEntries(rows.map((r) => [`${r.agent}/${r.source}`, r]));
  assert.deepEqual(Object.keys(by).sort(), ["claude/cli", "claude/desktop", "codex/cli"]);
  assert.equal(by["claude/desktop"]!.input, 10);
  assert.equal(by["claude/desktop"]!.cacheRead, 1000);
  assert.equal(by["claude/desktop"]!.estimated, true);
  assert.equal(by["codex/cli"]!.output, 20);
  assert.equal(by["codex/cli"]!.model, "gpt-6.1-sol");
  // 文件没变，第二次走缓存，结果一样
  assert.deepEqual(await localUsage(ymd, ymd, dirs), rows);
  assert.deepEqual(await localUsage("2026-01-01", "2026-01-31", dirs).then((r) => r.length), 1);
});

test("刷新：追加记录后重新采集，删除文件后不再返回缓存的旧用量；目录缺失时返回空", async (t) => {
  const { dir, write, dirs } = fixture(t);
  const day = "2026-10-29";
  const a = claudeLine({ id: "a" });
  write("claude/session.jsonl", [a]);
  assert.equal((await localUsage(day, day, dirs))[0]!.output, 50);
  write("claude/session.jsonl", [a, claudeLine({ id: "b" })]);
  const [first, second] = await Promise.all([localUsage(day, day, dirs), localUsage(day, day, dirs)]);
  assert.equal(first[0]!.output, 100);
  assert.deepEqual(first, second);
  fs.unlinkSync(path.join(dir, "claude/session.jsonl"));
  assert.deepEqual(await localUsage(day, day, dirs), []);
});
