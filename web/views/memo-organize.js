import { h } from "../lib/dom.js";
import { modal } from "../lib/overlay.js";
import { api } from "../lib/api.js";
import { vaultFiles } from "./memo-find.js";

export function organizeDialog(endpoint, path) {
  return new Promise(resolve => {
    const controller = new AbortController();
    const field = h("input",{class:"input",value:path,required:true,"aria-label":"目标路径"});
    const status = h("p",{role:"status"},"正在检查可能引用此文件的笔记…");
    const refs = h("ul",{class:"memo-refs"});
    const submit = h("button",{class:"btn primary",type:"submit"},"移动或重命名");
    const trash = h("button",{class:"btn danger-fill",type:"button",onclick:() => finish({op:"trash"})},"移入回收站");
    const form = h("form",{class:"modal-body memo-fields"},h("label",{},"目标路径（含文件名）",field),status,refs,
      h("div",{class:"memo-dialog-actions"},trash,submit));
    function finish(value) { controller.abort(); close(); resolve(value); }
    const close = modal({title:"整理文件 · "+path.split("/").pop(),body:form,beforeClose:() => finish(null)});
    document.addEventListener("aim:leave-view",() => finish(null),{once:true,signal:controller.signal});
    form.onsubmit = e => { e.preventDefault(); if (field.value.trim() !== path) finish({op:"move",to:field.value.trim()}); };
    field.focus(); field.setSelectionRange(path.lastIndexOf("/")+1,path.lastIndexOf(".")>path.lastIndexOf("/") ? path.lastIndexOf(".") : path.length);
    const name = path.split("/").pop().replace(/\.(md|markdown)$/i,"").toLowerCase();
    void (async () => {
      let skipped = 0;
      try {
        for await (const file of vaultFiles(endpoint,controller.signal)) {
          if (file === path || !/\.(md|markdown)$/i.test(file)) continue;
          let data;
          try { data = await api(endpoint("file",file).replace("collab=1","collab=0"),{signal:controller.signal}); }
          catch (err) { if (controller.signal.aborted || [401,403].includes(err.status)) throw err; skipped++; continue; }
          const matches = data.text.matchAll(/\[\[([^\]|#]+)|\]\(<?([^)>]+)/g);
          if ([...matches].some(m => {
            let target = m[1] || m[2]; try { target = decodeURIComponent(target); } catch {}
            return target.split("#")[0].trim().split("/").pop().replace(/\.(md|markdown)$/i,"").toLowerCase() === name;
          })) refs.append(h("li",{},file));
        }
        status.textContent = (refs.childElementCount ? "可能需要更新链接的笔记" : "未发现引用此文件的链接") + (skipped ? "（有文件未能检查）" : "");
      } catch (err) { if (!controller.signal.aborted) status.textContent = "引用检查未完成 · "+err.message; }
    })();
  });
}
