import { fill, h } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { S } from "../state.js";

// ---------- 用量：按日 / 月 / 年统计 token 和费用（数据见 src/core/usage.ts 按天的账） ----------

/** 各项的顺序和颜色跟「更多」菜单里本会话的用量一致 */
const PARTS = [
  { key: "input", label: "输入", cls: "u-input" },
  { key: "cacheWrite", label: "缓存写入", cls: "u-cwrite" },
  { key: "cacheRead", label: "缓存读取", cls: "u-cread" },
  { key: "output", label: "输出", cls: "u-output" },
];

const UNITS = [
  ["day", "按日"],
  ["month", "按月"],
  ["year", "按年"],
];

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 1234 → 1.2k，1234567 → 1.23M */
function fmtCount(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
  return String(n);
}
const exact = (n) => n.toLocaleString("en-US");
const fmtCost = (n) => `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`;
const tokensOf = (r) => r.input + r.cacheRead + r.cacheWrite + r.output;

/** 某个周期的起止（含两头）、标题、趋势图的格子 */
function periodOf(unit, anchor) {
  const y = anchor.getFullYear();
  const m = anchor.getMonth();
  if (unit === "day") {
    const d = ymd(anchor);
    return { from: d, to: d, title: `${y}年${m + 1}月${anchor.getDate()}日`, buckets: null };
  }
  if (unit === "year") {
    const buckets = Array.from({ length: 12 }, (_, i) => ({ key: `${y}-${pad(i + 1)}`, label: `${i + 1}月` }));
    return { from: `${y}-01-01`, to: `${y}-12-31`, title: `${y}年`, buckets, slice: 7 };
  }
  const days = new Date(y, m + 1, 0).getDate();
  const buckets = Array.from({ length: days }, (_, i) => ({ key: `${y}-${pad(m + 1)}-${pad(i + 1)}`, label: `${m + 1}月${i + 1}日` }));
  return { from: buckets[0].key, to: buckets[days - 1].key, title: `${y}年${m + 1}月`, buckets, slice: 10 };
}

function shift(unit, anchor, step) {
  const d = new Date(anchor);
  if (unit === "day") d.setDate(d.getDate() + step);
  else if (unit === "month") d.setMonth(d.getMonth() + step, 1);
  else d.setFullYear(d.getFullYear() + step, 0, 1);
  return d;
}

function sum(rows) {
  const t = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0 };
  for (const r of rows) {
    for (const k of Object.keys(t)) t[k] += r[k] ?? 0;
  }
  return t;
}

/** 按 keyOf 分组合计，Token 多的在前 */
function groupBy(rows, keyOf) {
  const m = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m].map(([k, list]) => ({ key: k, ...sum(list) })).sort((a, b) => tokensOf(b) - tokensOf(a));
}

