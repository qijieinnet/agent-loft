// 文件的换行符。编辑器内部一律按 \n 处理，保存时要还原，不能让改一行变成整个文件都有改动。

/** lf / crlf：整个文件统一；mixed：混着用，或者有单独的 \r，编辑器里要原样保留 */
export function detectEol(text) {
  if (!text.includes("\r")) return "lf";
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const cr = text.match(/\r/g)?.length ?? 0;
  const lf = text.match(/\n/g)?.length ?? 0;
  return crlf === cr && crlf === lf ? "crlf" : "mixed";
}

/** 编辑器里的文字（\n）还原成文件原来的换行符 */
export function restoreEol(text, eol) {
  return eol === "crlf" ? text.replace(/\n/g, "\r\n") : text;
}
