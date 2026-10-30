// 用量汇总：主进程拉各服务器的 /api/usage，含 Agent Loft 和各服务器本机直接使用的桌面端 / CLI。
// 直接使用的记录带 source（desktop / cli / other），桌面端只展示服务端数据。
// 写法、配色照着 web/settings/usage.js，多了「按来源」。

const usagePanel = (() => {
  /** 各项的顺序和颜色跟网页里的一致 */
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
  const AGENT_LABELS = { claude: "Claude Code", codex: "Codex" };
  const SOURCE_LABELS = { desktop: "桌面端", cli: "CLI", other: "其他" };
  /** 通过 Agent Loft 用的和各服务器上直接使用的桌面端 / CLI 分开显示 */
  const agentLabel = (key, hasLocal) => {
    const [agent, source] = key.split("\n");
    const name = AGENT_LABELS[agent] ?? agent;
    if (source) return `${name} ${SOURCE_LABELS[source] ?? source}`;
    return hasLocal ? `${name} · Agent Loft` : name;
  };

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

  function pct(n, total) {
    const p = (n / total) * 100;
    return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
  }

  function tile(label, value, title) {
    return h("div", { class: "us-tile", title }, h("span", {}, label), h("b", {}, value));
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
        { class: "us-bars", style: { gridTemplateColumns: `repeat(${n},1fr)` } },
        period.buckets.map((b) => {
          const t = byKey.get(b.key);
          const tip = t ? `${b.label}　${exact(t.tokens)} tokens${t.cost ? `　约 ${fmtCost(t.cost)}` : ""}` : `${b.label}　没有用量`;
          return h(
            "div",
            { class: `us-col${b.key > today ? " future" : ""}`, title: tip },
            t ? h("i", { style: { height: `${Math.max(2, (t.tokens / max) * 100)}%` } }) : null,
          );
        }),
      ),
      h(
        "div",
        { class: "us-axis", style: { gridTemplateColumns: `repeat(${n},1fr)` } },
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
          h("span", { class: "us-meter", "aria-hidden": "true" }, h("i", { style: { width: `${(n / tokens) * 100}%` } })),
          h("span", { class: "us-num" }, fmtCount(n)),
          h("span", { class: "us-cost" }, g.costUsd ? fmtCost(g.costUsd) : "—"),
        );
      }),
    );
  }

  let unit = "month";
  let anchor = new Date();
  let box = null;
  /** 连着翻页时只认最后一次请求的结果 */
  let seq = 0;

  /** 打开面板：每次打开都回到本月、重新拉数据 */
  function build(panel) {
    unit = "month";
    anchor = new Date();
    box = h("div", { class: "panel-inner usage-stats" });
    panel.replaceChildren(box);
    void render();
  }

  async function render() {
    const my = ++seq;
    const period = periodOf(unit, anchor);
    const isCurrent = period.to >= ymd(new Date());
    const go = (next) => {
      anchor = next;
      void render();
    };
    const seg = h(
      "div",
      { class: "pick" },
      UNITS.map(([u, label]) =>
        h(
          "button",
          {
            class: u === unit ? "on" : "",
            "aria-pressed": String(u === unit),
            onclick: () => {
              if (u === unit) return;
              unit = u;
              go(new Date());
            },
          },
          label,
        ),
      ),
    );
    const nav = h(
      "div",
      { class: "us-nav" },
      h("button", { class: "btn icon-btn", "aria-label": "上一个", onclick: () => go(shift(unit, anchor, -1)) }, "‹"),
      h("span", { class: "us-title" }, period.title),
      h("button", { class: "btn icon-btn", "aria-label": "下一个", disabled: isCurrent, onclick: () => go(shift(unit, anchor, 1)) }, "›"),
      isCurrent ? null : h("button", { class: "btn", onclick: () => go(new Date()) }, unit === "day" ? "今天" : unit === "month" ? "本月" : "今年"),
      h("button", { class: "btn", onclick: () => void render() }, "刷新"),
    );
    const head = [
      h("h1", {}, "用量汇总"),
      h("p", { class: "muted" }, `已添加的 ${state.servers.length} 台服务器的 Token 和费用合计，包含各服务器本机的 Claude Code、Codex 桌面端和 CLI 用量（仅管理员可见）`),
      h("div", { class: "us-head" }, seg, nav),
    ];
    fill(box, head, h("div", { class: "us-loading" }, h("div", { class: "spinner-lg" })));

    let results;
    try {
      results = await call("usage", period.from, period.to);
    } catch (err) {
      if (my !== seq) return;
      fill(box, head, h("p", { class: "error-text" }, errText(err)));
      return;
    }
    if (my !== seq || !box?.isConnected) return;

    const nameOf = (id) => {
      const s = state.servers.find((x) => x.id === id);
      return s ? `${s.icon ? `${s.icon} ` : ""}${s.name}` : "已移除的服务器";
    };
    const ok = results.filter((r) => r.rows);
    const rows = ok.flatMap((r) => r.rows.map((row) => ({ ...row, server: r.id })));
    const skipped = results.filter((r) => !r.rows);
    const outdated = ok.filter((r) => r.admin && !r.localUsageIncluded);
    const total = sum(rows);
    const tokens = tokensOf(total);
    const estimated = rows.reduce((n, r) => n + (r.estimated ? r.costUsd : 0), 0);
    const unpriced = rows.reduce((n, r) => n + (r.costUsd ? 0 : tokensOf(r)), 0);

    const skippedNote = skipped.length
      ? h(
          "p",
          { class: "hint us-skipped" },
          "没算进去：",
          skipped.map((r) => `${nameOf(r.id)}（${r.error ?? STATUS_TEXT[r.status] ?? r.status}）`).join("、"),
        )
      : null;
    const note = h(
      "p",
      { class: "hint" },
      "金额都是按 API 价格算的参考值，订阅用户实际不按这个扣费：Agent Loft 的 Claude 用它自己报的费用；Codex 和直接用的 Claude Code 按模型单价 × Token 估算。各服务器按自己的时区记日期。",
      " 各服务器读取运行服务的系统用户下 Claude Code、Codex 的会话记录，Agent Loft 跑的会话不重复算；桌面端本机如需统计，也要添加本机服务端。",
      outdated.length ? ` ${outdated.map((r) => nameOf(r.id)).join("、")} 的服务端版本较旧，尚未包含桌面端 / CLI 用量，请升级服务端。` : "",
      unpriced ? ` 有 ${fmtCount(unpriced)} Token 认不出模型单价，没算进金额。` : "",
    );
    if (!tokens) {
      fill(box, head, skippedNote, h("div", { class: "muted us-empty" }, ok.length ? `${period.title}没有用量记录` : "没有能统计的服务器"), note);
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
        total.costUsd ? `$${total.costUsd.toFixed(4)}${estimated ? `，其中按单价估算 $${estimated.toFixed(4)}` : ""}` : "这段时间没有能算金额的用量",
      ),
      unit === "day"
        ? tile("输出", fmtCount(total.output), `${exact(total.output)} tokens`)
        : tile("日均 Token", fmtCount(Math.round(tokens / days)), `有用量的 ${days} 天平均`),
    );

    const parts = PARTS.map((p) => ({ ...p, n: total[p.key] })).filter((p) => p.n > 0);
    const composition = h(
      "div",
      { class: "usage" },
      h("div", { class: "usage-bar", "aria-hidden": "true" }, parts.map((p) => h("i", { class: p.cls, style: { flexGrow: p.n } }))),
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

    const hasLocal = rows.some((r) => r.source);
    const byServer = groupBy(rows, (r) => r.server).map((g) => ({ ...g, label: nameOf(g.key) }));
    const byAgent = groupBy(rows, (r) => (r.source ? `${r.agent}\n${r.source}` : r.agent)).map((g) => ({
      ...g,
      label: agentLabel(g.key, hasLocal),
    }));
    const byModel = groupBy(rows, (r) => r.model ?? "").map((g) => ({ ...g, label: g.key || "未记录模型" }));
    // 用户是各服务器自己的，同名也不一定是同一个人：分开算，多台时名字后面带上服务器
    const users = new Map(ok.filter((r) => r.admin).map((r) => [r.id, r.users]));
    const multi = new Set(rows.filter((r) => users.has(r.server)).map((r) => r.server)).size > 1;
    const byUser = groupBy(
      rows.filter((r) => users.has(r.server) && !r.source),
      (r) => `${r.server}\n${r.owner ?? ""}`,
    ).map((g) => {
      const [sid, owner] = g.key.split("\n");
      const name = owner ? (users.get(sid)[owner] ?? "已删除的用户") : "未归属（飞书等）";
      return { ...g, owner, label: multi ? `${name} · ${nameOf(sid)}` : name };
    });
    const section = (title, ...body) => [h("h2", {}, title), h("div", { class: "card us-card" }, body)];

    fill(
      box,
      head,
      skippedNote,
      tiles,
      period.buckets ? h("div", { class: "card us-card" }, trend(period, rows)) : null,
      section("构成", composition),
      byServer.length > 1 ? section("按来源", breakdown(byServer, tokens)) : null,
      section("按 Agent", breakdown(byAgent, tokens)),
      section("按模型", breakdown(byModel, tokens)),
      byUser.length > 1 || (byUser.length === 1 && byUser[0].owner) ? section("按用户", breakdown(byUser, tokens)) : null,
      note,
    );
  }

  return { build };
})();