export async function usageTab(panel) {
  let unit = "month";
  let anchor = new Date();
  const box = h("div", { class: "section usage-stats" });
  fill(panel, box);

  const render = async () => {
    const period = periodOf(unit, anchor);
    const isCurrent = period.to >= ymd(new Date());
    const seg = h(
      "div",
      { class: "seg" },
      UNITS.map(([u, label]) =>
        h(
          "button",
          {
            class: u === unit ? "on" : "",
            onclick: () => {
              if (u === unit) return;
              unit = u;
              anchor = new Date();
              void render();
            },
          },
          label,
        ),
      ),
    );
    const nav = h(
      "div",
      { class: "us-nav" },
      h("button", { class: "btn small", "aria-label": "上一个", onclick: () => ((anchor = shift(unit, anchor, -1)), void render()) }, "‹"),
      h("span", { class: "us-title" }, period.title),
      h(
        "button",
        { class: "btn small", "aria-label": "下一个", disabled: isCurrent, onclick: () => ((anchor = shift(unit, anchor, 1)), void render()) },
        "›",
      ),
      isCurrent ? null : h("button", { class: "btn small", onclick: () => ((anchor = new Date()), void render()) }, unit === "day" ? "今天" : unit === "month" ? "本月" : "今年"),
    );
    const head = h("div", { class: "us-head" }, h("h4", {}, "Token 与费用"), seg, nav);
    fill(box, head, h("span", { class: "spinner" }));

    let data;
    try {
      data = await api(`/api/usage?from=${period.from}&to=${period.to}`);
    } catch (err) {
      fill(box, head, h("div", { class: "error-text" }, err.message));
      return;
    }
    const rows = data.rows;
    const total = sum(rows);
    const tokens = tokensOf(total);
    // 估算的金额、没能算金额的 Token（认不出模型，或者是升级前没记模型的 Codex 用量）
    const estimated = rows.reduce((n, r) => n + (r.estimated ? r.costUsd : 0), 0);
    const unpriced = rows.reduce((n, r) => n + (r.costUsd ? 0 : tokensOf(r)), 0);
    const note = h(
      "div",
      { class: "muted" },
      "金额都是按 API 价格算的参考值，订阅用户实际不按这个扣费：Claude 用它自己报的费用；Codex 不报费用，按模型单价（LiteLLM 公开价格表，每天更新）× Token 估算，不含长上下文加价。从这个版本开始记录，之前的用量没有日期，不计入。",
      unpriced ? ` 有 ${fmtCount(unpriced)} Token 认不出模型单价，没算进金额。` : "",
    );
    if (!tokens) {
      fill(box, head, h("div", { class: "muted us-empty" }, `${period.title}没有用量记录`), note);
      return;
    }

    const days = unit === "day" ? 1 : new Set(rows.map((r) => r.day)).size;
    const tiles = h(
      "div",
      { class: "us-tiles" },
      tile("Token 合计", fmtCount(tokens), `${exact(tokens)} tokens`),
      tile(
        "费用（约）",
        total.costUsd ? fmtCost(total.costUsd) : "—",
        total.costUsd
          ? `$${total.costUsd.toFixed(4)}${estimated ? `，其中按单价估算 $${estimated.toFixed(4)}` : ""}`
          : "这段时间没有能算金额的用量",
      ),
      unit === "day"
        ? tile("输出", fmtCount(total.output), `${exact(total.output)} tokens`)
        : tile("日均 Token", fmtCount(Math.round(tokens / days)), `有用量的 ${days} 天平均`),
    );

    const parts = PARTS.map((p) => ({ ...p, n: total[p.key] })).filter((p) => p.n > 0);
    const composition = h(
      "div",
      { class: "usage" },
      h("div", { class: "usage-bar", "aria-hidden": "true" }, parts.map((p) => h("i", { class: p.cls, style: `flex-grow:${p.n}` }))),
      parts.map((p) =>
        h(
          "div",
          { class: "usage-row", title: `${exact(p.n)} tokens` },
          h("span", { class: `usage-dot ${p.cls}` }),
          h("span", { class: "usage-name" }, p.label, p.key === "output" && total.reasoning ? h("small", {}, `含推理 ${fmtCount(total.reasoning)}`) : null),
          h("span", { class: "usage-num" }, fmtCount(p.n)),
          h("span", { class: "usage-pct" }, pct(p.n, tokens)),
        ),
      ),
    );

    const agentName = (id) => S.agents.find((a) => a.id === id)?.label ?? id;
    const byAgent = groupBy(rows, (r) => r.agent).map((g) => ({ ...g, label: agentName(g.key) }));
    const byModel = groupBy(rows, (r) => r.model ?? "").map((g) => ({ ...g, label: g.key || "未记录模型" }));
    const byUser = data.admin
      ? groupBy(rows, (r) => r.owner ?? "").map((g) => ({ ...g, label: g.key ? data.users[g.key] : "未归属（飞书等）" }))
      : [];

    fill(
      box,
      head,
      tiles,
      period.buckets ? trend(period, rows) : null,
      h("h5", {}, "构成"),
      composition,
      h("h5", {}, "按 Agent"),
      breakdown(byAgent, tokens),
      h("h5", {}, "按模型"),
      breakdown(byModel, tokens),
      byUser.length > 1 || (byUser.length === 1 && byUser[0].key) ? [h("h5", {}, "按用户"), breakdown(byUser, tokens)] : null,
      note,
    );
  };
  await render();
}

function tile(label, value, title) {
  return h("div", { class: "us-tile", title }, h("span", {}, label), h("b", {}, value));
}

function pct(n, total) {
  const p = (n / total) * 100;
  return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
}

/** 趋势：月视图每天一根，年视图每月一根。悬停看具体数字 */
function trend(period, rows) {
  const byKey = new Map();
  for (const r of rows) {
    const k = r.day.slice(0, period.slice);
    const t = byKey.get(k) ?? { tokens: 0, cost: 0 };
    t.tokens += tokensOf(r);
    t.cost += r.costUsd ?? 0;
    byKey.set(k, t);
  }
  const max = Math.max(...[...byKey.values()].map((t) => t.tokens), 1);
  const today = ymd(new Date()).slice(0, period.slice);
  const n = period.buckets.length;
  return h(
    "div",
    { class: "us-trend", role: "img", "aria-label": `${period.title}每${period.slice === 7 ? "月" : "天"}的 Token 用量` },
    h(
      "div",
      { class: "us-bars", style: `grid-template-columns:repeat(${n},1fr)` },
      period.buckets.map((b) => {
        const t = byKey.get(b.key);
        const tip = t ? `${b.label}　${exact(t.tokens)} tokens${t.cost ? `　约 ${fmtCost(t.cost)}` : ""}` : `${b.label}　没有用量`;
        return h(
          "div",
          { class: `us-col${b.key > today ? " future" : ""}`, title: tip },
          t ? h("i", { style: `height:${Math.max(2, (t.tokens / max) * 100)}%` }) : null,
        );
      }),
    ),
    h(
      "div",
      { class: "us-axis", style: `grid-template-columns:repeat(${n},1fr)` },
      period.buckets.map((b, i) => {
        // 月视图只标 1、5、10…号，免得挤
        const show = period.slice === 7 || i === 0 || (i + 1) % 5 === 0;
        return h("span", {}, show ? String(i + 1) : "");
      }),
    ),
    h("div", { class: "us-max" }, `最高 ${fmtCount(max)}`),
  );
}

function breakdown(groups, tokens) {
  return h(
    "div",
    { class: "us-list" },
    groups.map((g) => {
      const n = tokensOf(g);
      return h(
        "div",
        { class: "us-item", title: `${exact(n)} tokens` },
        h("span", { class: "us-name" }, g.label),
        h("span", { class: "us-meter", "aria-hidden": "true" }, h("i", { style: `width:${(n / tokens) * 100}%` })),
        h("span", { class: "us-num" }, fmtCount(n)),
        h("span", { class: "us-cost" }, g.costUsd ? fmtCost(g.costUsd) : "—"),
      );
    }),
  );
}
