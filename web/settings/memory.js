import { fill, h, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { relTime } from "../lib/time.js";
import { agentCatalog } from "../views/topbar.js";
import { expertChoices } from "../views/experts.js";
import { confirmDialog } from "../lib/overlay.js";
import { field, saveButton } from "./common.js";

// ---------- 记忆（每个人自己的） ----------

export async function memoryTab(panel) {
  const box = h("div", { class: "section" }, h("h4", {}, "记忆"), h("span", { class: "spinner" }));
  fill(panel, box);
  let mem;
  try {
    mem = await api("/api/account/memory");
  } catch (err) {
    fill(box, h("h4", {}, "记忆"), h("div", { class: "error-text" }, err.message));
    return;
  }
  const reload = () => void memoryTab(panel);
  const run = (btn, fn) => async () => {
    btn.disabled = true;
    try {
      if ((await fn()) !== false) reload();
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  };

  const enabled = h("input", { type: "checkbox", checked: mem.enabled });
  enabled.onchange = async () => {
    try {
      await api("/api/account/memory", { method: "PUT", body: { enabled: enabled.checked } });
      toast(enabled.checked ? "记忆已开启" : "记忆已关闭，已有的内容保留");
    } catch (err) {
      enabled.checked = !enabled.checked;
      toast(err.message);
    }
  };

  /** 一个开关：改了立刻存 */
  const toggle = (key, label, on, off) => {
    const box = h("input", { type: "checkbox", checked: mem[key] });
    box.onchange = async () => {
      try {
        await api("/api/account/memory", { method: "PUT", body: { [key]: box.checked } });
        toast(box.checked ? on : off);
      } catch (err) {
        box.checked = !box.checked;
        toast(err.message);
      }
    };
    return h("label", { class: "check" }, box, label);
  };
  const history = await api("/api/account/history").catch(() => null);
  const clearHistory = h("button", { class: "btn small" }, "清空聊天记录索引");
  clearHistory.onclick = run(clearHistory, async () => {
    const sure = await confirmDialog({
      title: "清空聊天记录索引？",
      message: "侧栏的「搜索」和 agent 都将搜不到以前聊天的内容（按标题还能搜到；对话本身不删，侧栏里照样能打开）。之后的聊天还会继续记进来。",
      confirmText: "清空",
      danger: true,
    });
    if (!sure) return false;
    await api("/api/account/history", { method: "DELETE" });
    toast("已清空");
  });

  const about = h("textarea", { rows: 5, maxlength: mem.limits.about, placeholder: "比如：我叫小明，在深圳做后端开发，家里有台 QNAP NAS。回答尽量简短，代码用 TypeScript。" });
  about.value = mem.about;
  const saveAbout = saveButton(async () => {
    await api("/api/account/memory", { method: "PUT", body: { about: about.value } });
    toast("已保存，之后的对话会用上");
  });

  const newItem = h("input", { maxlength: mem.limits.item, style: { flex: "1", minWidth: "0" }, placeholder: "手动加一条，比如：我的软路由是 iStoreOS，地址 192.168.8.2" });
  const addBtn = h("button", { class: "btn" }, "添加");
  addBtn.onclick = run(addBtn, async () => {
    if (!newItem.value.trim()) return false;
    await api("/api/account/memory/items", { method: "POST", body: { text: newItem.value } });
  });
  newItem.onkeydown = (e) => {
    if (e.key === "Enter" && !e.isComposing) addBtn.click();
  };

  const items = [...mem.items].sort((a, b) => b.updatedAt - a.updatedAt);
  const itemRow = (it) => {
    const from = { user: "你加的", agent: "agent 在聊天里记的", auto: "聊完后自动整理的" }[it.source] ?? "agent 记的";
    const body = h("div", { class: "grow" }, h("div", { class: "t", style: { whiteSpace: "pre-wrap" } }, it.text), h("div", { class: "s" }, `${from} · ${relTime(it.updatedAt)}`));
    const edit = h("button", { class: "btn small" }, "编辑");
    const del = h("button", { class: "btn small danger" }, "删除");
    edit.onclick = () => {
      const input = h("textarea", { rows: 2, maxlength: mem.limits.item });
      input.value = it.text;
      const ok = h("button", { class: "btn small primary" }, "保存");
      ok.onclick = run(ok, () => api(`/api/account/memory/items/${it.id}`, { method: "PATCH", body: { text: input.value } }));
      fill(body, input, h("div", { class: "row" }, ok, h("button", { class: "btn small", onclick: reload }, "取消")));
      input.focus();
    };
    del.onclick = run(del, () => api(`/api/account/memory/items/${it.id}`, { method: "DELETE" }));
    return h("div", { class: "list-item" }, body, edit, del);
  };

  const clearBtn = h("button", { class: "btn danger" }, "清空全部记忆");
  clearBtn.onclick = run(clearBtn, async () => {
    const sure = await confirmDialog({
      title: "清空全部记忆？",
      message: "「关于我」和所有记住的事都会删除，不能恢复。",
      confirmText: "清空",
      danger: true,
    });
    if (!sure) return false;
    await api("/api/account/memory", { method: "DELETE" });
    toast("已清空");
  });

  fill(
    panel,
    h(
      "div",
      { class: "section" },
      h("h4", {}, "记忆", h("span", { class: "grow" }), h("label", { class: "check" }, enabled, "开启")),
      h(
        "div",
        { class: "muted" },
        "像 ChatGPT 的记忆：对话时 agent 会参考你的「关于我」和记住的事，聊天里遇到长期有用的信息也会主动记一条（会在回复里告诉你）。Claude 和 Codex、Web 和飞书共用这一份。",
      ),
      h(
        "div",
        { class: "muted" },
        "用在哪些对话：你在 Web 上的对话；在「账号」里绑定了飞书后，和机器人的私聊也会用。飞书群聊不用。别人（包括管理员）看不到你的记忆，管理员只能清空它。",
      ),
    ),
    h(
      "div",
      { class: "section" },
      h("h4", {}, "自动"),
      curateSection(mem, reload),
      toggle("chatHistory", "参考以前的聊天", "已开启：agent 能搜你以前的聊天了", "已关闭：agent 不再搜以前的聊天"),
      h(
        "div",
        { class: "muted" },
        `agent 遇到「上次说的那个……」时，可以搜你以前的聊天（只有你自己的对话，被删掉的对话不算）。侧栏的「搜索」也用这份聊天记录索引，不开记忆也会记。${history ? `现在收录了 ${history.conversations} 段对话、${history.count} 句话。` : ""}`,
      ),
      h("div", { class: "row" }, clearHistory),
    ),
    h("div", { class: "section", "data-form": "" }, h("h4", {}, "关于我"), field("写给 agent 看的自我介绍：你是谁、在做什么、希望它怎么回答", about, `每次对话都会带上，最多 ${mem.limits.about} 字`), h("div", { class: "row" }, saveAbout)),
    h(
      "div",
      { class: "section" },
      h("h4", {}, `记住的事（${items.length}）`),
      h("div", { class: "row" }, newItem, addBtn),
      items.length ? items.map(itemRow) : h("div", { class: "muted" }, "还没有。聊天时说「记住……」，或者在上面手动加。"),
    ),
    h(
      "div",
      { class: "section" },
      h("div", { class: "muted" }, "注意：和多用户一样，这不是安全隔离 —— 能读文件的专家（包括内置的 Claude Code / Codex）能读到这台机器上的文件，也包括记忆文件。"),
      h("div", { class: "row" }, clearBtn),
    ),
  );
}

/** 记忆页里的「整理记忆」：什么时候整理、用哪个 agent 的哪个模型、现在整理、上次的结果 */
function curateSection(mem, reload) {
  const c = { ...mem.curate };
  const box = h("div");
  const save = async (patch) => {
    try {
      await api("/api/account/memory", { method: "PUT", body: { curate: patch } });
      Object.assign(c, patch);
      if (patch.agent === "auto") c.model = "";
      render();
      toast("已保存");
    } catch (err) {
      toast(err.message);
      render();
    }
  };
  const select = (value, options, onchange) =>
    h("select", { onchange: (e) => onchange(e.target.value) }, options.map(([v, label]) => h("option", { value: v, selected: String(v) === String(value) }, label)));

  const render = () => {
    const when = select(
      c.when,
      [
        ["daily", "每天一次，把当天聊过的合起来整理（推荐）"],
        ["idle", "每段对话聊完后就整理"],
        ["manual", "只在我点「现在整理」时"],
        ["off", "不整理"],
      ],
      (v) => save({ when: v }),
    );
    // 换了范围，等着整理的段数也跟着变：重新读一遍
    const scope = select(
      c.scope,
      [
        ["all", "全部对话"],
        ["experts", "只整理选中专家的对话"],
      ],
      (v) => save({ scope: v, experts: c.experts ?? [] }).then(reload),
    );
    // 选哪些专家：内置的（Claude Code / Codex）和自己的
    const expertPicks =
      c.scope === "experts"
        ? h(
            "div",
            { class: "check-list" },
            expertChoices().map((e) => {
              const box = h("input", { type: "checkbox", checked: (c.experts ?? []).includes(e.id) });
              box.onchange = () => {
                const next = box.checked ? [...new Set([...(c.experts ?? []), e.id])] : (c.experts ?? []).filter((x) => x !== e.id);
                void save({ experts: next }).then(reload);
              };
              return h("label", { class: "check-item" }, box, h("span", {}, `${e.icon ? `${e.icon} ` : ""}${e.name}`));
            }),
          )
        : null;
    const timing =
      c.when === "idle"
        ? field("停下来多久算聊完", select(c.idleMinutes, [10, 30, 60, 120, 240].map((m) => [m, m < 60 ? `${m} 分钟` : `${m / 60} 小时`]), (v) => save({ idleMinutes: Number(v) })))
        : c.when === "daily"
          ? field(
              "几点整理（服务器所在时区）",
              select(c.dailyHour, Array.from({ length: 24 }, (_, i) => [i, `${i} 点`]), (v) => save({ dailyHour: Number(v) })),
              "这个点之后第一次检查时整理；服务器那会儿没开机的话，开机后补上",
            )
          : null;
    const agent = select(
      c.agent,
      [
        ["auto", "自动：有 Claude 就用 Claude，否则 Codex"],
        ["claude", "Claude Code"],
        ["codex", "Codex"],
      ],
      (v) => save({ agent: v, model: "" }),
    );
    const model =
      c.agent === "auto"
        ? null
        : (() => {
            const sel = h("select", { onchange: (e) => save({ model: e.target.value }) }, h("option", { value: "" }, c.agent === "claude" ? "默认：Haiku（最省）" : "默认模型，思考程度 low（最省）"));
            if (c.model) sel.append(h("option", { value: c.model, selected: true }, c.model));
            agentCatalog(c.agent)
              .then((models) => {
                for (const m of models) {
                  if (m.id === "default" || m.id === c.model) continue;
                  sel.append(h("option", { value: m.id }, m.label || m.id));
                }
              })
              .catch(() => sel.append(h("option", { value: "", disabled: true }, "（这个 agent 没启用，读不到模型列表）")));
            return field("模型", sel, "整理只是读一遍对话、改几条记忆，用便宜的模型就够了；贵的模型会多占订阅额度");
          })();

    const nowBtn = h("button", { class: "btn small", disabled: c.when === "off" || !mem.enabled }, "现在整理");
    nowBtn.onclick = async () => {
      nowBtn.disabled = true;
      nowBtn.textContent = "整理中…";
      try {
        const r = await api("/api/account/memory/curate", { method: "POST" });
        toast(
          r.error
            ? `整理失败：${r.error}`
            : r.conversations
              ? `整理了 ${r.conversations} 段对话：新增 ${r.added.length}、更新 ${r.updated.length}、删除 ${r.removed}`
              : "没有需要整理的对话（正在回复的那段先不整理）",
        );
        reload();
      } catch (err) {
        toast(err.message);
        nowBtn.disabled = false;
        nowBtn.textContent = "现在整理";
      }
    };
    const last = mem.lastCuration;
    const lastText = last
      ? last.error
        ? `上次整理（${relTime(last.at)}）没成功：${last.error}`
        : `上次整理：${relTime(last.at)}，${last.conversations} 段对话${last.by ? `，用 ${last.by}` : ""}，新增 ${last.added.length}、更新 ${last.updated.length}、删除 ${last.removed}`
      : "还没整理过";

    fill(
      box,
      field("整理记忆", when),
      h(
        "div",
        { class: "muted" },
        {
          daily: "攒一天再整理：每次整理都要把你现有的记忆整份带上，合起来一次最省额度，几段对话放在一起看也更容易合并重复。改了什么只显示在这里，不打扰对话。",
          idle: "每段对话停下来就整理一次，改了什么会在那条对话里告诉你。最及时，但聊得多时调用次数也多。",
          manual: "聊过的内容会攒着，你点「现在整理」时一次整理完。",
          off: "不整理，聊过的内容也不攒着。聊天里 agent 照样可以自己用 remember 记东西。",
        }[c.when],
      ),
      timing,
      c.when === "off" ? null : field("整理哪些对话", h("div", {}, scope, expertPicks), "按对话用的专家算；不在范围里的对话直接跳过，之后改回来也不会补整理"),
      c.when === "off" ? null : field("用哪个 agent", agent),
      c.when === "off" ? null : model,
      h("div", { class: "row", style: { alignItems: "center", gap: "10px" } }, nowBtn, h("span", { class: "muted" }, `${mem.pending ? `有 ${mem.pending} 段对话等着整理。` : ""}${lastText}`)),
      h("div", { class: "muted" }, "整理时会对照现有记忆补充、更新或删掉过时的条目；你自己加的条目它不会动。"),
    );
  };
  render();
  return box;
}
