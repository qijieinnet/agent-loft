import { fill, h, icon, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { copyText } from "../lib/markdown.js";
import { desktopQuota, S } from "../state.js";
import { defaultEntryName, usableAgents } from "../views/topbar.js";
import { renderEmpty } from "../views/messages.js";
import { field, saveButton, saveConfig } from "./common.js";
import { modelPicker } from "./commands.js";

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
                h("div", {}, `${a.fix.title}：在运行 agent-loft 的机器上打开终端执行${a.fix.commands.length > 1 ? "（任选一条）" : ""}`),
                a.fix.commands.map((cmd) => {
                  const copy = h("button", { class: "btn small", onclick: () => copyText(cmd, copy) }, "复制");
                  return h("div", { class: "health-cmd" }, h("code", {}, cmd), copy);
                }),
                a.fix.note ? h("small", {}, a.fix.note) : null,
                a.id === "codex" && a.fix.action === "install" ? installCodexButton(() => load(true)) : null,
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

export function agentsTab(cfg, page) {
  page.append(agentHealthSection());
  const a = structuredClone(cfg.agents);
  const claudeOn = h("input", { type: "checkbox", checked: a.claude.enabled });
  const claudePick = modelPicker("claude", a.claude.defaultModel, a.claude.defaultEffort, "跟随 Claude Code 默认");
  const claudeModels = modelChecklist("claude", a.claude.models ?? []);
  const codexOn = h("input", { type: "checkbox", checked: a.codex.enabled });
  const codexPath = h("input", { value: a.codex.path });
  const codexHome = h("input", { value: a.codex.home, placeholder: "留空用 ~/.codex" });
  const sandbox = h(
    "select",
    {},
    ["read-only", "workspace-write", "danger-full-access"].map((m) => h("option", { value: m, selected: m === a.codex.sandbox }, m)),
  );
  const codexPick = modelPicker("codex", a.codex.defaultModel, a.codex.defaultEffort, "跟随 config.toml");
  const codexModels = modelChecklist("codex", a.codex.models ?? []);
  // 自动生成会话名称：一行，勾上才显示后面的模型选择
  const titleOn = h("input", { type: "checkbox", checked: !!a.codex.autoTitle });
  const titlePick = modelPicker("codex", a.codex.titleModel ?? "", "", "跟随 config.toml");
  const titleModelEl = h("div", { class: "grow field" }, titlePick.modelEl);
  const syncTitle = () => (titleModelEl.hidden = !titleOn.checked);
  titleOn.addEventListener("change", syncTitle);
  syncTitle();
  // 一组勾选框不能放进 <label>（点哪都会切到第一个），所以不用 field()
  const checksField = (list) => h("div", { class: "field" }, h("span", {}, "输入框可选模型"), list.el);
  // 两个 agent 一起保存：整组算一张表单
  page.append(
    h(
      "div",
      { class: "settings-stack", "data-form": "" },
      h(
        "div",
        { class: "section" },
        h("h4", {}, "Claude Code", h("span", { class: "grow" }), h("label", { class: "check" }, claudeOn, "启用")),
        field("默认模型", claudePick.modelEl),
        field("默认思考程度", claudePick.effortEl),
        checksField(claudeModels),
      ),
      h(
        "div",
        { class: "section" },
        h("h4", {}, "Codex", h("span", { class: "grow" }), h("label", { class: "check" }, codexOn, "启用")),
        field("codex 可执行文件", codexPath, "以系统服务运行时 PATH 很短，建议写绝对路径"),
        field("CODEX_HOME", codexHome),
        field("沙箱", sandbox, "workspace-write：目录内可读写，越界才弹授权。danger-full-access 等于关掉沙箱"),
        field("默认模型", codexPick.modelEl),
        field("默认思考程度", codexPick.effortEl),
        checksField(codexModels),
        h("div", { class: "row title-row" }, h("label", { class: "check" }, titleOn, "自动生成会话名称"), titleModelEl),
      ),
      h(
        "div",
        { class: "row" },
        saveButton(() => {
          const claudeList = claudeModels.value();
          const codexList = codexModels.value();
          if (!claudeList || !codexList) {
            toast(`${!claudeList ? "Claude Code" : "Codex"} 至少勾选一个模型`);
            return false;
          }
          return saveConfig(cfg, {
            agents: {
              claude: {
                enabled: claudeOn.checked,
                defaultModel: claudePick.model(),
                defaultEffort: claudePick.effort(),
                models: claudeList,
              },
              codex: {
                enabled: codexOn.checked,
                path: codexPath.value.trim() || "codex",
                home: codexHome.value.trim(),
                sandbox: sandbox.value,
                defaultModel: codexPick.model(),
                defaultEffort: codexPick.effort(),
                models: codexList,
                autoTitle: titleOn.checked,
                titleModel: titlePick.model(),
              },
            },
          });
        }, "保存 Agent 设置"),
      ),
    ),
    quotaSection(cfg),
  );
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
