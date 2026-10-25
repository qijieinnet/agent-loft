// ---------- 远程桌面：手机上的手势 ----------
// noVNC 自己的手势是「触摸屏」式的（手指点哪就点哪），而且没法在本地放大：手机上 1600 宽的桌面缩到 390 宽，
// 按钮小得点不准。这里在外层用捕获阶段把触摸事件全接过来自己处理：画面用 CSS 在本地放大、拖动，
// 鼠标按帧缓冲坐标直接发给 VNC（坐标按画布实际显示的位置换算，所以放大了也对得上）。
//
// 两种模式（像微软远程桌面）：
//   触控板（默认）：屏幕上有个指针，单指滑动移动它，轻点在指针处单击，双指轻点右键，长按后拖动是按住左键拖，
//                   双指滑动滚动，双指捏合放大；放大后指针推到边上，画面跟着走。
//   触摸：点哪就点哪，长按右键，长按后拖动是按住左键拖；放大后单指拖动是挪画面，没放大时单指拖动是按住左键拖。

const MOVE_SLOP = 8;
const LONG_PRESS_MS = 420;
const MAX_ZOOM = 5;
/** 双指滑动多少像素算滚一格 */
const WHEEL_STEP = 22;

const BTN = { left: 1, middle: 2, right: 4, up: 8, down: 16, wleft: 32, wright: 64 };

/**
 * viewport：裁剪用的外框；screen：交给 noVNC 的那块（在它上面做 CSS 放大）。
 * send(x, y, mask)：按帧缓冲坐标发鼠标；mods：点击前后按下 / 松开粘住的修饰键（Ctrl、Alt…）
 */
