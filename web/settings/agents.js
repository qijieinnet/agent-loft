import { fill, h, icon, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { copyText } from "../lib/markdown.js";
import { desktopQuota, isAdmin, S } from "../state.js";
import { defaultEntryName, renderContext, usableAgents } from "../views/topbar.js";
import { DEFAULT_LEVELS, engineSupports, PERMISSIONS } from "../lib/permission.js";
import { renderEmpty } from "../views/messages.js";
import { field, saveButton, saveConfig } from "./common.js";
import { modelPicker } from "./commands.js";

const ENGINE_LABEL = { claude: "Claude Code", codex: "Codex", workbuddy: "WorkBuddy" };
const ENGINES = Object.keys(ENGINE_LABEL);
/** 设置里的默认权限「跟随」时实际是什么 */
const FOLLOW_LABEL = { claude: "跟随 Claude Code（逐次询问）", codex: "跟随沙箱设置", workbuddy: "跟随 WorkBuddy（逐次询问）" };
const WORKBUDDY_SITES = [
  ["workbuddy", "WorkBuddy（www.workbuddy.cn，用本机的 WorkBuddy 桌面版）"],
  ["internal", "CodeBuddy 国内版（copilot.tencent.com）"],
  ["external", "CodeBuddy 国际版（codebuddy.ai）"],
  ["ioa", "腾讯 iOA"],
];

/**
 * 设置 → Agent：勾选哪些模型出现在输入框的模型列表里。
 * 全部勾上存成空数组 = 「全部显示」，以后 agent 新增的模型也会自动出现；
 * 只勾了一部分就只显示这些。一个都不勾不允许保存。
 */
function modelChecklist(agent, selected) {
  const box = h("div", { class: "model-checks" }, h("small", {}, "正在读取模型列表…"));
  const summaryText = h("span", {}, "正在读取模型列表…");
  const summary = h("summary", { class: "input model-check-summary" }, summaryText, icon("down"));
  const dropdown = h("details", { class: "model-check-dropdown" }, summary, box);
  let boxes = null;
  const syncSummary = () => {
    const count = boxes.filter((b) => b.el.checked).length;
    summaryText.textContent = count === boxes.length ? `全部模型（${count} 个）` : `已选 ${count} / ${boxes.length} 个模型`;
  };
  box.addEventListener("change", syncSummary);
  dropdown.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dropdown.open) {
      e.preventDefault();
      e.stopPropagation();
      dropdown.open = false;
      summary.focus();
    }
  });
  api(`/api/agents/${agent}/models`)
    .then((data) => {
      const models = data?.models ?? [];
      if (!models.length) {
        summaryText.textContent = "没读到模型列表";
        return fill(box, h("small", {}, "没读到模型列表，保留原来的选择"));
      }
      boxes = models.map((m) => ({ id: m.id, el: h("input", { type: "checkbox", checked: !selected.length || selected.includes(m.id) }) }));
      syncSummary();
      fill(
        box,
        boxes.map(({ el }, i) => {
          const m = models[i];
          return h(
            "label",
            { class: "model-check" },
            el,
            h("span", { class: "t" }, m.label || m.id),
            h("span", { class: "s" }, m.id === "default" && defaultEntryName(m) ? `跟随默认 · 现在是 ${defaultEntryName(m)}` : m.id),
          );
        }),
        h("small", {}, "只影响输入框里的模型选择列表；全部勾上 = 以后新出的模型也自动显示"),
      );
    })
    .catch((err) => {
      summaryText.textContent = "读取模型列表失败";
      fill(box, h("small", {}, err.status === 409 ? err.message : `读取模型列表失败：${err.message ?? err}`));
    });
  return {
    el: dropdown,
    /** 列表没读到时原样保留；null = 一个都没勾 */
    value: () => {
      if (!boxes) return selected;
      const on = boxes.filter((b) => b.el.checked).map((b) => b.id);
      if (on.length === 0) return null;
      return on.length === boxes.length ? [] : on;
    },
  };
}

