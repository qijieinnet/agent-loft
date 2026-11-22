import { api } from "../lib/api.js";
import { h, fill, icon } from "../lib/dom.js";
import { memoModal as modal } from "./memo-modal.js";

export const trashDir = ".agent-loft-trash";
const textFile = /\.(md|markdown|txt|json|ya?ml|toml|ini|csv|tsv|log|css|js|ts|xml|html)$/i;

export async function* vaultEntries(endpoint, signal, start = "") {
  const dirs = new Set([start]);
  for (const dir of dirs) {
    const seen = new Set();
    let cursor = "";
    do {
      if (seen.has(cursor)) throw new Error("目录分页重复");
      seen.add(cursor);
      const page = await api(endpoint("tree", dir, cursor), { signal });
      for (const item of page.entries) {
        const path = dir ? dir + "/" + item.name : item.name;
        if (path === trashDir) continue;
        if (item.directory) dirs.add(path);
        yield { path, directory: item.directory };
      }
      cursor = page.next;
    } while (cursor);
  }
}

export async function* vaultFiles(endpoint, signal, start = "") {
  for await (const { path, directory } of vaultEntries(endpoint, signal, start)) {
    if (!directory && (start === trashDir || textFile.test(path) || /\.(png|jpe?g|gif|webp)$/i.test(path))) yield path;
  }
}

function load(key) {
  try {
    const values = JSON.parse(localStorage.getItem(key));
    return Array.isArray(values) ? values.filter(v => typeof v === "string") : [];
  } catch { return []; }
}

function save(key, values) {
  try { localStorage.setItem(key, JSON.stringify(values)); } catch { /* Optional preference. */ }
}

export function recentFiles(key) { return load(key + ".recent"); }
export function rememberFile(key, file) {
  save(key + ".recent", [file, ...recentFiles(key).filter(v => v !== file)].slice(0, 30));
}
export function isFavorite(key, path) { return load(key + ".stars").includes(path); }
export function toggleFavorite(key, path) {
  const stars = load(key + ".stars");
  const add = !stars.includes(path);
  save(key + ".stars", add ? [...stars, path] : stars.filter(v => v !== path));
  return add;
}
export function relocatePreference(key, from, to) {
  for (const suffix of [".recent", ".stars"]) save(key + suffix, load(key + suffix).flatMap(v => v !== from ? [v] : to ? [to] : []));
}

