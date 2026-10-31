import DOMPurify from "/vendor/purify.js";
import hljs from "/vendor/hljs.js";
import { marked } from "/vendor/marked.js";
import { diagramLang, mountDiagram, unmountDiagrams } from "./diagrams.js";
import { h, toast } from "./dom.js";

// ---------- markdown ----------

marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(text, opts) {
  const div = h("div", { class: "md" });
  patchMarkdown(div, text, opts);
  return div;
}

/**
 * 把 div 里的 markdown 更新成 text，只重画变了的块（段落、列表、代码块…）。
 * 流式输出时前面的块不再变，每帧只需重画最后一两块；选中的文字、代码块的横向滚动也不会被冲掉。
 * live = 还在输出：最后一块随时会变，先不高亮，等它定下来再高亮。
 * enhance(box, { final })：每块画好后再加工一下（比如把文件路径变成链接、完整相册块变成网格）。
 * 按块拼起来和整段解析的结果一样（marked 的 parser 本来就是逐块拼接的）。
 */
export function patchMarkdown(div, text, { live = false, enhance } = {}) {
  const tokens = marked.lexer(text ?? "");
  const links = JSON.stringify(tokens.links ?? {});
  // 引用式链接的定义可能在后面才出现（流式输出时地址还会一点点变长），会影响前面的块：定义变了就整个重画
  if (div._links !== links) {
    div._links = links;
    div._blocks = [];
    div.replaceChildren();
  }
  // HTML 块（<details>、<div align> 之类）的开闭标签常常不在同一块里，分开解析会被浏览器提前补上结束标签：
  // 从第一个 HTML 块起到结尾合成一块
  const cut = tokens.findIndex((t) => t.type === "html");
  const chunks = cut < 0 ? tokens.map((t) => [t]) : [...tokens.slice(0, cut).map((t) => [t]), tokens.slice(cut)];
  const raws = chunks.map((c) => c.map((t) => t.raw).join(""));
  const blocks = (div._blocks ??= []);
  const last = chunks.length - 1;
  let i = 0;
  // 还在输出时画的块没高亮，只有它仍是正在输出的最后一块才能接着用
  while (i < blocks.length && i <= last && blocks[i].raw === raws[i] && (blocks[i].final || (live && i === last))) i++;
  for (const b of blocks.splice(i)) {
    for (const n of b.nodes) {
      if (n.nodeType === Node.ELEMENT_NODE) for (const code of n.querySelectorAll("pre code")) lazyHighlight.unobserve(code);
      unmountDiagrams(n);
      n.remove();
    }
  }
  for (; i <= last; i++) {
    const final = !(live && i === last);
    const chunk = chunks[i];
    chunk.links = tokens.links;
    // 在本页的元素里解析（DOMPurify 直接返回的节点属于另一个 document，搬过来后 IntersectionObserver 就不灵了）
    const box = document.createElement("div");
    box.innerHTML = DOMPurify.sanitize(marked.parser(chunk), { ADD_ATTR: ["target"] });
    decorate(box, final);
    enhance?.(box, { final });
    const nodes = [...box.childNodes];
    div.append(...nodes);
    blocks.push({ raw: raws[i], final, nodes });
  }
}

/** 链接新窗口打开；代码块加上语言 + 复制按钮的头，滚到附近了再高亮；```chart / ```mermaid 画成图 */
function decorate(root, highlight) {
  for (const a of root.querySelectorAll("a")) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  for (const pre of root.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    if (!code) continue;
    const lang = /language-([\w+-]+)/.exec(code.className)?.[1] ?? "";
    const copy = h("button", { class: "copy-btn", onclick: () => copyText(code.textContent, copy) }, "复制");
    pre.prepend(h("div", { class: "code-head" }, h("span", {}, lang || "code"), copy));
    const diagram = diagramLang(code);
    if (diagram) mountDiagram(pre, code, diagram, highlight);
    else if (highlight && lang !== "album") lazyHighlight.observe(code);
  }
}

/**
 * 高亮（尤其是自动识别语言）很慢：长会话一打开几十个代码块会卡住。
 * 只在代码块快滚进视口时才高亮；高亮不改变文字和行高，不会让内容跳。
 */
const lazyHighlight = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      lazyHighlight.unobserve(e.target);
      highlight(e.target);
    }
  },
  // 代码块在消息区这种滚动容器里：rootMargin 只放大视口，scrollMargin 才放大滚动容器的裁剪范围（不支持的浏览器忽略它）
  { rootMargin: "800px 0px", scrollMargin: "800px 0px" },
);

function highlight(code) {
  const lang = /language-([\w+-]+)/.exec(code.className)?.[1] ?? "";
  try {
    if (lang && hljs.getLanguage(lang)) hljs.highlightElement(code);
    else if (code.textContent.length < 20000) {
      code.innerHTML = hljs.highlightAuto(code.textContent).value;
      code.classList.add("hljs");
    }
  } catch {
    // 高亮失败就原样显示
  }
}

export async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h("textarea", { style: { position: "fixed", opacity: "0" } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = "已复制";
    setTimeout(() => (btn.textContent = old), 1200);
  } else toast("已复制");
}
