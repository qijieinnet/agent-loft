import { api } from "../lib/api.js";
import { h, fill, icon } from "../lib/dom.js";
import { modal } from "../lib/overlay.js";

export const trashDir = ".agent-loft-trash";
const textFile = /\.(md|markdown|txt|json|ya?ml|toml|ini|csv|tsv|log|css|js|ts|xml|html)$/i;
export async function* vaultFiles(endpoint, signal, start = "") {
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
        else if (start === trashDir || textFile.test(path) || /\.(png|jpe?g|gif|webp)$/i.test(path)) yield path;
      }
      cursor = page.next;
    } while (cursor);
  }
}
function load(key) {
  try { const a = JSON.parse(localStorage.getItem(key)); return Array.isArray(a) ? a.filter(v => typeof v === "string") : []; }
  catch { return []; }
}
function save(key, values) { try { localStorage.setItem(key, JSON.stringify(values)); } catch { /* optional preference */ } }
export function rememberFile(key, file) {
  save(key + ".recent", [file, ...load(key + ".recent").filter(v => v !== file)].slice(0, 30));
}
export function relocatePreference(key, from, to) {
  for (const suffix of [".recent", ".stars"]) save(key + suffix, load(key + suffix).flatMap(v => v !== from ? [v] : to ? [to] : []));
}

export function findMemo(endpoint, key, initial = "", trash = false) {
  return new Promise(resolve => {
    const controller = new AbortController();
    let stars = load(key + ".stars"), recent = load(key + ".recent");
    const files = [], hits = [], list = h("div", {class:"memo-results"}), status = h("small", {role:"status"});
    const query = h("input", {class:"input", type:"search", value:initial, maxlength:512, placeholder:"输入文件名或路径", "aria-label":"搜索关键词"});
    let bodyMode = false, active = 0, scan, complete = false;
    const bodySearch = h("button", {class:"btn", hidden:trash, onclick:() => {
      bodyMode = !bodyMode;
      scan?.abort(); hits.length = 0; active = 0;
      bodySearch.setAttribute("aria-pressed", String(bodyMode));
      query.placeholder = bodyMode ? "输入正文关键词，回车搜索" : "输入文件名或路径";
      status.textContent = ""; draw(); query.focus();
      if (bodyMode && query.value.trim()) void search();
    }}, "搜正文");
    const close = modal({title:trash ? "回收站" : "快速打开", body:h("div",{class:"modal-body memo-fields"},
      h("div",{class:"memo-find-tools"},query,bodySearch),list,status), beforeClose:() => finish(null)});
    function finish(result) { controller.abort(); scan?.abort(); close(); resolve(result); }
    document.addEventListener("aim:leave-view", () => finish(null), {once:true,signal:controller.signal});
    function draw() {
      const term = query.value.trim().toLowerCase();
      const paths = term || trash ? files.filter(p => p.toLowerCase().includes(term)) : [...new Set([...stars,...recent])];
      const rows = bodyMode ? hits : paths.map(path => ({path}));
      active = Math.max(0, Math.min(active, Math.min(rows.length,100)-1));
      fill(list,rows.slice(0,100).map((hit,i) => {
        const display = trash ? hit.path.split("/").slice(2).join("/") : hit.path;
        const open = h("button",{class:"memo-found",onclick:() => finish(hit)},h("strong",{},display.split("/").pop()),
          h("small",{},display),hit.snippet && h("span",{},hit.snippet));
        const star = h("button",{class:"icon-btn","aria-label":(stars.includes(hit.path) ? "取消收藏 " : "收藏 ")+display,
          "aria-pressed":String(stars.includes(hit.path)),onclick:() => {
            stars = stars.includes(hit.path) ? stars.filter(p => p !== hit.path) : [...stars,hit.path];
            save(key+".stars",stars); draw(); query.focus();
          }},icon("bookmark"));
        return h("div",{class:"memo-result"+(i===active?" active":"")},open,trash ? null : star);
      }));
      if (!bodyMode) status.textContent = rows.length > 100 ? "显示前 100 项，请缩小搜索范围" :
        rows.length ? "" : term || trash ? (complete ? "没有匹配的文件" : "正在读取目录…") : "输入文件名搜索，收藏和最近打开的笔记会显示在这里。";
    }
    async function search() {
      scan?.abort(); const request = scan = new AbortController();
      const term = query.value.trim(); hits.length = 0; draw();
      if (!term) return;
      let skipped = 0;
      status.textContent = "正在搜索正文…";
      try {
        const indexed = await api(endpoint("search")+"&q="+encodeURIComponent(term),{signal:request.signal});
        if (indexed.ready) {
          for (const hit of indexed.hits) {
            const lower = hit.snippet.toLowerCase();
            const needle = [term,...term.split(/\s+/)].find(word => lower.includes(word.toLowerCase()));
            hits.push({...hit, needle});
          }
          draw(); status.textContent = hits.length ? "全文索引 · "+hits.length+" 项结果（最多 20 项）" : "没有匹配的正文";
          return;
        }
        for await (const path of vaultFiles(endpoint, request.signal)) {
          if (!textFile.test(path)) continue;
          let data;
          try { data = await api(endpoint("file",path).replace("collab=1","collab=0"),{signal:request.signal}); }
          catch (err) { if (request.signal.aborted || [401,403].includes(err.status)) throw err; skipped++; continue; }
          const ix = data.text.toLowerCase().indexOf(term.toLowerCase());
          if (ix >= 0) { hits.push({path,needle:term, snippet:data.text.slice(Math.max(0,ix-32),ix+80)}); draw(); }
        }
        status.textContent = hits.length+" 篇命中"+(skipped ? "，"+skipped+" 个文件未能读取" : "");
      } catch (err) { if (!request.signal.aborted) status.textContent = err.message; }
    }
    query.oninput = () => { active = 0; scan?.abort(); hits.length = 0; status.textContent = bodyMode ? "按回车搜索正文" : ""; draw(); };
    query.onkeydown = e => {
      if (e.isComposing) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); active += e.key === "ArrowDown" ? 1 : -1; draw(); list.children[active]?.scrollIntoView({block:"nearest"});
      } else if (e.key === "Enter") {
        e.preventDefault(); if (bodyMode && !hits.length) void search(); else list.children[active]?.querySelector("button").click();
      }
    };
    list.parentElement.onkeydown = e => { if (e.key === "Escape") finish(null); };
    draw(); query.focus();
    void (async () => {
      try {
        for await (const file of vaultFiles(endpoint,controller.signal,trash ? trashDir : "")) {
          files.push(file); if (files.length % 40 === 0 && !bodyMode) draw();
        }
        complete = true; draw();
      } catch (err) { if (!controller.signal.aborted) status.textContent = trash && err.status === 404 ? "回收站为空" : err.message; }
    })();
  });
}
