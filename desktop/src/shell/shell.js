// 顶栏（服务器标签、设置）+ 下面的面板（服务器管理、连不上、证书确认）。
// 当前服务器正常时，面板被服务器自己的页面盖住，看不到。

let state = null;
const $servers = document.getElementById("servers");
const $panel = document.getElementById("panel");
const $settings = document.getElementById("settings");

const call = (method, ...args) => window.loft.call(method, ...args);

// ---------- 顶栏 ----------

function renderBar() {
  document.body.classList.toggle("fullscreen", !!state.fullscreen);
  $servers.replaceChildren(
    ...state.servers.map((s) => {
      const active = s.id === state.activeId && !state.managing;
      const count = s.unread || s.pending.length;
      const detail = [STATUS_TEXT[s.status] ?? s.status, s.busy ? `${s.busy} 个运行中` : "", s.pending.length ? `${s.pending.length} 个待处理` : ""]
        .filter(Boolean)
        .join(" · ");
      return h(
        "button",
        { class: `tab ${s.status} ${active ? "active" : ""}`, title: `${s.name}\n${detail}`, onclick: () => call("select", s.id) },
        serverIcon(s, "avatar"),
        h("span", { class: "name" }, s.name),
        h("span", { class: `status` }),
        count ? h("span", { class: `badge ${s.unread ? "" : "pending"}` }, count > 99 ? "99+" : count) : null,
      );
    }),
  );
  // 选中的标签滚进可见范围（标签多、窗口窄时）
  $servers.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  $settings.classList.toggle("on", state.managing);
  // 有新版本：齿轮上一个小红点
  $settings.classList.toggle("has-update", !!state.system.update.available || state.servers.some((s) => s.server?.updateAvailable && s.server.canUpgrade));
}

$settings.addEventListener("click", () => {
  if (state.managing && state.activeId) void call("select", state.activeId);
  else void call("manage");
});

// ---------- 下面的面板 ----------

let mode = null;

function renderPanel() {
  if (!state.onboarded || wizardOverride) {
    if (!mode?.startsWith("wizard")) wiz.built = null;
    mode = "wizard";
    renderWizard();
    return;
  }
  const active = state.servers.find((s) => s.id === state.activeId);
  if (state.managing || !active) {
    if (mode !== "manage") buildManage();
    mode = "manage";
    renderManage();
    return;
  }
  mode = `server:${active.id}:${active.loadFailed ? "failed" : "ok"}:${active.cert ? "cert" : ""}`;
  if (!active.loadFailed) {
    $panel.replaceChildren();
    return;
  }
  $panel.replaceChildren(active.cert ? certNotice(active) : offlineNotice(active));
}

function offlineNotice(s) {
  return h(
    "div",
    { class: "panel-inner notice" },
    serverIcon(s, "big-avatar"),
    h("h1", {}, `连不上「${s.name}」`),
    h("p", { class: "muted" }, s.url),
    h("p", { class: "muted" }, s.loadFailed.message || s.error || ""),
    h("p", { class: "hint" }, "确认 agent-loft 正在运行（agent-loft start 或 agent-loft service status），以及这台电脑能访问到它。"),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn primary", onclick: () => call("reload", s.id) }, "重试"),
      h("button", { class: "btn", onclick: () => openServerDialog(s) }, "修改地址"),
    ),
  );
}

function certNotice(s) {
  return h(
    "div",
    { class: "panel-inner notice" },
    serverIcon(s, "big-avatar"),
    h("h1", {}, "证书不受信任"),
    h("p", { class: "muted" }, `${s.url} 的 HTTPS 证书无法验证（${s.cert.error}）。`),
    h("p", { class: "hint" }, "如果这是你自己签发的证书，核对下面的指纹和服务器上的一致后再信任。之后只要证书不变就直接连接。"),
    h(
      "div",
      { class: "fingerprint mono" },
      h("div", {}, `指纹：${s.cert.fingerprint}`),
      h("div", {}, `签发给：${s.cert.subject}`),
      h("div", {}, `签发者：${s.cert.issuer}`),
    ),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn primary", onclick: () => call("trustCert", s.id) }, "信任这个证书"),
      h("button", { class: "btn", onclick: () => call("reload", s.id) }, "重试"),
    ),
  );
}

// ---------- 服务器管理 ----------

const manage = {};

function buildManage() {
  manage.list = h("div");
  manage.prefs = h("div", { class: "card" });
  manage.local = h("div", { class: "card" });
  manage.update = h("div", { class: "card", id: "update-card" });
  manage.intro = h("div");

  $panel.replaceChildren(
    h(
      "div",
      { class: "panel-inner" },
      manage.intro,
      manage.list,
      h("p", { class: "hint", style: { marginTop: "8px" } }, "每台服务器各自登录、各自保存登录状态。切到别的服务器时页面仍在后台连着，回复完成、需要授权时会弹系统通知。"),
      h("h2", {}, "本机服务端"),
      manage.local,
      h("h2", {}, "通用"),
      manage.prefs,
      h("h2", {}, "更新"),
      manage.update,
      h("p", { class: "hint", style: { marginTop: "12px" } }, `Agent Loft 桌面端 ${state.version}`),
    ),
  );
}

