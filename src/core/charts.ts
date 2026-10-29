// 回复里的 ```chart 代码块（格式见 core/expert-prompt.ts 的 RICH_REPLY_LINES，网页上由 web/lib/diagrams.js 画成图）。
// 飞书卡片画不了：换成一张 markdown 表格，数还在。JSON 不对就原样留着。

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*chart[ \t]*\n([\s\S]*?)\n {0,3}\1[ \t]*$/gim;

type Cell = string | number | null | undefined;

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : String(v);
}

function esc(v: Cell): string {
  return String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function table(head: Cell[], rows: Cell[][]): string {
  return [`| ${head.map(esc).join(" | ")} |`, `|${head.map(() => " --- ").join("|")}|`, ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`)].join("\n");
}

/** 一段 chart JSON 换成表格；看不懂就 undefined */
export function chartTable(json: string): string | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const spec = raw as { type?: unknown; title?: unknown; x?: unknown; series?: unknown; data?: unknown; unit?: unknown; xName?: unknown };
  const list = Array.isArray(spec.series) ? spec.series : Array.isArray(spec.data) ? [{ data: spec.data }] : [];
  const series = list.map((s: { name?: unknown; data?: unknown }, i) => ({
    name: s?.name ? String(s.name) : list.length > 1 ? `系列 ${i + 1}` : "数值",
    data: Array.isArray(s?.data) ? (s.data as unknown[]) : [],
  }));
  const first = series[0];
  if (!first) return undefined;
  const type = String(spec.type ?? "line");
  const x = Array.isArray(spec.x) ? spec.x.map((v) => String(v ?? "")) : [];
  const unit = spec.unit ? `（${String(spec.unit)}）` : "";
  let body: string;
  if (type === "pie") {
    body = table(
      ["", `${first.name}${unit}`],
      first.data.map((p, j) => (p && typeof p === "object" && !Array.isArray(p) ? [String((p as { name?: unknown }).name ?? ""), fmt((p as { value?: unknown }).value)] : [x[j] ?? `#${j + 1}`, fmt(p)])),
    );
  } else if (type === "scatter") {
    body = table(
      ["", spec.xName ? String(spec.xName) : "x", `y${unit}`],
      series.flatMap((s) => s.data.map((p) => (Array.isArray(p) ? [s.name, fmt(p[0]), fmt(p[1])] : [s.name, "—", "—"]))),
    );
  } else {
    const n = Math.max(x.length, ...series.map((s) => s.data.length));
    body = table(
      [spec.xName ? String(spec.xName) : "", ...series.map((s) => `${s.name}${unit}`)],
      Array.from({ length: n }, (_, i) => [x[i] ?? String(i + 1), ...series.map((s) => fmt(s.data[i]))]),
    );
  }
  return spec.title ? `**📊 ${String(spec.title)}**\n\n${body}` : body;
}

/** 回复里的 ```chart 都换成表格（给画不了图的地方，比如飞书） */
export function chartsToTables(text: string): string {
  if (!/chart/i.test(text)) return text;
  return text.replace(FENCE, (whole, _fence: string, json: string) => chartTable(json) ?? whole);
}
