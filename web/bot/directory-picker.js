import { api, button, h, icon } from "./client.js";

export function directoryPicker(url, initial) {
  let value = initial || "", listing = null, request = 0;
  const selected = h("p", { class: "folder-path", id: "codex-selected-folder", role: "status" });
  const validation = h("p", { class: "form-error", role: "alert", hidden: true }, "请先选择服务器工作目录。");
  const location = h("p", { class: "folder-path", tabindex: "-1" });
  const status = h("p", { class: "help", role: "status" });
  const folders = h("ul", { class: "folder-list", "aria-label": "子文件夹" });
  const workspace = button("工作区", () => load(""), "secondary");
  const parent = button("上一级", () => load(listing.parent), "secondary");
  const more = button("查看更多文件夹", () => load(listing.path, listing.nextOffset), "secondary");
  const use = button("使用此文件夹", () => {
    value = listing.path;
    validation.hidden = true;
    updateSelection();
    collapse();
    browse.focus({ preventScroll: true });
  }, "primary");
  const browser = h("div", { class: "folder-browser", id: "codex-folder-browser", hidden: true },
    h("div", { class: "folder-actions" }, workspace, parent), location, status, folders, more, use);
  const browse = button("选择文件夹", () => {
    if (!browser.hidden) {
      collapse();
      return;
    }
    browser.hidden = false;
    browse.setAttribute("aria-expanded", "true");
    load(value);
  }, "secondary");
  browse.setAttribute("aria-controls", browser.id);
  browse.setAttribute("aria-expanded", "false");
  browse.setAttribute("aria-describedby", selected.id);
  const node = h("div", { class: "folder-picker", role: "group", "aria-labelledby": "codex-directory-label" },
    h("span", { id: "codex-directory-label", class: "folder-label" }, "服务器工作目录（启用本机工具时必填）"),
    selected, browse, validation, browser);
  updateSelection();

  function updateSelection() {
    selected.textContent = value || "尚未选择文件夹";
    browse.textContent = value ? "更换文件夹" : "选择文件夹";
  }
  function collapse() {
    request++;
    browser.hidden = true;
    browse.setAttribute("aria-expanded", "false");
  }
  async function load(path, offset = 0) {
    const pending = ++request;
    const focused = folders.contains(document.activeElement) ? document.activeElement : null;
    parent.disabled = more.disabled = use.disabled = true;
    status.textContent = "正在读取文件夹…";
    try {
      const params = new URLSearchParams({ path, offset });
      const next = await api(url + "/directories?" + params);
      if (pending !== request || !node.isConnected) return;
      const moveFocus = !offset && focused === document.activeElement;
      listing = next;
      location.textContent = listing.path;
      const rows = listing.dirs.map(dir => h("li", {},
        button(h("span", { class: "folder-name" }, icon("folder"), dir.name), () => load(dir.path), "row")));
      if (offset) folders.append(...rows);
      else folders.replaceChildren(...rows);
      status.textContent = folders.childElementCount ? "" : "没有子文件夹";
      if (moveFocus) location.focus({ preventScroll: true });
    } catch (error) {
      if (pending === request && node.isConnected) status.textContent = error.message;
    } finally {
      if (pending === request && node.isConnected) {
        parent.disabled = !listing?.parent;
        use.disabled = !listing?.selectable;
        more.hidden = listing?.nextOffset == null;
        more.disabled = more.hidden;
      }
    }
  }
  return {
    node,
    get value() { return value; },
    enabled(required) {
      browse.disabled = !required;
      if (!required) {
        validation.hidden = true;
        collapse();
      }
    },
    validate() {
      if (value) return true;
      validation.hidden = false;
      browse.focus();
      return false;
    },
  };
}
