import { h, icon } from "../lib/dom.js";

// Keep the app's sheet layout while the native dialog manages focus and platform dismissal.
export function memoModal({ title, body, beforeClose }) {
  const heading = h("h3", { id: "memo-dialog-" + ++nextId }, title);
  const dismiss = h("button", { type: "button", class: "icon-btn", "aria-label": "关闭", onclick: requestDismiss }, icon("x"));
  const dialog = h("dialog", { class: "overlay memo-dialog", "aria-labelledby": heading.id },
    h("div", { class: "modal" }, h("div", { class: "modal-head" }, heading, dismiss), body));
  function close() {
    if (!dialog.open) return;
    document.removeEventListener("aim:leave-view", requestDismiss);
    dialog.close();
    dialog.remove();
  }
  function requestDismiss() {
    if (beforeClose?.() !== false) close();
  }
  dialog.addEventListener("cancel", event => {
    event.preventDefault();
    requestDismiss();
  });
  document.addEventListener("aim:leave-view", requestDismiss);
  document.body.append(dialog);
  dialog.showModal();
  return close;
}

let nextId = 0;
