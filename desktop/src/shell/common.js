// 侧栏和菜单栏面板共用的小工具（普通脚本，挂在全局上）。

/** 建 DOM：h("div", { class: "x", onclick }, "文字", child) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const STATUS_TEXT = {
  online: "在线",
  login: "需要登录",
  setup: "还没设置密码",
  offline: "连不上",
  access: "需要验证",
  unknown: "连接中…",
};

/** 名字的头一两个字，当服务器图标 */
function initials(name) {
  const text = String(name).trim();
  if (!text) return "?";
  // 中文取一个字；英文取两个单词的首字母，只有一个词就取前两个字母
  if (/^[㐀-鿿]/.test(text)) return text[0];
  const words = text.split(/[\s._-]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : text.slice(0, 2)).toUpperCase();
}

/** 按 id 固定分一个颜色，同一台服务器每次都一样 */
function serverColor(id) {
  const palette = ["#2f7cf6", "#0ea5b7", "#7c5cf2", "#e0672f", "#2b9a5c", "#d23f87", "#b8860b", "#4f6d8f"];
  let n = 0;
  for (const ch of id) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[n % palette.length];
}

function resetText(at) {
  if (!at) return "";
  const d = new Date(at);
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return `${hm} 重置`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm} 重置`;
}

function agoText(at) {
  if (!at) return "";
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  return `${Math.floor(s / 3600)} 小时前`;
}

/** 一个 agent 的额度：每个窗口一行进度条 */
function quotaBlock(q) {
  return h(
    "div",
    { class: "quota" },
    h(
      "div",
      { class: "quota-head" },
      h("span", { class: "agent" }, q.label),
      q.plan ? h("span", { class: "plan" }, q.plan) : null,
      q.reached ? h("span", { class: "reached" }, "已到上限") : null,
    ),
    (q.windows ?? []).map((w) => {
      const pct = Math.max(0, Math.min(100, Math.round(w.percent)));
      const level = pct >= 90 ? "bad" : pct >= 70 ? "warn" : "";
      return h(
        "div",
        { class: "quota-row", title: `${w.label}：已用 ${pct}%${w.resetsAt ? `，${resetText(w.resetsAt)}` : ""}` },
        h("span", { class: "short" }, w.short),
        h("div", { class: `bar ${level}` }, h("i", { style: { width: `${pct}%` } })),
        h("span", { class: "pct" }, `${pct}%`),
      );
    }),
    q.extra ? h("div", { class: "quota-extra muted" }, q.extra) : null,
  );
}

/**
 * 同一个账号登在好几台服务器上时，额度一模一样，只显示一次。
 * 返回 Map：「服务器 id + agent」→ 先出现的那台服务器的名字（重复的才有）。
 */
function duplicateQuotas(servers) {
  const seen = new Map();
  const dup = new Map();
  for (const s of servers) {
    for (const q of s.quotas ?? []) {
      const sig = JSON.stringify([
        q.agent,
        q.plan ?? "",
        (q.windows ?? []).map((w) => [w.short, Math.round(w.percent), Math.round((w.resetsAt ?? 0) / 60000)]),
      ]);
      if (seen.has(sig)) dup.set(`${s.id}:${q.agent}`, seen.get(sig));
      else seen.set(sig, s.name);
    }
  }
  return dup;
}

/** el.replaceChildren，但跳过 null / false（DOM 原生的会把 null 变成文字 "null"） */
function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
}
