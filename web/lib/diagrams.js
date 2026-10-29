import { h } from "./dom.js";

// 回复里的 ```chart（专家用一小段 JSON 描述的曲线图、柱状图、饼图）和 ```mermaid（流程图、时序图…）。
//
// - chart 只认数据，不认 ECharts 的原始配置：模型不容易写错，也不会带进能执行的东西（tooltip 的 formatter 能写 HTML）。
//   格式和提示词里教给模型的一致（src/core/expert-prompt.ts 的 RICH_REPLY_LINES），飞书那边降级成表格（src/core/charts.ts）。
// - mermaid 画成 SVG 后放进 <img>：图片里的 SVG 不会执行脚本，模型写坏了也伤不到页面。
// - ECharts、mermaid 都很大，滚到附近了才加载、才画；跟着系统的深浅色重画。

const MAX_SERIES = 8;
const MAX_POINTS = 5000;
const TYPES = new Set(["line", "area", "bar", "pie", "scatter"]);

/** 分类色：固定顺序，深色模式用各自那一档（都过了色盲区分度校验） */
const PALETTE = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};
const CHROME = {
  light: { grid: "#e1e0d9", axis: "#c3c2b7", muted: "#898781", ring: "#ffffff" },
  dark: { grid: "#2c2c2a", axis: "#383835", muted: "#898781", ring: "#212121" },
};

const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const mode = () => (darkQuery.matches ? "dark" : "light");

/** 代码块是不是要画成图：返回语言，不是就 null */
export function diagramLang(code) {
  const lang = /language-([\w+-]+)/.exec(code.className)?.[1]?.toLowerCase();
  return lang === "chart" || lang === "mermaid" ? lang : null;
}

/**
 * 把 <pre><code class="language-chart|mermaid"> 换成图。
 * final = false：还在输出、内容不全，先放个占位，定下来了再画。
 */
export function mountDiagram(pre, code, lang, final) {
  const source = code.textContent;
  if (!final) {
    pre.replaceWith(h("div", { class: "diagram pending" }, h("div", { class: "diagram-wait" }, lang === "chart" ? "图表生成中…" : "图生成中…")));
    return;
  }
  const body = h("div", { class: "diagram-body" });
  const box = h("div", { class: `diagram ${lang}` });
  box._lang = lang;
  box._source = source;
  box._body = body;
  pre.replaceWith(box);
  // 原来的代码块（带复制按钮）留着，点「源码」看
  pre.classList.add("diagram-src");
  pre.hidden = true;
  const views = [];
  if (lang === "chart") {
    const spec = parseChart(source);
    if (typeof spec === "string") return fail(box, pre, spec);
    box._spec = spec;
    if (spec.title) box.append(h("div", { class: "diagram-title" }, spec.title));
    body.style.height = `${spec.height}px`;
    const table = chartTable(spec);
    table.hidden = true;
    views.push(["表格", table]);
    box.append(body, table);
  } else box.append(body);
  views.push(["源码", pre]);
  box.append(
    pre,
    h(
      "div",
      { class: "diagram-actions" },
      views.map(([label, el]) => {
        const btn = h("button", { class: "diagram-btn" }, label);
        btn.onclick = () => {
          el.hidden = !el.hidden;
          btn.classList.toggle("on", !el.hidden);
        };
        return btn;
      }),
    ),
  );
  lazyRender.observe(box);
}

function fail(box, pre, message) {
  pre.hidden = false;
  box.classList.add("broken");
  box.append(h("div", { class: "diagram-error" }, message), pre);
}

const lazyRender = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      lazyRender.unobserve(e.target);
      void draw(e.target);
    }
  },
  { rootMargin: "800px 0px", scrollMargin: "800px 0px" },
);

/** 块被重画掉时调：还没画的别再画 */
export function unmountDiagrams(root) {
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  for (const box of [...(root.matches(".diagram") ? [root] : []), ...root.querySelectorAll(".diagram")]) {
    lazyRender.unobserve(box);
    box._chart?.dispose();
  }
}

