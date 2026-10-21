// 按住拖动排序：顶栏的服务器标签（横向）、设置页的服务器列表（竖向）共用。
//
// 用 pointer 事件自己做，不用 HTML5 拖放（那个会拖出一个半透明的截图，样式没法控制）：
//   - 按下后移动超过几像素才算开始拖，没动就是普通点击；
//   - 被拖的那项跟着鼠标走（只沿一个方向，不出头尾），其余项带过渡让出位置；
//   - 松手：先在页面上把它挪到新位置（不等主进程，免得闪回原位），再调 onDrop(id, 新序号)；
//   - 拖完那一下不算点击（不然松手在标签上会顺带切换服务器）。
// 拖的过程中状态还会不停推过来（在线状态、额度……），重画会把正在拖的元素换掉，
// 所以拖的时候 sortDragging 为 true，shell.js 先不重画，拖完再补一次。

let sortDragging = false;

/**
 * @param {HTMLElement} container 各项的父元素（各项是它的直接子元素，带 data-id）
 * @param {{ axis: "x" | "y", item: string, ignore?: string, onDrop: (id: string, to: number) => void, onEnd?: () => void }} opts
 *   item：项的选择器；ignore：按在这些元素上不开始拖（按钮、输入框……）
 */
function sortable(container, { axis, item, ignore, onDrop, onEnd }) {
  const THRESHOLD = 4;
  const start = (r) => (axis === "x" ? r.left : r.top);
  const end = (r) => (axis === "x" ? r.right : r.bottom);
  const mid = (r) => (start(r) + end(r)) / 2;
  const shift = (el, d) => (el.style.transform = d ? (axis === "x" ? `translateX(${d}px)` : `translateY(${d}px)`) : "");

  container.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    const el = e.target.closest(item);
    if (!el || el.parentElement !== container) return;
    if (ignore && e.target.closest(ignore) && !e.target.closest(ignore).contains(el)) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    /** @type {null | { items: HTMLElement[], index: number, rects: DOMRect[], step: number, target: number }} */
    let drag = null;

    const begin = () => {
      const items = [...container.children].filter((c) => c.matches(item));
      const index = items.indexOf(el);
      const rects = items.map((c) => c.getBoundingClientRect());
      const gap = items.length > 1 ? Math.max(0, start(rects[1]) - end(rects[0])) : 0;
      const step = end(rects[index]) - start(rects[index]) + gap;
      sortDragging = true;
      window.getSelection()?.removeAllRanges();
      document.body.classList.add("sorting-body");
      container.classList.add("sorting-active");
      el.classList.add("sorting");
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // 指针已经没了：照样拖，靠 window 上的监听
      }
      return { items, index, rects, step, target: index };
    };

    const move = (ev) => {
      const d0 = axis === "x" ? ev.clientX - x0 : ev.clientY - y0;
      if (!drag) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < THRESHOLD) return;
        drag = begin();
      }
      const { items, index, rects, step } = drag;
      // 不拖出第一项的头、最后一项的尾
      const d = Math.max(start(rects[0]) - start(rects[index]), Math.min(d0, end(rects.at(-1)) - end(rects[index])));
      shift(el, d);
      // 往前拖看前沿、往后拖看后沿，越过别项的中线就占它的位置。
      // 不用自己的中点：各项宽度不一样（标签名有长有短），宽的那项拖到头时中点可能过不了第一项的中线
      const lead = start(rects[index]) + d;
      const tail = end(rects[index]) + d;
      let target = index;
      for (let i = 0; i < index; i++) if (lead < mid(rects[i])) { target = i; break; }
      for (let i = items.length - 1; i > index; i--) if (tail > mid(rects[i])) { target = i; break; }
      drag.target = target;
      items.forEach((c, i) => {
        if (i === index) return;
        shift(c, i > index && i <= target ? -step : i < index && i >= target ? step : 0);
      });
    };

    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (!drag) return;
      const { items, index, target } = drag;
      // 先在页面上挪好，再清掉位移：不带过渡，免得各项先弹回原位再跳过去
      for (const c of items) c.style.transition = "none";
      if (target !== index) {
        const ref = target > index ? items[target].nextSibling : items[target];
        container.insertBefore(el, ref);
      }
      for (const c of items) shift(c, 0);
      void container.offsetWidth;
      for (const c of items) c.style.transition = "";
      el.classList.remove("sorting");
      container.classList.remove("sorting-active");
      document.body.classList.remove("sorting-body");
      sortDragging = false;
      // 吃掉松手后紧跟着的那次 click；没有 click 的话下一轮事件循环就撤掉，不影响之后的点击
      const swallow = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      if (target !== index) onDrop(el.dataset.id, target);
      onEnd?.();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  });
}
