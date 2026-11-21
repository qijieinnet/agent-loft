import { h } from "./dom.js";

const labels = { off: "关闭", read: "只读", write: "读写" };

export function memoAccessSelect(label, value, libraryDefault) {
  const select = h("select", { class: "input", "aria-label": label },
    libraryDefault ? h("option", { value: "" }, `沿用笔记库默认（${labels[libraryDefault]}）`) : null,
    Object.entries(labels).map(([id, name]) => h("option", { value: id }, name)));
  select.value = value;
  return select;
}

export function expertMemoField(libraries = [], expert) {
  const rows = libraries.map(source => {
    const initial = source.expertAccess?.[expert] ?? "";
    const input = memoAccessSelect(source.name, initial, source.access ?? "off");
    return { id: source.id, input, initial, row: h("label", { class: "memo-expert-access" }, h("span", {}, source.name), input) };
  });
  return {
    el: h("div", { class: "field" }, h("span", {}, "备忘录权限"),
      rows.length ? h("div", { class: "memo-fields" }, rows.map(r => r.row))
        : h("small", {}, "可先在「备忘录」连接自己的笔记库。")),
    changes() {
      const entries = rows.filter(r => r.input.value !== r.initial).map(r => [r.id, r.input.value || null]);
      return entries.length ? Object.fromEntries(entries) : undefined;
    },
  };
}