async function draw(box) {
  box.dataset.drawn = "1";
  try {
    if (box._lang === "chart") await drawChart(box);
    else await drawMermaid(box);
  } catch (err) {
    box._body.replaceChildren(h("div", { class: "diagram-error" }, `画不出来：${err?.message ?? err}`));
    const src = box.querySelector(".diagram-src");
    if (src) src.hidden = false;
  }
}

// 换了深浅色：画好的都重画一遍
darkQuery.addEventListener("change", () => {
  for (const box of document.querySelectorAll(".diagram[data-drawn]")) void draw(box);
});

const scripts = {};
function loadScript(src, name) {
  return (scripts[src] ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => (window[name] ? resolve(window[name]) : reject(new Error(`${name} 没加载上`)));
    s.onerror = () => {
      delete scripts[src];
      reject(new Error(`${name} 加载失败`));
    };
    document.head.append(s);
  }));
}

// ---------- chart ----------

const num = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : NaN);

/** 校验并整理 chart 的 JSON；不对就返回一句给人看的原因 */
export function parseChart(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return "图表的 JSON 写得不对，显示原文";
  }
  if (!raw || typeof raw !== "object") return "图表的内容不是一个对象";
  const type = String(raw.type ?? "line");
  if (!TYPES.has(type)) return `不认识的图表类型「${type}」`;
  const list = Array.isArray(raw.series) ? raw.series : raw.data ? [{ data: raw.data }] : [];
  if (!list.length) return "图表没有数据（series）";
  if (list.length > MAX_SERIES) return `一张图最多 ${MAX_SERIES} 组数据`;
  const x = Array.isArray(raw.x) ? raw.x.map((v) => String(v ?? "")) : undefined;
  const series = [];
  let points = 0;
  for (const [i, s] of list.entries()) {
    const data = Array.isArray(s?.data) ? s.data : [];
    points += data.length;
    let values;
    if (type === "scatter") {
      values = data.map((p) => (Array.isArray(p) ? [num(p[0]), num(p[1])] : [NaN, NaN]));
      if (values.some(([a, b]) => Number.isNaN(a) || Number.isNaN(b))) return "散点图的每个点要写成 [x, y]";
    } else if (type === "pie") {
      values = data.map((p, j) =>
        p && typeof p === "object" && !Array.isArray(p) ? { name: String(p.name ?? ""), value: num(p.value) } : { name: x?.[j] ?? `#${j + 1}`, value: num(p) },
      );
      if (values.some((p) => p.value === null || Number.isNaN(p.value))) return "饼图的每一块都要有数值";
      if (values.length > MAX_SERIES) return `饼图最多 ${MAX_SERIES} 块，小的合并成「其他」`;
    } else {
      values = data.map(num);
      if (values.some(Number.isNaN)) return `第 ${i + 1} 组数据里有不是数字的值`;
    }
    series.push({ name: String(s?.name ?? (list.length > 1 ? `系列 ${i + 1}` : raw.title ?? "")), data: values });
  }
  if (points > MAX_POINTS) return `数据点太多（最多 ${MAX_POINTS} 个）`;
  if (type === "pie" && series.length > 1) return "饼图只能有一组数据";
  const longest = Math.max(...series.map((s) => s.data.length));
  if (!["pie", "scatter"].includes(type) && x && x.length < longest) return "x 的个数比数据少";
  const height = Math.min(Math.max(Number(raw.height) || (type === "pie" ? 280 : 300), 180), 600);
  const str = (v) => (v === undefined || v === null ? "" : String(v).slice(0, 200));
  return {
    type,
    title: str(raw.title),
    x: x ?? (["pie", "scatter"].includes(type) ? undefined : Array.from({ length: longest }, (_, i) => String(i + 1))),
    series,
    unit: str(raw.unit),
    xName: str(raw.xName),
    stack: Boolean(raw.stack),
    horizontal: type === "bar" && Boolean(raw.horizontal),
    height,
  };
}

