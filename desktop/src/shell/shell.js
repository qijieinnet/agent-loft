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

/** 「本机有会话在跑时不休眠」：说清楚现在是什么情况 */
function keepAwakeHint() {
  if (!state.localId) return `只对${THIS_PC}上的服务端生效。服务器列表里还没有本机，加上之后才会起作用。`;
  if (state.awake?.reason === "本机有会话在跑") return "本机正有会话在跑，正在阻止系统休眠（屏幕仍可以关）。";
  return `只对${THIS_PC}上的服务端生效，远程服务器不受影响。会话跑完后恢复正常休眠，屏幕照常可以关。`;
}

const AWAKE_MODES = [
  ["system", "跟随系统"],
  ["always", "永不休眠"],
  ...(IS_MAC ? [["scheduled", "定时休眠"]] : []),
];
const WINDOW_LENGTHS = [30, 60, 120, 180, 240, 360, 480, 600, 720];
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const lengthText = (min) => (min < 60 ? `${min} 分钟` : `${min / 60} 小时`);

function awakeModeHint(p) {
  const a = state.awake;
  if (p.awakeMode === "always") return "一直阻止系统闲置休眠，屏幕照常可以关。";
  if (p.awakeMode === "scheduled") {
    if (!p.sleepWindows.some((w) => w.enabled && w.days.length)) return "还没有可用的休眠时段，先加一个。";
    if (a?.waiting) return `已到休眠时段，${a.waiting}。`;
    if (a?.reason === "休眠时段外") return "现在在休眠时段外，正在阻止系统休眠。";
    return "现在在休眠时段内，系统可以正常休眠。";
  }
  return "按系统的节能设置休眠。";
}

/** 定时休眠的一个时段：开始时间、持续多久、哪几天、启用 / 删除 */
function sleepWindowRow(w, list) {
  const save = (patch) => call("setPref", "sleepWindows", list.map((x) => (x.id === w.id ? { ...x, ...patch } : x)));
  const end = w.start + w.length;
  return h(
    "div",
    { class: `sleep-window ${w.enabled ? "" : "off"}` },
    h("input", { type: "checkbox", class: "switch", checked: w.enabled, title: "启用这个时段", onchange: (e) => save({ enabled: e.target.checked }) }),
    h("input", {
      type: "time",
      class: "time",
      value: hhmm(w.start),
      onchange: (e) => {
        const [hh, mm] = e.target.value.split(":").map(Number);
        if (Number.isFinite(hh) && Number.isFinite(mm)) void save({ start: hh * 60 + mm });
      },
    }),
    h("span", { class: "sub" }, "起"),
    h(
      "select",
      { class: "select", onchange: (e) => save({ length: Number(e.target.value) }) },
      [...new Set([...WINDOW_LENGTHS, w.length])].sort((a, b) => a - b).map((m) => h("option", { value: m, selected: m === w.length }, lengthText(m))),
    ),
    h("span", { class: "sub until" }, `到${end >= 24 * 60 ? "次日 " : ""}${hhmm(end % (24 * 60))}`),
    h("button", { class: "btn del", title: "删除这个时段", onclick: () => call("setPref", "sleepWindows", list.filter((x) => x.id !== w.id)) }, "删除"),
    h(
      "div",
      { class: "pick days" },
      WEEKDAYS.map((name, d) => {
        const on = w.days.includes(d);
        return h("button", { class: on ? "on" : "", "aria-pressed": String(on), onclick: () => save({ days: on ? w.days.filter((x) => x !== d) : [...w.days, d] }) }, name);
      }),
    ),
  );
}

