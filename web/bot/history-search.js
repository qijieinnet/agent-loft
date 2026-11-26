import { api, h } from "./client.js";
import { action, note, panel, panelError } from "./panel.js";

export async function searchHistory(term, openMessage) {
  const list = h("div"), status = h("p", { class: "help", role: "status" }, "正在搜索…");
  let cursor = null, count = 0;
  const more = action("加载更多", load);
  more.hidden = true;
  const live = panel("历史消息", note("关键词 · " + term), list, status, more);
  async function load() {
    const query = new URLSearchParams({ q: term });
    if (cursor) query.set("before", cursor);
    const data = await api("/api/bots/search?" + query);
    if (!live()) return;
    for (const row of data.matches) {
      const scope = row.scope === "private" ? "私聊" : "共享对话";
      list.append(action(h("span", {}, h("strong", {}, row.botName + " · " + scope),
        h("small", {}, new Date(row.createdAt).toLocaleString()), h("span", {}, row.excerpt)),
        () => openMessage(row.thread, row.id, live), "row history-match"));
      count++;
    }
    cursor = data.nextBefore;
    more.hidden = !cursor;
    status.textContent = count ? "已显示 " + count + " 条消息" : "当前可见的对话里没有匹配的消息。";
  }
  try { await load(); } catch (err) { if (live()) panelError(err.message); }
}
