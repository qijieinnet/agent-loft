// 主窗口面板里的几块「系统」界面：首次启动向导、本机服务端、Agent 环境、服务端版本、桌面端更新。
// 普通脚本，和 shell.js 共用全局的 h / call / state（shell.js 在后面加载，这里的函数都是调用时才用到它们）。

const errText = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

// ---------- Agent 环境（向导和设置页共用；任意服务器，登录只能在本机） ----------

const agentEnv = { id: null, loading: false, data: null, error: null, el: null, installing: false };

async function loadAgentEnv(id, refresh = false) {
  agentEnv.id = id;
  agentEnv.loading = true;
  agentEnv.error = null;
  renderAgentEnv();
  try {
    agentEnv.data = (await call("agentHealth", id, refresh)).agents;
  } catch (err) {
    agentEnv.error = errText(err);
  } finally {
    agentEnv.loading = false;
    renderAgentEnv();
  }
}

function agentEnvBox() {
  agentEnv.el ??= h("div", { class: "agent-env" });
  renderAgentEnv();
  return agentEnv.el;
}

function renderAgentEnv() {
  const el = agentEnv.el;
  if (!el) return;
  const recheck = h(
    "button",
    { class: "btn", disabled: agentEnv.loading || agentEnv.installing, onclick: () => loadAgentEnv(agentEnv.id, true) },
    agentEnv.loading ? "检查中…" : agentEnv.data ? "重新检查" : "检查",
  );
  if (!agentEnv.data) {
    fill(el, 
      h(
        "div",
        { class: "row" },
        h("div", { class: "grow muted" }, agentEnv.loading ? "正在检查 Claude Code 和 Codex…（要十几秒）" : agentEnv.error || "看看 Claude Code、Codex 装好、登录了没有"),
        recheck,
      ),
    );
    return;
  }
  // Windows 上本机的服务端跑在 WSL 之类的地方，桌面端没法替它开终端登录：和远程服务器一样给出命令
  const isLocal = agentEnv.id === state.localId && !state.system.localUnsupported;
  const where = agentEnv.id === state.localId ? "登录要在运行 agent-loft 的地方（比如 WSL）执行上面的命令" : "登录要在那台服务器上进行（SSH 上去执行上面的命令）";
  fill(el, 
    ...agentEnv.data.map((a) => agentRow(a, isLocal)),
    agentEnv.error ? h("div", { class: "row error-text" }, agentEnv.error) : null,
    h(
      "div",
      { class: "row" },
      h("div", { class: "grow hint" }, isLocal ? "登录在「终端」里进行，命令和输出你都看得到；做完回来点「重新检查」。" : `${where}，做完回来点「重新检查」。`),
      recheck,
    ),
  );
}

function agentRow(a, isLocal) {
  const ok = a.installed && a.loggedIn === true;
  const text = !a.installed ? "未安装" : a.loggedIn === false ? "未登录" : a.loggedIn === null ? "无法确认登录状态" : "可以使用";
  let action = null;
  if (!a.installed && a.id === "codex") {
    action = h(
      "button",
      {
        class: "btn primary",
        disabled: agentEnv.installing,
        onclick: async () => {
          agentEnv.installing = true;
          renderAgentEnv();
          try {
            const r = await call("installCodex", agentEnv.id);
            if (!r.ok) agentEnv.error = `安装失败：${r.output.slice(-300)}`;
          } catch (err) {
            agentEnv.error = errText(err);
          } finally {
            agentEnv.installing = false;
            void loadAgentEnv(agentEnv.id, true);
          }
        },
      },
      agentEnv.installing ? "正在安装，要几分钟…" : "安装 Codex",
    );
  } else if (a.installed && a.loggedIn !== true && isLocal) {
    action = h(
      "button",
      {
        class: "btn primary",
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            await call("loginAgent", a.id);
            btn.textContent = "已在终端里打开";
          } catch (err) {
            btn.disabled = false;
            agentEnv.error = errText(err);
            renderAgentEnv();
          }
        },
      },
      `登录 ${a.label}`,
    );
  }
  // 远程服务器没法替用户登录：把命令给出来
  const cmds = !isLocal && a.installed && a.loggedIn !== true ? (a.fix?.commands ?? []) : [];
  return h(
    "div",
    { class: "row" },
    h("span", { class: `dot ${ok ? "online" : "login"}` }),
    h(
      "div",
      { class: "grow" },
      h("div", { class: "name" }, a.label, a.enabled ? null : h("span", { class: "muted" }, "（未启用）")),
      h("div", { class: "sub wrap" }, [text, a.account, a.version, ok ? "" : a.problem].filter(Boolean).join(" · ")),
      cmds.map((c) => h("div", { class: "cmd mono" }, c)),
      cmds.length && a.fix?.note ? h("div", { class: "sub wrap" }, a.fix.note) : null,
    ),
    action,
  );
}

