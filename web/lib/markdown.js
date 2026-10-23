import DOMPurify from "/vendor/purify.js";
import hljs from "/vendor/hljs.js";
import { marked } from "/vendor/marked.js";
import { h, toast } from "./dom.js";

// ---------- markdown ----------

marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(text) {
  const html = DOMPurify.sanitize(marked.parse(text ?? ""), { ADD_ATTR: ["target"] });
  const div = h("div", { class: "md", html });
  for (const a of div.querySelectorAll("a")) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  for (const pre of div.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    if (!code) continue;
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
    const copy = h("button", { class: "copy-btn", onclick: () => copyText(code.textContent, copy) }, "复制");
    pre.prepend(h("div", { class: "code-head" }, h("span", {}, lang || "code"), copy));
  }
  return div;
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
