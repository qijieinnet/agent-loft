import { byId, field, h, icon, button } from "./client.js";

const dialog = byId("panel");
let revision = 0;
let returnToSettings;
const title = byId("panel-title"),
  body = byId("panel-body"),
  error = byId("panel-error"),
  actions = byId("panel-actions");
const close = byId("panel-close");
const back = button("全部设置", () => returnToSettings?.(), "sheet-back");
back.prepend(icon("back"));
title.before(back);
close.append(icon("x"));
close.onclick = () => dialog.close();
function syncViewport() {
  const viewport = window.visualViewport;
  if (!viewport || viewport.scale !== 1) return;
  dialog.style.setProperty("--visible-height", viewport.height + "px");
  dialog.style.setProperty("--keyboard-inset", Math.max(0, innerHeight - viewport.height - viewport.offsetTop) + "px");
}
window.visualViewport?.addEventListener("resize", () => { if (dialog.open) syncViewport(); });
window.visualViewport?.addEventListener("scroll", () => { if (dialog.open) syncViewport(); });
if (!("closedBy" in HTMLDialogElement.prototype)) {
  let pressedOutside = false;
  const outside = event => {
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  };
  dialog.addEventListener("pointerdown", event => { pressedOutside = outside(event); });
  dialog.addEventListener("pointerup", event => { if (pressedOutside && outside(event)) dialog.close(); });
}
export const closePanel = () => {
  revision++;
  if (dialog.open) dialog.close();
};
export function currentPanel() {
  const expected = revision, open = dialog.open;
  return () => expected === revision && open === dialog.open;
}
export const note = (text) => h("p", { class: "help" }, text);
export const divider = () => h("hr", { class: "divider" });
function showPanel(name, content, { formActions, overview } = {}) {
  revision++;
  if (overview || !dialog.open) returnToSettings = overview;
  const nodes = content.filter(Boolean);
  dialog.classList.toggle("settings-panel", !!overview);
  dialog.classList.toggle("editor-panel", nodes.some(node => node.matches?.("form, .field")));
  back.hidden = !returnToSettings || !!overview;
  actions.replaceChildren(...(formActions || []));
  actions.hidden = !formActions;
  title.textContent = name;
  body.replaceChildren(...nodes);
  error.textContent = "";
  error.hidden = true;
  syncViewport();
  if (!dialog.open) dialog.showModal();
  if (document.activeElement !== dialog) dialog.focus({ preventScroll: true });
  body.scrollTop = 0;
  return currentPanel();
}
export function panel(name, ...content) {
  return showPanel(name, content);
}
export function settingsPanel(content, overview) {
  return showPanel("对话设置", [content], { overview });
}
export function formPanel(name, form, submit, onCancel = closePanel) {
  form.id = "bot-panel-form";
  submit.setAttribute("form", form.id);
  submit.classList.add("primary");
  return showPanel(name, [form], { formActions: [button("取消", onCancel, "secondary"), submit] });
}
export function panelError(message) {
  error.textContent = message;
  error.hidden = false;
}
export async function run(control, action) {
  if (control.disabled) return;
  control.disabled = true;
  error.textContent = "";
  error.hidden = true;
  try {
    await action();
  } catch (err) {
    if (dialog.open && control.isConnected) panelError(err.message);
  } finally {
    control.disabled = false;
  }
}
export function action(label, handler, className = "row") {
  const control = button(label, () => run(control, handler), className);
  return control;
}
export function chooseName(label, initial, save, returnTo) {
  const input = h("input", {
    id: "new-name",
    value: initial,
    required: true,
    maxlength: "40",
    autocomplete: "off",
  });
  const submit = h("button", { type: "submit", class: "primary" }, "保存");
  formPanel(
    label,
    h(
      "form",
      {
        class: "sheet-form",
        onsubmit: (e) => {
          e.preventDefault();
          if (input.value.trim()) run(submit, () => save(input.value.trim()));
        },
      },
      field("Bot 名称", input),
    ),
    submit,
    returnTo,
  );
}
