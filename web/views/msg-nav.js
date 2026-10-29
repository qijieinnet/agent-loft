import { h } from "../lib/dom.js";
import { S, ui } from "../state.js";
import { userScrolled } from "./messages.js";

// ---------- 消息区右边的快速定位（像网页版 ChatGPT） ----------
// 每条用户消息一道短横线，竖着排在滚动条旁边，正看到的那条高亮；平时淡淡的，滚动时清楚些。
// 鼠标移上去展开成列表，显示每条消息的开头，点一下跳过去。用户消息少于 3 条时不显示。
// 手机用短轨道定位：按住拖动预览问题，松手跳转；只在手动滚动和操作时显示。

const MIN_USERS = 3;
const HIDE_DELAY = 1600;
const compact = matchMedia("(max-width: 768px), (hover: none)");
let entries = [];
let activeIdx = -1;
let scheduled = false;
let scrollRaf = 0;
let scrollingTimer = 0;
let builtFor = null;
let scrubbing = null;

compact.addEventListener("change", () => {
  resetScrolling();
  updateActive();
});

export function createNav() {
  resetScrolling();
  builtFor = null;
  entries = [];
  ui.navTicks = h("div", { class: "msg-nav-ticks" });
  ui.navPanel = h("div", { class: "msg-nav-panel" });
  ui.navTrack = h("div", { class: "msg-nav-track", "aria-hidden": "true" });
  ui.navRail = h("div", {
    class: "msg-nav-rail", role: "slider", tabindex: "0", "aria-label": "拖动定位用户消息", "aria-orientation": "vertical", "aria-valuemin": "1",
    onpointerdown: startScrubbing, onpointermove: moveScrubbing, onpointerup: finishScrubbing,
    onpointercancel: cancelPointer, onlostpointercapture: cancelPointer, onkeydown: onRailKey,
    onfocus: markScrolling, onblur: markScrolling,
  }, ui.navTrack);
  ui.navCount = h("span", { class: "msg-nav-count" });
  ui.navSnippet = h("span", { class: "msg-nav-snippet" });
  const preview = h("div", { class: "msg-nav-preview", "aria-hidden": "true" }, ui.navCount, ui.navSnippet);
  ui.nav = h("nav", { class: "msg-nav", hidden: true, "aria-label": "消息快速定位", onpointerenter: revealActiveRow, onpointerdown: markScrolling }, ui.navTicks, ui.navPanel, ui.navRail, preview);
  ui.navTicks.addEventListener("scroll", () => {
    if (ui.nav.classList.contains("scrolling")) markScrolling();
  }, { passive: true });
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
  if (builtFor !== S.current || users.length < MIN_USERS) resetScrolling();
  else if (scrubbing) {
    cancelScrubbing();
    markScrolling();
  }
  builtFor = S.current;
  ui.nav.hidden = users.length < MIN_USERS;
  activeIdx = -1;
  if (ui.nav.hidden) {
    entries = [];
    ui.navTicks.replaceChildren();
    ui.navPanel.replaceChildren();
    ui.navTrack.replaceChildren();
    return;
  }
  entries = users.map((item, i) => {
    const label = snippet(item);
    return {
      item,
      label,
      tick: h("button", { class: "msg-nav-tick", "aria-label": `第 ${i + 1} 条：${label}`, onclick: () => jump(item) }, h("i")),
      row: h("button", { class: "msg-nav-row", onclick: () => jump(item) }, label),
    };
  });
  ui.navTicks.replaceChildren(...entries.map((e) => e.tick));
  ui.navPanel.replaceChildren(...entries.map((e) => e.row));
  const marks = Math.min(entries.length, 9);
  ui.navRail.style.setProperty("--nav-rail-height", `${Math.min(156, 56 + (marks - 1) * 16)}px`);
  ui.navTrack.replaceChildren(
    ...Array.from({ length: marks }, (_, i) => h("i", { class: `msg-nav-mark${i % 2 === 0 ? " major" : ""}`, style: { top: `${i / (marks - 1) * 100}%` } })),
    h("span", { class: "msg-nav-thumb" }),
  );
  ui.navRail.setAttribute("aria-valuemax", String(entries.length));
  updateActive();
}

/** 顶栏叠在消息区上面：跳过去时让出它的高度 */
function covered() {
  return Math.max(0, ui.topbar.getBoundingClientRect().bottom - ui.messages.getBoundingClientRect().top);
}

function jump(item) {
  if (!item?.el?.isConnected) return;
  userScrolled();
  ui.messages.scrollTo({ top: Math.max(0, item.el.offsetTop - covered() - 12), behavior: "smooth" });
}