// ---------- 首次启动向导 ----------

/** 「一键安装本机服务端」怎么做的，向导和设置页共用 */
function localInstallText() {
  if (IS_MAC) return "一键将 agent-loft 安装到用户目录 ~/.local，无需管理员权限；需要 Node.js 22 以上，缺少时会先用 Homebrew 安装，开机自动运行。";
  return "一键将 agent-loft 安装到用户目录 ~/.local，无需管理员权限；需要 Node.js 22 以上，注册成 systemd 用户服务开机自动运行。";
}

const wiz = { step: "choose", error: null, id: null, built: null };

/** 从设置页开启本机服务端、需要设密码时，临时借用向导的界面 */
let wizardOverride = false;

function renderWizard() {
  // 带输入框的步骤只建一次，状态广播时不重画，免得把用户正在输的密码清掉
  if (wiz.built === wiz.step && (wiz.step === "password" || wiz.step === "agents")) return;
  wiz.built = wiz.step;
  const body = wiz.step === "password" ? wizardPassword() : wiz.step === "agents" ? wizardAgents() : wiz.step === "working" ? wizardWorking() : wizardChoose();
  $panel.replaceChildren(h("div", { class: "panel-inner wizard" }, body));
}

function wizardChoose() {
  const L = state.system.local;
  const running = !!L?.running;
  return [
    h("img", { class: "wizard-logo", src: "../../assets/icon.png", alt: "" }),
    h("h1", {}, "欢迎使用 Agent Loft"),
    h("p", { class: "muted" }, `Claude Code、Codex 跑在哪台机器上，那台机器就是「服务端」。先决定${THIS_PC}的角色。`),
    h(
      "div",
      { class: "choices" },
      h(
        "button",
        // Windows 上不能一键安装：没检测到在跑的就点不了，说明写在下面
        { class: "choice", disabled: !L || (!running && !!state.system.localUnsupported), onclick: () => startLocal(running) },
        h("div", { class: "choice-title" }, running ? `连接${THIS_PC}上的 agent-loft` : `${THIS_PC}也作为服务端`),
        h(
          "div",
          { class: "choice-desc" },
          !L
            ? `正在检测${THIS_PC}…`
            : running
              ? `检测到${THIS_PC}上已经在运行 agent-loft，直接连上它。`
              : (state.system.localUnsupported ?? `${localInstallText()}退出桌面端也不影响，手机、飞书、其他电脑都能连过来。`),
        ),
      ),
      h(
        "button",
        {
          class: "choice",
          onclick: async () => {
            await call("finishOnboarding");
            void openServerDialog(null);
          },
        },
        h("div", { class: "choice-title" }, "只连接其他服务器"),
        h("div", { class: "choice-desc" }, `agent-loft 跑在别的电脑、NAS 或云服务器上，${THIS_PC}只用来操作。${state.system.localUnsupported ? "" : "以后随时可以在设置里安装本机服务端。"}`),
      ),
    ),
    wiz.error ? h("p", { class: "error-text" }, wiz.error) : null,
  ];
}

function wizardWorking() {
  const installing = state.system.localBusy === "install";
  return [
    h("div", { class: "spinner-lg" }),
    h("h1", {}, installing ? "正在安装本机服务端…" : "正在连接…"),
    h("p", { class: "muted" }, installing ? "安装在「终端」窗口里进行，可以看到每一步。装好后这里会自动继续。" : "稍等一下。"),
  ];
}

async function startLocal(running) {
  wiz.step = "working";
  wiz.error = null;
  renderWizard();
  try {
    const r = await call(running ? "localConnect" : "localInstall");
    wiz.id = r.id;
    if (r.needsSetup) {
      wiz.step = "password";
      renderWizard();
    } else {
      // 已经设过密码（比如之前用过命令行版）：在页面上登录就行，Agent 环境以后在设置里看
      wizardOverride = false;
      await call("finishOnboarding", r.id);
    }
  } catch (err) {
    wiz.step = "choose";
    wiz.error = errText(err);
    if (wizardOverride) {
      // 从设置页来的：回设置页，错误显示在卡片里
      wizardOverride = false;
      render();
    } else {
      renderWizard();
    }
  }
}