/** Agent 运行环境：装没装、登没登录；没好的给出在终端里执行的命令 */
function agentHealthSection() {
  const box = h("div", { class: "section" });
  const load = async (refresh) => {
    const recheck = h("button", { class: "btn small", onclick: () => load(true) }, "重新检查");
    fill(box, h("h4", {}, "运行环境", h("span", { class: "grow" }), h("span", { class: "spinner" })));
    let data;
    try {
      data = await api(`/api/agents/health${refresh ? "?refresh=1" : ""}`);
    } catch (err) {
      fill(box, h("h4", {}, "运行环境", h("span", { class: "grow" }), recheck), h("div", { class: "error-text" }, err.message));
      return;
    }
    // 体检结果顺手同步到新对话的 agent 列表：刚装好 / 登录好的立刻能选，不行的立刻消失
    for (const a of data.agents) {
      const known = S.agents.find((x) => x.id === a.id);
      if (known) known.available = a.installed && a.loggedIn !== false;
    }
    if (!usableAgents().some((a) => a.id === S.draftAgent)) S.draftAgent = usableAgents()[0]?.id ?? null;
    if (!S.current) renderEmpty();
    fill(
      box,
      h("h4", {}, "运行环境", h("span", { class: "grow" }), recheck),
      ...data.agents.map((a) => {
        const ok = a.installed && a.loggedIn === true;
        const state = !a.installed ? "未安装" : a.loggedIn === false ? "未登录" : a.loggedIn === null ? "无法确认" : "正常";
        return h(
          "div",
          { class: "health-row" },
          h(
            "div",
            { class: "health-head" },
            h("span", { class: `health-dot ${ok ? "ok" : "bad"}` }),
            h("b", {}, a.label),
            h("span", { class: "health-state" }, state),
            a.enabled ? null : h("span", { class: "health-off" }, "（未启用）"),
          ),
          a.account || a.version ? h("div", { class: "health-meta" }, [a.account, a.version].filter(Boolean).join(" · ")) : null,
          a.problem ? h("div", { class: "health-meta" }, a.problem) : null,
          a.fix
            ? h(
                "div",
                { class: "health-fix" },
                a.fix.web || !a.fix.commands.length
                  ? h("div", {}, `${a.fix.title}：`)
                  : h("div", {}, `${a.fix.title}：在运行 agent-loft 的机器上打开终端执行${a.fix.commands.length > 1 ? "（任选一条）" : ""}`),
                a.fix.commands.map((cmd) => {
                  const copy = h("button", { class: "btn small", onclick: () => copyText(cmd, copy) }, "复制");
                  return h("div", { class: "health-cmd" }, h("code", {}, cmd), copy);
                }),
                a.fix.note ? h("small", {}, a.fix.note) : null,
                a.id === "codex" && a.fix.action === "install" ? installCodexButton(() => load(true)) : null,
                a.id === "workbuddy" && a.fix.web ? workbuddyLoginButton(() => load(true)) : null,
              )
            : null,
        );
      }),
    );
  };
  void load(false);
  return box;
}

/** 直接在服务端那台机器上装 Codex（Homebrew 或 npm），装完重新检查 */
function installCodexButton(after) {
  const btn = h(
    "button",
    {
      class: "btn small primary",
      onclick: async () => {
        btn.disabled = true;
        btn.textContent = "正在安装，可能要几分钟…";
        try {
          const r = await api("/api/agents/codex/install", { method: "POST" });
          toast(r.ok ? `已用 ${r.via} 装好 Codex` : `安装失败：${r.output.slice(-200)}`, 6000);
          after();
        } catch (err) {
          toast(`安装失败：${err.message}`, 6000);
          btn.disabled = false;
          btn.textContent = "直接在服务器上安装";
        }
      },
    },
    "直接在服务器上安装",
  );
  return h("div", {}, btn);
}

/**
 * WorkBuddy 网页登录：服务端拿到登录链接，在新标签页里打开（用的是你自己的浏览器，不是服务器的），
 * 登录完这边轮询到结果就重新检查。弹窗被拦时把链接留在按钮下面，手动点
 */
