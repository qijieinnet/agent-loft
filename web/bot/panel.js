import { byId, field, h, icon, button } from "./client.js";

const dialog = byId("panel");
let revision = 0;
const title = byId("panel-title"),
  body = byId("panel-body"),
  error = byId("panel-error");
const close = byId("panel-close"), head = title.parentElement;
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
function showPanel(name, content, formActions) {
  revision++;
  dialog.classList.toggle("form-panel", !!formActions);
  head.replaceChildren(...(formActions ? [formActions.cancel, title, formActions.submit] : [title, close]));
  title.textContent = name;
  body.replaceChildren(...content.filter(Boolean));
  error.textContent = "";
  error.hidden = true;
  syncViewport();
  if (!dialog.open) dialog.showModal();
  else (formActions?.cancel || body.querySelector("[autofocus]") || close).focus();
  body.scrollTop = 0;
  return currentPanel();
}
export function panel(name, ...content) {
  return showPanel(name, content);
}
export function formPanel(name, form, submit, onCancel = closePanel) {
  form.id = "bot-panel-form";
  submit.setAttribute("form", form.id);
  submit.className = "sheet-confirm";
  const cancel = button("取消", onCancel, "sheet-cancel");
  cancel.autofocus = true;
  return showPanel(name, [form], { cancel, submit });
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
