import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_LOFT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aim-usage-"));
const { dailyUsage, dayOf, flushUsage, recordUsage, usageOf } = await import("../src/core/usage.js");
const { dataDir } = await import("../src/home.js");
const { estimateCost, pickOpenAiPrices, priceOf } = await import("../src/core/pricing.js");

test("增量（Codex）累加，累计值（Claude）取较大的", () => {
  recordUsage("codex-1", { input: 100, cacheRead: 900, cacheWrite: 0, output: 50, reasoning: 20 });
  recordUsage("codex-1", { input: 10, cacheRead: 1000, cacheWrite: 0, output: 5, reasoning: 0 });
  const c = usageOf("codex-1")!;
  assert.deepEqual([c.input, c.cacheRead, c.cacheWrite, c.output, c.reasoning], [110, 1900, 0, 55, 20]);
  assert.equal(c.costUsd, undefined);

  recordUsage("claude-1", { input: 5, cacheRead: 2000, cacheWrite: 300, output: 80, costUsd: 0.1 }, true);
  recordUsage("claude-1", { input: 9, cacheRead: 5000, cacheWrite: 600, output: 200, costUsd: 0.25 }, true);
  // 恢复的会话没从原来的总数接着算：不倒退，也不把之前的再加一遍
  recordUsage("claude-1", { input: 1, cacheRead: 100, cacheWrite: 10, output: 3, costUsd: 0.01 }, true);
  const a = usageOf("claude-1")!;
  assert.deepEqual([a.input, a.cacheRead, a.cacheWrite, a.output], [9, 5000, 600, 200]);
  assert.equal(a.costUsd, 0.25);
});

test("没有会话 id 不记；坏数据当 0", () => {
  recordUsage(undefined, { input: 1, cacheRead: 1, cacheWrite: 1, output: 1 });
  recordUsage("bad", { input: Number.NaN, cacheRead: -5, cacheWrite: 2, output: Infinity });
  const b = usageOf("bad")!;
  assert.deepEqual([b.input, b.cacheRead, b.cacheWrite, b.output], [0, 0, 2, 0]);
  assert.equal(usageOf(undefined), undefined);
});

test("落盘", () => {
  flushUsage();
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "usage.json"), "utf8"));
  assert.equal(saved["codex-1"].input, 110);
  assert.equal(saved["claude-1"].output, 200);
});

test("按天的账：累计值只记增量，按人和 agent 分开，能按主人过滤", () => {
  const today = dayOf(Date.now());
  recordUsage("c-a", { input: 10, cacheRead: 100, cacheWrite: 5, output: 20, costUsd: 0.1 }, true, { owner: "u1", agent: "claude" });
  recordUsage("c-a", { input: 15, cacheRead: 300, cacheWrite: 5, output: 30, costUsd: 0.3 }, true, { owner: "u1", agent: "claude" });
  // 倒退的累计值不算
  recordUsage("c-a", { input: 1, cacheRead: 1, cacheWrite: 1, output: 1, costUsd: 0.01 }, true, { owner: "u1", agent: "claude" });
  recordUsage("x-b", { input: 7, cacheRead: 0, cacheWrite: 0, output: 3, reasoning: 1 }, false, { agent: "codex" });
  recordUsage("x-b", { input: 3, cacheRead: 0, cacheWrite: 0, output: 2 }, false, { agent: "codex" });

  const rows = dailyUsage(today, today);
  const a = rows.find((r) => r.owner === "u1" && r.agent === "claude")!;
  assert.deepEqual([a.input, a.cacheRead, a.cacheWrite, a.output], [15, 300, 5, 30]);
  assert.ok(Math.abs(a.costUsd! - 0.3) < 1e-9);
  const b = rows.find((r) => !r.owner && r.agent === "codex")!;
  assert.deepEqual([b.input, b.output, b.reasoning], [10, 5, 1]);
  assert.equal(b.costUsd, undefined);

  assert.deepEqual(dailyUsage(today, today, (o) => o === "u1").map((r) => r.agent), ["claude"]);
  assert.equal(dailyUsage("2000-01-01", "2000-12-31").length, 0);

  flushUsage();
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "usage-daily.json"), "utf8"));
  assert.equal(saved[today]["u1\tclaude\t"].output, 30);
});

test("单价：从 LiteLLM 的表里只挑 OpenAI 对话模型，换成每百万 token", () => {
  const t = pickOpenAiPrices({
    "gpt-x": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 2e-6, cache_read_input_token_cost: 1e-7, output_cost_per_token: 1e-5 },
    "gpt-x-pro": { litellm_provider: "openai", mode: "responses", input_cost_per_token: 3e-5, output_cost_per_token: 1.8e-4 },
    "claude-y": { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
    "text-embedding-z": { litellm_provider: "openai", mode: "embedding", input_cost_per_token: 1e-7, output_cost_per_token: 0 },
    sample_spec: { litellm_provider: "openai", mode: "chat" },
  });
  assert.deepEqual(t, { "gpt-x": [2, 0.1, 10], "gpt-x-pro": [30, null, 180] });
});

test("按单价估算：内置快照认得、带前缀 / 日期后缀也认；认不出不估", () => {
  assert.deepEqual(priceOf("gpt-5-codex"), [1.25, 0.125, 10]);
  assert.deepEqual(priceOf("openai/gpt-5-codex"), priceOf("gpt-5-codex"));
  assert.deepEqual(priceOf("gpt-5-2099-01-01"), priceOf("gpt-5"));
  assert.equal(priceOf("no-such-model"), undefined);
  // 100 万输入 + 100 万缓存读取 + 10 万输出（gpt-5-codex：1.25 / 0.125 / 10）
  const cost = estimateCost("gpt-5-codex", { input: 1e6, cacheRead: 1e6, cacheWrite: 0, output: 1e5 })!;
  assert.ok(Math.abs(cost - (1.25 + 0.125 + 1)) < 1e-9);
  assert.equal(estimateCost("no-such-model", { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 }), undefined);
});

test("按天的账：没报费用的按模型单价估算，报了的不动", () => {
  const today = dayOf(Date.now());
  recordUsage("x-c", { input: 1e6, cacheRead: 0, cacheWrite: 0, output: 1e5 }, false, { owner: "u3", agent: "codex", model: "gpt-5-codex" });
  recordUsage("x-d", { input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }, false, { owner: "u3", agent: "codex", model: "mystery" });
  recordUsage("c-e", { input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 9 }, true, { owner: "u3", agent: "claude", model: "gpt-5-codex" });
  const rows = dailyUsage(today, today, (o) => o === "u3");
  const est = rows.find((r) => r.model === "gpt-5-codex" && r.agent === "codex")!;
  assert.equal(est.estimated, true);
  assert.ok(Math.abs(est.costUsd! - 2.25) < 1e-9);
  const unknown = rows.find((r) => r.model === "mystery")!;
  assert.equal(unknown.costUsd, undefined);
  const reported = rows.find((r) => r.agent === "claude")!;
  assert.equal(reported.costUsd, 9);
  assert.equal(reported.estimated, undefined);
});
