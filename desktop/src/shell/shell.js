// 左侧服务器栏 + 右侧面板（服务器管理、连不上、证书确认）。
// 当前服务器正常时，右侧被服务器自己的页面盖住，这里的面板看不到。

let state = null;
const $servers = document.getElementById("servers");
const $panel = document.getElementById("panel");
const $add = document.getElementById("add");
const $settings = document.getElementById("settings");

const call = (method, ...args) => window.loft.call(method, ...args);

// ---------- 服务器栏 ----------

function renderRail() {
  $servers.replaceChildren(
    ...state.servers.map((s) => {
      const active = s.id === state.activeId && !state.managing;
      const count = s.unread || s.pending.length;
      const tip = [s.name, s.url, STATUS_TEXT[s.status] ?? s.status];
      if (s.pending.length) tip.push(`${s.pending.length} 个待处理`);
      if (s.busy) tip.push(`${s.busy} 个运行中`);
      return h(
        "button",
        { class: `srv ${s.status} ${active ? "active" : ""}`, title: tip.join("\n"), onclick: () => call("select", s.id) },
        h("div", { class: "avatar", style: { background: serverColor(s.id) } }, initials(s.name)),
        h("span", { class: `status dot ${s.status}` }),
        count ? h("span", { class: `badge ${s.unread ? "" : "pending"}` }, count > 99 ? "99+" : count) : null,
      );
    }),
  );
  $settings.classList.toggle("on", state.managing);
  // 有新版本：齿轮上一个小红点
  $settings.classList.toggle("has-update", !!state.system.update.available || state.servers.some((s) => s.server?.updateAvailable && s.server.canUpgrade));
}

$add.addEventListener("click", () => {
  void call("manage");
  showForm(null);
});
$settings.addEventListener("click", () => {
  if (state.managing && state.activeId) void call("select", state.activeId);
  else void call("manage");
});

// ---------- 右侧面板 ----------

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
    h("div", { class: "big-avatar", style: { background: serverColor(s.id) } }, initials(s.name)),
    h("h1", {}, `连不上「${s.name}」`),
    h("p", { class: "muted" }, s.url),
    h("p", { class: "muted" }, s.loadFailed.message || s.error || ""),
    h("p", { class: "hint" }, "确认 agent-loft 正在运行（agent-loft start 或 agent-loft service status），以及这台电脑能访问到它。"),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn primary", onclick: () => call("reload", s.id) }, "重试"),
      h("button", { class: "btn", onclick: () => (call("manage"), showForm(s)) }, "修改地址"),
    ),
  );
}

function certNotice(s) {
  return h(
    "div",
    { class: "panel-inner notice" },
    h("div", { class: "big-avatar", style: { background: serverColor(s.id) } }, initials(s.name)),
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
  manage.formTitle = h("h2", {}, "添加服务器");
  manage.name = h("input", { id: "f-name", placeholder: "例如：家里 Mac mini", maxlength: 40 });
  manage.url = h("input", { id: "f-url", placeholder: "http://192.168.1.5:8800 或 https://loft.example.com", spellcheck: "false" });
  manage.error = h("div", { class: "error-text" });
  manage.submit = h("button", { class: "btn primary", type: "submit" }, "添加");
  manage.cancel = h("button", { class: "btn", type: "button", onclick: () => showForm(null) }, "取消");
  manage.editing = null;
  // 登录网关：服务器前面挡着 Cloudflare Access 之类的验证时才需要
  manage.domains = h("input", { id: "f-domains", placeholder: "例如：sso.example.com, accounts.google.com", spellcheck: "false" });
  manage.tokenId = h("input", { id: "f-token-id", placeholder: "xxxxxxxx.access", spellcheck: "false", autocomplete: "off" });
  manage.tokenSecret = h("input", { id: "f-token-secret", type: "password", autocomplete: "new-password", spellcheck: "false" });
  manage.advanced = h(
    "details",
    { class: "advanced" },
    h("summary", {}, "登录网关（Cloudflare Access 等）"),
    h(
      "p",
      { class: "hint" },
      "服务器前面有 Cloudflare Access 时，打开服务器会先显示它的验证页（邮箱验证码、Google / GitHub 登录），直接在窗口里完成就行，不用在这里填什么。验证过期时会弹通知提醒。",
    ),
    h(
      "div",
      { class: "field" },
      h("label", { for: "f-domains" }, "额外的登录域名（可选）"),
      manage.domains,
      h("div", { class: "hint" }, "用的不是 Cloudflare、或者 Cloudflare 后面接了自己的 SSO 时，把登录页的域名填在这里，多个用逗号隔开。*.cloudflareaccess.com 不用填。"),
    ),
    h("div", { class: "field" }, h("label", { for: "f-token-id" }, "Service Token · Client ID（可选）"), manage.tokenId),
    h("div", { class: "field" }, h("label", { for: "f-token-secret" }, "Service Token · Client Secret"), manage.tokenSecret),
    h(
      "div",
      { class: "hint" },
      "配了 Service Token 就不用再做邮箱验证，也不会过期。需要在 Cloudflare 的 Access 策略里加一条 Service Auth 规则放行这个 Token。Secret 用 macOS 钥匙串加密保存；清空 Client ID 再保存即删除。",
    ),
  );
  manage.form = h(
    "form",
    { class: "server-form", onsubmit: onSubmit },
    h("div", { class: "field" }, h("label", { for: "f-url" }, "地址"), manage.url),
    h("div", { class: "field" }, h("label", { for: "f-name" }, "名称（可选）"), manage.name),
    manage.advanced,
    manage.error,
    h("div", { class: "form-actions" }, manage.submit, manage.cancel),
  );
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
      manage.formTitle,
      h("div", { class: "card" }, manage.form),
      h("p", { class: "hint", style: { marginTop: "8px" } }, "每台服务器各自登录、各自保存登录状态。切到别的服务器时页面仍在后台连着，回复完成、需要授权时会弹系统通知。"),
      h("h2", {}, "本机服务端"),
      manage.local,
      h("h2", {}, "菜单栏和通知"),
      manage.prefs,
      h("h2", {}, "更新"),
      manage.update,
      h("p", { class: "hint", style: { marginTop: "12px" } }, `Agent Loft 桌面端 ${state.version}`),
    ),
  );
  showForm(null);
}

