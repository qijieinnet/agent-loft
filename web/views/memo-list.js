import { h, fill, icon } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { createMemoSearch, recentFiles, trashDir } from "./memo-find.js";

const parent = path => path.split("/").slice(0, -1).join("/");
const name = path => path.split("/").pop();

export function createMemoList({ endpoint, shelfKey, canWrite, currentFile, onOpen, onMenu, onNewFolder }) {
  const query = h("input", { type: "search", placeholder: "搜索笔记", "aria-label": "搜索笔记", maxlength: 512 });
  const cancel = h("button", { type: "button", hidden: true, "aria-label": "取消搜索", onclick: stopSearch }, "取消");
  const searchBar = h("div", { class: "memo-search-bar" }, h("label", {}, icon("search"), query), cancel);
  const section = h("div", { class: "memo-list-heading" });
  const entries = h("div", { class: "memo-entries" });
  const tree = h("nav", { class: "memo-tree", id: "memo-tree", "aria-label": "笔记列表" }, entries);
  const positions = new Map();
  let folder = null, search, directoryLoad, origin, restoreTop = 0;
  const location = () => folder === null ? "recent" : "folder:" + folder;

  function startSearch() {
    if (search) return;
    restoreTop = tree.scrollTop;
    search = createMemoSearch({ endpoint, key: shelfKey(), query, onOpen: pick });
    section.hidden = entries.hidden = true;
    cancel.hidden = false;
    tree.append(search.root);
    tree.scrollTop = 0;
  }
  function stopSearch() {
    if (!search) return;
    search.destroy();
    search.root.remove();
    search = null;
    query.value = "";
    section.hidden = entries.hidden = false;
    cancel.hidden = true;
    render(restoreTop);
    section.querySelector("button")?.focus({ preventScroll: true });
  }
  query.addEventListener("focus", startSearch);
  query.addEventListener("input", startSearch);
  function exitSearch(e) {
    if (e.key === "Escape" && search && !e.isComposing) { e.preventDefault(); stopSearch(); }
  }
  searchBar.addEventListener("keydown", exitSearch);
  tree.addEventListener("keydown", exitSearch);

  function pick(hit, button = document.activeElement) {
    origin = button;
    return onOpen(hit, button);
  }
  function focusOrigin() {
    const target = origin?.isConnected && tree.contains(origin) && origin.getClientRects().length ? origin :
      (search ? tree.querySelector(".memo-found") : entries.querySelector(".memo-row.selected")) || section.querySelector("button");
    target?.focus({ preventScroll: true });
  }
  function highlight() {
    for (const row of entries.querySelectorAll(".memo-row[data-path]")) {
      const active = !row.dataset.directory && row.dataset.path === currentFile();
      row.classList.toggle("selected", active);
      if (active) row.setAttribute("aria-current", "page");
      else row.removeAttribute("aria-current");
    }
  }
  function fileRow(path, directory, context) {
    const title = name(path);
    const label = directory ? title : title.replace(/\.(md|markdown)$/i, "");
    const btn = h("button", { type: "button", class: "memo-row", title: path,
      "data-path": path, "data-directory": directory ? "1" : null,
      onclick: e => directory ? navigate(path) : pick({path}, e.currentTarget) },
    icon(directory ? "folder" : "file"), h("span", { class: "memo-row-text" }, h("span", {}, label),
      context ? h("small", {}, parent(path) || "根目录") : null));
    const more = directory ? null : h("button", { type: "button", class: "icon-btn memo-row-more",
      "aria-label": title + "的更多操作", onclick: e => onMenu(e.currentTarget, path) }, icon("more"));
    return h("div", { class: "memo-list-row" }, btn, more);
  }
  function navigate(to) {
    positions.set(location(), tree.scrollTop);
    folder = to;
    render(positions.get(location()) || 0);
    section.querySelector("button")?.focus({preventScroll:true});
  }
  function render(top = tree.scrollTop) {
    directoryLoad?.abort();
    const recent = folder === null ? recentFiles(shelfKey()) : [];
    const inFolder = folder !== null;
    const back = h("button", { type: "button", class: "icon-btn", "aria-label": "上一级",
      onclick: () => navigate(folder ? parent(folder) : null) }, icon("back"));
    fill(section, inFolder ? back : null,
      h("h2", {}, inFolder ? name(folder) || "文件夹" : recent.length ? "最近笔记" : "文件"),
      inFolder ? canWrite() && h("button", { type: "button", class: "icon-btn", title: "新建文件夹",
        "aria-label": "新建文件夹", onclick: onNewFolder }, icon("folderPlus")) :
        h("button", { type: "button", class: "memo-folder-link", onclick: () => navigate("") }, icon("folder"), "文件夹"));
    if (recent.length) {
      const names = new Set(), duplicates = new Set();
      for (const path of recent) {
        if (names.has(name(path))) duplicates.add(name(path));
        names.add(name(path));
      }
      fill(entries, recent.map(path => fileRow(path, false, duplicates.has(name(path)))));
      highlight();
      tree.scrollTop = top;
      return;
    }
    const dir = folder || "";
    const request = directoryLoad = new AbortController();
    fill(entries);
    const load = async (cursor = "") => {
      const loading = h("div", { class: "memo-list-info", role: "status" }, "正在读取…");
      entries.append(loading);
      try {
        const page = await api(endpoint("tree", dir, cursor), { signal: request.signal });
        if (request.signal.aborted) return;
        loading.remove();
        for (const item of page.entries) {
          const path = dir ? dir + "/" + item.name : item.name;
          if (path !== trashDir) entries.append(fileRow(path, item.directory, false));
        }
        if (page.next) entries.append(h("button", { class: "btn", onclick: e => {
          e.currentTarget.remove(); void load(page.next);
        } }, "加载更多"));
        else if (!entries.childElementCount) entries.append(h("p", {class:"memo-list-info"}, "暂无文件"));
        highlight();
        if (!cursor && !search) tree.scrollTop = top;
      } catch (err) {
        if (request.signal.aborted) return;
        fill(loading, err.message, h("button", {class:"btn", onclick: () => { loading.remove(); void load(cursor); }}, "重试"));
      }
    };
    void load();
  }
  function destroy() {
    directoryLoad?.abort();
    search?.destroy();
    search?.root.remove();
    search = null;
    query.value = "";
    cancel.hidden = true;
    section.hidden = entries.hidden = false;
    positions.clear();
    folder = origin = null;
  }
  return { tree, section, searchBar, query, focusOrigin, highlight, destroy,
    refresh: () => { if (search) search.refresh(true); else render(); },
    refreshFavorites: () => search?.refresh(),
    navigate, directory: () => search ? "" : folder || "",
    reset: () => { destroy(); render(0); } };
}