function workbuddyLoginButton(after) {
  const status = h("small", {});
  const btn = h(
    "button",
    {
      class: "btn small primary",
      onclick: async () => {
        // 先开空白页再填地址：等接口回来再 window.open 会被浏览器当成弹窗拦掉
        const tab = window.open("", "_blank");
        btn.disabled = true;
        btn.textContent = "正在获取登录链接…";
        try {
          const { url } = await api("/api/agents/workbuddy/login", { method: "POST" });
          if (tab) tab.location.href = url;
          fill(status, "请在 1 分钟内在打开的页面里登录（超时要重新点），完成后这里会自动刷新。没弹出来的话点这里：", h("a", { href: url, target: "_blank", rel: "noopener" }, "打开登录页"));
          btn.textContent = "等待登录…";
          const started = Date.now();
          const poll = async () => {
            if (!btn.isConnected) return;
            const st = await api("/api/agents/workbuddy/login").catch(() => null);
            if (st?.status === "done") {
              toast(`WorkBuddy 已登录：${st.user}`);
              after();
              return;
            }
            if (st?.status === "failed" || Date.now() - started > 3 * 60_000) {
              fill(status, `登录没有完成：${st?.error ?? "超时"}。点「重新登录」再来一次，拿到链接后尽快登录`);
              btn.disabled = false;
              btn.textContent = "重新登录";
              return;
            }
            setTimeout(poll, 2000);
          };
          setTimeout(poll, 2000);
        } catch (err) {
          tab?.close();
          toast(err.message, 6000);
          btn.disabled = false;
          btn.textContent = "登录 WorkBuddy";
        }
      },
    },
    "登录 WorkBuddy",
  );
  return h("div", {}, btn, status);
}

/** 个人默认工具单独保存，避免改服务器配置时覆盖尚未保存的个人选择。 */
function builtinDefaultsSections(targets) {
  const load = async () => {
    let data;
    try {
      data = await api("/api/agents/defaults");
    } catch (err) {
      for (const section of Object.values(targets)) fill(section, h("div", { class: "error-text" }, err.message), h("button", { class: "btn small", onclick: load }, "重试"));
      return;
    }
    const picker = (label, items, selected, inheritLabel) => {
      const mode = h("select", { "aria-label": label },
        ...(inheritLabel ? [h("option", { value: "inherit", selected: selected === null }, inheritLabel)] : []),
        h("option", { value: "pick", selected: selected !== null }, "指定加载（可全部取消）"));
      const known = new Set(items.map((item) => item.id));
      const missing = (selected ?? []).filter((id) => !known.has(id)).map((id) => ({ id, name: `${id}（暂不可用，可取消）` }));
      const inputs = [...items, ...missing].map((item) => ({ id: item.id, input: h("input", { type: "checkbox", checked: (selected ?? []).includes(item.id) }), item }));
      const list = h("div", { class: "check-list" }, inputs.length
        ? inputs.map(({ input, item }) => h("label", { class: "check-item tool-check-item", title: item.description ?? item.name }, input, h("span", {}, item.name)))
        : h("small", {}, "暂无可选项，请先在设置中添加"));
      const sync = () => { list.hidden = mode.value !== "pick"; };
      mode.addEventListener("change", sync);
      sync();
      return { el: h("div", { class: "field" }, h("span", {}, label), mode, list), value: () => mode.value === "inherit" ? null : inputs.filter((x) => x.input.checked).map((x) => x.id) };
    };
    for (const [engine, section] of Object.entries(targets)) {
      const prefs = data.agents[engine];
      if (!prefs) {
        section.hidden = true;
        if (section.parentElement?.dataset.personal) section.parentElement.hidden = true;
        continue;
      }
      const label = ENGINE_LABEL[engine] ?? engine;
      const skills = picker(`${label} 技能`, data.skills, prefs.skills, "全部已启用的个人技能（含以后新增）");
      const machine = (data.machineMcp?.[engine] ?? []).map((name) => ({ id: `${data.machinePrefix}${name}`, name: `${name}（本机）` }));
      const mcp = picker(`${label} MCP`, [...data.mcp, ...machine], prefs.mcp, data.machineMcp ? "沿用机器上的 MCP 配置" : null);
      const machineSkills = h("input", { type: "checkbox", checked: prefs.machineSkills });
      // 成员最高到自动改文件；自动判断只有 Claude 有
      const levels = DEFAULT_LEVELS.filter((l) => engineSupports(engine, l) && (l !== "auto" || isAdmin()));
      const permission = h("select", { "aria-label": `${label} 默认权限` },
        h("option", { value: "", selected: !prefs.permission }, FOLLOW_LABEL[engine] ?? "跟随默认"),
        levels.map((l) => h("option", { value: l, selected: l === prefs.permission }, `${PERMISSIONS[l].label}：${PERMISSIONS[l].desc}`)));
      fill(section, h("h4", {}, "默认权限"),
        field("新对话的权限", permission, "没单独选过权限的对话都按这一级（输入框里的盾牌按钮可以随时改）。自定义专家也按它，但不会超过专家自己的权限；定时任务按任务里选的。「完全允许」不能设成默认。"),
        h("h4", {}, "默认加载"),
        h("p", { class: "skill-note" }, "仅影响你当前账号使用的这个内置 Agent，自定义专家使用各自的配置。保存后，下次发消息生效。"),
        skills.el,
        data.machineMcp ? h("label", { class: "check-item" }, machineSkills, "同时加载机器上的技能") : null,
        mcp.el,
        h("small", {}, "技能和 MCP 可分别全部取消。记忆、定时任务、技能管理等系统工具仍按功能设置提供。"),
        h("div", { class: "row" }, saveButton(async () => {
          const res = await api("/api/agents/defaults", { method: "PUT", body: { agents: { [engine]: { permission: permission.value || null, skills: skills.value(), machineSkills: machineSkills.checked, mcp: mcp.value() } } } });
          S.defaultPermission = { ...S.defaultPermission, [engine]: res.agents?.[engine]?.permission ?? null };
          renderContext();
          toast("已保存，下次发消息生效");
        }, `保存 ${label} 默认设置`)));
    }
    if (!Object.keys(data.agents).length) {
      const section = Object.values(targets)[0];
      section.hidden = false;
      section.parentElement.hidden = false;
      const message = h("p", { class: "muted" }, "没有获授权的内置 Agent，请联系管理员配置使用权限。");
      if (section.parentElement.dataset.personal) fill(section.parentElement, h("h4", {}, "内置 Agent"), message);
      else fill(section, message);
    }
  };
  void load();
}