function renderManage() {
  const empty = state.servers.length === 0;
  manage.intro.replaceChildren(
    empty
      ? h(
          "div",
          { style: { textAlign: "center", padding: "6vh 0 8px" } },
          h("h1", {}, "连接你的 agent-loft"),
          h("p", { class: "muted" }, "填上运行 agent-loft 的机器地址。可以添加多台，在左边切换。"),
        )
      : h("h1", {}, "服务器"),
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
              h("div", { class: "mini-avatar", style: { background: serverColor(s.id) } }, initials(s.name)),
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
                h("button", { class: "btn", onclick: () => showForm(s) }, "编辑"),
                h("button", { class: "btn", onclick: () => call("select", s.id) }, "打开"),
              ),
            ),
            manage.expanded === s.id && s.status === "online" ? h("div", { class: "expand" }, agentEnvBox()) : null,
          ]),
        ),
  );
  manage.cancel.hidden = empty && !manage.editing;
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

/** 表单切到「添加」（s 为空）或「编辑 s」 */
function showForm(s) {
  if (!manage.form) return;
  manage.editing = s?.id ?? null;
  manage.formTitle.textContent = s ? `编辑「${s.name}」` : "添加服务器";
  manage.submit.textContent = s ? "保存" : "添加";
  manage.name.value = s?.name ?? "";
  manage.url.value = s?.url ?? "";
  manage.domains.value = (s?.authDomains ?? []).join(", ");
  manage.tokenId.value = s?.serviceTokenId ?? "";
  manage.tokenSecret.value = "";
  manage.tokenSecret.placeholder = s?.serviceTokenId ? "已保存，留空则不改" : "";
  manage.advanced.open = !!(s?.serviceTokenId || s?.authDomains?.length);
  manage.error.textContent = "";
  manage.cancel.hidden = !s && state.servers.length === 0;
  manage.cancel.textContent = s ? "取消" : "清空";
  for (const el of manage.form.querySelectorAll(".remove")) el.remove();
  if (s) {
    manage.form
      .querySelector(".form-actions")
      .append(h("button", { class: "btn danger remove", type: "button", style: { marginLeft: "auto" }, onclick: () => call("removeServer", s.id).then((ok) => ok && showForm(null)) }, "移除这台服务器"));
  }
  requestAnimationFrame(() => manage.url.focus());
}

async function onSubmit(e) {
  e.preventDefault();
  manage.error.textContent = "";
  manage.submit.disabled = true;
  try {
    const auth = {
      authDomains: manage.domains.value,
      serviceToken: { clientId: manage.tokenId.value, secret: manage.tokenSecret.value },
    };
    if (manage.editing) await call("updateServer", manage.editing, { name: manage.name.value, url: manage.url.value }, auth);
    else await call("addServer", manage.name.value, manage.url.value, auth);
    showForm(null);
  } catch (err) {
    // ipcRenderer.invoke 的错误信息前面带了一串前缀，只留最后的说明
    manage.error.textContent = String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  } finally {
    manage.submit.disabled = false;
  }
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
    toggle("hoverPopover", "悬停菜单栏图标时显示面板", "显示各服务器的额度、待处理和运行中的会话。关掉后悬停只显示文字提示，点击图标仍会弹出面板。"),
    toggle("trayTitle", "菜单栏图标旁显示额度", "显示最紧的那个 5 小时窗口的占用百分比。"),
    toggle("openAtLogin", "登录时自动启动", "启动后只在菜单栏，不弹窗口。"),
    h("div", { class: "row" }, h("div", { class: "grow" }, "额度刷新间隔（分钟）", h("div", { class: "sub" }, "跑完一轮、打开菜单栏面板时也会刷新。")), interval),
  );
}

// ---------- 状态 ----------

function render() {
  if (!state) return;
  renderRail();
  renderPanel();
}

window.loft.onState((s) => {
  state = s;
  render();
});
window.loft.onShow((what) => {
  if (what === "add") requestAnimationFrame(() => showForm(null));
  if (what === "update") requestAnimationFrame(() => document.getElementById("update-card")?.scrollIntoView({ behavior: "smooth", block: "center" }));
});
window.loft.state().then((s) => {
  state = s;
  render();
});