function renderManage() {
  const empty = state.servers.length === 0;
  manage.intro.replaceChildren(
    empty
      ? h(
          "div",
          { style: { textAlign: "center", padding: "6vh 0 8px" } },
          h("h1", {}, "连接你的 agent-loft"),
          h("p", { class: "muted" }, "填上运行 agent-loft 的机器地址。可以添加多台，在顶栏切换。"),
          h("button", { class: "btn primary", style: { marginTop: "10px" }, onclick: () => openServerDialog(null) }, "添加服务器"),
        )
      : h(
          "div",
          { class: "list-head" },
          h("h1", {}, "服务器"),
          h("button", { class: "btn primary", onclick: () => openServerDialog(null) }, "添加服务器"),
        ),
  );
  manage.list.replaceChildren(
    empty
      ? ""
      : h(
          "div",
          { class: "card" },
          state.servers.map((s, i) => [
            h(
              "div",
              { class: "row" },
              serverIcon(s, "mini-avatar"),
              h(
                "div",
                { class: "grow" },
                h("div", { class: "name" }, s.name),
                h(
                  "div",
                  { class: "sub" },
                  h("span", { class: `dot ${s.status}`, style: { marginRight: "6px", verticalAlign: "0" } }),
                  [
                    STATUS_TEXT[s.status] ?? s.status,
                    s.url,
                    s.trusted ? "已信任自签证书" : "",
                    s.serviceTokenId ? "Service Token" : "",
                    s.authDomains.length ? `登录域名 ${s.authDomains.join("、")}` : "",
                  ]
                    .filter(Boolean)
                    .join(" · "),
                ),
                serverVersionLine(s),
              ),
              h(
                "div",
                { class: "actions" },
                iconBtn("上移", "M10 15V5M5 10l5-5 5 5", () => call("moveServer", s.id, -1), i === 0),
                iconBtn("下移", "M10 5v10M5 10l5 5 5-5", () => call("moveServer", s.id, 1), i === state.servers.length - 1),
                serverUpgradeButton(s),
                s.status === "online"
                  ? h(
                      "button",
                      {
                        class: `btn ${manage.expanded === s.id ? "on" : ""}`,
                        title: "Claude Code、Codex 装好、登录了没有",
                        onclick: () => {
                          manage.expanded = manage.expanded === s.id ? null : s.id;
                          if (manage.expanded && agentEnv.id !== s.id) {
                            agentEnv.data = null;
                            void loadAgentEnv(s.id);
                          }
                          renderManage();
                        },
                      },
                      "Agent 环境",
                    )
                  : null,
                h("button", { class: "btn", onclick: () => openServerDialog(s) }, "编辑"),
                h("button", { class: "btn", onclick: () => call("select", s.id) }, "打开"),
              ),
            ),
            manage.expanded === s.id && s.status === "online" ? h("div", { class: "expand" }, agentEnvBox()) : null,
          ]),
        ),
  );
  renderPrefs();
  renderLocalCard(manage.local);
  renderUpdateCard(manage.update);
}

function iconBtn(title, d, onclick, disabled) {
  return withPath(h("button", { class: "icon-btn", title, onclick, disabled }), d);
}

/** h() 建的是 HTML 元素，SVG 得用 createElementNS */
function withPath(btn, d) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.7");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  btn.append(svg);
  return btn;
}

function renderPrefs() {
  const p = state.prefs;
  const toggle = (key, label, hint) =>
    h(
      "div",
      { class: "row switch-row" },
      h("label", { for: `p-${key}` }, h("div", {}, label), hint ? h("div", { class: "sub" }, hint) : null),
      h("input", { id: `p-${key}`, type: "checkbox", class: "switch", checked: p[key], onchange: (e) => call("setPref", key, e.target.checked) }),
    );
  const interval = h("input", {
    class: "num",
    type: "number",
    min: 1,
    max: 1440,
    value: p.quotaRefreshMin,
    onchange: (e) => {
      const v = Number(e.target.value);
      if (Number.isFinite(v) && v >= 1) void call("setPref", "quotaRefreshMin", v);
    },
  });
  // 正在改数字时别重画，不然光标会跳
  if (manage.prefs.contains(document.activeElement)) return;
  manage.prefs.replaceChildren(
    toggle("openAtLogin", "登录时自动启动", "启动后只在菜单栏，不弹窗口。"),
    h("div", { class: "row" }, h("div", { class: "grow" }, "额度刷新间隔（分钟）", h("div", { class: "sub" }, "跑完一轮、打开菜单栏面板时也会刷新。")), interval),
  );
}

// ---------- 状态 ----------

function render() {
  if (!state) return;
  renderBar();
  renderPanel();
}

window.loft.onState((s) => {
  state = s;
  render();
});
window.loft.onShow((what) => {
  if (what === "add") requestAnimationFrame(() => void openServerDialog(null));
  if (what === "update") requestAnimationFrame(() => document.getElementById("update-card")?.scrollIntoView({ behavior: "smooth", block: "center" }));
});
window.loft.state().then((s) => {
  state = s;
  render();
});
