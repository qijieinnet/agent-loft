import { h, toast } from "../lib/dom.js";
import { closeMenu, placePopover, showPopover } from "../lib/overlay.js";

export function createMemoOutline(reading) {
  let sections = [], pop;


  function update(body) {
    const used = new Set(), suffixes = new Map();
    const next = [];
    for (const node of body?.querySelectorAll("h1,h2,h3,h4,h5,h6") ?? []) {
      const title = node.textContent.trim();
      if (!title) continue;
      const base = title.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "").replace(/\s+/g, "-") || title;
      let key = base, suffix = suffixes.get(base) || 0;
      while (used.has(key)) key = base + "-" + ++suffix;
      suffixes.set(base, suffix);
      used.add(key);
      next.push({ title, key, node, level: Number(node.tagName[1]) });
    }
    // Keep the open outline usable while collaborators edit paragraphs.
    if (pop && (sections.length !== next.length || next.some((s, i) =>
      s.key !== sections[i].key || s.title !== sections[i].title || s.level !== sections[i].level))) closeMenu();
    sections = next;

  }

  function jump(key) {
    const section = sections.find(s => s.key === key.toLowerCase()) ?? sections.find(s => s.title === key);
    if (!section) { toast("找不到章节「" + key + "」"); return; }
    const { node } = section;
    for (let el = node.parentElement; el && el !== reading; el = el.parentElement) {
      if (el.tagName === "DETAILS") el.open = true;
    }
    reading.scrollTop += node.getBoundingClientRect().top - reading.getBoundingClientRect().top - 16;
    node.tabIndex = -1;
    node.focus({ preventScroll: true });
  }
  function currentSection() {
    const top = reading.getBoundingClientRect().top + 20;
    return sections.findLast(s => s.node.getClientRects().length && s.node.getBoundingClientRect().top <= top);
  }
  function position() {
    const top = reading.scrollTop;
    const section = top > 0 && currentSection();
    if (!section) return { top };
    return { top, section: section.key, offset: reading.getBoundingClientRect().top - section.node.getBoundingClientRect().top };
  }
  function restore(position) {
    const section = sections.find(s => s.key === position.section);
    if (section?.node.getClientRects().length && Number.isFinite(position.offset)) {
      reading.scrollTop += section.node.getBoundingClientRect().top - reading.getBoundingClientRect().top + position.offset;
    } else reading.scrollTop = Number.isFinite(position.top) ? position.top : 0;
  }
  function open(trigger) {
    if (pop) { closeMenu(); return; }
    const current = currentSection();
    const baseLevel = sections.reduce((min, s) => Math.min(min, s.level), 6);
    pop = showPopover(trigger, { place: "below" });
    const nav = h("nav", { "aria-label": "章节大纲" }, sections.map(s =>
      h("button", { type: "button", title: s.title, "aria-current": s === current ? "location" : null,
        style: { paddingInlineStart: (12 + (s.level - baseLevel) * 12) + "px" },
        onclick: () => { closeMenu(); jump(s.key); } }, s.title)));
    pop.classList.add("memo-outline");
    pop.append(h("div", { class: "pop-head" }, "章节大纲"), nav);
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("aim:leave-view", closeMenu);
    pop.onMenuClose = () => {
      document.removeEventListener("aim:leave-view", closeMenu);
      if (pop.contains(document.activeElement)) trigger.focus({ preventScroll: true });
      trigger.setAttribute("aria-expanded", "false");
      pop = null;
    };
    nav.onkeydown = e => {
      const next = e.key === "ArrowDown" ? e.target.nextElementSibling :
        e.key === "ArrowUp" ? e.target.previousElementSibling : null;
      if (next) { e.preventDefault(); next.focus(); }
    };
    placePopover(pop, trigger);
    (nav.querySelector("[aria-current]") || nav.firstElementChild).focus();
  }
  return { open, available: () => sections.length > 1, update, jump, position, restore };
}
