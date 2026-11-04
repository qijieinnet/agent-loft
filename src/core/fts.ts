// 全文索引（SQLite FTS5）用的文字处理：写进索引的文字怎么切，搜索词怎么变成 MATCH 表达式。
//
// FTS5 自带的 trigram 分词搜不到两个字的中文词（「豆豆」），unicode61 又把一整串中文当成一个词。
// 所以写进索引之前把中日韩文字一个字一个字隔开，搜的时候用短语查询：「软路由」→ "软 路 由"。
// 英文词整个保留，驼峰词另外拆开补一份（搜 clash 能搜到 OpenClash）。

const CJK = "\\u3040-\\u30ff\\u3400-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff";
const CJK_CHAR = new RegExp(`([${CJK}])`, "g");
const HAS_CJK = new RegExp(`[${CJK}]`);

export const isCjk = (s: string) => HAS_CJK.test(s);

const spaced = (text: string) => text.replace(CJK_CHAR, " $1 ");

/** 写进索引的文字 */
export function ftsIndexText(text: string): string {
  // 先按词切再看里面有没有大小写变化：一个正则写到底的话，很长的一串字母（贴进来的 hash、base64）会回溯到平方级
  const camel = text.replace(/[A-Za-z0-9]+/g, (w) => (w.length <= 64 && /[a-z0-9][A-Z]/.test(w) ? `${w} ${w.replace(/([a-z0-9])([A-Z])/g, "$1 $2")}` : w));
  return spaced(camel);
}

/** 把查询拆成词：按空白和标点切开。中文不切词 */
export function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,，。.!！?？、;；:："'“”‘’()（）[\]【】<>《》/\\|]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 2 <= s.length; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** 要找的东西：每个词本身，长的中文词再加上它的两字组合（「软路由防污染」也能找到「软路由怎么防 DNS 污染」） */
export function needles(query: string): string[] {
  return [...new Set(terms(query).flatMap((t) => (isCjk(t) && t.length >= 4 ? [t, ...bigrams(t)] : [t])))].slice(0, 64);
}

/** 查询变成 MATCH 表达式，任何一个词命中都算候选（排序在外面做）。没有能搜的词（全是符号）就是 undefined */
export function ftsMatch(query: string): string | undefined {
  const phrases: string[] = [];
  for (const needle of needles(query)) {
    if (!/[\p{L}\p{N}]/u.test(needle)) continue;
    const phrase = spaced(needle).replace(/"/g, "").replace(/\s+/g, " ").trim();
    if (!phrase) continue;
    // 纯英文数字按前缀搜：clash 也能搜到 clashx
    phrases.push(/^[a-z0-9]+$/.test(phrase) ? `"${phrase}"*` : `"${phrase}"`);
  }
  return phrases.length ? phrases.join(" OR ") : undefined;
}
