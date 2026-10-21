// 额度对应的账号标识：桌面端连着多台服务器时，靠它认出「这几台登的是同一个账号」，
// 同一个账号只问一台，结果分给其他几台（额度是跟着账号走的，问哪台都一样）。
//
// 只给哈希、不给原文：接口返回里不出现邮箱。不同服务器上同一个账号算出来的值相同，
// 这正是要的效果，所以不加盐。
import { createHash } from "node:crypto";

/** 没有能认出账号的信息（API key、第三方云之类）时返回 undefined，桌面端就照旧逐台去问 */
export function accountKey(agent: string, ...parts: (string | null | undefined)[]): string | undefined {
  if (!parts[0]) return undefined;
  const text = [agent, ...parts.map((p) => (p ?? "").trim().toLowerCase())].join("\n");
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
