// 工作区面板的入口：顶栏上的分支标记和按钮、Git 状态的刷新。首屏就加载，所以只放这点；
// 面板本身（views/workspace.js）第一次打开时才加载。
import { h, icon, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { S } from "../state.js";

/** 当前会话的 Git 状态：null = 还不知道；{ repo: false } = 不是仓库；出错时带 error */
export const git = { status: null };

const narrow = () => matchMedia("(max-width: 768px)").matches;
const allowed = () => !!S.user?.files;
const OPEN_KEY = "aim.wsOpen";

let panel = null;
function loadPanel() {
  panel ??= import("./workspace.js").catch((err) => {
    panel = null;
    toast(`工作区面板加载失败，刷新页面再试：${err.message}`);
    throw err;
  });
  return panel;
}

/** 面板开着的话记下来，下次进来接着开（手机上不记：全屏挡住对话） */
export function rememberOpen(open) {
  if (narrow()) return;
  if (open) localStorage.setItem(OPEN_KEY, "1");
  else localStorage.removeItem(OPEN_KEY);
}

// ---------- 顶栏 ----------

const chipText = h("span", { class: "top-git-name" });
const chipCount = h("span", { class: "top-git-count" });
const chip = h("button", { class: "top-git", hidden: true, onclick: () => void openWorkspace("changes") }, icon("fork"), chipText, chipCount);
const toggleBtn = h("button", { class: "icon-btn top-workspace", title: "工作区：文件和改动", "aria-label": "工作区面板", onclick: () => void loadPanel().then((m) => m.togglePanel()) }, icon("panel"));

function renderChip() {
  const s = git.status;
  chip.hidden = !s?.repo;
  if (!s?.repo) return;
  const name = s.branch ?? s.head ?? "未知";
  chipText.textContent = name;
  chipCount.textContent = s.files.length ? String(s.files.length) : "";
  chipCount.hidden = !s.files.length;
  const sync = [s.ahead ? `领先 ${s.ahead}` : "", s.behind ? `落后 ${s.behind}` : ""].filter(Boolean).join("，");
  chip.title = [s.branch ? `当前分支：${s.branch}` : `分离头指针：${s.head}`, sync, s.files.length ? `${s.files.length} 个文件有改动` : "没有改动"].filter(Boolean).join("\n");
}

/** 顶栏要放的按钮。每次重画顶栏用的是同一组元素，状态不用重新画 */
export function workspaceButtons() {
  return allowed() ? [chip, toggleBtn] : [];
}

// ---------- 状态 ----------

let seq = 0;
export async function refreshGit() {
  const key = S.current;
  const token = ++seq;
  if (!key || !allowed()) {
    git.status = null;
  } else {
    try {
      const status = await api(`/api/conversations/${encodeURIComponent(key)}/git-status`);
      if (token !== seq) return;
      git.status = status;
    } catch (err) {
      if (token !== seq) return;
      git.status = { repo: false, error: err.message };
    }
  }
  renderChip();
  document.dispatchEvent(new Event("aim:git"));
}

let lastId = null;
let restored = false;

/** 顶栏每次重画时对一下：换了会话、换了工作目录就重新拉；面板跟着显示 / 藏起来 */
export function syncWorkspace() {
  if (!allowed()) return;
  const c = S.current ? S.convs.get(S.current) : null;
  const id = S.current && !S.view ? `${S.current}\n${c?.cwd ?? ""}` : null;
  if (id !== lastId) {
    lastId = id;
    git.status = null;
    renderChip();
    if (id) void refreshGit();
    void panel?.then((m) => m.syncPanel());
  }
  if (id && !restored) {
    restored = true;
    if (!narrow() && localStorage.getItem(OPEN_KEY) === "1") void loadPanel().then((m) => m.showPanel());
  }
}

/** 从别处打开面板：tab 是 files / changes */
export async function openWorkspace(tab) {
  (await loadPanel()).showPanel(tab);
}

export async function openWorkspaceFile(rel) {
  await (await loadPanel()).openFile(rel);
}

/** 打开某一轮的改动：path 给了就直接看这个文件的 diff */
export async function openTurnChanges(changes, path) {
  await (await loadPanel()).openTurn(changes, path);
}

/** 这个账号能不能看改动卡片 */
export const canSeeChanges = allowed;

/** 绝对路径换算成相对当前会话工作目录的路径；不在工作目录里、不能用面板：null */
export function workspaceRelative(abs) {
  const cwd = S.current ? S.convs.get(S.current)?.cwd : null;
  if (!allowed() || !cwd || !abs) return null;
  const dir = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return abs.startsWith(dir) ? abs.slice(dir.length) : null;
}

// 一轮结束、切回这个窗口：文件可能变了
document.addEventListener("aim:turn-done", () => void refreshGit());
let lastFocus = 0;
addEventListener("focus", () => {
  if (!lastId || Date.now() - lastFocus < 5000) return;
  lastFocus = Date.now();
  void refreshGit();
});
