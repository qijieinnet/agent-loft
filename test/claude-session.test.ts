import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelUsage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvents, SessionOptions, TokenUsage, TurnResult } from "../src/core/types.js";

process.env.AGENT_LOFT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aim-claude-session-"));
const { ClaudeSession } = await import("../src/agents/claude/session.js");
const { recordUsage, usageOf } = await import("../src/core/usage.js");
const { closeDatabaseForTest } = await import("../src/core/db.js");
after(() => closeDatabaseForTest());

function modelUsage(overrides: Partial<ModelUsage> = {}): ModelUsage {
  return {
    inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0,
    webSearchRequests: 0, costUSD: 0, contextWindow: 200000, maxOutputTokens: 32000,
    ...overrides,
  };
}

function makeSession(opts: Partial<SessionOptions> = {}) {
  const results: TurnResult[] = [];
  const usages: TokenUsage[] = [];
  const errors: unknown[] = [];
  const cumulativeFlags: (boolean | undefined)[] = [];
  const events: AgentEvents = {
    onStep: () => {}, onTextDelta: () => {}, onText: () => {}, onSessionId: () => {},
    onResult: (r) => results.push(r),
    onError: (e) => errors.push(e),
    onUsage: (u, cumulative) => { usages.push(u); cumulativeFlags.push(cumulative); },
  };
  const session = new ClaudeSession({ cwd: "/tmp", uploadsDir: "/tmp", ...opts }, events, async () => ({ settlement: "deny", answers: {} }));
  // 直接投递 SDK 结果，验证会话到回复页脚的事件，不启动 Claude CLI。
  const result = (usage: Record<string, ModelUsage> | undefined, subtype = "success") => (session as any).handle({
    type: "result", subtype, result: "完成", duration_ms: 1000, total_cost_usd: 0.1, modelUsage: usage,
  });
  return { results, usages, errors, cumulativeFlags, result };
}

test("Claude 回复同时保留费用和本轮 Token，包含全部模型及缓存，推理不重复算", () => {
  const s = makeSession();
  const helper = modelUsage({ inputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 20, outputTokens: 15 });
  s.result({
    main: modelUsage({ inputTokens: 100, cacheReadInputTokens: 200, cacheCreationInputTokens: 10, outputTokens: 50, thinkingTokens: 20 }),
    helper,
  });
  assert.equal(s.results[0]?.tokens, 500);
  assert.equal(s.results[0]?.costUsd, 0.1);
  assert.equal(s.results[0]?.durationMs, 1000);
  assert.deepEqual(s.usages[0], { input: 105, cacheRead: 300, cacheWrite: 30, output: 65, reasoning: 20, costUsd: 0 });
  s.result({
    main: modelUsage({ inputTokens: 200, cacheReadInputTokens: 500, cacheCreationInputTokens: 20, outputTokens: 100, thinkingTokens: 40 }),
    helper,
  });
  assert.equal(s.results[1]?.tokens, 460, "第二轮取累计差额，不把上一轮再算一次");
  assert.deepEqual(s.cumulativeFlags, [true, true], "会话汇总仍接收累计值");
});

test("恢复或分叉 Claude 会话时，用已保存的累计统计扣除历史 Token", () => {
  for (const fork of [false, true]) {
    const resumeId = `saved-${fork}`;
    recordUsage(resumeId, { input: 100, cacheRead: 1000, cacheWrite: 200, output: 50, reasoning: 20 }, true);
    const s = makeSession({ resumeId, fork });
    s.result({ main: modelUsage({ inputTokens: 110, cacheReadInputTokens: 1200, cacheCreationInputTokens: 220, outputTokens: 70 }) });
    assert.equal(s.results[0]?.tokens, 250);
    assert.equal(usageOf(resumeId)?.input, 100, "读基线时不改历史统计");
  }
});

test("恢复时缺少历史统计或累计值倒退，先建立起点，后续正常计算本轮 Token", () => {
  const s = makeSession({ resumeId: "unknown-session" });
  s.result({ main: modelUsage({ inputTokens: 1500 }) });
  assert.equal(s.results[0]?.tokens, undefined);
  s.result({ main: modelUsage({ inputTokens: 1800 }) });
  assert.equal(s.results[1]?.tokens, 300);
  s.result({ main: modelUsage({ inputTokens: 500 }) });
  assert.equal(s.results[2]?.tokens, undefined);
  s.result({ main: modelUsage({ inputTokens: 600 }) });
  assert.equal(s.results[3]?.tokens, 100);
});

test("空用量不显示虚假的零值，错误结果有用量时也更新起点", () => {
  const s = makeSession();
  s.result({ main: modelUsage({ inputTokens: 100 }) });
  s.result({}, "error_during_execution");
  s.result({ main: modelUsage({ inputTokens: 150 }) });
  assert.equal(s.results[1]?.tokens, 50, "崩溃时的零用量不覆盖起点");
  s.result({ main: modelUsage({ inputTokens: 175 }) }, "error_during_execution");
  s.result({ main: modelUsage({ inputTokens: 200 }) });
  assert.equal(s.results[2]?.tokens, 25, "报错轮次的消耗不算到下一轮");
  s.result(undefined);
  assert.equal(s.results[3]?.tokens, undefined);
  assert.equal(s.errors.length, 2);
  assert.equal(s.usages.length, 4);
});
