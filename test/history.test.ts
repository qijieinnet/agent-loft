import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_LOFT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aim-history-"));
const { parseQuestionAnswers } = await import("../src/agents/claude/driver.js");

const q = (question: string, labels: string[], multiSelect = false) => ({
  id: question,
  header: "h",
  question,
  options: labels.map((label) => ({ label })),
  multiSelect,
  allowOther: true,
});
const wrap = (pairs: string) => `Your questions have been answered: ${pairs}. You can now continue with these answers in mind.`;

test("提问的回答：单选、多选、自由作答、选项里带逗号和引号、好几个问题", () => {
  const a = q("用哪个？", ["甲", "乙"]);
  const b = q("要哪些？", ["x", "y", "z"], true);
  const c = q("还有吗？", ["没有"]);
  assert.deepEqual(parseQuestionAnswers(wrap(`"用哪个？"="乙"`), [a]), { selections: [[1]], freeText: {} });
  assert.deepEqual(parseQuestionAnswers(wrap(`"用哪个？"="甲", "要哪些？"="x, z", "还有吗？"="随便写的，带 "引号""`), [a, b, c]), {
    selections: [[0], [0, 2], []],
    freeText: { 2: `随便写的，带 "引号"` },
  });
  // 选项文字本身带「, 」：整句匹配优先
  const d = q("格式？", ["a, b", "c"]);
  assert.deepEqual(parseQuestionAnswers(wrap(`"格式？"="a, b"`), [d]), { selections: [[0]], freeText: {} });
  // 认不出来（格式变了、没作答）
  assert.equal(parseQuestionAnswers("The user did not answer the questions.", [a]), null);
});

test("弹出授权 / 提问卡时在事件流里占位：刷新页面重放进行中的一轮时放回原位", async () => {
  const { hub } = await import("../src/core/hub.js");
  const { interactions } = await import("../src/core/interactions.js");
  const seen: { key: string; ev: { type: string; id?: string } }[] = [];
  hub.on("event", (env) => seen.push(env as never));
  const p = interactions.create("web:ix-pos", { kind: "approval", title: "t", detail: "d" }, 60_000);
  const id = interactions.listPending("web:ix-pos")[0]!.id;
  assert.deepEqual(seen.filter((e) => e.key === "web:ix-pos").map((e) => e.ev), [{ type: "ix", id }]);
  interactions.cancelAll("web:ix-pos", "测试");
  await p;
  // 处理完了也还查得到（重放时要画成已处理）
  assert.equal(interactions.get(id)?.settled?.settlement, "cancelled");
});