function wizardPassword() {
  const pw1 = h("input", { id: "w-pw1", type: "password", autocomplete: "new-password", placeholder: "至少 8 位" });
  const pw2 = h("input", { id: "w-pw2", type: "password", autocomplete: "new-password" });
  const error = h("div", { class: "error-text" });
  const submit = h("button", { class: "btn primary", type: "submit" }, "设置并继续");
  const form = h(
    "form",
    {
      class: "server-form card",
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = "";
        if (pw1.value.length < 8) return void (error.textContent = "密码至少 8 位");
        if (pw1.value !== pw2.value) return void (error.textContent = "两次输入的密码不一样");
        submit.disabled = true;
        try {
          await call("localSetup", pw1.value);
          wiz.step = "agents";
          renderWizard();
          void loadAgentEnv(wiz.id);
        } catch (err) {
          error.textContent = errText(err);
          submit.disabled = false;
        }
      },
    },
    h("div", { class: "field" }, h("label", { for: "w-pw1" }, "登录密码"), pw1),
    h("div", { class: "field" }, h("label", { for: "w-pw2" }, "再输一次"), pw2),
    error,
    h("div", { class: "form-actions" }, submit),
  );
  requestAnimationFrame(() => pw1.focus());
  return [
    h("h1", {}, "给本机服务端设一个登录密码"),
    h("p", { class: "muted" }, "用手机或其他电脑打开 agent-loft 时要用它登录。桌面端这次会自动登录，不保存密码。"),
    form,
  ];
}

function wizardAgents() {
  return [
    h("h1", {}, "检查 Agent 环境"),
    h("p", { class: "muted" }, "agent-loft 已经带上了 Claude Code 的运行时，登录一下就能用；Codex 需要另外安装，点一下就行。不用的可以跳过，以后在设置里也能处理。"),
    h("div", { class: "card" }, agentEnvBox()),
    h(
      "div",
      { class: "form-actions", style: { marginTop: "16px" } },
      h(
        "button",
        {
          class: "btn primary",
          onclick: () => {
            wizardOverride = false;
            void call("finishOnboarding", wiz.id);
          },
        },
        "完成",
      ),
    ),
  ];
}

// ---------- 设置页：本机服务端 ----------

function renderLocalCard(el) {
  const L = state.system.local;
  const busy = state.system.localBusy;
  const localServer = state.servers.find((s) => s.id === state.localId);
  let title;
  let sub;
  let dot;
  let actions = [];
  // 运行 / 重启 / 停止 / 日志 / 卸载都收进「更多」的下拉菜单（系统菜单，main.js 的 localMenu 按状态排）
  const more = h("button", {
    class: "btn icon-btn",
    title: "更多",
    "aria-label": "更多",
    disabled: !!busy,
    onclick: (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      void call("localMenu", { x: Math.round(r.left), y: Math.round(r.bottom + 4) }).catch(() => {});
    },
  });
  more.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
  if (!L) {
    [title, sub, dot] = ["检测中…", "", "unknown"];
  } else if (busy === "install") {
    [title, sub, dot] = ["正在安装…", "安装在「终端」窗口里进行，装好后会自动加到顶栏。", "unknown"];
  } else if (L.running) {
    // Windows 上看不到服务端是怎么跑的（多半在 WSL 里），不下结论
    title =
      busy === "restart" ? "正在重启…" : busy === "stop" ? "正在停止…" : busy === "uninstall" ? "正在卸载…" : state.system.localUnsupported ? "运行中" : L.service ? "运行中 · 开机自动运行" : "运行中（手动启动的，没有开机自启）";
    sub = L.url;
    dot = "online";
    if (L.service) actions = [more];
  } else if (L.service) {
    // 手动停的，或者起不来（那就看日志）；开机自启还在
    title = busy === "restart" ? "正在启动…" : busy === "uninstall" ? "正在卸载…" : "已停止 · 开机自动运行";
    [sub, dot] = [`${L.url} · 不是自己停的话，看一下日志里的报错`, "offline"];
    actions = [more];
  } else if (state.system.localUnsupported) {
    [title, sub, dot] = ["没有检测到", state.system.localUnsupported, "unknown"];
  } else {
    title = "未安装";
    sub = `${localInstallText()}手机、飞书、其他电脑都能连过来。`;
    dot = "unknown";
    actions = [h("button", { class: "btn primary", disabled: !!busy, onclick: () => installFromSettings() }, "一键安装")];
  }
  if (L?.running && !localServer) actions.unshift(h("button", { class: "btn primary", disabled: !!busy, onclick: () => call("localConnect").catch(() => {}) }, "添加到列表"));
  const rows = [
    h("div", { class: "row" }, h("span", { class: `dot ${dot}` }), h("div", { class: "grow" }, h("div", { class: "name" }, title), h("div", { class: "sub wrap" }, sub)), h("div", { class: "actions" }, actions)),
  ];
  if (state.system.localError) rows.push(h("div", { class: "row error-text" }, state.system.localError));
  fill(el, ...rows);
}

async function installFromSettings() {
  wizardOverride = true;
  await startLocal(false);
}

// ---------- 设置页：每台服务器的 Agent 环境和版本（在服务器列表的展开区） ----------