function chartOption(spec) {
  const m = mode();
  const colors = PALETTE[m];
  const c = CHROME[m];
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue("--fg-soft").trim() || "#5d5d5d";
  const font = css.getPropertyValue("--font").trim() || "system-ui, sans-serif";
  const text = { color: ink, fontFamily: font, fontSize: 12 };
  const multi = spec.series.length > 1;
  const base = {
    color: colors,
    backgroundColor: "transparent",
    textStyle: text,
    animationDuration: 400,
    legend: multi || spec.type === "pie" ? { top: 0, left: 0, icon: "roundRect", itemWidth: 12, itemHeight: 12, textStyle: text } : undefined,
    tooltip: {
      confine: true,
      backgroundColor: css.getPropertyValue("--bg").trim() || "#fff",
      borderColor: css.getPropertyValue("--border").trim() || "#e5e5e5",
      textStyle: { ...text, color: css.getPropertyValue("--fg").trim() || "#0d0d0d" },
      valueFormatter: (v) => (v === null || v === undefined ? "—" : `${Number(v).toLocaleString()}${spec.unit ? ` ${spec.unit}` : ""}`),
    },
  };
  if (spec.type === "pie") {
    return {
      ...base,
      tooltip: { ...base.tooltip, trigger: "item" },
      series: [
        {
          type: "pie",
          name: spec.series[0].name,
          radius: ["45%", "70%"],
          center: ["50%", "55%"],
          itemStyle: { borderColor: c.ring, borderWidth: 2, borderRadius: 4 },
          label: { color: ink, formatter: "{b}  {d}%" },
          data: spec.series[0].data,
        },
      ],
    };
  }
  const axis = (type, name) => ({
    type,
    name,
    nameTextStyle: { color: c.muted },
    axisLine: { lineStyle: { color: c.axis } },
    axisTick: { show: false },
    axisLabel: { color: c.muted },
    splitLine: { show: type === "value", lineStyle: { color: c.grid } },
    scale: type === "value" && spec.type === "scatter",
  });
  const category = axis("category", spec.xName);
  category.data = spec.x;
  const value = axis("value", spec.unit);
  // 上面先放图例，再放 y 轴的单位，别叠在一起
  const grid = { left: 8, right: 16, top: (multi ? 28 : 0) + (spec.unit && !spec.horizontal ? 28 : 12), bottom: 8, containLabel: true };
  const series = spec.series.map((s) => {
    const one = { name: s.name, data: s.data, emphasis: { focus: "series" } };
    if (spec.type === "scatter") return { ...one, type: "scatter", symbolSize: 8, itemStyle: { borderColor: c.ring, borderWidth: 1 } };
    if (spec.type === "bar") {
      return {
        ...one,
        type: "bar",
        stack: spec.stack ? "total" : undefined,
        barMaxWidth: 28,
        itemStyle: { borderRadius: spec.stack ? 0 : spec.horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0], borderColor: c.ring, borderWidth: spec.stack ? 1 : 0 },
      };
    }
    const few = s.data.length <= 40;
    return {
      ...one,
      type: "line",
      stack: spec.stack ? "total" : undefined,
      showSymbol: few,
      symbol: "circle",
      symbolSize: 8,
      lineStyle: { width: 2 },
      itemStyle: { borderColor: c.ring, borderWidth: 2 },
      areaStyle: spec.type === "area" ? { opacity: spec.stack ? 0.6 : 0.15 } : undefined,
      connectNulls: false,
    };
  });
  if (spec.type === "scatter") {
    return { ...base, grid, tooltip: { ...base.tooltip, trigger: "item", valueFormatter: undefined }, xAxis: axis("value", spec.xName), yAxis: value, series };
  }
  const pointer = spec.type === "bar" ? { type: "shadow", shadowStyle: { color: "rgba(127,127,127,0.12)" } } : { type: "line", lineStyle: { color: c.axis } };
  return {
    ...base,
    grid,
    tooltip: { ...base.tooltip, trigger: "axis", axisPointer: pointer },
    xAxis: spec.horizontal ? value : { ...category, boundaryGap: spec.type === "bar" },
    yAxis: spec.horizontal ? { ...category, inverse: true } : value,
    series,
  };
}

