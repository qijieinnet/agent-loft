// 解析 CSV / TSV。不碰 DOM，方便单独测试。

/** 第一行里哪个分隔符多就用哪个（欧洲地区常用分号）。.tsv 直接是制表符 */
export function csvDelimiter(name, text) {
  if (/\.tsv$/i.test(name)) return "\t";
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const count = (ch) => firstLine.split(ch).length;
  return count(";") > count(",") ? ";" : ",";
}

/**
 * 按 RFC 4180：双引号里可以有分隔符和换行，两个双引号是一个双引号。
 * cut：文本是从大文件截下来的，最后一行不完整，扔掉。
 * maxRows：只解析这么多行，more 表示后面还有。返回 { rows, more }
 */
export function parseCsv(text, { delimiter = ",", cut = false, maxRows = Infinity } = {}) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let more = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endRow = () => {
    row.push(cell);
    rows.push(row);
    row = [];
    cell = "";
  };
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
      if (rows.length >= maxRows) {
        more = i + 1 < text.length;
        return { rows, more };
      }
    } else cell += ch;
  }
  // 文件末尾没有换行的最后一行
  if (!cut && (cell !== "" || row.length > 0)) endRow();
  return { rows, more: more || cut };
}