/** 服务器列表里一行下面的版本说明和升级按钮 */
function serverVersionLine(s) {
  const v = s.server;
  if (s.status !== "online" || !v) return null;
  if (v.unsupported) return h("div", { class: "sub wrap" }, "服务端版本较旧，不支持在线升级：在那台机器上执行 npm install -g agent-loft@latest");
  const parts = [`服务端 ${v.version}`];
  if (s.upgrading) parts.push("正在升级…");
  else if (v.updateAvailable) parts.push(`可以升级到 ${v.latest}`);
  else if (v.latest) parts.push("已是最新");
  const line = h("div", { class: `sub wrap ${v.updateAvailable && !s.upgrading ? "accent" : ""}` }, parts.join(" · "));
  if (v.updateAvailable && !v.canUpgrade && v.reason) return [line, h("div", { class: "sub wrap" }, v.reason)];
  return line;
}

function serverUpgradeButton(s) {
  const v = s.server;
  if (s.status !== "online" || !v?.updateAvailable || !v.canUpgrade) return null;
  return h(
    "button",
    {
      class: "btn primary",
      disabled: !!s.upgrading,
      onclick: async () => {
        try {
          const r = await call("upgradeServer", s.id);
          if (!r.restarting) alert(`已升级到 ${r.to}。agent-loft 是手动运行的，重启它之后生效。`);
        } catch (err) {
          alert(`升级失败：${errText(err)}`);
        }
      },
    },
    s.upgrading ? "升级中…" : "升级服务端",
  );
}

// ---------- 设置页：桌面端更新 ----------

/** 不能自动更新时，手动装新版的说法 */
const MANUAL_UPDATE_HINT = IS_MAC
  ? "下载后打开 DMG，把新版拖进「应用程序」替换旧版，设置和登录状态都会保留。"
  : PLATFORM === "win32"
    ? "下载后运行安装程序，会直接覆盖旧版，设置和登录状态都会保留。"
    : "下载新的 AppImage 替换旧的，或者用新的 deb 包安装（sudo apt install ./文件名.deb），设置和登录状态都会保留。";

function renderUpdateCard(el) {
  const u = state.system.update;
  const p = state.prefs;
  const installing = u.installing !== null && u.installing !== undefined;
  let status;
  if (installing) status = `正在下载新版本… ${Math.round(u.installing * 100)}%`;
  else if (u.checking) status = "正在检查…";
  else if (u.available) status = `新版本 ${u.available.version} 可以更新`;
  else if (u.error) status = `检查失败：${u.error}`;
  else if (u.checkedAt) status = `已是最新版本（${agoText(u.checkedAt)}检查）`;
  else status = state.system.packaged ? "还没检查过" : "开发版本，不自动检查";

  const canInstall = u.available && !state.system.selfUpdateProblem && u.available.pkg;
  const hours = h("input", {
    class: "num",
    type: "number",
    min: 1,
    max: 720,
    value: p.updateCheckHours,
    onchange: (e) => {
      const v = Number(e.target.value);
      if (Number.isFinite(v) && v >= 1) void call("setPref", "updateCheckHours", v);
    },
  });
  if (el.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
  fill(el, 
    h(
      "div",
      { class: "row" },
      h("div", { class: "grow" }, h("div", { class: "name" }, `桌面端 ${state.version}`), h("div", { class: `sub wrap ${u.available ? "accent" : ""}` }, status)),
      h(
        "div",
        { class: "actions" },
        u.available ? h("button", { class: "btn primary", disabled: installing, onclick: () => call("applyUpdate") }, canInstall ? (installing ? "更新中…" : "更新并重启") : "下载新版本") : null,
        h("button", { class: "btn", disabled: u.checking || installing, onclick: () => call("checkUpdates") }, "检查更新"),
      ),
    ),
    installing ? h("div", { class: "row" }, h("div", { class: "bar grow" }, h("i", { style: { width: `${Math.round(u.installing * 100)}%` } }))) : null,
    u.available && !canInstall
      ? h("div", { class: "row hint wrap" }, `${state.system.selfUpdateProblem ?? "这个版本没有自动更新包"}。${MANUAL_UPDATE_HINT}`)
      : null,
    h(
      "div",
      { class: "row switch-row" },
      h("label", { for: "p-autoUpdate" }, h("div", {}, "自动检查更新"), h("div", { class: "sub" }, "有新版本时弹通知提醒，同一个版本只提醒一次。服务端的新版本在上面的服务器列表里看。")),
      h("input", { id: "p-autoUpdate", type: "checkbox", class: "switch", checked: p.autoUpdate, onchange: (e) => call("setPref", "autoUpdate", e.target.checked) }),
    ),
    p.autoUpdate ? h("div", { class: "row" }, h("div", { class: "grow" }, "检查间隔（小时）"), hours) : null,
  );
}
