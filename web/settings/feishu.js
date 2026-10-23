import { fill, h, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { S } from "../state.js";
import { confirmDialog, modal } from "../lib/overlay.js";
import { field, saveConfig } from "./common.js";

export function feishuTab(cfg, panel) {
  const bots = structuredClone(cfg.feishu.bots);
  const statusBox = new Map();
  const render = () => {
    fill(panel, 
      h(
        "div",
        { class: "row" },
        h("button", { class: "btn accent", onclick: () => registerBot() }, "扫码创建新机器人"),
        h(
          "button",
          {
            class: "btn",
            onclick: () => {
              bots.push({ id: "", name: "新机器人", enabled: true, appId: "", appSecret: "", domain: "feishu", allowFrom: [], agents: ["claude"], defaultAgent: "claude", _new: true });
              render();
            },
          },
          "手动添加",
        ),
      ),
      ...bots.map((b, i) => botSection(b, i)),
      bots.length === 0 ? h("div", { class: "muted" }, "还没有飞书机器人。") : null,
    );
  };
  const botSection = (b, i) => {
    const name = h("input", { value: b.name });
    const appId = h("input", { value: b.appId, placeholder: "cli_xxx" });
    const secret = h("input", { value: b.appSecret, placeholder: "App Secret", type: "password", autocomplete: "off" });
    const domain = h("select", {}, h("option", { value: "feishu", selected: b.domain !== "lark" }, "飞书"), h("option", { value: "lark", selected: b.domain === "lark" }, "Lark"));
    const allow = h("textarea", { rows: 2, placeholder: "ou_xxx，一行一个" });
    allow.value = b.allowFrom.join("\n");
    const enabled = h("input", { type: "checkbox", checked: b.enabled });
    const agentChecks = S.agents.map((a) => {
      const box = h("input", { type: "checkbox", checked: b.agents.includes(a.id), value: a.id });
      return { id: a.id, box, el: h("label", { class: "check" }, box, a.label) };
    });
    const def = h("select", {}, S.agents.map((a) => h("option", { value: a.id, selected: a.id === b.defaultAgent }, a.label)));
    const status = h("span", { class: "status-tag" }, "…");
    statusBox.set(b.id, status);
    const collect = () => ({
      ...b,
      name: name.value.trim(),
      appId: appId.value.trim(),
      appSecret: secret.value.trim(),
      domain: domain.value,
      allowFrom: allow.value.split(/[\s,]+/).filter(Boolean),
      enabled: enabled.checked,
      agents: agentChecks.filter((c) => c.box.checked).map((c) => c.id),
      defaultAgent: def.value,
    });
    return h(
      "div",
      { class: "section" },
      h("h4", {}, b.name || "机器人", b._new ? null : status, h("span", { class: "grow" }), h("label", { class: "check" }, enabled, "启用")),
      field("名称", name),
      h("div", { class: "row" }, h("div", { style: { flex: 1 } }, field("App ID", appId)), h("div", { style: { flex: 1 } }, field("App Secret", secret))),
      field("域名", domain),
      field("可用的 Agent", h("div", { class: "row" }, agentChecks.map((c) => c.el)), "勾一个 = 一个机器人对应一个 agent；勾多个可在会话里用 /agent 切换"),
      field("默认 Agent", def),
      field("Owner 白名单（open_id）", allow, "陌生人发消息会拿到配对码，在「授权」里批准即可，不必手填"),
      h(
        "div",
        { class: "row" },
        h(
          "button",
          {
            class: "btn primary",
            onclick: async () => {
              bots[i] = collect();
              delete bots[i]._new;
              await saveConfig(cfg, { feishu: { bots } });
              feishuTab(cfg, (fill(panel, ), panel));
            },
          },
          "保存",
        ),
        h(
          "button",
          {
            class: "btn",
            onclick: async () => {
              const v = collect();
              try {
                const r = await api("/api/feishu/test", { method: "POST", body: { id: b.id, appId: v.appId, appSecret: v.appSecret, domain: v.domain } });
                toast(r.ok ? "✅ 凭据有效" : `❌ ${r.message}`);
              } catch (err) {
                toast(err.message);
              }
            },
          },
          "测试凭据",
        ),
        h(
          "button",
          {
            class: "btn danger",
            onclick: async () => {
              if (!(await confirmDialog({ title: `删除机器人「${b.name}」？`, confirmText: "删除", danger: true }))) return;
              bots.splice(i, 1);
              if (!b._new) await saveConfig(cfg, { feishu: { bots } });
              render();
            },
          },
          "删除",
        ),
      ),
    );
  };
  const registerBot = async () => {
    const nameInput = h("input", { value: "Agent 助手" });
    const checks = S.agents.filter((a) => a.enabled).map((a) => ({ id: a.id, box: h("input", { type: "checkbox", checked: true }), label: a.label }));
    const body = h(
      "div",
      { class: "modal-body" },
      h("div", { class: "muted" }, "用飞书扫码，会自动创建一个飞书应用（机器人），并把扫码的你设为 owner。"),
      field("机器人名称", nameInput),
      field("可用的 Agent", h("div", { class: "row" }, checks.map((c) => h("label", { class: "check" }, c.box, c.label)))),
    );
    const go = h("button", { class: "btn primary" }, "生成二维码");
    const closeReg = modal({ title: "扫码创建飞书机器人", body, foot: h("div", { class: "modal-foot" }, go) });
    go.onclick = async () => {
      go.disabled = true;
      try {
        const reg = await api("/api/feishu/register", {
          method: "POST",
          body: { name: nameInput.value, agents: checks.filter((c) => c.box.checked).map((c) => c.id) },
        });
        const state = h("div", { class: "muted", style: { textAlign: "center" } }, "等待扫码确认…");
        fill(body, 
          h("div", { class: "qr", html: reg.qrSvg }),
          h("div", { class: "row", style: { justifyContent: "center" } }, h("a", { href: reg.qrUrl, target: "_blank", rel: "noopener" }, "手机上直接打开链接")),
          state,
        );
        go.remove();
        const poll = async () => {
          if (!body.isConnected) return;
          try {
            const r = await api(`/api/feishu/register/${reg.id}`);
            if (r.status === "pending") return setTimeout(poll, 3000);
            if (r.status === "success") {
              toast("✅ 机器人已创建并启动");
              closeReg();
              const fresh = await api("/api/config");
              Object.assign(cfg, fresh);
              await saveConfig(cfg, {});
              feishuTab(cfg, (fill(panel, ), panel));
              return;
            }
            state.textContent = { access_denied: "已拒绝授权", expired: "二维码已过期", timeout: "超时了" }[r.status] ?? `出错：${r.message ?? r.status}`;
          } catch (err) {
            state.textContent = err.message;
          }
        };
        setTimeout(poll, 3000);
      } catch (err) {
        toast(err.message);
        go.disabled = false;
      }
    };
  };
  render();
  api("/api/feishu/status")
    .then((list) => {
      for (const s of list) {
        const el = statusBox.get(s.id);
        if (!el) continue;
        const label = { connected: "已连接", connecting: "连接中", reconnecting: "重连中", failed: "连接失败", stopped: "已停止" }[s.state] ?? s.state;
        el.textContent = label;
        el.className = `status-tag ${s.state === "connected" ? "ok" : s.state === "failed" ? "bad" : ""}`;
        if (s.error) el.title = s.error;
      }
    })
    .catch(() => {});
}
