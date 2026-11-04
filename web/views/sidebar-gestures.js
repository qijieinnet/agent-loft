import { closeSide, openSide } from "./sidebar.js";

/** 只接管明确的单指横滑；上下滚动、输入、横向内容和远程控制保留自己的手势。 */
export function bindSidebarGestures(layout, sidebar) {
  const mobile = matchMedia("(max-width: 768px)");
  let gesture = null;
  let suppressClickUntil = 0;

  const reset = () => {
    gesture = null;
    layout.classList.remove("side-dragging");
    layout.style.removeProperty("--side-reveal");
    layout.style.removeProperty("--side-progress");
  };
  const ownsHorizontalScroll = (target) => {
    for (let el = target; el && el !== layout; el = el.parentElement) {
      if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true;
    }
    return false;
  };

  layout.addEventListener("touchstart", (e) => {
    reset();
    suppressClickUntil = 0;
    if (!mobile.matches || e.touches.length !== 1) return;
    if (e.defaultPrevented || document.querySelector(".overlay, .popover")) return;
    const target = e.target;
    if (!(target instanceof Element) || target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), .desk-viewport, .term-pane, .msg-nav, .ws-panel") || ownsHorizontalScroll(target)) return;
    if (window.getSelection()?.isCollapsed === false) return;
    const touch = e.touches[0];
    const open = layout.classList.contains("side-open");
    if (open ? !sidebar.contains(target) && !target.closest(".scrim") : touch.clientX - layout.getBoundingClientRect().left > 32) return;
    gesture = {
      id: touch.identifier, x: touch.clientX, y: touch.clientY, open,
      width: sidebar.getBoundingClientRect().width, viewport: innerWidth,
      started: false, dx: 0, at: performance.now(),
    };
  }, { passive: true });

  layout.addEventListener("touchmove", (e) => {
    if (!gesture) return;
    const g = gesture;
    if (e.defaultPrevented || !mobile.matches || innerWidth !== g.viewport || e.touches.length !== 1 || layout.classList.contains("side-open") !== g.open) return reset();
    const touch = [...e.touches].find((t) => t.identifier === g.id);
    if (!touch) return reset();
    const dx = touch.clientX - g.x;
    const dy = touch.clientY - g.y;
    if (!g.started) {
      if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) return reset();
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
      if (g.open ? dx > 0 : dx < 0) return reset();
      g.started = true;
      layout.classList.add("side-dragging");
    }
    if (!e.cancelable) return reset();
    e.preventDefault();
    g.dx = dx;
    const reveal = Math.max(0, Math.min(g.width, (g.open ? g.width : 0) + dx));
    layout.style.setProperty("--side-reveal", `${reveal}px`);
    layout.style.setProperty("--side-progress", String(reveal / g.width));
  }, { passive: false });

  layout.addEventListener("touchend", (e) => {
    if (!gesture || ![...e.changedTouches].some((t) => t.identifier === gesture.id)) return;
    const g = gesture;
    if (g.started) {
      const distance = g.open ? -g.dx : g.dx;
      const commit = distance >= Math.min(80, g.width * 0.25) || (distance >= 28 && performance.now() - g.at < 250);
      suppressClickUntil = performance.now() + 400;
      if (commit) (g.open ? closeSide : openSide)();
    }
    reset();
  }, { passive: true });

  layout.addEventListener("touchcancel", reset, { passive: true });
  // 横滑从会话行或按钮开始时，松手不能再触发点击；下一次触摸会清除拦截。
  layout.addEventListener("click", (e) => {
    if (e.detail && performance.now() < suppressClickUntil) {
      e.preventDefault();
      e.stopImmediatePropagation();
      suppressClickUntil = 0;
    }
  }, { capture: true });
}
