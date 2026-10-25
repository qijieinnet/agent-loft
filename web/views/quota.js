import { agentIcon, fill, h } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { relTime } from "../lib/time.js";
import { desktop, desktopQuota, S, ui } from "../state.js";

// ---------- 侧栏底部的账号额度 ----------
// 服务端不主动查：只有前端请求 /api/quota 时才去问各 agent，结果缓存 60 秒
// （60 秒内再请求直接返回缓存；Claude 要临时拉一个 CLI 进程才问得到，不能太勤）。
// 前端什么时候请求：
//   - 打开页面拉一次；
//   - 空闲时每隔 S.quotaRefreshMin 分钟（设置 → Agent → 账号额度，默认 10，0 = 不自动刷新），只在页面可见时；
//   - 有会话跑完一轮：10 秒后拉；若那时服务端缓存还没过期，就推迟到过期之后，保证拿到新数据；
//   - 切回前台：距上次超过一个刷新间隔就拉；
//   - 点一下额度区域：立刻拉（可能拿到 60 秒内的缓存）。
// 设置 → Agent 里关了「查询额度」（S.quotaEnabled）：以上全都不做，侧栏也不显示额度。
// 在桌面端里（desktopQuota）以上全都不做：桌面端统一去查（同一个账号的多台服务器只问一台），
// 查好推过来；点一下额度区域是请桌面端去刷新。

export const quotaState = { data: null, at: 0, loading: false, timer: 0, idle: 0 };
const QUOTA_SERVER_CACHE = 60_000;
const quotaInterval = () => (S.quotaEnabled ? (S.quotaRefreshMin ?? 10) * 60_000 : 0);

export async function loadQuota() {
  if (!S.quotaEnabled) {
    quotaState.data = null;
    renderQuota();
    return;
  }
  if (desktopQuota) {
    ui.quota?.classList.add("loading");
    desktop.refreshQuota();
    return;
  }
  if (quotaState.loading) return;
  quotaState.loading = true;
  ui.quota?.classList.add("loading");
  try {
    const data = await api("/api/quota");
    quotaState.data = data.quotas;
    quotaState.at = Date.now();
    desktop?.setQuota(data.quotas);
  } catch {
    // 保留旧数据
  } finally {
    quotaState.loading = false;
    ui.quota?.classList.remove("loading");
    renderQuota();
    scheduleIdleQuota();
  }
}

/** 桌面端推来的额度。查失败（error）时保留旧数据 */
export function applyDesktopQuota(payload) {
  if (Array.isArray(payload?.quotas) && !payload.error) {
    quotaState.data = payload.quotas;
    quotaState.at = payload.at || Date.now();
  }
  ui.quota?.classList.remove("loading");
  renderQuota();
}

/** 空闲定时：每次拉完重新计时，所以刚因为跑完一轮拉过，就不会紧接着又拉 */
export function scheduleIdleQuota() {
  clearTimeout(quotaState.idle);
  if (desktopQuota || !quotaInterval()) return;
  quotaState.idle = setTimeout(() => {
    // 页面不可见就先不拉，等切回来再说
    if (document.visibilityState === "visible") void loadQuota();
  }, quotaInterval());
}

/** 一轮跑完：10 秒后拉；服务端缓存那时还没过期就推迟到过期之后 */
export function scheduleQuota() {
  // 桌面端里：它从页面报的运行数看出跑完了一轮，自己会去查
  if (desktopQuota || !S.quotaEnabled) return;
  const wait = Math.max(10_000, quotaState.at + QUOTA_SERVER_CACHE + 1000 - Date.now());
  clearTimeout(quotaState.timer);
  quotaState.timer = setTimeout(() => void loadQuota(), wait);
}

document.addEventListener("visibilitychange", () => {
  if (desktopQuota || document.visibilityState !== "visible" || !ui.quota || !quotaInterval()) return;
  if (Date.now() - quotaState.at >= quotaInterval()) void loadQuota();
});

function untilText(ms) {
  const sec = Math.floor((ms - Date.now()) / 1000);
  if (sec <= 0) return "即将重置";
  const d = Math.floor(sec / 86400);
  const hh = Math.floor((sec % 86400) / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} 天 ${hh} 小时后重置`;
  if (hh > 0) return `${hh} 小时 ${mm} 分后重置`;
  return `${Math.max(1, mm)} 分钟后重置`;
}

function quotaLevel(p) {
  return p >= 90 ? "danger" : p >= 75 ? "warn" : "";
}

export function renderQuota() {
  if (!ui.quota) return;
  const list = S.quotaEnabled ? (quotaState.data ?? []) : [];
  if (ui.sideBottom) ui.sideBottom.hidden = list.length === 0;
  if (list.length === 0) return fill(ui.quota);
  const rows = list.map((q) =>
    h(
      "div",
      { class: `quota-row${q.reached ? " reached" : ""}` },
      agentIcon(q.agent, "agent-icon quota-icon"),
      q.windows.slice(0, 2).map((w) =>
        h(
          "span",
          { class: `quota-cell ${quotaLevel(w.percent)}` },
          h("span", { class: "q-label" }, w.short),
          h("span", { class: "q-bar" }, h("i", { style: { width: `${Math.max(2, Math.min(100, w.percent))}%` } })),
          h("span", { class: "q-pct" }, `${Math.round(w.percent)}%`),
        ),
      ),
    ),
  );
  const tip = h(
    "div",
    { class: "quota-tip" },
    list.map((q) =>
      h(
        "div",
        { class: "qt-agent" },
        h("div", { class: "qt-head" }, agentIcon(q.agent), h("b", {}, q.label), q.plan ? h("span", { class: "qt-plan" }, q.plan) : null),
        q.windows.map((w) =>
          h(
            "div",
            { class: "qt-row" },
            h("span", { class: "qt-name" }, w.label),
            h("span", { class: `qt-pct ${quotaLevel(w.percent)}` }, `已用 ${Math.round(w.percent)}%`),
            w.resetsAt ? h("span", { class: "qt-reset" }, untilText(w.resetsAt)) : null,
          ),
        ),
        q.extra ? h("div", { class: "qt-extra" }, q.extra) : null,
        q.reached ? h("div", { class: "qt-extra danger" }, "已达上限，等窗口重置后才能继续") : null,
      ),
    ),
    h("div", { class: "qt-foot" }, `${relTime(quotaState.at)}更新 · 点击刷新`),
  );
  fill(ui.quota, h("button", { class: "quota-btn", onclick: () => void loadQuota() }, rows), tip);
}
