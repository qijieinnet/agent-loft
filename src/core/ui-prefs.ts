// 每个用户的界面偏好，跟着账号走（换手机、换浏览器、桌面端都一样）。
// 侧栏菜单的显示、顺序，以及「项目」目录的顺序。
import path from "node:path";
import { dataDir, readJson, writeJsonAtomic } from "../home.js";

export type SidebarNavItem = { id: string; visible: boolean };
const NAV_IDS = ["search", "tasks", "library", "remote", "settings"];
type Prefs = { dirOrder?: string[]; sidebarNav?: SidebarNavItem[] };

const prefsPath = path.join(dataDir, "ui-prefs.json");
let cache: Record<string, Prefs> | null = null;

function load(): Record<string, Prefs> {
  if (!cache) {
    const raw = readJson<unknown>(prefsPath, {});
    cache = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, Prefs>) : {};
  }
  return cache;
}

function save(): void {
  writeJsonAtomic(prefsPath, cache ?? {});
}

const MAX_DIRS = 2000;

function cleanDirs(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((d): d is string => typeof d === "string" && d.length > 0 && d.length < 4096))].slice(0, MAX_DIRS);
}

/** 目录顺序；undefined = 这个用户还没在服务端存过（前端可以把本地的迁上来） */
export function getDirOrder(userId: string): string[] | undefined {
  return load()[userId]?.dirOrder;
}

/** 整份换掉（拖拽、置顶、按活跃重排） */
export function setDirOrder(userId: string, order: unknown): string[] {
  const all = load();
  const dirOrder = cleanDirs(order);
  all[userId] = { ...all[userId], dirOrder };
  save();
  return dirOrder;
}

/** 新出现的目录接在最后。只追加没有的，不动已有的名次 —— 别的设备同时在拖也不会被盖掉 */
export function appendDirOrder(userId: string, dirs: unknown): string[] {
  const all = load();
  const cur = all[userId]?.dirOrder ?? [];
  const add = cleanDirs(dirs).filter((d) => !cur.includes(d));
  if (add.length === 0 && all[userId]?.dirOrder) return cur;
  const dirOrder = [...cur, ...add].slice(0, MAX_DIRS);
  all[userId] = { ...all[userId], dirOrder };
  save();
  return dirOrder;
}

/** 新菜单接在最后；未配置过的菜单沿用默认显示方式（设置默认收进「更多」）。 */
function cleanSidebarNav(value: unknown): SidebarNavItem[] {
  const items: SidebarNavItem[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item !== "object" || !NAV_IDS.includes(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push({ id: item.id, visible: typeof item.visible === "boolean" ? item.visible : item.id !== "settings" });
  }
  for (const id of NAV_IDS) if (!seen.has(id)) items.push({ id, visible: id !== "settings" });
  return items;
}

export function getSidebarNav(userId: string): SidebarNavItem[] {
  return cleanSidebarNav(load()[userId]?.sidebarNav);
}

export function setSidebarNav(userId: string, value: unknown): SidebarNavItem[] {
  const all = load();
  const sidebarNav = cleanSidebarNav(value);
  all[userId] = { ...all[userId], sidebarNav };
  save();
  return sidebarNav;
}

export function deleteUiPrefs(userId: string): void {
  const all = load();
  if (!(userId in all)) return;
  delete all[userId];
  save();
}

export function resetUiPrefsForTest(): void {
  cache = null;
}
