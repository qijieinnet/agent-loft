// 模型写的日期（工具参数、整理结果）：YYYY-MM 或 YYYY-MM-DD，当成服务器所在时区的时间。
// 单独成模块：记忆工具子进程要用，不能因此把 hub 整个加载进去。

/** 写错了就当没有。不合法的日子（2 月 31 日）也算写错，不让它滚到下个月 */
export function parseDay(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(v.trim());
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3] ?? 1);
  if (month < 1 || month > 12 || day < 1) return undefined;
  const d = new Date(year, month - 1, day);
  if (d.getMonth() !== month - 1 || d.getDate() !== day) return undefined;
  return d.getTime();
}