export function createMemoSearch({ endpoint, key, query, onOpen, trash = false }) {
  const lifetime = new AbortController();
  const list = h("div", { class: "memo-results" });
  const status = h("small", { role: "status" });
  const section = h("strong", { class: "memo-search-heading" }, "收藏");
  const searchBody = h("button", { type: "button", class: "btn", onclick: () => void findInBody() }, "搜索正文");
  const root = h("div", { class: "memo-search-results memo-fields" }, section, searchBody, list, status);
  let directoryRequest, bodyRequest, files = [], hits = [], active = 0, complete = false, error = "", bodyStatus = "";
  const displayPath = path => trash ? path.split("/").slice(2).join("/") : path;

  function draw() {
    const term = query.value.trim().toLowerCase();
    const stars = trash ? [] : load(key + ".stars");
    const names = term || trash ? files.filter(p => displayPath(p).toLowerCase().includes(term)) : stars;
    const rows = bodyRequest ? hits : names.map(path => ({ path }));
    const shown = rows.slice(0, 100);
    active = Math.max(0, Math.min(active, shown.length - 1));
    section.hidden = !!term || trash || !stars.length;
    searchBody.hidden = trash || !term || !!bodyRequest;
    fill(list, shown.map((hit, index) => {
      const display = displayPath(hit.path);
      const title = display.split("/").pop();
      const folder = display.substring(0, display.lastIndexOf("/"));
      const content = [h("strong", {}, title), folder && h("small", {}, folder), hit.snippet && h("span", {}, hit.snippet)];
      const name = trash ? h("div", { class: "memo-found" }, content) :
        h("button", { type: "button", class: "memo-found", onclick: event => onOpen(hit, event.currentTarget) }, content);
      const favorite = stars.includes(hit.path);
      const action = trash ?
        h("button", { type: "button", class: "btn", onclick: event => onOpen(hit, event.currentTarget) }, "恢复") :
        h("button", {
          type: "button", class: "icon-btn", "aria-label": (favorite ? "取消收藏 " : "收藏 ") + display,
          "aria-pressed": String(favorite), onclick: () => { toggleFavorite(key, hit.path); draw(); query.focus(); },
        }, icon("bookmark"));
      return h("div", { class: "memo-result" + (index === active ? " active" : "") }, name, action);
    }));
    if (bodyRequest) status.textContent = bodyStatus;
    else if (error) status.textContent = error;
    else if (rows.length > shown.length) status.textContent = "显示前 100 项，请缩小搜索范围";
    else if (rows.length) status.textContent = "";
    else if (!term && !trash) status.textContent = "输入文件名或路径搜索";
    else if (!complete) status.textContent = "正在读取目录…";
    else status.textContent = trash && !term ? "回收站为空" : "没有匹配的文件";
  }

  async function loadNames() {
    if (directoryRequest) return;
    const request = directoryRequest = new AbortController();
    try {
      for await (const path of vaultFiles(endpoint, request.signal, trash ? trashDir : "")) {
        if (request.signal.aborted) return;
        files.push(path);
        if (files.length % 40 === 0 && !bodyRequest) draw();
      }
    } catch (err) {
      if (request.signal.aborted) return;
      if (!trash || err.status !== 404) error = err.message;
    }
    if (!request.signal.aborted) { complete = true; draw(); }
  }

  async function findInBody() {
    const term = query.value.trim();
    if (!term || trash) return;
    bodyRequest?.abort();
    const request = bodyRequest = new AbortController();
    hits = [];
    active = 0;
    bodyStatus = "正在搜索正文…";
    query.focus();
    draw();
    try {
      const indexed = await api(endpoint("search") + "&q=" + encodeURIComponent(term), { signal: request.signal });
      if (request.signal.aborted) return;
      if (indexed.ready) {
        hits = indexed.hits.map(hit => {
          const lower = hit.snippet.toLowerCase();
          const needle = [term, ...term.split(/\s+/)].find(word => lower.includes(word.toLowerCase()));
          return { ...hit, needle };
        });
        bodyStatus = hits.length ? "全文索引 · " + hits.length + " 项结果（最多 20 项）" : "没有匹配的正文";
      } else {
        let skipped = 0;
        for await (const path of vaultFiles(endpoint, request.signal)) {
          if (!textFile.test(path)) continue;
          let data;
          try { data = await api(endpoint("file", path).replace("collab=1", "collab=0"), { signal: request.signal }); }
          catch (err) { if (request.signal.aborted || [401, 403].includes(err.status)) throw err; skipped++; continue; }
          if (request.signal.aborted) return;
          const offset = data.text.toLowerCase().indexOf(term.toLowerCase());
          if (offset >= 0) {
            hits.push({ path, needle: term, snippet: data.text.slice(Math.max(0, offset - 32), offset + 80) });
            draw();
          }
        }
        if (request.signal.aborted) return;
        bodyStatus = hits.length + " 篇命中" + (skipped ? "，" + skipped + " 个文件未能读取" : "");
      }
    } catch (err) {
      if (request.signal.aborted) return;
      bodyStatus = err.message;
    }
    draw();
  }

  function searchNames() {
    bodyRequest?.abort();
    bodyRequest = null;
    active = 0;
    if (trash || query.value.trim()) void loadNames();
    draw();
  }
  query.addEventListener("input", searchNames, { signal: lifetime.signal });
  query.addEventListener("keydown", e => {
    if (e.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active += e.key === "ArrowDown" ? 1 : -1;
      draw();
      list.children[active]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = list.children[active];
      if (row && trash) row.querySelector("button").focus();
      else if (row) row.querySelector("button").click();
      else if (!trash && !bodyRequest) void findInBody();
    }
  }, { signal: lifetime.signal });

  searchNames();
  return {
    root,
    refresh(reload = false) {
      if (!reload) { draw(); return; }
      directoryRequest?.abort();
      directoryRequest = null;
      complete = false;
      error = "";
      files = [];
      if (bodyRequest) void findInBody();
      else searchNames();
    },
    destroy() { lifetime.abort(); directoryRequest?.abort(); bodyRequest?.abort(); },
  };
}

export function findMemo(endpoint, key, initial = "", trash = false) {
  return new Promise(resolve => {
    const query = h("input", {
      class: "input", type: "search", value: initial, maxlength: 512,
      placeholder: "输入文件名或路径", "aria-label": "搜索关键词",
    });
    const search = createMemoSearch({ endpoint, key, query, onOpen: finish, trash });
    const body = h("div", { class: "modal-body memo-fields" }, query, search.root);
    const close = modal({ title: trash ? "回收站" : "搜索笔记", body, beforeClose: () => finish(null) });
    function finish(result) {
      search.destroy();
      close();
      resolve(result);
    }
    query.focus();
  });
}
