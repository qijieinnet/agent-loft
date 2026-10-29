// 侧栏会话列表分页：打开页面只拿第一页，点「展开显示」再按页拉。
//
// 一页按「树」算：主对话连同从它分叉出来的对话算一条（和前端 sidebar.js 的 forkForest 一样），
// 按整棵树里最近的活跃时间从新到旧排。翻页用游标（上一页最后一棵树的活跃时间 + 根的 key），
// 期间有会话变活跃、被删，也不会漏掉或重复一页的边界。
import type { ConversationInfo } from "../../core/hub.js";

export type Cursor = { at: number; key: string };
export type Page = { conversations: ConversationInfo[]; next: Cursor | null };
type Tree = { root: ConversationInfo; convs: ConversationInfo[]; at: number };

/** 最近：飞书以外的会话（飞书按机器人各占一行，另外给） */
export const inRecent = (c: ConversationInfo): boolean => c.channel !== "feishu";
/** 项目：Web 会话按工作目录分组 */
export const inDir = (dir: string) => (c: ConversationInfo): boolean => c.channel === "web" && c.cwd === dir;

/** 按分叉关系成树：父对话也在这一组里的挂到下面，其余的是根。父链绕回自己（数据坏了）就当根 */
export function forkTrees(list: ConversationInfo[]): Tree[] {
  const byKey = new Map(list.map((c) => [c.key, c]));
  const rootOf = (c: ConversationInfo): ConversationInfo => {
    let cur = c;
    for (let n = 0; n < 50; n++) {
      const parent = cur.forkOf ? byKey.get(cur.forkOf) : undefined;
      if (!parent || parent.key === c.key) return cur;
      cur = parent;
    }
    return c;
  };
  const trees = new Map<string, Tree>();
  for (const c of list) {
    const root = rootOf(c);
    let t = trees.get(root.key);
    if (!t) trees.set(root.key, (t = { root, convs: [], at: 0 }));
    t.convs.push(c);
    t.at = Math.max(t.at, c.activeAt);
  }
  return [...trees.values()].sort((a, b) => b.at - a.at || (a.root.key < b.root.key ? 1 : -1));
}

/** 游标之后的 limit 棵树 */
export function pageOf(list: ConversationInfo[], before: Cursor | null, limit: number): Page {
  const trees = forkTrees(list);
  const start = before ? trees.findIndex((t) => t.at < before.at || (t.at === before.at && t.root.key < before.key)) : 0;
  if (start < 0) return { conversations: [], next: null };
  const slice = trees.slice(start, start + limit);
  const last = slice[slice.length - 1];
  return {
    conversations: slice.flatMap((t) => t.convs),
    next: last && start + limit < trees.length ? { at: last.at, key: last.root.key } : null,
  };
}

/** 项目目录：每个目录最近的活跃时间（目录行本身要全部显示，会话再按需拉） */
export function dirsOf(list: ConversationInfo[]): { dir: string; at: number }[] {
  const at = new Map<string, number>();
  for (const c of list) if (c.channel === "web") at.set(c.cwd, Math.max(at.get(c.cwd) ?? 0, c.activeAt));
  return [...at].map(([dir, t]) => ({ dir, at: t })).sort((a, b) => b.at - a.at);
}

export function parseCursor(at: string | null, key: string | null): Cursor | null {
  const n = Number(at);
  return key && Number.isFinite(n) ? { at: n, key } : null;
}

export const clampLimit = (v: unknown, def: number): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : def;
};

export type SearchResult = { conv: ConversationInfo; snippet?: string };

/**
 * 搜索会话：标题（和工作目录名）里每个词都出现的排前面，整句出现的更靠前，同样的按活跃时间；
 * 再接上聊天内容里搜到的（contentHits，按相关程度排好的，同一条对话只取第一句）。
 * 没输入查询：给最近活跃的。
 */
export function searchConvs(
  list: ConversationInfo[],
  query: string,
  contentHits: { key: string; text: string }[] = [],
  limit = 50,
): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list].sort((a, b) => b.activeAt - a.activeAt).slice(0, limit).map((conv) => ({ conv }));
  const words = q.split(/\s+/);
  const byTitle = list
    .map((c) => {
      const title = (c.title ?? "").toLowerCase();
      const hay = `${title} ${c.cwd.split(/[\\/]/).filter(Boolean).pop() ?? ""}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return null;
      return { c, rank: title.includes(q) ? 2 : 1 };
    })
    .filter((x) => x !== null)
    .sort((a, b) => b.rank - a.rank || b.c.activeAt - a.c.activeAt);
  const out: SearchResult[] = byTitle.map((x) => ({ conv: x.c }));
  const seen = new Set(out.map((r) => r.conv.key));
  const byKey = new Map(list.map((c) => [c.key, c]));
  for (const hit of contentHits) {
    const conv = byKey.get(hit.key);
    if (!conv || seen.has(hit.key)) continue;
    seen.add(hit.key);
    out.push({ conv, snippet: hit.text });
  }
  return out.slice(0, limit);
}
