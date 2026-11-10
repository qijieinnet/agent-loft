import { fill, h, icon, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { copyText } from "../lib/markdown.js";
import { desktopQuota, S } from "../state.js";
import { defaultEntryName, usableAgents } from "../views/topbar.js";
import { renderEmpty } from "../views/messages.js";
import { field, saveButton, saveConfig } from "./common.js";
import { modelPicker } from "./commands.js";

const ENGINE_LABEL = { claude: "Claude Code", codex: "Codex", workbuddy: "WorkBuddy", pi: "pi", dsh: "dsh（DeepSeek）" };
const ENGINES = Object.keys(ENGINE_LABEL);
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

/** 设置 → Agent（管理员）：运行环境、启用、引擎自己的配置、输入框可选模型。默认模型 / 权限 / 加载在「专家」里各内置 Agent 的「设置」 */
export function agentsTab(cfg, page) {
  page.append(agentHealthSection());
  const a = structuredClone(cfg.agents);
  for (const engine of ENGINES) {
    const label = ENGINE_LABEL[engine];
    const settings = a[engine];
    if (!settings) continue;
    const on = h("input", { type: "checkbox", checked: settings.enabled });
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
    if (engine === "pi") {
      config.append(
        h("p", { class: "muted" }, "pi（pi.dev）：开源的编程 agent，用官方 SDK 在 agent-loft 进程里运行。不用登录账号，按模型服务商填 API Key（DeepSeek、智谱、Kimi、通义、MiniMax、OpenRouter……），整台服务器共用。凭据和会话记录都存在 agent-loft 的 data/pi/ 下，不读机器上的 ~/.pi。pi 本身没有权限系统，授权卡、计划模式、提问卡是 agent-loft 补上的；跑命令（bash）没有沙箱。暂不支持自定义专家。"),
        piProvidersSection(),
        piCustomSection(),
      );
    }
    let dsh = null;
    if (engine === "dsh") {
      const path = h("input", { value: settings.path ?? "dsh", placeholder: "dsh" });
      const home = h("input", { value: settings.home ?? "", placeholder: "留空用 ~/.dsh" });
      const patch = h("input", { value: settings.patch ?? "", placeholder: "留空不加（绝对路径，如 /home/me/.dsh/loft.patch.yml）" });
      dsh = { path, home, patch };
      config.append(
        h("p", { class: "muted" }, "dsh（DeepSeek Harness）：DeepSeek 官方的编程 agent，通过标准 ACP 协议接入，每个会话一个 dsh 进程（第一条消息要等 4~5 秒拉起）。用 dsh 自己的凭据（~/.dsh/.credentials.yaml 里的 DeepSeek API Key）和会话记录，dsh 网页里建的会话这里也能接着聊。权限用 dsh 的沙箱：逐次询问 = 只读、自动改文件 = 工作区可写、完全允许 = 不设沙箱；越界时弹授权卡。不支持自定义专家、分叉 / 回退、提问卡和图片直传（附件给路径）；设成「调用前询问」的 MCP 不会挂上。"),
        field("dsh 可执行文件", path, "npm install -g @deepseek-ai/dsh 装的；以系统服务运行时 PATH 很短，建议写绝对路径"),
        field("DSH_HOME", home),
        field("额外的 patch 文件", patch, "每个 dsh 进程都加 --patch 这个文件。dsh 的 ACP 模式默认只有官方 DeepSeek 模型，要接别家模型（llm-pi-ai）就写在这里"),
      );
    }
    config.append(h("small", { class: "muted" }, "默认模型、思考程度、权限和默认加载的技能 / MCP，在「设置 → 专家」里这个 Agent 的「设置」中修改。"));
    config.append(h("div", { class: "field" }, h("span", {}, "输入框可选模型"), models.el));
    if (codex) config.append(h("div", { class: "row title-row" }, h("label", { class: "check" }, codex.titleOn, "自动生成会话名称"), codex.titleModel));
    config.append(h("div", { class: "row" }, saveButton(() => {
      const selected = models.value();
      if (!selected) {
        toast(`${label} 至少勾选一个模型`);
        return false;
      }
      return saveConfig(cfg, { agents: { [engine]: {
        enabled: on.checked, models: selected,
        ...(site ? { environment: site.value, cliPath: cliPath.value.trim() } : {}),
        ...(dsh ? { path: dsh.path.value.trim() || "dsh", home: dsh.home.value.trim(), patch: dsh.patch.value.trim() } : {}),
        ...(codex ? { path: codex.path.value.trim() || "codex", home: codex.home.value.trim(), sandbox: codex.sandbox.value, autoTitle: codex.titleOn.checked, titleModel: codex.titlePick.model() } : {}),
      } } });
    }, `保存 ${label} 设置`)));
    page.append(h("div", { class: "section", "data-agent": engine }, config));
  }
  page.append(quotaSection(cfg));
}

/** 常用的排前面：国内能直接用的几家、再是 OpenRouter 和海外几家 */
const PI_PROVIDER_ORDER = ["deepseek", "zai-coding-cn", "kimi-coding", "moonshotai-cn", "qwen-token-plan-cn", "minimax-cn", "xiaomi-token-plan-cn", "openrouter", "anthropic", "openai", "google"];

/**
 * pi 的模型服务商：哪些能用了（存了 Key，或服务进程有环境变量），填 / 换 / 删 API Key。
 * Key 只往服务端写，不回显；存在 data/pi/auth.json（0600）
 */
function piProvidersSection() {
  const box = h("div", { class: "field pi-providers", "data-nodirty": "" }, h("span", {}, "模型服务商"), h("small", {}, "正在读取…"));
  const load = async () => {
    let data;
    try {
      data = await api("/api/agents/pi/providers");
    } catch (err) {
      fill(box, h("span", {}, "模型服务商"), h("div", { class: "error-text" }, err.message), h("button", { class: "btn small", onclick: load }, "重试"));
      return;
    }
    const rank = (p) => {
      const i = PI_PROVIDER_ORDER.indexOf(p.id);
      return i < 0 ? PI_PROVIDER_ORDER.length : i;
    };
    const providers = [...data.providers].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    const ready = providers.filter((p) => p.configured && !p.custom);
    const rows = ready.map((p) => {
      const remove = p.stored
        ? h("button", {
            class: "btn small",
            onclick: async () => {
              if (!confirm(`删除 ${p.name} 的凭据？用它的模型的对话会用不了。`)) return;
              remove.disabled = true;
              try {
                await api(`/api/agents/pi/providers/${encodeURIComponent(p.id)}`, { method: "DELETE" });
                toast(`已删除 ${p.name} 的凭据`);
              } catch (err) {
                toast(`删除失败：${err.message}`, 5000);
              }
              void load();
            },
          }, "删除")
        : null;
      const where = p.stored === "oauth" ? "已登录（OAuth）" : p.stored ? "API Key 已保存" : "来自服务的环境变量 / 云凭据";
      return h("div", { class: "health-row" }, h("div", { class: "health-head" }, h("span", { class: "health-dot ok" }), h("b", {}, p.name), h("span", { class: "health-state" }, `${where} · ${p.models} 个模型`), h("span", { class: "grow" }), remove));
    });
    const keyable = providers.filter((p) => p.apiKey && !p.custom);
    const sel = h("select", { "aria-label": "服务商" }, keyable.map((p) => h("option", { value: p.id }, `${p.name}${p.configured ? "（已配置，填了就替换）" : ""}`)));
    const key = h("input", { type: "password", autocomplete: "off", placeholder: "粘贴 API Key", "aria-label": "API Key" });
    const save = h("button", {
      class: "btn small primary",
      onclick: async () => {
        const value = key.value.trim();
        if (!value) {
          toast("先粘贴 API Key");
          return;
        }
        save.disabled = true;
        try {
          await api(`/api/agents/pi/providers/${encodeURIComponent(sel.value)}`, { method: "PUT", body: { key: value } });
          key.value = "";
          toast("已保存。模型列表一分钟内刷新，刷新设置页就能在下拉框里选", 5000);
        } catch (err) {
          toast(`保存失败：${err.message}`, 6000);
        }
        save.disabled = false;
        void load();
      },
    }, "保存 Key");
    const oauthable = providers.filter((p) => p.oauth);
    const oauthSel = h("select", { "aria-label": "订阅账号" }, oauthable.map((p) => h("option", { value: p.id }, `${p.oauth}${p.stored === "oauth" ? "（已登录，重新登录）" : ""}`)));
    const panel = h("div", { class: "pi-oauth" });
    const loginBtn = h("button", { class: "btn small", onclick: () => piOAuthFlow(panel, oauthSel.value, load) }, "登录");
    fill(
      box,
      h("span", {}, "模型服务商"),
      rows.length ? rows : h("small", {}, "还没有能用的服务商：在下面选一家、填上 API Key，或者登录订阅账号。"),
      h("div", { class: "row" }, sel, key, save),
      oauthable.length ? h("div", { class: "row" }, oauthSel, loginBtn) : null,
      oauthable.length ? h("small", {}, "订阅账号（Claude Pro/Max、ChatGPT Plus/Pro、GitHub Copilot、Kimi Code……）在你自己的浏览器里登录，整台服务器共用。订阅能不能用在第三方工具里，以各家的条款为准。") : null,
      panel,
      h("small", {}, "Key 只存在这台服务器上（data/pi/auth.json），网页上不会再显示。也可以给 agent-loft 服务设环境变量（如 DEEPSEEK_API_KEY），重启后自动识别。"),
    );
  };
  void load();
  return box;
}

const PI_API_LABEL = {
  "openai-completions": "OpenAI 兼容（/chat/completions，Ollama、LM Studio、vLLM、one-api 等）",
  "openai-responses": "OpenAI Responses（/responses）",
  "anthropic-messages": "Anthropic 兼容（/messages）",
  "google-generative-ai": "Google Gemini 兼容",
};

/**
 * 自定义服务商：写 data/pi/models.json。本地模型、OpenAI 兼容网关都在这里加。
 * 模型的能力（思考、图片、上下文）按整个服务商统一设，够用；要细调可以直接改文件。
 */
function piCustomSection() {
  const box = h("div", { class: "field pi-custom", "data-nodirty": "" }, h("span", {}, "自定义服务商"), h("small", {}, "正在读取…"));
  const load = async () => {
    let data;
    try {
      data = await api("/api/agents/pi/custom");
    } catch (err) {
      fill(box, h("span", {}, "自定义服务商"), h("div", { class: "error-text" }, err.message), h("button", { class: "btn small", onclick: load }, "重试"));
      return;
    }
    const formSlot = h("div");
    const rows = data.providers.map((p) => {
      const del = h("button", { class: "btn small", onclick: async () => {
        if (!confirm(`删除自定义服务商 ${p.name}？用它的模型的对话会用不了。`)) return;
        try {
          await api(`/api/agents/pi/custom/${encodeURIComponent(p.id)}`, { method: "DELETE" });
          toast(`已删除 ${p.name}`);
        } catch (err) {
          toast(`删除失败：${err.message}`, 5000);
        }
        void load();
      } }, "删除");
      const edit = h("button", { class: "btn small", onclick: () => fill(formSlot, customForm(data.apis, p, () => { formSlot.replaceChildren(); void load(); })) }, "编辑");
      return h("div", { class: "health-row" },
        h("div", { class: "health-head" }, h("b", {}, p.name), h("span", { class: "health-state" }, `${p.models.length} 个模型${p.hasKey ? " · 有 Key" : ""}`), h("span", { class: "grow" }), edit, del),
        h("div", { class: "health-meta" }, `${p.id} · ${p.baseUrl}`));
    });
    const add = h("button", { class: "btn small", onclick: () => fill(formSlot, customForm(data.apis, null, () => { formSlot.replaceChildren(); void load(); })) }, "添加自定义服务商");
    fill(box, h("span", {}, "自定义服务商"), rows, h("div", { class: "row" }, add), formSlot,
      h("small", {}, "本地的 Ollama（http://localhost:11434/v1）、LM Studio、vLLM、llama.cpp，或 one-api 之类的 OpenAI 兼容网关。存在 data/pi/models.json。"));
  };
  void load();
  return box;
}

function customForm(apis, src, done) {
  const first = src?.models?.[0] ?? {};
  const id = h("input", { value: src?.id ?? "", placeholder: "如 ollama、my-gateway", disabled: !!src });
  const name = h("input", { value: src?.name ?? "", placeholder: "显示名称，留空用 id" });
  const baseUrl = h("input", { value: src?.baseUrl ?? "", placeholder: "如 http://localhost:11434/v1" });
  const apiSel = h("select", {}, apis.map((a) => h("option", { value: a, selected: a === (src?.api || "openai-completions") }, PI_API_LABEL[a] ?? a)));
  const key = h("input", { type: "password", autocomplete: "off", placeholder: src?.hasKey ? "留空沿用已保存的" : "本地服务不用填" });
  const clearKey = h("input", { type: "checkbox" });
  const models = h("textarea", { rows: 4, placeholder: "一行一个模型 id，如 qwen2.5-coder:7b" }, (src?.models ?? []).map((m) => m.id).join("\n"));
  const reasoning = h("input", { type: "checkbox", checked: !!first.reasoning });
  const image = h("input", { type: "checkbox", checked: (first.input ?? []).includes("image") });
  const ctx = h("input", { type: "number", min: 1024, step: 1024, value: first.contextWindow ?? "", placeholder: "128000" });
  const discover = h("button", { class: "btn small", onclick: async () => {
    discover.disabled = true;
    try {
      const r = await api("/api/agents/pi/custom-discover", { method: "POST", body: { baseUrl: baseUrl.value, api: apiSel.value, apiKey: key.value, ...(src ? { id: src.id } : {}) } });
      if (!r.models.length) toast("服务没有返回模型");
      else {
        models.value = r.models.join("\n");
        toast(`读到 ${r.models.length} 个模型，删掉不要的再保存`);
      }
    } catch (err) {
      toast(err.message, 6000);
    }
    discover.disabled = false;
  } }, "从服务读取模型列表");
  const save = h("button", { class: "btn small primary", onclick: async () => {
    const ids = models.value.split(/\n+/).map((x) => x.trim()).filter(Boolean);
    const contextWindow = Number(ctx.value) || undefined;
    const body = {
      name: name.value.trim(),
      baseUrl: baseUrl.value.trim(),
      api: apiSel.value,
      models: ids.map((m) => ({ id: m, reasoning: reasoning.checked, image: image.checked, ...(contextWindow ? { contextWindow } : {}) })),
      ...(key.value.trim() ? { apiKey: key.value.trim() } : clearKey.checked || !src ? { apiKey: "" } : {}),
    };
    save.disabled = true;
    try {
      await api(`/api/agents/pi/custom/${encodeURIComponent(src?.id ?? id.value.trim())}`, { method: "PUT", body });
      toast("已保存。刷新设置页后可以在默认模型里选");
      done();
    } catch (err) {
      toast(`保存失败：${err.message}`, 6000);
      save.disabled = false;
    }
  } }, "保存");
  return h("div", { class: "health-fix" },
    h("div", { class: "row-fields" }, field("id", id, src ? "建好后不能改" : "小写字母、数字和 -"), field("名称", name)),
    field("地址（baseUrl）", baseUrl),
    field("接口类型", apiSel),
    field("API Key", key, "只存在服务器上，不会再显示"),
    src?.hasKey ? h("label", { class: "check-item" }, clearKey, "清除已保存的 Key") : null,
    field("模型", models),
    h("div", { class: "row" }, discover),
    h("div", { class: "row" }, h("label", { class: "check" }, reasoning, "支持思考"), h("label", { class: "check" }, image, "支持图片"), field("上下文长度（token）", ctx)),
    h("div", { class: "row" }, save, h("button", { class: "btn small", onclick: done }, "取消")));
}

/**
 * 订阅账号登录：服务端在后台跑 pi 的登录流程，这里每 1.5 秒拉一次状态，
 * 把登录链接、设备码显示出来，pi 要问的（登录方式、企业域名、回调地址）就地作答。
 */
async function piOAuthFlow(panel, provider, after) {
  let timer = null;
  let shownPrompt = null;
  const stop = () => {
    clearTimeout(timer);
    timer = null;
  };
  const cancel = h("button", { class: "btn small", onclick: async () => {
    stop();
    await api("/api/agents/pi/oauth", { method: "DELETE" }).catch(() => {});
    panel.replaceChildren();
  } }, "取消");
  const answer = async (id, value) => {
    try {
      render((await api("/api/agents/pi/oauth/answer", { method: "POST", body: { id, value } })).state);
    } catch (err) {
      toast(err.message, 5000);
    }
  };
  const promptEl = (pr) => {
    if (pr.type === "select") {
      return h("div", { class: "field" }, h("span", {}, pr.message), h("div", { class: "row" }, pr.options.map((o) => h("button", { class: "btn small", title: o.description ?? "", onclick: () => answer(pr.id, o.id) }, o.label))));
    }
    const input = h("input", { type: pr.type === "secret" ? "password" : "text", autocomplete: "off", placeholder: pr.placeholder ?? (pr.type === "manual_code" ? "粘贴浏览器最后跳到的地址，或者授权码" : "") });
    const submit = h("button", { class: "btn small primary", onclick: () => answer(pr.id, input.value) }, "提交");
    input.addEventListener("keydown", (e) => e.key === "Enter" && submit.click());
    return h("div", { class: "field" }, h("span", {}, pr.message), h("div", { class: "row" }, input, submit),
      pr.type === "manual_code" ? h("small", {}, "浏览器在别的机器上时，登录完会跳到一个打不开的 127.0.0.1 / localhost 地址：把地址栏里的整个地址复制过来就行。") : null);
  };
  const noticeEl = (n) => {
    if (n.type === "auth_url") return h("div", {}, h("a", { href: n.url, target: "_blank", rel: "noopener noreferrer", class: "btn small primary" }, "打开登录页"), n.instructions ? h("small", {}, ` ${n.instructions}`) : null);
    if (n.type === "device_code") {
      const copy = h("button", { class: "btn small", onclick: () => copyText(n.userCode, copy) }, "复制");
      return h("div", {}, h("div", { class: "health-cmd" }, h("code", {}, n.userCode), copy), h("small", {}, "到 ", h("a", { href: n.verificationUri, target: "_blank", rel: "noopener noreferrer" }, n.verificationUri), " 输入上面的代码"));
    }
    return h("small", { class: "muted" }, n.message, ...(n.links ?? []).map((l) => [" ", h("a", { href: l.url, target: "_blank", rel: "noopener noreferrer" }, l.label ?? l.url)]));
  };
  const render = (st) => {
    if (!st) {
      stop();
      panel.replaceChildren();
      return;
    }
    if (st.status === "done") {
      stop();
      panel.replaceChildren();
      toast("订阅账号已登录。模型列表一分钟内刷新", 5000);
      after();
      return;
    }
    if (st.status !== "running") {
      stop();
      fill(panel, h("div", { class: "error-text" }, st.status === "cancelled" ? "登录已取消" : `登录失败：${st.error ?? "未知原因"}`));
      return;
    }
    // 输入框里正在打字：问题没变就别重画
    if (st.prompt && shownPrompt === st.prompt.id && panel.contains(document.activeElement)) return;
    shownPrompt = st.prompt?.id ?? null;
    fill(panel, h("div", { class: "health-fix" }, st.notices.map(noticeEl), st.prompt ? promptEl(st.prompt) : h("small", {}, "等你在浏览器里完成登录…"), h("div", { class: "row" }, cancel)));
  };
  const poll = async () => {
    try {
      render((await api("/api/agents/pi/oauth")).state);
    } catch {
      // 网络抖一下，下次再拉
    }
    if (timer !== null) timer = setTimeout(poll, 1500);
  };
  try {
    render((await api("/api/agents/pi/oauth", { method: "POST", body: { provider } })).state);
    timer = setTimeout(poll, 1500);
  } catch (err) {
    toast(`登录失败：${err.message}`, 6000);
  }
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
