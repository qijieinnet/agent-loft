// ---------- 小工具 ----------

export const $app = document.getElementById("app");
export const isTouch = matchMedia("(pointer: coarse)").matches;

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** replaceChildren 会把 null 变成字面量 "null"，统一过滤掉 */
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
}

export const ICON = {
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  compose: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M18.4 2.6a2 2 0 0 1 2.9 2.9L12.5 14.3 9 15l.7-3.5Z"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>',
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.4 11.6-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>',
  fork: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10"/><path d="M18 9c0 5-6 4-11.2 8.6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.2h7.4A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z"/><path d="M3 10h18"/></svg>',
  folderOpen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17.5V7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.2h6.4A2.5 2.5 0 0 1 20 9.7V11"/><path d="M3 17.5 5.6 12a2 2 0 0 1 1.8-1.1h13a1 1 0 0 1 .9 1.4l-2.4 6.2a2.2 2.2 0 0 1-2 1.5H5.5A2.5 2.5 0 0 1 3 17.5Z"/></svg>',
  laptop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/></svg>',
  logo: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 8.5a8 8 0 0 1 13.2 0 8 8 0 0 1 9 9.4 8 8 0 0 1 0 12.2 8 8 0 0 1-9 9.4 8 8 0 0 1-13.2 0 8 8 0 0 1-9-9.4 8 8 0 0 1 0-12.2 8 8 0 0 1 9-9.4Z"/><path d="m17 18 5 5-5 5M25 30h7"/></svg>',
  feishu:
    '<svg viewBox="2 4 44 40"><path fill="#00D6B9" d="M11.6 7H27.6C30.9 9.9 32.8 14.7 33.6 17C30.9 18.3 29 20.6 27 24C22.6 16.4 15.6 11 11.6 7Z"/><path fill="#133C9A" d="M17 29C21 29 25 26.9 28 23.4C36 14 41.4 16.8 44 18C38.5 21 40.5 29.6 33 36C27.5 34.8 21.8 32.2 17 29Z"/><path fill="#3370FF" d="M4 16.2C7.2 20.8 12.4 26 17.4 29.4C23 33.2 28.6 35.7 34 35.2C28.9 39.8 23.8 41 19 41C12.5 41 6.9 37.8 4 35.4Z"/></svg>',
};

/** Claude 的放射状标志：长短不一的圆头射线 */
ICON.claude = (() => {
  const lens = [10, 8.2, 9.4, 7.6, 10.4, 8.4, 9.2, 7.8, 10, 8.6, 9.6, 7.4];
  const rays = lens
    .map((len, i) => {
      const a = (i / lens.length) * Math.PI * 2 + 0.12;
      const x = (r) => (12 + Math.cos(a) * r).toFixed(2);
      const y = (r) => (12 + Math.sin(a) * r).toFixed(2);
      return `M${x(1.6)} ${y(1.6)}L${x(len)} ${y(len)}`;
    })
    .join("");
  return `<svg viewBox="0 0 24 24" fill="none" stroke="#D97757" stroke-width="2.3" stroke-linecap="round"><path d="${rays}"/></svg>`;
})();
ICON.codex = ICON.logo;

/**
 * 星星加载动画（回复末尾、打开会话时用）。开屏那个带台面的完整 logo 动画直接写在 index.html 里。
 * 每个实例的渐变 id 唯一，避免页面里有隐藏的同 id 渐变时画不出来。
 * 回复流式输出时整条消息会反复重建，动画按全局时钟设负的起始延迟，重建后接着播、不会一抖一抖地重来。
 */
let loaderSeq = 0;

/** 只有 logo 中间那颗大星，一边旋转一边放大缩小 */
const STARS_MS = 1800;
export function starsLoader(cls = "") {
  const id = `loft-g${++loaderSeq}`;
  const el = h("span", {
    class: `loft-stars${cls ? ` ${cls}` : ""}`,
    role: "img",
    "aria-label": "回复中",
    html: `<svg viewBox="180 82 152 152" aria-hidden="true"><defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="180" y1="82" x2="332" y2="234"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#06b6d4"/></linearGradient></defs><path d="M256 82C268.92 145.08 268.92 145.08 332 158C268.92 170.92 268.92 170.92 256 234C243.08 170.92 243.08 170.92 180 158C243.08 145.08 243.08 145.08 256 82Z" fill="url(#${id})"/></svg>`,
  });
  el.style.setProperty("--t", `${-(performance.now() % STARS_MS).toFixed(0)}ms`);
  return el;
}

export function agentIcon(id, cls = "agent-icon") {
  return h("span", { class: cls, html: ICON[id] ?? ICON.laptop });
}

export function icon(name) {
  return h("span", { html: ICON[name], style: { display: "inline-grid" } });
}

export function toast(text, ms = 2600) {
  const el = h("div", { class: "toast" }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}
