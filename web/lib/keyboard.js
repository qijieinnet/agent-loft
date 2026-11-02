import { isTouch } from "./dom.js";

// iOS 不按 interactive-widget=resizes-content 缩小布局视口，100dvh 也不会避开键盘。
// 从主界面加载时就跟踪可见视口，让聊天、侧栏和远程控制共用一次高度补偿。
const vv = window.visualViewport;
if (vv && isTouch) {
  let last = 0;
  let frame = 0;
  let timers = [];
  const sync = () => {
    frame = 0;
    // 双指缩放不是软键盘；后台恢复时还没拿到有效尺寸也先保留当前布局。
    if (Math.abs(vv.scale - 1) > 0.01 || vv.height <= 0) return;
    const covered = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
    const style = document.documentElement.style;
    style.setProperty("--kb-inset", `${covered}px`);
    style.setProperty("--keyboard-input-max-height", `${Math.floor(Math.min(innerHeight, vv.height) * 0.4)}px`);
    // iOS 为露出光标推上去的外层容器，收键盘后有时不会复位。
    // 消息列表、输入框和终端自己的滚动位置保留。
    if (last > 0 && covered === 0) {
      window.scrollTo(0, 0);
      for (const el of [document.scrollingElement, ...document.querySelectorAll("#app, .layout, .main, .remote-pane, .remote-body")]) {
        if (el?.scrollTop) el.scrollTop = 0;
      }
    }
    last = covered;
  };
  const queue = () => {
    if (!frame) frame = requestAnimationFrame(sync);
  };
  const settle = () => {
    queue();
    timers.forEach(clearTimeout);
    // PWA 的 resize 可能先于 height / offsetTop 更新；动画结束后再读几次。
    timers = [80, 300, 700].map((delay) => setTimeout(queue, delay));
  };
  vv.addEventListener("resize", settle);
  vv.addEventListener("scroll", settle);
  for (const event of ["resize", "orientationchange", "pageshow"]) window.addEventListener(event, settle);
  for (const event of ["focusin", "focusout"]) document.addEventListener(event, settle);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) settle();
  });
  sync();
}