export function createTouch({ viewport, screen, send, active, mods, onZoom }) {
  const Z = { s: 1, tx: 0, ty: 0 };
  /** 指针在帧缓冲里的位置（触控板模式下画出来） */
  const P = { x: 0, y: 0 };
  let mode = localStorage.getItem("aim.deskTouch") === "touch" ? "touch" : "trackpad";
  let buttons = 0;
  let g = null;
  let movePending = false;

  const cursor = document.createElement("div");
  cursor.className = "desk-cursor";
  cursor.innerHTML =
    '<svg viewBox="0 0 20 24" aria-hidden="true"><path d="M2 1.5v18l4.6-4.4 3 7 3.2-1.4-3-6.8H16Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  viewport.append(cursor);

  const canvas = () => screen.querySelector("canvas");
  const fb = () => {
    const c = canvas();
    return c && c.width > 0 ? { w: c.width, h: c.height } : null;
  };

  // ---------- 本地放大 / 拖动 ----------

  /** 放大后画面不能拖出边界；比视口小的那个方向居中 */
  function clamp() {
    const c = canvas();
    if (!c) return;
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    // offsetLeft / offsetWidth 是没算 transform 的布局值（.desk-screen 是 offsetParent）
    const axis = (t, off, size, view) => {
      const scaled = size * Z.s;
      if (scaled <= view) return (view - scaled) / 2 - off * Z.s;
      return Math.min(-off * Z.s, Math.max(view - scaled - off * Z.s, t));
    };
    Z.tx = axis(Z.tx, c.offsetLeft, c.offsetWidth, vw);
    Z.ty = axis(Z.ty, c.offsetTop, c.offsetHeight, vh);
    if (Z.s === 1) Z.tx = Z.ty = 0;
  }

  function apply() {
    // 藏着（切到终端、回了对话）时量出来是 0：别拿它重算，等露出来再说
    if (!viewport.clientWidth || !viewport.clientHeight) return;
    clamp();
    screen.style.transform = Z.s === 1 ? "" : `translate(${Z.tx}px, ${Z.ty}px) scale(${Z.s})`;
    placeCursor();
    onZoom(Z.s);
  }

  /** 以 (cx, cy)（页面坐标）为中心缩放到 s */
  function zoomAt(s, cx, cy) {
    const r = viewport.getBoundingClientRect();
    const lx = (cx - r.left - Z.tx) / Z.s;
    const ly = (cy - r.top - Z.ty) / Z.s;
    Z.s = Math.max(1, Math.min(MAX_ZOOM, s));
    Z.tx = cx - r.left - lx * Z.s;
    Z.ty = cy - r.top - ly * Z.s;
    apply();
  }

  function pan(dx, dy) {
    if (Z.s === 1) return;
    Z.tx += dx;
    Z.ty += dy;
    apply();
  }

  // ---------- 坐标 ----------

  function toFb(clientX, clientY) {
    const c = canvas();
    const size = fb();
    if (!c || !size) return null;
    const r = c.getBoundingClientRect();
    return {
      x: Math.round(Math.max(0, Math.min(size.w - 1, ((clientX - r.left) / r.width) * size.w))),
      y: Math.round(Math.max(0, Math.min(size.h - 1, ((clientY - r.top) / r.height) * size.h))),
    };
  }

  /** 指针在视口里的位置（像素） */
  function cursorInView() {
    const c = canvas();
    const size = fb();
    if (!c || !size) return null;
    const r = c.getBoundingClientRect();
    const v = viewport.getBoundingClientRect();
    return { x: r.left - v.left + (P.x / size.w) * r.width, y: r.top - v.top + (P.y / size.h) * r.height };
  }

  function placeCursor() {
    const at = mode === "trackpad" && active() ? cursorInView() : null;
    cursor.hidden = !at;
    if (at) cursor.style.transform = `translate(${at.x}px, ${at.y}px)`;
  }

  /** 放大时指针推到边上：画面跟着走 */
  function followCursor() {
    const at = cursorInView();
    if (!at || Z.s === 1) return;
    const m = 36;
    const dx = at.x < m ? m - at.x : at.x > viewport.clientWidth - m ? viewport.clientWidth - m - at.x : 0;
    const dy = at.y < m ? m - at.y : at.y > viewport.clientHeight - m ? viewport.clientHeight - m - at.y : 0;
    if (dx || dy) pan(dx, dy);
  }

  // ---------- 发鼠标 ----------

  function moveTo(x, y) {
    const size = fb();
    if (!size) return;
    P.x = Math.max(0, Math.min(size.w - 1, Math.round(x)));
    P.y = Math.max(0, Math.min(size.h - 1, Math.round(y)));
    placeCursor();
    // 一帧最多发一次
    if (movePending) return;
    movePending = true;
    requestAnimationFrame(() => {
      movePending = false;
      send(P.x, P.y, buttons);
    });
  }

  function press(mask) {
    if (!buttons) mods.down();
    buttons |= mask;
    send(P.x, P.y, buttons);
    cursor.classList.add("pressed");
  }

  function release(mask) {
    buttons &= ~mask;
    send(P.x, P.y, buttons);
    if (!buttons) {
      mods.up();
      cursor.classList.remove("pressed");
    }
  }

  function click(mask) {
    press(mask);
    release(mask);
  }

  function wheel(mask, times) {
    for (let i = 0; i < times; i++) {
      send(P.x, P.y, buttons | mask);
      send(P.x, P.y, buttons);
    }
  }

  // ---------- 手势 ----------

  const point = (t) => ({ x: t.clientX, y: t.clientY });
  const mid = (ts) => ({ x: (ts[0].clientX + ts[1].clientX) / 2, y: (ts[0].clientY + ts[1].clientY) / 2 });
  const dist = (ts) => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
  const vibrate = () => navigator.vibrate?.(12);

  function onLong() {
    if (!g || g.moved || g.fingers !== 1) return;
    g.hold = true;
    vibrate();
    cursor.classList.add("armed");
    // 触摸模式：长按的地方就是要点的地方
    if (mode === "touch") {
      const p = toFb(g.x0, g.y0);
      if (p) moveTo(p.x, p.y);
    }
  }

  function start(e) {
    e.preventDefault();
    e.stopPropagation();
    const ts = e.touches;
    if (!g) {
      const p = point(ts[0]);
      g = { x0: p.x, y0: p.y, last: p, t: performance.now(), v: 0, fingers: 1, max: 1, moved: false, hold: false, dragging: false };
      g.timer = setTimeout(onLong, LONG_PRESS_MS);
    }
    g.fingers = ts.length;
    g.max = Math.max(g.max, ts.length);
    if (ts.length >= 2) {
      clearTimeout(g.timer);
      g.two = { d0: dist(ts), s0: Z.s, c: mid(ts), kind: null, acc: { x: 0, y: 0 } };
    }
  }

  function move(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!g) return;
    const ts = e.touches;
    // 双指：捏合放大，或者滚动
    if (ts.length >= 2 && g.two) {
      const c = mid(ts);
      const d = dist(ts);
      const two = g.two;
      if (!two.kind) {
        if (Math.abs(d - two.d0) > 24) two.kind = "pinch";
        else if (Math.hypot(c.x - two.c.x, c.y - two.c.y) > 10) two.kind = "scroll";
        else return;
        g.moved = true;
      }
      if (two.kind === "pinch") {
        zoomAt(two.s0 * (d / two.d0), c.x, c.y);
        pan(c.x - two.c.x, c.y - two.c.y);
      } else {
        // 跟手机上一样的「自然滚动」：手指往上推，内容往下走
        two.acc.x += c.x - two.c.x;
        two.acc.y += c.y - two.c.y;
        const ny = Math.trunc(two.acc.y / WHEEL_STEP);
        const nx = Math.trunc(two.acc.x / WHEEL_STEP);
        if (ny) wheel(ny < 0 ? BTN.down : BTN.up, Math.abs(ny));
        if (nx) wheel(nx < 0 ? BTN.wright : BTN.wleft, Math.abs(nx));
        two.acc.y -= ny * WHEEL_STEP;
        two.acc.x -= nx * WHEEL_STEP;
      }
      two.c = c;
      return;
    }
    // 双指松开了一个：剩下那个不算新手势，免得指针跳一下
    if (g.max >= 2) return;
    const p = point(ts[0]);
    if (!g.moved && Math.hypot(p.x - g.x0, p.y - g.y0) < MOVE_SLOP) return;
    g.moved = true;
    clearTimeout(g.timer);
    const now = performance.now();
    const dx = p.x - g.last.x;
    const dy = p.y - g.last.y;
    const dt = Math.max(1, now - g.t);
    g.last = p;
    g.t = now;
    if (mode === "trackpad") {
      if (g.hold && !g.dragging) {
        g.dragging = true;
        press(BTN.left);
      }
      // 屏幕上挪多少，指针在画面上就挪多少；划得快再加速一点
      const c = canvas();
      const size = fb();
      if (!c || !size) return;
      const perPx = size.w / c.getBoundingClientRect().width;
      const speed = Math.hypot(dx, dy) / dt;
      const accel = 1 + Math.min(2, Math.max(0, (speed - 0.25) * 1.6));
      moveTo(P.x + dx * perPx * accel, P.y + dy * perPx * accel);
      followCursor();
      return;
    }
    // 触摸模式
    if (g.hold || Z.s === 1) {
      if (!g.dragging) {
        const from = toFb(g.x0, g.y0);
        if (from) moveTo(from.x, from.y);
        g.dragging = true;
        press(BTN.left);
      }
      const to = toFb(p.x, p.y);
      if (to) moveTo(to.x, to.y);
    } else {
      pan(dx, dy);
    }
  }

  function end(e) {
    // touchcancel 不能取消（cancelable 为 false），硬取消浏览器会报错
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    if (!g || e.touches.length > 0) return;
    clearTimeout(g.timer);
    cursor.classList.remove("armed");
    const gest = g;
    g = null;
    if (gest.dragging) return release(BTN.left);
    // 被系统打断了（来电、下拉通知栏）：不是松手，别点下去
    if (gest.moved || e.type === "touchcancel") return;
    if (mode === "touch") {
      const p = toFb(gest.x0, gest.y0);
      if (p) moveTo(p.x, p.y);
    }
    // 双指轻点、长按不动：右键；轻点：左键
    click(gest.max >= 2 || gest.hold ? BTN.right : BTN.left);
  }

  // 画面上浮着的按钮（右下角「还原」）照常交给浏览器去点，别当成在桌面上点
  const mine = (e) => active() && !e.target.closest?.("button");
  const opts = { capture: true, passive: false };
  viewport.addEventListener("touchstart", (e) => mine(e) && start(e), opts);
  viewport.addEventListener("touchmove", (e) => g && move(e), opts);
  viewport.addEventListener("touchend", (e) => g && end(e), opts);
  viewport.addEventListener("touchcancel", (e) => g && end(e), opts);
  // 转屏、窗口变了：画面重新摆好
  new ResizeObserver(() => apply()).observe(viewport);

  return {
    get mode() {
      return mode;
    },
    setMode(next) {
      mode = next;
      localStorage.setItem("aim.deskTouch", mode);
      placeCursor();
    },
    get zoom() {
      return Z.s;
    },
    resetZoom() {
      Z.s = 1;
      apply();
    },
    /** 连上了：指针放到中间，画面还原 */
    connected() {
      const size = fb();
      if (size) {
        P.x = Math.round(size.w / 2);
        P.y = Math.round(size.h / 2);
      }
      Z.s = 1;
      apply();
    },
    refresh: placeCursor,
  };
}
