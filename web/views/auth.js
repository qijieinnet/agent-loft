import { $app, fill, h } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { WS } from "../lib/ws.js";
import { boot } from "./layout.js";
import { mountSwitcher } from "../lib/shell.js";

// ---------- 登录 ----------

export async function showAuth() {
  WS.stopped = true;
  WS.sock?.close();
  let me = { needsSetup: false };
  try {
    me = await api("/api/me");
  } catch {
    // 网络问题时按登录处理
  }
  const err = h("div", { class: "error-text" });
  const pw = h("input", { type: "password", placeholder: "密码", autocomplete: me.needsSetup ? "new-password" : "current-password" });
  const token = h("input", { placeholder: "设置码（在启动日志里）", autocomplete: "off" });
  // 只有一个用户时和以前一样只要密码；多个用户才要填用户名
  const askName = me.needsSetup || me.multiUser;
  const name = h("input", {
    placeholder: me.needsSetup ? "admin" : "用户名",
    autocomplete: "username",
    autocapitalize: "off",
    spellcheck: "false",
  });
  const btn = h("button", { class: "btn primary", type: "submit" }, me.needsSetup ? "设置密码并进入" : "登录");
  const form = h(
    "form",
    {
      class: "auth-card",
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        btn.disabled = true;
        try {
          if (me.needsSetup) {
            await api("/api/setup", { method: "POST", body: { token: token.value, name: name.value.trim() || "admin", password: pw.value } });
          } else {
            await api("/api/login", { method: "POST", body: { ...(askName ? { name: name.value.trim() } : {}), password: pw.value } });
          }
          await boot();
        } catch (e2) {
          err.textContent = e2.message;
        } finally {
          btn.disabled = false;
        }
      },
    },
    h("h1", {}, "Agent Loft"),
    h("p", {}, me.needsSetup ? "首次使用：输入启动日志里的设置码，建一个管理员账号（密码至少 8 位）" : "登录以继续"),
    me.needsSetup ? h("label", { class: "field" }, h("span", {}, "设置码"), token) : null,
    askName ? h("label", { class: "field" }, h("span", {}, me.needsSetup ? "管理员用户名" : "用户名"), name) : null,
    h("label", { class: "field" }, h("span", {}, me.needsSetup ? "新密码" : "密码"), pw),
    btn,
    err,
  );
  // 被嵌在别的服务器的页面里（多服务器）：左上角照样能切回去，不然手机上就困在登录页了
  fill($app, h("div", { class: "auth" }, mountSwitcher("auth", h("div", { class: "auth-switch", hidden: true })), form));
  (me.needsSetup ? token : askName ? name : pw).focus();
}