export function agentsTab(cfg, page) {
  const targets = Object.fromEntries(ENGINES.map((engine) => [engine, h("div", { class: "builtin-agent-defaults", "data-form": "" }, h("span", { class: "spinner" }))]));
  if (!cfg) {
    for (const [engine, target] of Object.entries(targets)) page.append(h("div", { class: "section", "data-personal": "true", "data-agent": engine }, h("h4", {}, ENGINE_LABEL[engine]), target));
    builtinDefaultsSections(targets);
    return;
  }
  page.append(agentHealthSection());
  const a = structuredClone(cfg.agents);
  for (const engine of ENGINES) {
    const label = ENGINE_LABEL[engine];
    const settings = a[engine];
    if (!settings) continue;
    const on = h("input", { type: "checkbox", checked: settings.enabled });
    const pick = modelPicker(engine, settings.defaultModel, settings.defaultEffort, engine === "claude" ? "跟随 Claude Code 默认" : engine === "workbuddy" ? "跟随 WorkBuddy 默认" : "跟随 config.toml");
    const models = modelChecklist(engine, settings.models ?? []);
    const config = h("div", { class: "agent-config", "data-form": "" },
      h("h4", {}, label, h("span", { class: "grow" }), h("label", { class: "check" }, on, "启用")));
    let codex = null;
    if (engine === "codex") {
      const path = h("input", { value: settings.path });
      const home = h("input", { value: settings.home, placeholder: "留空用 ~/.codex" });
      const sandbox = h("select", {}, ["read-only", "workspace-write", "danger-full-access"].map((mode) => h("option", { value: mode, selected: mode === settings.sandbox }, mode)));
      const titleOn = h("input", { type: "checkbox", checked: !!settings.autoTitle });
      const titlePick = modelPicker("codex", settings.titleModel ?? "", "", "跟随 config.toml");
      const titleModel = h("div", { class: "grow field" }, titlePick.modelEl);
      const syncTitle = () => { titleModel.hidden = !titleOn.checked; };
      titleOn.addEventListener("change", syncTitle);
      syncTitle();
      codex = { path, home, sandbox, titleOn, titlePick, titleModel };
      config.append(field("codex 可执行文件", path, "以系统服务运行时 PATH 很短，建议写绝对路径"), field("CODEX_HOME", home), field("沙箱", sandbox, "workspace-write：目录内可读写，越界才弹授权。danger-full-access 等于关掉沙箱"));
    }
    let site = null;
    let cliPath = null;
    if (engine === "workbuddy") {
      site = h("select", {}, WORKBUDDY_SITES.map(([value, name]) => h("option", { value, selected: value === (settings.environment || "workbuddy") }, name)));
      cliPath = h("input", { value: settings.cliPath ?? "", placeholder: "留空自动找（如 /opt/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy）" });
      const cliField = field("WorkBuddy CLI 路径", cliPath, "WorkBuddy 桌面版里自带的 CLI，装在常见位置时不用填");
      const syncSite = () => { cliField.hidden = site.value !== "workbuddy"; };
      site.addEventListener("change", syncSite);
      syncSite();
      config.append(
        h("p", { class: "muted" }, "腾讯 WorkBuddy：调用这台服务器上 WorkBuddy 桌面版自带的 CLI；也可以改用 CodeBuddy 的账号（用 agent-loft 自带的 CLI）。启用并保存后，到上面「运行环境」里登录——桌面版里登录过也要在这里再登一次，同一个账号就行。暂不支持自定义专家和分叉。"),
        field("账号站点", site, "登录和对话都走这个站点。换了站点要重新登录"),
        cliField,
      );
    }
    config.append(field("默认模型", pick.modelEl));
    if (engine !== "workbuddy") config.append(field("默认思考程度", pick.effortEl));
    config.append(h("div", { class: "field" }, h("span", {}, "输入框可选模型"), models.el));
    if (codex) config.append(h("div", { class: "row title-row" }, h("label", { class: "check" }, codex.titleOn, "自动生成会话名称"), codex.titleModel));
    config.append(h("div", { class: "row" }, saveButton(() => {
      const selected = models.value();
      if (!selected) {
        toast(`${label} 至少勾选一个模型`);
        return false;
      }
      return saveConfig(cfg, { agents: { [engine]: {
        enabled: on.checked, defaultModel: pick.model(), defaultEffort: pick.effort(), models: selected,
        ...(site ? { environment: site.value, cliPath: cliPath.value.trim() } : {}),
        ...(codex ? { path: codex.path.value.trim() || "codex", home: codex.home.value.trim(), sandbox: codex.sandbox.value, autoTitle: codex.titleOn.checked, titleModel: codex.titlePick.model() } : {}),
      } } });
    }, `保存 ${label} 设置`)));
    page.append(h("div", { class: "section", "data-agent": engine }, config, targets[engine]));
  }
  page.append(quotaSection(cfg));
  builtinDefaultsSections(targets);
}

