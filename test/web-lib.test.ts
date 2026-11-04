// 前端里不碰 DOM 的小模块。它们是 .js 没有类型，所以 import 时要关掉类型检查。
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error 前端模块没有类型声明
import { csvDelimiter, parseCsv } from "../web/lib/csv.js";
// @ts-expect-error 前端模块没有类型声明
import { detectEol, restoreEol } from "../web/lib/eol.js";
// @ts-expect-error 前端模块没有类型声明
import { diffStat, pairLines, parseUnifiedDiff } from "../web/lib/diff-parse.js";

test("parseCsv：引号、转义、字段里的换行和分隔符", () => {
  assert.deepEqual(parseCsv('a,b\n1,"x,y"\n2,"say ""hi"""\n3,"l1\nl2"\n').rows, [["a", "b"], ["1", "x,y"], ["2", 'say "hi"'], ["3", "l1\nl2"]]);
});

test("parseCsv：CRLF、BOM、没有结尾换行、空字段、空文本", () => {
  assert.deepEqual(parseCsv("\ufeffa,b\r\n1,\r\n,2").rows, [["a", "b"], ["1", ""], ["", "2"]]);
  assert.deepEqual(parseCsv("").rows, []);
  assert.deepEqual(parseCsv("a,").rows, [["a", ""]]);
  assert.deepEqual(parseCsv("a\n\nb\n").rows, [["a"], [""], ["b"]]);
});

test("parseCsv：行数上限和截断的文本", () => {
  const limited = parseCsv("a\nb\nc\n", { maxRows: 2 });
  assert.deepEqual(limited.rows, [["a"], ["b"]]);
  assert.equal(limited.more, true);
  // 正好读完不算还有
  assert.equal(parseCsv("a\nb\n", { maxRows: 2 }).more, false);
  // 截断的文本扔掉最后不完整的一行，包括没闭合的引号
  const cut = parseCsv('a\nb\n"未闭', { cut: true });
  assert.deepEqual(cut.rows, [["a"], ["b"]]);
  assert.equal(cut.more, true);
});

test("csvDelimiter：按后缀和第一行判断", () => {
  assert.equal(csvDelimiter("a.tsv", "x,y"), "\t");
  assert.equal(csvDelimiter("a.csv", "x,y;z"), ",");
  assert.equal(csvDelimiter("a.csv", "x;y;z,w\n1,2,3,4,5,6"), ";");
  assert.equal(parseCsv("a\tb", { delimiter: "\t" }).rows[0].length, 2);
});

test("换行符：判断和还原", () => {
  assert.equal(detectEol("a\nb\n"), "lf");
  assert.equal(detectEol(""), "lf");
  assert.equal(detectEol("a\r\nb\r\n"), "crlf");
  assert.equal(detectEol("a\r\nb\n"), "mixed");
  assert.equal(detectEol("a\rb"), "mixed");
  assert.equal(restoreEol("a\nb\n", "crlf"), "a\r\nb\r\n");
  assert.equal(restoreEol("a\nb\n", "lf"), "a\nb\n");
  assert.equal(restoreEol("a\r\nb\n", "mixed"), "a\r\nb\n");
});

test("parseUnifiedDiff：行号、段落标题、文件末尾没有换行", () => {
  const text = [
    "diff --git a/a.ts b/a.ts",
    "index 1..2 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -10,3 +10,3 @@ function foo() {",
    " keep",
    "-old",
    "+new",
    " keep2",
    "\\ No newline at end of file",
    "@@ -30 +30,2 @@",
    " x",
    "+-- 以减号开头的新增行",
    "",
  ].join("\n");
  const parsed = parseUnifiedDiff(text);
  assert.equal(parsed.combined, false);
  assert.equal(parsed.meta.length, 4);
  assert.equal(parsed.hunks.length, 2);
  assert.equal(parsed.hunks[0].section, "function foo() {");
  assert.deepEqual(parsed.hunks[0].lines, [
    { type: "ctx", text: "keep", oldNo: 10, newNo: 10 },
    { type: "del", text: "old", oldNo: 11 },
    { type: "add", text: "new", newNo: 11 },
    { type: "ctx", text: "keep2", oldNo: 12, newNo: 12 },
    { type: "note", text: "No newline at end of file" },
  ]);
  assert.equal(parsed.hunks[1].lines[1].text, "-- 以减号开头的新增行");
  assert.deepEqual(diffStat(parsed), { added: 2, removed: 1 });
});

test("parseUnifiedDiff：合并冲突的格式原样给，只有文件头的没有内容", () => {
  assert.equal(parseUnifiedDiff("diff --cc a\n@@@ -1,1 -1,1 +1,1 @@@\n- a\n -b\n++c\n").combined, true);
  const mode = parseUnifiedDiff("diff --git a/x b/x\nold mode 100644\nnew mode 100755\n");
  assert.deepEqual(mode.hunks, []);
  assert.equal(mode.meta.length, 3);
});

test("pairLines：删除和紧跟的新增配对，多出来的一侧留空", () => {
  const ctx = { type: "ctx", text: "c", oldNo: 1, newNo: 1 };
  const d1 = { type: "del", text: "d1", oldNo: 2 };
  const d2 = { type: "del", text: "d2", oldNo: 3 };
  const a1 = { type: "add", text: "a1", newNo: 2 };
  assert.deepEqual(pairLines([ctx, d1, d2, a1, ctx]), [
    { left: ctx, right: ctx },
    { left: d1, right: a1 },
    { left: d2, right: null },
    { left: ctx, right: ctx },
  ]);
  assert.deepEqual(pairLines([a1]), [{ left: null, right: a1 }]);
});
