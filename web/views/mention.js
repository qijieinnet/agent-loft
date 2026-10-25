import { fill, h } from "../lib/dom.js";
import { api } from "../lib/api.js";

// ---------- @ 技能补全 ----------
//
// 光标前面是「@xxx」（@ 在开头或者前面是空白、标点）时弹出能用的技能，选中后补成「@name 」。
// 输入框和定时任务的「要做的事」共用：发出去之后由服务端认消息里的 @name（skill-runtime.ts），
// 前端只负责补全，不用另外传选了哪些。
// 列表缓存半分钟；技能有变化时服务端推 { t: "skills" }，缓存作废。

let cache = null;
document.addEventListener("aim:skills", () => (cache = null));

async function loadSkills() {
  if (cache && Date.now() - cache.at < 30_000) return cache.list;
  const data = await api("/api/skills/mention");
  cache = { at: Date.now(), list: data.skills };
  return data.skills;
}

/** 光标前的 @ 片段：返回 { start, query }，不在 @ 里就是 null */
function mentionAt(input) {
  const pos = input.selectionStart ?? input.value.length;
  if (pos !== (input.selectionEnd ?? pos)) return null;
  const m = /(^|[\s(（，。,.!！?？:：;；"'“”‘’、])@([a-z0-9_-]*)$/i.exec(input.value.slice(0, pos));
  if (!m) return null;
  return { start: pos - m[2].length - 1, query: m[2].toLowerCase() };
}

function match(list, q) {
  if (!q) return list;
  const tiers = [[], [], []];
  for (const s of list) {
    if (s.name.startsWith(q)) tiers[0].push(s);
    else if (s.name.includes(q)) tiers[1].push(s);
    else if (s.description.toLowerCase().includes(q)) tiers[2].push(s);
  }
  return tiers.flat();
}

/**
 * 给一个输入框挂上 @ 补全。menu 是放菜单的元素（调用方决定放哪、怎么定位，样式用 .slash-menu）。
 * onEmpty：一个技能都没有时，菜单里给个入口（去设置里的技能页）。onShown：菜单关着时弹出来、有了内容那一下。返回 { update, keydown, close }：
 * 输入框的 input / keydown / blur 里分别调用。
 */
export function attachMention(input, menu, { onEmpty, onPicked, onShown } = {}) {
  const st = { open: false, shown: false, items: [], index: 0, token: 0, at: null };

  const shown = () => {
    if (st.shown) return;
    st.shown = true;
    onShown?.();
  };

  const close = () => {
    st.open = false;
    st.shown = false;
    st.items = [];
    st.index = 0;
    st.token++;
    menu.hidden = true;
  };

  const highlight = () => {
    menu.querySelectorAll(".slash-item").forEach((el, i) => el.classList.toggle("on", i === st.index));
    menu.querySelector(".slash-item.on")?.scrollIntoView({ block: "nearest" });
  };

  const pick = (s) => {
    const at = mentionAt(input);
    if (!at) return close();
    const before = input.value.slice(0, at.start);
    const after = input.value.slice(input.selectionStart);
    const insert = `@${s.name}${after.startsWith(" ") ? "" : " "}`;
    input.value = `${before}${insert}${after}`;
    const caret = before.length + insert.length;
    input.setSelectionRange(caret, caret);
    close();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    onPicked?.(s);
  };

  const render = (items, note) => {
    st.open = true;
    menu.hidden = false;
    if (!items) {
      fill(menu, h("div", { class: "slash-empty" }, note ?? h("span", { class: "spinner" })));
      return;
    }
    fill(
      menu,
      items.map((s, i) =>
        h(
          "button",
          {
            class: `slash-item${i === st.index ? " on" : ""}`,
            type: "button",
            onmousedown: (e) => {
              e.preventDefault();
              pick(s);
            },
            onmousemove: () => {
              if (st.index !== i) {
                st.index = i;
                highlight();
              }
            },
          },
          h(
            "div",
            { class: "slash-head" },
            h("span", { class: "slash-name" }, `@${s.name}`),
            s.kind === "machine" ? h("span", { class: "badge" }, "本机") : null,
          ),
          h("div", { class: "slash-desc" }, s.description || "（无说明）"),
        ),
      ),
    );
    highlight();
  };

  const update = async () => {
    const at = mentionAt(input);
    if (!at) return close();
    const token = ++st.token;
    if (!st.open) render(null);
    let list;
    try {
      list = await loadSkills();
    } catch (err) {
      if (token === st.token) render(null, `读取技能失败：${err.message}`);
      return;
    }
    const now = mentionAt(input);
    if (token !== st.token || !now) return;
    if (list.length === 0) {
      if (now.query || !onEmpty) return close();
      st.items = [];
      st.open = true;
      menu.hidden = false;
      fill(
        menu,
        h(
          "button",
          {
            class: "slash-item on",
            type: "button",
            onmousedown: (e) => {
              e.preventDefault();
              close();
              onEmpty();
            },
          },
          h("div", { class: "slash-head" }, h("span", { class: "slash-name" }, "还没有技能")),
          h("div", { class: "slash-desc" }, "去「设置 → 技能」新建、上传"),
        ),
      );
      shown();
      return;
    }
    const items = match(list, now.query);
    if (items.length === 0) return close();
    st.items = items;
    st.index = Math.min(st.index, items.length - 1);
    render(items);
    shown();
  };

  /** 菜单开着时接管方向键 / Tab / 回车 / Esc；返回 true 表示已处理 */
  const keydown = (e) => {
    if (!st.open) return false;
    if (e.isComposing) return false;
    if (e.key === "Escape") {
      close();
      return true;
    }
    if (st.items.length === 0) return false;
    switch (e.key) {
      case "ArrowDown":
        st.index = (st.index + 1) % st.items.length;
        highlight();
        return true;
      case "ArrowUp":
        st.index = (st.index - 1 + st.items.length) % st.items.length;
        highlight();
        return true;
      case "Tab":
        pick(st.items[st.index]);
        return true;
      case "Enter":
        if (e.shiftKey) return false;
        pick(st.items[st.index]);
        return true;
    }
    return false;
  };

  // 光标移动（点击、方向键离开 @ 片段）也要跟着开关
  input.addEventListener("click", () => void update());
  return { update, keydown, close, get open() { return st.open; } };
}