function resetScrolling() {
  cancelScrubbing();
  clearTimeout(scrollingTimer);
  cancelAnimationFrame(scrollRaf);
  scrollRaf = 0;
  ui.nav?.classList.remove("scrolling");
}

function markScrolling() {
  if (!entries.length) return;
  ui.nav.classList.add("scrolling");
  clearTimeout(scrollingTimer);
  if (scrubbing) return;
  scrollingTimer = setTimeout(() => {
    if (compact.matches && document.activeElement === ui.navRail) return;
    ui.nav.classList.remove("scrolling");
  }, HIDE_DELAY);
}

function onScroll() {
  if (!entries.length) return;
  // 自动跟随模型回复时不打扰阅读；手动滚动才唤出手机上的轨道。
  if (!compact.matches || ui.follow === false) markScrolling();
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    updateActive();
  });
}

/** 正看到的：顶部往下三分之一处以上、最后一条用户消息；已经滚到底就是最后一条 */
function updateActive() {
  if (!entries.length || scrubbing) return;
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
  selectEntry(idx);
}

function selectEntry(idx) {
  const entry = entries[idx];
  if (!entry) return;
  ui.nav.style.setProperty("--nav-progress", String(idx / (entries.length - 1)));
  ui.navRail.setAttribute("aria-valuenow", String(idx + 1));
  ui.navRail.setAttribute("aria-valuetext", `第 ${idx + 1} 条，共 ${entries.length} 条：${entry.label}`);
  ui.navCount.textContent = `${idx + 1} / ${entries.length}`;
  ui.navSnippet.textContent = entry.label;
  if (idx === activeIdx) return;
  entries[activeIdx]?.tick.classList.remove("on");
  entries[activeIdx]?.row.classList.remove("on");
  activeIdx = idx;
  entries[idx].tick.classList.add("on");
  entries[idx].row.classList.add("on");
  if (!compact.matches) keepVisible(ui.navTicks, entries[idx].tick);
}

function scrubTo(clientY) {
  const rect = ui.navTrack.getBoundingClientRect();
  if (!rect.height) return;
  const fraction = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  scrubbing.index = Math.round(fraction * (entries.length - 1));
  selectEntry(scrubbing.index);
}

function startScrubbing(e) {
  if (!compact.matches || !entries.length || e.button !== 0 || scrubbing) return;
  e.preventDefault();
  scrubbing = { pointerId: e.pointerId, index: activeIdx, key: S.current };
  ui.navRail.setPointerCapture(e.pointerId);
  ui.nav.classList.add("scrubbing");
  markScrolling();
  scrubTo(e.clientY);
}

function moveScrubbing(e) {
  if (scrubbing?.pointerId !== e.pointerId) return;
  scrubTo(e.clientY);
}

function finishScrubbing(e) {
  if (scrubbing?.pointerId !== e.pointerId) return;
  scrubTo(e.clientY);
  const target = scrubbing;
  cancelScrubbing();
  if (target.key === S.current) jump(entries[target.index]?.item);
  markScrolling();
}

function cancelScrubbing() {
  const pointerId = scrubbing?.pointerId;
  scrubbing = null;
  ui.nav?.classList.remove("scrubbing");
  if (pointerId !== undefined && ui.navRail?.hasPointerCapture(pointerId)) ui.navRail.releasePointerCapture(pointerId);
  updateActive();
}

function cancelPointer(e) {
  if (scrubbing?.pointerId !== e.pointerId) return;
  cancelScrubbing();
  markScrolling();
}

function onRailKey(e) {
  const delta = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1, PageUp: -5, PageDown: 5 }[e.key];
  if (!entries.length || (delta === undefined && e.key !== "Home" && e.key !== "End")) return;
  e.preventDefault();
  const idx = e.key === "Home" ? 0 : e.key === "End" ? entries.length - 1 : Math.max(0, Math.min(entries.length - 1, activeIdx + delta));
  selectEntry(idx);
  jump(entries[idx].item);
  markScrolling();
}

/** 横线太多、竖条装不下时它自己能滚：让高亮的那道留在看得见的地方（不用 scrollIntoView，免得把外层也带着滚） */
function keepVisible(box, el) {
  const top = el.offsetTop - box.offsetTop;
  if (top < box.scrollTop) box.scrollTop = top;
  else if (top + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + el.offsetHeight - box.clientHeight;
}

/** 展开列表时：列表滚到正看到的那条 */
function revealActiveRow() {
  if (compact.matches) return;
  const row = entries[activeIdx]?.row;
  if (row) ui.navPanel.scrollTop = Math.max(0, row.offsetTop - ui.navPanel.clientHeight / 2);
}