/** 账号额度：侧栏底部、/status、桌面端显示的 Claude / Codex 订阅额度，查不查、多久查一次 */
function quotaSection(cfg) {
  const quotaOn = h("input", { type: "checkbox", checked: cfg.web?.quotaEnabled !== false });
  const quotaMin = h("input", { type: "number", min: 0, max: 1440, value: cfg.web?.quotaRefreshMin ?? 10 });
  const minField = field(
    "自动刷新间隔（分钟）",
    quotaMin,
    desktopQuota
      ? "在桌面端里额度由桌面端统一刷新，以桌面端设置里的间隔为准；这里只对浏览器打开的页面生效"
      : "侧栏底部的额度，空闲时多久刷新一次；0 表示不自动刷新（跑完一轮、点击额度区域仍会刷新）",
  );
  const sync = () => (minField.hidden = !quotaOn.checked);
  quotaOn.addEventListener("change", sync);
  sync();
  return h(
    "div",
    { class: "section", "data-form": "" },
    h("h4", {}, "账号额度", h("span", { class: "grow" }), h("label", { class: "check" }, quotaOn, "查询")),
    h("div", { class: "muted" }, "侧栏底部、/status、桌面端显示的订阅额度（5 小时、每周）。关掉后都不再去问 agent（Claude 每次要临时起一个 CLI 进程才查得到）。"),
    minField,
    h(
      "div",
      { class: "row" },
      saveButton(() => saveConfig(cfg, { web: { quotaRefreshMin: Number(quotaMin.value), quotaEnabled: quotaOn.checked } })),
    ),
  );
}