/** 防休眠这一组设置 */
function awakePrefs(p, toggle) {
  const mode = h(
    "div",
    { class: "row" },
    h("div", { class: "grow" }, "防休眠", h("div", { class: "sub" }, awakeModeHint(p))),
    h(
      "div",
      { class: "pick" },
      AWAKE_MODES.map(([key, name]) => h("button", { class: p.awakeMode === key ? "on" : "", "aria-pressed": String(p.awakeMode === key), onclick: () => call("setPref", "awakeMode", key) }, name)),
    ),
  );
  const scheduled = IS_MAC && p.awakeMode === "scheduled";
  const windows = scheduled
    ? h(
        "div",
        { class: "row" },
        h(
          "div",
          { class: "grow" },
          "休眠时段",
          h("div", { class: "sub wrap" }, "时段外一直不休眠；进了时段，本机没有会话在跑时让 Mac 睡下去，每个时段只睡一次。"),
          h("div", { class: "sleep-windows" }, p.sleepWindows.map((w) => sleepWindowRow(w, p.sleepWindows))),
          p.sleepWindows.length < 10
            ? h(
                "button",
                {
                  class: "btn add-window",
                  onclick: () => call("setPref", "sleepWindows", [...p.sleepWindows, { id: Math.random().toString(36).slice(2, 10), enabled: true, start: 23 * 60, length: 480, days: [0, 1, 2, 3, 4, 5, 6] }]),
                },
                "添加时段",
              )
            : null,
        ),
      )
    : null;
  const locked = scheduled ? toggle("sleepRequireLocked", "锁屏后才休眠", "到了休眠时段也要等屏幕锁上才睡，免得正在用电脑时突然睡过去。") : null;
  const lid = IS_MAC
    ? h(
        "div",
        { class: "row switch-row" },
        h(
          "label",
          { for: "p-lidGuard" },
          h("div", {}, "合盖不休眠"),
          h(
            "div",
            { class: "sub wrap" },
            state.awake?.lidGuard === null
              ? "读不到系统的状态。"
              : "系统级设置（pmset disablesleep），开关都要输管理员密码。打开后退出 Agent Loft、重启也一直有效，合盖放进包里也不会睡，记得用完关掉。",
          ),
        ),
        h("input", {
          id: "p-lidGuard",
          type: "checkbox",
          class: "switch",
          checked: !!state.awake?.lidGuard,
          disabled: state.awake?.lidGuard === null,
          onchange: async (e) => {
            const want = e.target.checked;
            e.target.disabled = true;
            try {
              await call("setLidGuard", want);
            } catch (err) {
              alert(errText(err));
            }
            // 取消授权时状态没变，界面跟着系统实际值回去
            renderPrefs();
          },
        }),
      )
    : null;
  return [toggle("keepAwake", "本机有会话在跑时不休眠", keepAwakeHint()), mode, windows, locked, lid];
}

/**
 * macOS 菜单栏图标上显示哪些 5 小时额度：「所有服务器（取最高）」一行，连着多台时每台再一行，
 * 每行 Claude / Codex 可多选。存成「服务器 id:agent」，* 是所有服务器；顺序就是这里从上到下、Claude 在前
 */
function trayPicker(items) {
  const AGENTS = [
    ["claude", "Claude"],
    ["codex", "Codex"],
  ];
  const lines = [["*", "所有服务器（取最高）"]];
  if (state.servers.length > 1) for (const s of state.servers) lines.push([s.id, `${s.icon ? `${s.icon} ` : ""}${s.name}`]);
  const order = lines.flatMap(([sid]) => AGENTS.map(([a]) => `${sid}:${a}`));
  return h(
    "div",
    { class: "row" },
    h(
      "div",
      { class: "grow" },
      "菜单栏显示 5 小时额度",
      h(
        "div",
        { class: "sub" },
        "图标换成所选的 5 小时已用百分比；按服务器选的，图标下面的小字会带上服务器名。都不选就只显示图标。",
      ),
      h(
        "div",
        { class: "tray-pick" },
        lines.map(([sid, label]) =>
          h(
            "div",
            { class: "tray-line" },
            h("span", { class: "tray-label" }, label),
            h(
              "div",
              { class: "pick" },
              AGENTS.map(([agent, name]) => {
                const key = `${sid}:${agent}`;
                const on = items.includes(key);
                return h(
                  "button",
                  {
                    class: on ? "on" : "",
                    "aria-pressed": String(on),
                    onclick: () => {
                      // 删掉的服务器留下的项顺手清掉
                      const next = order.filter((k) => (k === key ? !on : items.includes(k)));
                      void call("setPref", "trayItems", next);
                    },
                  },
                  name,
                );
              }),
            ),
          ),
        ),
      ),
    ),
  );
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
  const tray = IS_MAC ? trayPicker(p.trayItems) : null;
  // 正在改数字时别重画，不然光标会跳
  if (manage.prefs.contains(document.activeElement) && ["number", "time"].includes(document.activeElement.type)) return;
  fill(
    manage.prefs,
    toggle("openAtLogin", "登录时自动启动", `启动后只在${TRAY_PLACE}，不弹窗口。`),
    awakePrefs(p, toggle),
    tray,
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
