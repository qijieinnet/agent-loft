import { h } from "../lib/dom.js";
import { memoModal as modal } from "./memo-modal.js";
import { api } from "../lib/api.js";
import { vaultEntries, vaultFiles } from "./memo-find.js";

function referenceDetails(endpoint, path, signal) {
  const status = h("p", { role: "status" });
  const refs = h("ul", { class: "memo-refs" });
  const details = h("details", {}, h("summary", {}, "查看引用"), status, refs);
  const filename = path.split("/").pop().replace(/\.(md|markdown)$/i, "").toLowerCase();
  details.addEventListener("toggle", async () => {
    let skipped = 0;
    status.textContent = "正在检查引用…";
    try {
      for await (const file of vaultFiles(endpoint, signal)) {
        if (file === path || !/\.(md|markdown)$/i.test(file)) continue;
        let data;
        try { data = await api(endpoint("file", file).replace("collab=1", "collab=0"), { signal }); }
        catch (err) { if (signal.aborted || [401, 403].includes(err.status)) throw err; skipped++; continue; }
        const matches = data.text.matchAll(/\[\[([^\]|#]+)|\]\(<?([^)>]+)/g);
        if ([...matches].some(match => {
          let target = match[1] || match[2];
          try { target = decodeURIComponent(target); } catch { /* A literal link may contain %. */ }
          return target.split("#")[0].trim().split("/").pop().replace(/\.(md|markdown)$/i, "").toLowerCase() === filename;
        })) refs.append(h("li", {}, file));
      }
      status.textContent = (refs.childElementCount ? "可能需要更新链接的笔记" : "未发现引用此文件的链接") +
        (skipped ? "（有文件未能检查）" : "");
    } catch (err) { if (!signal.aborted) status.textContent = "引用检查未完成 · " + err.message; }
  }, { once: true, signal });
  return details;
}

export function organizeDialog(endpoint, path, action) {
  return new Promise(resolve => {
    const labels = { rename: "重命名", move: "移动", trash: "移入回收站" };
    if (!Object.hasOwn(labels, action)) { resolve(null); return; }
    const controller = new AbortController();
    const { signal } = controller;
    const slash = path.lastIndexOf("/");
    const name = path.slice(slash + 1);
    const parent = slash < 0 ? "" : path.slice(0, slash);
    const submit = h("button", { type: "submit", class: action === "trash" ? "btn danger-fill" : "btn primary" }, labels[action]);
    const status = h("small", { role: "status" });
    let field, control;
    if (action === "rename") {
      field = h("input", { class: "input", value: name, required: true, autocomplete: "off" });
      control = h("label", {}, "文件名", field);
      submit.disabled = true;
      field.oninput = () => {
        field.setCustomValidity("");
        submit.disabled = field.value.trim() === name || !field.value.trim();
      };
    } else if (action === "move") {
      field = h("select", { class: "input" }, h("option", { value: "" }, "库根目录"));
      if (parent) field.append(h("option", { value: parent }, parent));
      field.value = parent;
      submit.disabled = true;
      field.onchange = () => { submit.disabled = field.value === parent; };
      control = h("label", {}, "目标文件夹", field);
      status.textContent = "正在读取文件夹…";
      void (async () => {
        try {
          for await (const entry of vaultEntries(endpoint, signal)) {
            if (entry.directory && entry.path !== parent) field.append(h("option", { value: entry.path }, entry.path));
          }
          status.textContent = field.length < 2 ? "没有其他文件夹" : "";
        } catch (err) { if (!signal.aborted) status.textContent = err.message; }
      })();
    } else {
      control = h("p", {}, "将「" + name + "」移入回收站？可在当前库的回收站恢复。");
    }

    const cancel = h("button", { type: "button", class: "btn ghost", onclick: () => finish(null) }, "取消");
    const form = h("form", { class: "modal-body memo-fields" }, control, action === "move" ? status : null,
      referenceDetails(endpoint, path, signal), h("div", { class: "memo-dialog-actions" }, cancel, submit));
    const close = modal({ title: labels[action], body: form, beforeClose: () => finish(null) });
    function finish(value) {
      controller.abort();
      close();
      resolve(value);
    }
    form.onsubmit = e => {
      e.preventDefault();
      if (action === "trash") { finish({ op: "trash" }); return; }
      if (submit.disabled) return;
      const value = field.value.trim();
      if (action === "rename" && (!value || value === "." || value === ".." || /[\\/]/.test(value))) {
        field.setCustomValidity("请输入单个文件名");
        field.reportValidity();
        return;
      }
      const folder = action === "rename" ? parent : field.value;
      const destName = action === "rename" ? value : name;
      finish({ op: "move", to: folder ? folder + "/" + destName : destName });
    };
    (field || cancel).focus();
    if (action === "rename") field.setSelectionRange(0, name.lastIndexOf(".") > 0 ? name.lastIndexOf(".") : name.length);
  });
}
