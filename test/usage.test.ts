import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_LOFT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aim-usage-"));
const { flushUsage, recordUsage, usageOf } = await import("../src/core/usage.js");
const { dataDir } = await import("../src/home.js");

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
