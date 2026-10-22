// 顶栏（服务器标签、更多）+ 下面的面板（服务器管理、连不上、证书确认）。
// 当前服务器正常时，面板被服务器自己的页面盖住，看不到。

let state = null;
const $servers = document.getElementById("servers");
const $panel = document.getElementById("panel");
const $more = document.getElementById("more");

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
        { class: `tab ${s.status} ${active ? "active" : ""}`, "data-id": s.id, title: `${s.name}\n${detail}`, onclick: () => call("select", s.id) },
        serverIcon(s, "avatar"),
        h("span", { class: "name" }, s.name),
        h("span", { class: `status` }),
        count ? h("span", { class: `badge ${s.unread ? "" : "pending"}` }, count > 99 ? "99+" : count) : null,
      );
    }),
  );
  // 选中的标签滚进可见范围（标签多、窗口窄时）
  $servers.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  $more.classList.toggle("on", state.managing);
  // 有新版本：按钮上一个小红点
  $more.classList.toggle("has-update", !!state.system.update.available || state.servers.some((s) => s.server?.updateAvailable && s.server.canUpgrade));
}

// 按住标签左右拖：调整服务器顺序
sortable($servers, { axis: "x", item: ".tab", onDrop: (id, to) => void call("moveServer", id, to), onEnd: flushRender });

// 更多：弹原生菜单（下面挂着服务器页面，HTML 下拉会被它盖住）
$more.addEventListener("click", () => {
  const r = $more.getBoundingClientRect();
  void call("moreMenu", { x: Math.round(r.left), y: Math.round(r.bottom + 4) });
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
  // 服务器列表：各项是它的直接子元素，按住一行上下拖调整顺序（按钮上按下不算）
  manage.list = h("div", { class: "card server-list" });
  sortable(manage.list, {
    axis: "y",
    item: ".server-item",
    ignore: "button, a, input, select, textarea, .expand",
    onDrop: (id, to) => void call("moveServer", id, to),
    onEnd: flushRender,
  });
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
  manage.list.hidden = empty;
  manage.list.replaceChildren(
    ...state.servers.map((s) =>
      h(
        "div",
        { class: "server-item", "data-id": s.id },
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
      ),
    ),
  );
  renderPrefs();
  renderLocalCard(manage.local);
  renderUpdateCard(manage.update);
}

/** 防休眠只管本机服务端：说清楚现在是什么情况 */
function keepAwakeHint() {
  if (!state.localId) return `只对${THIS_PC}上的服务端生效。服务器列表里还没有本机，加上之后才会起作用。`;
  if (state.keepingAwake) return "本机正有会话在跑，正在阻止系统休眠（屏幕仍可以关）。合上笔记本盖子依然会睡。";
  return `只对${THIS_PC}上的服务端生效，远程服务器不受影响。会话跑完后恢复正常休眠，屏幕照常可以关。`;
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
  if (manage.prefs.contains(document.activeElement) && document.activeElement.type === "number") return;
  manage.prefs.replaceChildren(
    toggle("openAtLogin", "登录时自动启动", `启动后只在${TRAY_PLACE}，不弹窗口。`),
    toggle("keepAwake", "本机有会话在跑时不休眠", keepAwakeHint()),
    h("div", { class: "row" }, h("div", { class: "grow" }, "额度刷新间隔（分钟）", h("div", { class: "sub" }, PLATFORM === "linux" ? "跑完一轮时也会刷新。" : `跑完一轮、打开${TRAY_PLACE}面板时也会刷新。`)), interval),
  );
}

// ---------- 状态 ----------

let renderQueued = false;

function render() {
  if (!state) return;
  // 正在拖着排序：先不重画（会把拖着的元素换掉），拖完再补
  if (sortDragging) {
    renderQueued = true;
    return;
  }
  renderBar();
  renderPanel();
}

function flushRender() {
  if (!renderQueued) return;
  renderQueued = false;
  render();
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
