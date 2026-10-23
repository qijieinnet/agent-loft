/** 用时按大小换单位：12.3秒 / 3分12秒 / 1小时5分（和服务端 formatDuration 一致） */
function formatDuration(ms) {
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}秒`;
  const total = Math.round(sec);
  const hr = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (hr > 0) return `${hr}小时${m ? `${m}分` : ""}`;
  return `${m}分${s ? `${s}秒` : ""}`;
}

/** 回复进行中的实时用时：整秒跳动，12秒 / 3分05秒 / 1小时05分 */
export function liveDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hr = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (hr > 0) return `${hr}小时${String(m).padStart(2, "0")}分`;
  if (m > 0) return `${m}分${String(s).padStart(2, "0")}秒`;
  return `${s}秒`;
}

/** 服务端时间 - 本机时间。事件里的 ts 是服务端时钟，算用时要换算过来，免得两边时钟不准 */
let clockSkew = 0;
export const serverNow = () => Date.now() + clockSkew;
export const setServerTime = (serverTime) => (clockSkew = serverTime - Date.now());

/** 所有进行中的用时一秒刷一次，只改文字，不重建消息 */
setInterval(() => {
  for (const el of document.querySelectorAll(".ai-elapsed[data-start]")) {
    el.textContent = liveDuration(serverNow() - Number(el.dataset.start));
  }
}, 1000);

/** 老版本记下的脚注是「用时 1234.5s」，显示时也换成时 / 分 / 秒 */
export function tidyFooter(footer) {
  return footer?.replace(/用时 ([\d.]+)s/, (_, s) => `用时 ${formatDuration(Number(s) * 1000)}`) ?? "";
}

/** 回复下面的时间：今天只显示时分，今年显示月日，再早带上年份 */
export function clockTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}年${md} ${hm}`;
}

export function relTime(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr} 小时前`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN");
}
