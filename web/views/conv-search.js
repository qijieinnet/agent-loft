import { h, icon, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { relTime } from "../lib/time.js";
import { S } from "../state.js";
import { baseName } from "./topbar.js";
import { closeSide, convTitle } from "./sidebar.js";
import { openConversation } from "./messages.js";
import { leaveRemote } from "./remote.js";
import { convExpert, expertChoices, expertIcon } from "./experts.js";

// ---------- 搜索会话（侧栏「搜索」，服务端见 /api/conversations/search） ----------
// 弹窗：上面输入框，下面一排专家（默认「全部」），再下面是结果。
// 搜全部会话的标题、目录名和聊天内容，不只是侧栏已经拉下来的几页；没输入时列最近的。
// ↑↓ 选，回车打开，Esc 关。

let current = null;

export function openSearch() {
  if (current) return current.input.focus();
  const st = { q: "", expert: null, results: null, loading: false, seq: 0, timer: 0, sel: 0 };
  const input = h("input", {
    class: "search-input",
    type: "search",
    placeholder: "搜索会话标题、聊天内容",
    enterkeyhint: "search",
    autocomplete: "off",
    oninput: () => {
      st.q = input.value;
      clearTimeout(st.timer);
      st.timer = setTimeout(run, 200);
    },
  });
  const chips = h("div", { class: "search-experts" });
  const list = h("div", { class: "search-results" });
  const close = () => {
    clearTimeout(st.timer);
    st.seq++;
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    current = null;
  };
  const overlay = h(
    "div",
    { class: "overlay search-overlay", onclick: (e) => e.target === overlay && close() },
    h(
      "div",
      { class: "search-modal", role: "dialog", "aria-label": "搜索会话" },
      h(
        "div",
        { class: "search-head" },
        h("span", { class: "search-icon" }, icon("search")),
        input,
        h("button", { class: "icon-btn", title: "关闭（Esc）", onclick: close }, icon("x")),
      ),
      chips,
      list,
    ),
  );

  const open = (c) => {
    close();
    closeSide();
    if (!S.convs.has(c.key)) S.convs.set(c.key, c);
    if (c.key !== S.current) void openConversation(c.key);
    else if (S.view === "remote") leaveRemote();
  };

  function renderChips() {
    const chip = (id, label, iconEl) =>
      h(
        "button",
        {
          class: `search-chip${st.expert === id ? " on" : ""}`,
          onclick: () => {
            if (st.expert === id) return;
            st.expert = id;
            renderChips();
            void run();
            input.focus();
          },
        },
        iconEl,
        label,
      );
    chips.replaceChildren(chip(null, "全部", null), ...expertChoices().map((e) => chip(e.id, e.name, expertIcon(e))));
  }

  function renderResults() {
    const { results } = st;
    if (!results) {
      list.replaceChildren(h("div", { class: "search-empty" }, "搜索中…"));
      return;
    }
    if (results.length === 0) {
      list.replaceChildren(h("div", { class: "search-empty" }, st.loading ? "搜索中…" : st.q.trim() ? "没有找到相关的会话" : "还没有会话"));
      return;
    }
    st.sel = Math.min(st.sel, results.length - 1);
    const words = st.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    list.replaceChildren(
      ...(st.q.trim() ? [] : [h("div", { class: "search-label" }, "最近")]),
      ...results.map(({ conv, snippet }, i) => {
        // 本地有就用本地的（标题是最新的）
        const c = S.convs.get(conv.key) ?? conv;
        const where = c.channel === "feishu" ? "飞书" : baseName(c.cwd);
        return h(
          "button",
          {
            class: `search-hit${i === st.sel ? " sel" : ""}`,
            title: `${convTitle(c)}\n${c.cwd}`,
            onclick: () => open(c),
            onpointermove: () => {
              if (st.sel !== i) select(i, false);
            },
          },
          h("span", { class: "hit-icon" }, expertIcon(convExpert(c))),
          h(
            "span",
            { class: "hit-body" },
            h("span", { class: "hit-title" }, mark(convTitle(c), words)),
            snippet ? h("span", { class: "hit-snippet" }, mark(snippet, words)) : null,
          ),
          h("span", { class: "hit-meta" }, `${where} · ${relTime(c.activeAt)}`),
        );
      }),
    );
  }

  function select(i, scroll = true) {
    const hits = list.querySelectorAll(".search-hit");
    if (!hits.length) return;
    st.sel = (i + hits.length) % hits.length;
    hits.forEach((el, n) => el.classList.toggle("sel", n === st.sel));
    if (scroll) hits[st.sel].scrollIntoView({ block: "nearest" });
  }

  async function run() {
    const seq = ++st.seq;
    st.loading = true;
    if (!st.results?.length) renderResults();
    const q = new URLSearchParams({ q: st.q.trim() });
    if (st.expert) q.set("expert", st.expert);
    try {
      const data = await api(`/api/conversations/search?${q}`);
      if (seq !== st.seq) return;
      st.results = data.results;
    } catch (err) {
      if (seq !== st.seq) return;
      st.results = [];
      toast(`搜索失败：${err.message}`);
    }
    st.loading = false;
    st.sel = 0;
    renderResults();
    list.scrollTop = 0;
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      select(st.sel + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter" && !e.isComposing && e.target === input) {
      e.preventDefault();
      const hit = st.results?.[st.sel];
      if (hit) open(hit.conv);
    }
  }

  document.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  current = { input };
  renderChips();
  renderResults();
  input.focus();
  void run();
}

/** 把查询的词在文字里标出来 */
function mark(text, words) {
  if (!words.length) return text;
  const lower = text.toLowerCase();
  const out = [];
  let i = 0;
  while (i < text.length) {
    // 从 i 开始最早出现的那个词
    let at = -1;
    let len = 0;
    for (const w of words) {
      const p = lower.indexOf(w, i);
      if (p >= 0 && (at < 0 || p < at || (p === at && w.length > len))) {
        at = p;
        len = w.length;
      }
    }
    if (at < 0) break;
    if (at > i) out.push(text.slice(i, at));
    out.push(h("mark", {}, text.slice(at, at + len)));
    i = at + len;
  }
  out.push(text.slice(i));
  return out;
}
