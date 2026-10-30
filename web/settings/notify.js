import { fill, h, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { relTime } from "../lib/time.js";
import { currentPushSub, enablePush, pushSupport } from "../lib/push.js";
import { refreshShellPush } from "../lib/shell.js";
import { WS } from "../lib/ws.js";

export async function notifyTab(panel) {
  const support = pushSupport();
  const box = h("div", { class: "section" }, h("h4", {}, "系统通知"), h("span", { class: "spinner" }));
  fill(panel, box);
  const render = async () => {
    let data = { subscriptions: [] };
    try {
      data = await api("/api/push");
    } catch (err) {
      fill(box, h("h4", {}, "系统通知"), h("div", { class: "error-text" }, err.message));
      return;
    }
    const mine = await currentPushSub();
    const here = mine && data.subscriptions.some((d) => d.endpoint === mine.endpoint);
    const busy = (btn, fn) => async () => {
      btn.disabled = true;
      try {
        await fn();
      } catch (err) {
        toast(err.message);
      }
      btn.disabled = false;
      // 多服务器的外壳：开关通知后，转给各台的订阅跟着变
      void WS.refreshPushPresence();
      void refreshShellPush();
      await render();
    };
    const onBtn = h("button", { class: "btn primary" }, "在此设备开启通知");
    onBtn.onclick = busy(onBtn, async () => {
      await enablePush();
      toast("已开启，可以发一条测试通知看看");
    });
    const offBtn = h("button", { class: "btn" }, "关闭此设备的通知");
    offBtn.onclick = busy(offBtn, async () => {
      await api("/api/push/unsubscribe", { method: "POST", body: { endpoint: mine.endpoint } });
      await mine.unsubscribe().catch(() => {});
      toast("已关闭");
    });
    const testBtn = h("button", { class: "btn" }, "发送测试通知");
    testBtn.onclick = busy(testBtn, async () => {
      const r = await api("/api/push/test", { method: "POST" });
      toast(`已发送到 ${r.sent} 台设备`);
    });
    fill(
      box,
      h("h4", {}, "系统通知"),
      h("div", { class: "muted" }, "Web 对话里 agent 回复完成、出错、需要授权或向你提问时，推送到开启了通知的设备。本设备的应用在前台时不推送，打开或切回应用会清除本应用的历史通知和角标。飞书对话由飞书自己提醒。"),
      support.ok
        ? h("div", { class: "row" }, here ? offBtn : onBtn, data.subscriptions.length ? testBtn : null)
        : support.framed
          ? [h("div", { class: "muted" }, support.why), data.subscriptions.length ? h("div", { class: "row" }, testBtn) : null]
          : h("div", { class: "error-text" }, support.why),
      // 推送用不了（比如不是 HTTPS）：至少让页面开着、切到别的窗口时能弹提醒
      !support.ok && !support.framed && "Notification" in window && Notification.permission === "default"
        ? h(
            "div",
            { class: "row" },
            h(
              "button",
              { class: "btn", onclick: async () => (await Notification.requestPermission(), void render()) },
              "允许这个页面弹出提醒",
            ),
            h("span", { class: "muted" }, "页面开着、但你在看别的窗口时，需要授权会弹出浏览器提醒"),
          )
        : null,
      support.ok && Notification.permission === "denied"
        ? h("div", { class: "error-text" }, "这个设备的通知权限已被拒绝，需要到系统设置（iPhone：设置 → 通知 → Agent Loft）里重新打开。")
        : null,
      h("h4", {}, "已开启通知的设备"),
      data.subscriptions.length === 0
        ? h("div", { class: "muted" }, "还没有")
        : data.subscriptions.map((d) => {
            const rm = h("button", { class: "btn small" }, "移除");
            rm.onclick = busy(rm, async () => {
              await api("/api/push/unsubscribe", { method: "POST", body: { endpoint: d.endpoint } });
              if (mine && mine.endpoint === d.endpoint) await mine.unsubscribe().catch(() => {});
            });
            return h(
              "div",
              { class: "list-item" },
              h(
                "div",
                { class: "grow" },
                h("div", { class: "t" }, d.label, mine && mine.endpoint === d.endpoint ? "（本设备）" : ""),
                h("div", { class: "s" }, `开启于 ${relTime(d.createdAt)}${d.lastOkAt ? ` · 上次送达 ${relTime(d.lastOkAt)}` : ""}`),
              ),
              rm,
            );
          }),
    );
  };
  await render();
}