async function drawChart(box) {
  const echarts = await loadScript("/vendor/echarts.js", "echarts");
  box._chart?.dispose();
  const chart = echarts.init(box._body, null, { renderer: "svg" });
  box._chart = chart;
  chart.setOption(chartOption(box._spec));
  // 跟着宽度变；块被删掉（不在页面上了）就释放
  box._resize?.disconnect();
  box._resize = new ResizeObserver(() => {
    if (!box.isConnected) {
      chart.dispose();
      box._resize.disconnect();
    } else chart.resize();
  });
  box._resize.observe(box._body);
}

/** 图的数据换成表格，给读屏和想看具体数字的人 */
function chartTable(spec) {
  const fmt = (v) => (v === null ? "—" : Number(v).toLocaleString());
  let head;
  let rows;
  if (spec.type === "pie") {
    head = ["", spec.series[0].name || "数值"];
    rows = spec.series[0].data.map((p) => [p.name, fmt(p.value)]);
  } else if (spec.type === "scatter") {
    head = ["", spec.xName || "x", spec.unit || "y"];
    rows = spec.series.flatMap((s) => s.data.map(([a, b]) => [s.name, fmt(a), fmt(b)]));
  } else {
    head = [spec.xName, ...spec.series.map((s) => s.name || "数值")];
    rows = spec.x.map((label, i) => [label, ...spec.series.map((s) => fmt(s.data[i] ?? null))]);
  }
  return h(
    "div",
    { class: "diagram-table" },
    h("table", {}, h("thead", {}, h("tr", {}, head.map((c) => h("th", {}, c)))), h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c) => h("td", {}, c)))))),
  );
}

// ---------- mermaid ----------

let mermaidQueue = Promise.resolve();
let mermaidSeq = 0;
let mermaidTheme;

function drawMermaid(box) {
  // mermaid 同一时间只能画一张（共用一个全局状态），排队
  const job = mermaidQueue.then(async () => {
    const mermaid = await loadScript("/vendor/mermaid.js", "mermaid");
    const theme = mode() === "dark" ? "dark" : "default";
    if (mermaidTheme !== theme) {
      const font = getComputedStyle(document.documentElement).getPropertyValue("--font").trim();
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme, fontFamily: font || undefined, htmlLabels: false, flowchart: { htmlLabels: false } });
      mermaidTheme = theme;
    }
    const id = `aloft-mermaid-${++mermaidSeq}`;
    let svg;
    try {
      ({ svg } = await mermaid.render(id, box._source));
    } catch (err) {
      throw new Error(String(err?.message ?? err).split("\n")[0] || "mermaid 语法不对");
    } finally {
      // 出错时 mermaid 会在 body 里留下一个画错的临时元素
      document.getElementById(`d${id}`)?.remove();
      document.getElementById(id)?.remove();
    }
    const img = svgImage(svg);
    box._body.replaceChildren(img);
  });
  mermaidQueue = job.catch(() => {});
  return job;
}

/** SVG 放进 <img>：按 viewBox 给出原始大小，窄屏上缩小 */
function svgImage(svg) {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  const vb = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  const width = vb.length === 4 && vb[2] > 0 ? Math.ceil(vb[2]) : undefined;
  const height = vb.length === 4 && vb[3] > 0 ? Math.ceil(vb[3]) : undefined;
  if (width && height) {
    root.setAttribute("width", String(width));
    root.setAttribute("height", String(height));
  }
  root.removeAttribute("style");
  const data = new XMLSerializer().serializeToString(root);
  const img = h("img", { class: "diagram-svg", alt: "图", src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data)}` });
  if (width) img.style.width = `${width}px`;
  return img;
}
