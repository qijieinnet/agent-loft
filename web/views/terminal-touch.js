import { h } from "../lib/dom.js";
import { copyText } from "../lib/markdown.js";

// ---------- 终端：手机上的手势 ----------
// xterm.js 在手机上既不能用手指翻历史，也不能长按选字。这里补上：
//   单指上下滑：翻看历史（带惯性）；在 less、vim 这类占满整屏的程序里换成发 ↑↓（它们自己没有历史可翻）
//   长按：选中按住的那个词，接着拖动能扩大选区；松手后上面出一条「复制 / 全选 / 取消」
//   轻点：照旧交给 xterm（弹出键盘）

const SLOP = 8;
const LONG_PRESS_MS = 450;

/** tab：{ term, el }；sendInput(data)：发给 shell（↑↓ 用） */
export function attachTermTouch(tab, sendInput) {
  const { term, el } = tab;
  let g = null;
  let fling = 0;
  let selecting = null;

  const bar = h(
    "div",
    { class: "term-selbar", hidden: true },
    h("button", { onpointerdown: (e) => e.preventDefault(), onclick: (e) => void copySel(e.currentTarget) }, "复制"),
    h("button", { onpointerdown: (e) => e.preventDefault(), onclick: () => (term.selectAll(), showBar()) }, "全选"),
    h("button", { onpointerdown: (e) => e.preventDefault(), onclick: () => clearSel() }, "取消"),
  );
  el.append(bar);

  const screenEl = () => el.querySelector(".xterm-screen");
  /** 屏幕上的点 → 缓冲区里的 (列, 行) */
  function cellAt(x, y) {
    const r = screenEl()?.getBoundingClientRect();
    if (!r || !r.width) return null;
    const col = Math.max(0, Math.min(term.cols - 1, Math.floor(((x - r.left) / r.width) * term.cols)));
    const row = Math.max(0, Math.min(term.rows - 1, Math.floor(((y - r.top) / r.height) * term.rows)));
    return { col, row: term.buffer.active.viewportY + row };
  }
  const lineHeight = () => (screenEl()?.getBoundingClientRect().height || 0) / term.rows || 16;

  /** 按住的那个词（连续的非空格格子；中文一个字占两格，第二格是空的） */
  function wordAt(cell) {
    const line = term.buffer.active.getLine(cell.row);
    if (!line) return { start: cell.col, len: 1 };
    const filled = (i) => {
      const c = line.getCell(i);
      if (!c) return false;
      const ch = c.getChars();
      return ch === "" ? c.getWidth() === 0 : ch.trim() !== "";
    };
    if (!filled(cell.col)) return { start: cell.col, len: 1 };
    let a = cell.col;
    let b = cell.col;
    while (a > 0 && filled(a - 1)) a--;
    while (b < term.cols - 1 && filled(b + 1)) b++;
    return { start: a, len: b - a + 1 };
  }

  function selectRange(from, to) {
    const [a, b] = from.row < to.row || (from.row === to.row && from.col <= to.col) ? [from, to] : [to, from];
    term.select(a.col, a.row, (b.row - a.row) * term.cols + (b.col - a.col) + 1);
  }

  function showBar() {
    bar.hidden = !term.hasSelection();
  }

  function clearSel() {
    term.clearSelection();
    selecting = null;
    bar.hidden = true;
  }

  async function copySel(btn) {
    const text = term.getSelection();
    if (!text) return;
    await copyText(text, btn);
    setTimeout(clearSel, 600);
  }

  // ---------- 滚动 ----------

  let acc = 0;
  /** 往下翻（看更新的）为正 */
  function scrollBy(lines) {
    if (!lines) return;
    if (term.buffer.active.type === "alternate") {
      // 占满整屏的程序：发 ↑↓ 让它自己翻
      const app = term.modes.applicationCursorKeysMode;
      const seq = lines > 0 ? (app ? "\x1bOB" : "\x1b[B") : app ? "\x1bOA" : "\x1b[A";
      sendInput(seq.repeat(Math.min(Math.abs(lines), 20)));
    } else term.scrollLines(lines);
  }

  function dragScroll(dy) {
    // 手指往上推，内容往上走：看下面（更新）的内容
    acc -= dy;
    const lh = lineHeight();
    const n = Math.trunc(acc / lh);
    if (n) {
      scrollBy(n);
      acc -= n * lh;
    }
  }

  function startFling(v) {
    cancelAnimationFrame(fling);
    let last = performance.now();
    const step = (now) => {
      // 标签关掉了
      if (!el.isConnected) return;
      const dt = now - last;
      last = now;
      v *= Math.pow(0.95, dt / 16);
      if (Math.abs(v) < 0.03) return;
      dragScroll(v * dt);
      fling = requestAnimationFrame(step);
    };
    fling = requestAnimationFrame(step);
  }

  // ---------- 手势 ----------

  function onLong() {
    if (!g || g.moved) return;
    const cell = cellAt(g.x0, g.y0);
    if (!cell) return;
    navigator.vibrate?.(12);
    const w = wordAt(cell);
    selecting = { anchor: { col: w.start, row: cell.row }, end: { col: w.start + w.len - 1, row: cell.row } };
    term.select(w.start, cell.row, w.len);
    g.selecting = true;
  }

  const opts = { capture: true, passive: false };
  el.addEventListener(
    "touchstart",
    (e) => {
      if (e.target.closest(".term-selbar")) return;
      cancelAnimationFrame(fling);
      if (e.touches.length !== 1) {
        clearTimeout(g?.timer);
        g = null;
        return;
      }
      const t = e.touches[0];
      g = { x0: t.clientX, y0: t.clientY, last: t.clientY, t: performance.now(), v: 0, moved: false, selecting: false };
      g.timer = setTimeout(onLong, LONG_PRESS_MS);
      acc = 0;
    },
    opts,
  );
  el.addEventListener(
    "touchmove",
    (e) => {
      if (!g || e.touches.length !== 1) return;
      const t = e.touches[0];
      if (!g.moved && Math.hypot(t.clientX - g.x0, t.clientY - g.y0) < SLOP) return;
      g.moved = true;
      clearTimeout(g.timer);
      e.preventDefault();
      e.stopPropagation();
      if (g.selecting) {
        // 长按选中后接着拖：扩大选区
        const cell = cellAt(t.clientX, t.clientY);
        if (cell) {
          selecting.end = cell;
          selectRange(selecting.anchor, cell);
        }
        return;
      }
      const now = performance.now();
      const dy = t.clientY - g.last;
      g.v = dy / Math.max(1, now - g.t);
      g.last = t.clientY;
      g.t = now;
      dragScroll(dy);
    },
    opts,
  );
  const end = (e) => {
    if (!g) return;
    clearTimeout(g.timer);
    const gest = g;
    g = null;
    if (gest.selecting) {
      // 别让这次松手变成一次点击（会弹出键盘、清掉选区）
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      showBar();
      return;
    }
    if (gest.moved) {
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      // 手指停住一会儿才松开的不甩
      if (Math.abs(gest.v) > 0.3 && performance.now() - gest.t < 80) startFling(gest.v);
      return;
    }
    // 轻点：有选区就先取消，否则照常交给 xterm
    if (term.hasSelection()) clearSel();
  };
  el.addEventListener("touchend", end, opts);
  el.addEventListener("touchcancel", end, opts);
  term.onSelectionChange(() => {
    if (!term.hasSelection()) bar.hidden = true;
  });
}
