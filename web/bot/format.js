// Replies use ordinary text nodes. Only these few reading styles become HTML elements.
import { h } from "./client.js";

function inline(node, text) {
  let start = 0;
  for (const match of text.matchAll(/\*\*([^*\n]+)\*\*|__([^_\n]+)__|`([^`\n]+)`/gu)) {
    node.append(text.slice(start, match.index), h(match[3] ? "code" : "strong", {}, match[1] || match[2] || match[3]));
    start = match.index + match[0].length;
  }
  node.append(text.slice(start));
}

export function replyText(text) {
  const output = h("div", { class: "message-text reply-text" });
  let paragraph = null, list = null, previousItem = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) { paragraph = list = previousItem = null; continue; }
    const item = /^ {0,3}(?:[-*+] |(\d{1,5})[.)、]\s+)(.+)$/u.exec(line);
    if (item) {
      const tag = item[1] ? "ol" : "ul";
      if (list?.localName !== tag) {
        list = h(tag, item[1] && Number(item[1]) !== 1 ? { start: Number(item[1]) } : {});
        output.append(list);
      }
      previousItem = h("li");
      inline(previousItem, item[2]);
      list.append(previousItem);
      paragraph = null;
      continue;
    }
    if (previousItem && /^ {2,}\S/u.test(line)) {
      previousItem.append(h("br"));
      inline(previousItem, line.trimStart());
      continue;
    }
    list = previousItem = null;
    const heading = /^#{1,6}\s+(.+)$/u.exec(line);
    if (heading) {
      const title = h("p", { class: "reply-heading" });
      inline(title, heading[1]);
      output.append(title);
      paragraph = null;
      continue;
    }
    if (paragraph) paragraph.append(h("br"));
    else { paragraph = h("p"); output.append(paragraph); }
    inline(paragraph, line);
  }
  return output;
}
