import { byId, icon } from "./client.js";

// Native popovers stay above the chat (including on iOS). Older browsers keep the same
// actions, keyboard controls and anchor using a fixed-position menu.
export function bindComposerActions(choosePhoto, chooseReminder, chooseRoutine, chooseFile, chooseVoice, chooseCall) {
  const trigger = byId("attach"), menu = byId("compose-actions");
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  const native = typeof menu.showPopover === "function";
  const anchored = native && CSS.supports("position-anchor", "--composer-add") && CSS.supports("bottom", "calc(anchor(top) + 8px)");
  const isOpen = () => native ? menu.matches(":popover-open") : !menu.hidden;
  const visible = () => items.filter(item => !item.hidden);
  let initialItem = null;

  function position() {
    if (anchored || !isOpen()) return;
    const box = trigger.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(box.left, innerWidth - menu.offsetWidth - 8)) + "px";
    menu.style.bottom = Math.max(8, innerHeight - box.top + 8) + "px";
  }
  function opened() {
    position();
    trigger.setAttribute("aria-expanded", "true");
    (initialItem || trigger).focus({ preventScroll: true });
    initialItem = null;
  }
  function close(restore = false) {
    if (!isOpen()) return;
    if (native) menu.hidePopover();
    else menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (restore) trigger.focus({ preventScroll: true });
  }
  trigger.addEventListener("click", event => {
    if (!isOpen() && event.detail === 0) initialItem ||= visible()[0];
  });
  if (native) {
    menu.hidden = false;
    menu.addEventListener("toggle", () => {
      if (isOpen()) opened();
      else trigger.setAttribute("aria-expanded", "false");
    });
  } else {
    trigger.onclick = () => {
      if (isOpen()) close(true);
      else { menu.hidden = false; opened(); }
    };
    document.addEventListener("pointerdown", event => {
      if (!trigger.contains(event.target) && !menu.contains(event.target)) close();
    });
  }
  trigger.addEventListener("keydown", event => {
    if (isOpen() && (event.key === "Escape" || event.key === "Tab")) {
      if (event.key === "Escape") event.preventDefault();
      close(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const target = event.key === "ArrowDown" ? visible()[0] : visible().at(-1);
    if (isOpen()) target.focus();
    else { initialItem = target; trigger.click(); }
  });
  menu.addEventListener("keydown", event => {
    if (event.key === "Tab" || event.key === "Escape") {
      if (event.key === "Escape") event.preventDefault();
      close(true);
      return;
    }
    const options = visible(), index = options.indexOf(document.activeElement);
    const next = { ArrowDown: (index + 1) % options.length, ArrowUp: (index - 1 + options.length) % options.length,
      Home: 0, End: options.length - 1 }[event.key];
    if (typeof next === "number") { event.preventDefault(); options[next].focus(); }
  });
  window.addEventListener("resize", position);
  window.visualViewport?.addEventListener("resize", position);
  trigger.append(icon("plus"));
  for (const [item, symbol, action] of [[items[0], "library", choosePhoto], [byId("choose-file"), "library", chooseFile], [byId("choose-voice"), "mic", chooseVoice], [byId("choose-call"), "mic", chooseCall], [byId("choose-routine"), "clock", chooseRoutine], [byId("choose-reminder"), "clock", chooseReminder]]) {
    item.prepend(icon(symbol));
    item.onclick = () => { close(true); action(); };
  }
  return close;
}
