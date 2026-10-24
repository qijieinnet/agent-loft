import { h } from "../lib/dom.js";
import { S, ui } from "../state.js";
import { userScrolled } from "./messages.js";

// ---------- 消息区右边的快速定位（像网页版 ChatGPT） ----------
// 每条用户消息一道短横线，竖着排在滚动条旁边，正看到的那条高亮；平时淡淡的，滚动时清楚些。
// 鼠标移上去展开成列表，显示每条消息的开头，点一下跳过去。用户消息少于 3 条时不显示；窄屏（手机）不显示。

const MIN_USERS = 3;
let entries = [];
let activeIdx = -1;
let scheduled = false;
let scrollRaf = 0;
let scrollingTimer = 0;

export function createNav() {
  ui.navTicks = h("div", { class: "msg-nav-ticks" });
  ui.navPanel = h("div", { class: "msg-nav-panel" });
  ui.nav = h("nav", { class: "msg-nav", hidden: true, "aria-label": "消息快速定位", onpointerenter: revealActiveRow }, ui.navTicks, ui.navPanel);
  ui.messages.addEventListener("scroll", onScroll, { passive: true });
  return ui.nav;
}

/** 用户消息变了（发了一条、打开别的会话）：下一帧重建 */
export function scheduleNav() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    build();
  });
}

function snippet(item) {
  const text = (item.text ?? "").replace(/\s+/g, " ").trim();
  if (text) return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  const names = (item.files ?? []).map((f) => (typeof f === "string" ? f : f.name));
  return names.length ? `[附件] ${names.join("、")}` : "（空消息）";
}

function build() {
  if (!ui.nav) return;
  const users = S.view ? [] : S.items.filter((it) => it.type === "user" && it.el?.isConnected);
  ui.nav.hidden = users.length < MIN_USERS;
  activeIdx = -1;
  if (ui.nav.hidden) {
    entries = [];
    ui.navTicks.replaceChildren();
    ui.navPanel.replaceChildren();
    return;
  }
  entries = users.map((item, i) => {
    const label = snippet(item);
    return {
      item,
      tick: h("button", { class: "msg-nav-tick", "aria-label": `第 ${i + 1} 条：${label}`, onclick: () => jump(item) }, h("i")),
      row: h("button", { class: "msg-nav-row", onclick: () => jump(item) }, label),
    };
  });
  ui.navTicks.replaceChildren(...entries.map((e) => e.tick));
  ui.navPanel.replaceChildren(...entries.map((e) => e.row));
  updateActive();
}

/** 顶栏叠在消息区上面：跳过去时让出它的高度 */
function covered() {
  return Math.max(0, ui.topbar.getBoundingClientRect().bottom - ui.messages.getBoundingClientRect().top);
}

function jump(item) {
  if (!item.el?.isConnected) return;
  userScrolled();
  ui.messages.scrollTo({ top: Math.max(0, item.el.offsetTop - covered() - 12), behavior: "smooth" });
}

function onScroll() {
  if (!entries.length) return;
  ui.nav.classList.add("scrolling");
  clearTimeout(scrollingTimer);
  scrollingTimer = setTimeout(() => ui.nav.classList.remove("scrolling"), 1200);
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    updateActive();
  });
}

/** 正看到的：顶部往下三分之一处以上、最后一条用户消息；已经滚到底就是最后一条 */
function updateActive() {
  const m = ui.messages;
  const line = m.scrollTop + covered() + m.clientHeight * 0.3;
  let idx = 0;
  if (m.scrollHeight - m.scrollTop - m.clientHeight < 4) idx = entries.length - 1;
  else {
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].item.el.offsetTop <= line) idx = i;
      else break;
    }
  }
  if (idx === activeIdx) return;
  entries[activeIdx]?.tick.classList.remove("on");
  entries[activeIdx]?.row.classList.remove("on");
  activeIdx = idx;
  entries[idx].tick.classList.add("on");
  entries[idx].row.classList.add("on");
  keepVisible(ui.navTicks, entries[idx].tick);
}

/** 横线太多、竖条装不下时它自己能滚：让高亮的那道留在看得见的地方（不用 scrollIntoView，免得把外层也带着滚） */
function keepVisible(box, el) {
  const top = el.offsetTop - box.offsetTop;
  if (top < box.scrollTop) box.scrollTop = top;
  else if (top + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + el.offsetHeight - box.clientHeight;
}

/** 展开列表时：列表滚到正看到的那条 */
function revealActiveRow() {
  const row = entries[activeIdx]?.row;
  if (row) ui.navPanel.scrollTop = Math.max(0, row.offsetTop - ui.navPanel.clientHeight / 2);
}
