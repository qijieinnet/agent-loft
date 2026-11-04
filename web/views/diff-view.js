// 把一个文件的 diff 画出来：单栏 / 并排，按文件类型高亮。解析在 lib/diff-parse.js。
import hljs from "../vendor/hljs.js";
import { h } from "../lib/dom.js";
import { diffStat, pairLines, parseUnifiedDiff } from "../lib/diff-parse.js";

/** 超过这么多行先只画一部分，点了才画全：几万行的 DOM 会把页面卡住 */
const RENDER_LIMIT = 2000;
/** 超过这么多行不高亮 */
const HIGHLIGHT_LIMIT = 5000;

function languageOf(path) {
  const ext = (/\.([\w+-]+)$/.exec(path)?.[1] ?? "").toLowerCase();
  return ext && hljs.getLanguage(ext) ? ext : null;
}

function codeCell(line, language) {
  const code = h("span", { class: "d-code" });
  if (language && line.type !== "note" && line.text) {
    try {
      // 一行一行高亮：跨行的注释、字符串会看不出来，但整个文件才高亮的话，diff 里本来就缺上下文
      code.innerHTML = hljs.highlight(line.text, { language, ignoreIllegals: true }).value;
      return code;
    } catch {
      // 退回纯文字
    }
  }
  code.textContent = line.text || "​";
  return code;
}

const MARK = { add: "+", del: "−", ctx: " ", note: "" };

function unifiedRow(line, language) {
  return h(
    "div",
    { class: `d-row d-${line.type}` },
    h("span", { class: "d-ln" }, line.oldNo ?? ""),
    h("span", { class: "d-ln" }, line.newNo ?? ""),
    h("span", { class: "d-mark" }, MARK[line.type]),
    codeCell(line, language),
  );
}

function splitSide(line, no, language) {
  if (!line) return [h("span", { class: "d-ln d-blank" }), h("span", { class: "d-code d-blank" })];
  const type = `d-${line.type}`;
  return [h("span", { class: `d-ln ${type}` }, no ?? ""), Object.assign(codeCell(line, language), { className: `d-code ${type}` })];
}

function splitRow({ left, right }, language) {
  return h("div", { class: "d-row d-split-row" }, splitSide(left, left?.oldNo, language), splitSide(right, right?.newNo, language));
}

/** 画一个文件的 diff。返回 { el, stat } */
export function renderDiff(text, { path, mode = "unified" }) {
  const parsed = parseUnifiedDiff(text);
  if (parsed.combined) {
    return {
      el: h("div", { class: "diff" }, h("div", { class: "d-note-bar" }, "这个文件有合并冲突，显示的是 git 的合并格式"), h("pre", { class: "d-raw" }, parsed.raw.join("\n"))),
      stat: null,
    };
  }
  const total = parsed.hunks.reduce((n, hunk) => n + hunk.lines.length, 0);
  const language = total <= HIGHLIGHT_LIMIT ? languageOf(path) : null;
  const split = mode === "split";
  const root = h("div", { class: `diff${split ? " split" : ""}` });

  const draw = (limit) => {
    const out = [];
    let left = limit;
    for (const hunk of parsed.hunks) {
      if (left <= 0) break;
      out.push(h("div", { class: "d-hunk" }, hunk.header.replace(/^(@@.*?@@).*$/, "$1"), hunk.section ? h("span", { class: "d-section" }, hunk.section) : null));
      if (split) {
        const rows = pairLines(hunk.lines).slice(0, left);
        left -= rows.length;
        out.push(rows.map((row) => splitRow(row, language)));
      } else {
        const lines = hunk.lines.slice(0, left);
        left -= lines.length;
        out.push(lines.map((line) => unifiedRow(line, language)));
      }
    }
    if (total > limit) {
      out.push(h("button", { class: "btn ghost d-more", onclick: () => draw(Infinity) }, `还有内容没显示（共 ${total} 行），显示全部`));
    }
    root.replaceChildren(...out.flat(Infinity));
  };
  draw(RENDER_LIMIT);
  return { el: root, stat: diffStat(parsed), empty: parsed.hunks.length === 0, meta: parsed.meta };
}
