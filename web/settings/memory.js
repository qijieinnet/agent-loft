import { fill, h, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { relTime } from "../lib/time.js";
import { agentCatalog } from "../views/topbar.js";
import { expertChoices } from "../views/experts.js";
import { confirmDialog } from "../lib/overlay.js";
import { field, saveButton } from "./common.js";

// ---------- 记忆（每个人自己的） ----------

/** 列表一次先显示这么多条 */
const PAGE = 50;

/** 筛选词和显示了多少条：改了东西页面会刷新，刷新后还是原样 */
const listState = { filter: "", shown: PAGE };

function dayText(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 展开着的区块：改了东西页面会刷新，刷新后还开着 */
const openSections = new Set();

/** 一个点开才读的区块 */
function lazySection(key, title, load) {
  const body = h("div", { class: "memory-more-body" });
  const details = h("details", { open: openSections.has(key) }, h("summary", { class: "memory-more" }, title), body);
  let loaded = false;
  details.ontoggle = () => {
    if (details.open) openSections.add(key);
    else openSections.delete(key);
    if (!details.open || loaded) return;
    loaded = true;
    void load(body);
  };
  return h("div", { class: "section" }, details);
}

/** 归档和回收站：点开才读 */
function otherItemsSection(title, view, count, hint, reload, run) {
  return lazySection(view, `${title}（${count}）`, async (body) => {
    fill(body, h("span", { class: "spinner" }));
    let items;
    try {
      items = (await api(`/api/account/memory/items?view=${view}`)).items;
    } catch (err) {
      fill(body, h("div", { class: "error-text" }, err.message));
      return;
    }
    const row = (it) => {
      const restore = h("button", { class: "btn small" }, "恢复");
      const buttons = [restore];
      if (view === "archive") {
        restore.onclick = run(restore, () => api(`/api/account/memory/items/${it.id}`, { method: "PATCH", body: { tier: "active" } }));
        const del = h("button", { class: "btn small danger" }, "删除");
        del.onclick = run(del, () => api(`/api/account/memory/items/${it.id}`, { method: "DELETE" }));
        buttons.push(del);
      } else {
        restore.onclick = run(restore, () => api(`/api/account/memory/items/${it.id}/restore`, { method: "POST" }));
        const purge = h("button", { class: "btn small danger" }, "彻底删除");
        purge.onclick = run(purge, async () => {
          const sure = await confirmDialog({ title: "彻底删除这条？", message: "连同它的改动记录一起删掉，不能恢复。", confirmText: "彻底删除", danger: true });
          if (!sure) return false;
          await api(`/api/account/memory/items/${it.id}?purge=1`, { method: "DELETE" });
        });
        buttons.push(purge);
      }
      const when = view === "trash" ? `删于 ${relTime(it.deletedAt)}` : relTime(it.updatedAt);
      return h("div", { class: "list-item memory-item" }, h("div", { class: "grow" }, h("div", { class: "t", style: { whiteSpace: "pre-wrap" } }, it.text), h("div", { class: "s" }, when)), ...buttons);
    };
    fill(body, h("div", { class: "muted" }, hint), items.length ? items.slice(0, 200).map(row) : h("div", { class: "muted" }, "这里没有东西。"));
  });
}

const ACTORS = { user: "你", agent: "agent", auto: "自动整理", system: "系统" };

function describeChange(e) {
  const text = e.newText ?? e.oldText ?? "";
  if (e.action === "about") return "改了「关于我」";
  if (e.action === "add") return `记下：${text}`;
  if (e.action === "update") return `改成：${text}（原来是：${e.oldText ?? ""}）`;
  if (e.action === "delete") return `删掉：${text}`;
  if (e.action === "restore") return `恢复：${text}`;
  const tiers = { core: "长期", active: "活跃", archive: "归档" };
  return `把一条从「${tiers[e.oldTier] ?? e.oldTier}」挪到「${tiers[e.newTier] ?? e.newTier}」${e.note ? `（${e.note}）` : ""}`;
}

/** 改动记录：谁在什么时候改了什么，可以撤销 */
function logSection(reload) {
  return lazySection("log", "改动记录", async (body) => {
    const list = h("div");
    let before;
    const more = h("button", { class: "btn small" }, "再看更早的");
    const row = (e) => {
      const undo = h("button", { class: "btn small" }, "撤销");
      undo.onclick = async () => {
        undo.disabled = true;
        try {
          await api(`/api/account/memory/log/${e.id}/undo`, { method: "POST" });
          toast("已撤销");
          await reload();
        } catch (err) {
          toast(err.message);
          undo.disabled = false;
        }
      };
      return h(
        "div",
        { class: "list-item memory-item" },
        h("div", { class: "grow" }, h("div", { class: "t", style: { whiteSpace: "pre-wrap" } }, describeChange(e)), h("div", { class: "s" }, `${ACTORS[e.actor] ?? e.actor} · ${relTime(e.at)}${e.undoneAt ? " · 已撤销" : ""}`)),
        e.undoneAt ? null : undo,
      );
    };
    const page = async () => {
      try {
        const { log } = await api(`/api/account/memory/log${before ? `?before=${before}` : ""}`);
        if (!before && log.length === 0) list.append(h("div", { class: "muted" }, "还没有改动。"));
        for (const e of log) list.append(row(e));
        before = log.at(-1)?.id;
        more.hidden = log.length < 30;
      } catch (err) {
        toast(err.message);
      }
    };
    more.onclick = page;
    fill(body, h("div", { class: "muted" }, "记忆的每一次改动都在这里，自动整理改错了可以撤销。"), list, more);
    await page();
  });
}

/** 摘要：月度的和每段对话的 */
function summariesSection(mem) {
  const total = (mem.summaries?.conv ?? 0) + (mem.summaries?.month ?? 0);
  return lazySection("summaries", `摘要（${total}）`, async (body) => {
    const list = h("div");
    let offset = 0;
    const more = h("button", { class: "btn small" }, "再看更早的");
    const row = (s) => {
      const del = h("button", { class: "btn small danger" }, "删除");
      const item = h(
        "div",
        { class: "list-item memory-item" },
        h(
          "div",
          { class: "grow" },
          h("div", { class: "t" }, `${s.kind === "month" ? `${s.scope} 月度：` : ""}${s.title}`),
          h("div", { style: { whiteSpace: "pre-wrap" } }, s.text),
          h("div", { class: "s" }, `${dayText(s.toTs)}${s.project ? ` · ${s.project}` : ""}`),
        ),
        del,
      );
      del.onclick = async () => {
        del.disabled = true;
        try {
          await api(`/api/account/memory/summaries/${s.id}`, { method: "DELETE" });
          item.remove();
        } catch (err) {
          toast(err.message);
          del.disabled = false;
        }
      };
      return item;
    };
    const page = async () => {
      try {
        const { summaries } = await api(`/api/account/memory/summaries?offset=${offset}`);
        if (offset === 0 && summaries.length === 0) list.append(h("div", { class: "muted" }, "还没有。整理记忆时会顺带给每段对话写摘要，一个月过去之后合成月度摘要。"));
        for (const s of summaries) list.append(row(s));
        offset += 30;
        more.hidden = summaries.length < 30;
      } catch (err) {
        toast(err.message);
      }
    };
    more.onclick = page;
    fill(body, h("div", { class: "muted" }, "agent 回答「那段时间做了什么」「那件事的经过」时会看这些。整理范围内的对话才有。"), list, more);
    await page();
  });
}

/** 导出、导入、备份、搜索统计 */
function dataSection(mem, reload) {
  const file = h("input", { type: "file", accept: "application/json,.json", style: { display: "none" } });
  const importBtn = h("button", { class: "btn small" }, "导入记忆");
  importBtn.onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files?.[0];
    file.value = "";
    if (!f) return;
    importBtn.disabled = true;
    try {
      const r = await api("/api/account/memory/import", { method: "POST", body: JSON.parse(await f.text()) });
      toast(`导入了 ${r.added} 条记忆${r.summaries ? `、${r.summaries} 份摘要` : ""}${r.skipped ? `，${r.skipped} 条已有的跳过` : ""}`);
      await reload();
    } catch (err) {
      toast(err instanceof SyntaxError ? "这个文件不是合法的 JSON" : err.message);
    } finally {
      importBtn.disabled = false;
    }
  };
  const stats = mem.searchStats;
  const b = mem.backup;
  let backupRow = null;
  if (b) {
    const btn = h("button", { class: "btn small" }, "现在备份");
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "备份中…";
      try {
        await api("/api/account/memory/backup", { method: "POST" });
        toast("已备份");
        await reload();
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
        btn.textContent = "现在备份";
      }
    };
    const size = b.last ? `，${(b.last.size / 1048576).toFixed(1)} MB` : "";
    backupRow = [
      h("div", { class: "row", style: { alignItems: "center", gap: "10px" } }, btn, h("span", { class: "muted" }, b.last ? `上次备份：${relTime(b.last.at)}${size}，共 ${b.count} 份` : "还没有备份")),
      h("div", { class: "muted" }, `整个数据库每天自动备份一份到 ${b.dir}（留最近 7 天、4 周、12 个月）。这个目录和数据在同一块盘上，防不了硬盘损坏；可以设环境变量 AGENT_LOFT_BACKUP_DIR 放到别的盘。`),
      b.error ? h("div", { class: "error-text" }, `上次备份失败（${relTime(b.error.at)}）：${b.error.message}`) : null,
    ];
  }
  return h(
    "div",
    { class: "section" },
    h("h4", {}, "导出和备份"),
    h(
      "div",
      { class: "row" },
      h("a", { class: "btn small memory-link", href: "/api/account/memory/export", download: "" }, "导出记忆"),
      h("a", { class: "btn small memory-link", href: "/api/account/history/export", download: "" }, "导出聊天记录"),
      importBtn,
      file,
    ),
    h("div", { class: "muted" }, "记忆导出成 JSON（条目、摘要和改动记录），可以导入到别的账号或服务器，内容一样的会跳过。聊天记录导出成一行一句的 JSONL。"),
    backupRow,
    stats?.searches ? h("div", { class: "muted" }, `近 30 天 agent 搜了 ${stats.searches} 次聊天记录，${stats.empty} 次没搜到。`) : null,
  );
}

export async function memoryTab(panel, refresh = false) {
  const box = h("div", { class: "section" }, h("h4", {}, "记忆"), h("span", { class: "spinner" }));
  // 更新时保留旧内容，避免加载占位让页面变短、滚动位置被浏览器压回顶部。
  if (!refresh) fill(panel, box);
  let mem;
  try {
    mem = await api("/api/account/memory");
  } catch (err) {
    if (refresh) toast(err.message);
    else fill(box, h("h4", {}, "记忆"), h("div", { class: "error-text" }, err.message));
    return;
  }
  const reload = () => memoryTab(panel, true);
  const run = (btn, fn) => async () => {
    btn.disabled = true;
    try {
      if ((await fn()) !== false) await reload();
    } catch (err) {
      toast(err.message);
    } finally {
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
      message: "侧栏的「搜索」和 agent 都将搜不到以前聊天的内容（按标题还能搜到；对话本身不删，侧栏里照样能打开）。从聊天写出来的对话摘要和月度摘要也一起清掉。之后的聊天还会继续记进来。",
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

  const newItem = h("input", { class: "input", maxlength: mem.limits.item, style: { flex: "1", minWidth: "0" }, placeholder: "手动加一条，比如：我的软路由是 iStoreOS，地址 192.168.8.2" });
  const addBtn = h("button", { class: "btn" }, "添加");
  addBtn.onclick = run(addBtn, async () => {
    if (!newItem.value.trim()) return false;
    await api("/api/account/memory/items", { method: "POST", body: { text: newItem.value } });
  });
  newItem.onkeydown = (e) => {
    if (e.key === "Enter" && !e.isComposing) addBtn.click();
  };

  const items = [...mem.items].sort((a, b) => Math.max(b.updatedAt, b.lastUsedAt ?? 0) - Math.max(a.updatedAt, a.lastUsedAt ?? 0));
  const patchItem = (it, body) => api(`/api/account/memory/items/${it.id}`, { method: "PATCH", body });
  const itemMeta = (it) => {
    const from = { user: "你加的", asked: "你让记的", agent: "agent 在聊天里记的", auto: "聊完后自动整理的" }[it.source] ?? "agent 记的";
    return [
      it.tier === "core" ? (it.locked ? "已置顶" : "长期") : "",
      from,
      relTime(it.updatedAt),
      it.observedAt ? `事情发生在 ${dayText(it.observedAt)}` : "",
      it.validUntil ? `到 ${dayText(it.validUntil)} 过期` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  };
  const itemRow = (it) => {
    const body = h("div", { class: "grow" }, h("div", { class: "t", style: { whiteSpace: "pre-wrap" } }, it.text), h("div", { class: "s" }, itemMeta(it)));
    const edit = h("button", { class: "btn small" }, "编辑");
    const pin = h("button", { class: "btn small", title: "置顶的一直放在系统提示里，自动整理也不会动它" }, it.tier === "core" ? "取消置顶" : "置顶");
    const archive = h("button", { class: "btn small", title: "归档：不再放进系统提示，agent 需要时还能搜到" }, "归档");
    const del = h("button", { class: "btn small danger" }, "删除");
    edit.onclick = () => {
      edit.hidden = del.hidden = pin.hidden = archive.hidden = true;
      const input = h("textarea", { class: "input", rows: 2, maxlength: mem.limits.item });
      input.value = it.text;
      const ok = h("button", { class: "btn small primary" }, "保存");
      ok.onclick = run(ok, () => patchItem(it, { text: input.value }));
      fill(body, input, h("div", { class: "row" }, ok, h("button", { class: "btn small", onclick: reload }, "取消")));
      input.focus();
    };
    pin.onclick = run(pin, () => patchItem(it, { tier: it.tier === "core" ? "active" : "core" }));
    archive.onclick = run(archive, () => patchItem(it, { tier: "archive" }));
    del.onclick = run(del, () => api(`/api/account/memory/items/${it.id}`, { method: "DELETE" }));
    return h("div", { class: "list-item memory-item" }, body, edit, pin, archive, del);
  };

  // 条目多了要能找：输入就筛，一次先显示前 PAGE 条
  const listBox = h("div");
  const filter = h("input", { class: "input", style: { flex: "1", minWidth: "0" }, placeholder: "筛选记住的事" });
  filter.value = listState.filter;
  const renderList = () => {
    const q = filter.value.trim().toLowerCase();
    const hit = q ? items.filter((it) => it.text.toLowerCase().includes(q)) : items;
    fill(
      listBox,
      hit.length ? hit.slice(0, listState.shown).map(itemRow) : h("div", { class: "muted" }, q ? "没有匹配的。" : "还没有。聊天时说「记住……」，或者在上面手动加。"),
      hit.length > listState.shown ? h("button", { class: "btn small", onclick: () => ((listState.shown += PAGE), renderList()) }, `再显示一些（还有 ${hit.length - listState.shown} 条）`) : null,
    );
  };
  filter.oninput = () => {
    listState.filter = filter.value;
    listState.shown = PAGE;
    renderList();
  };
  renderList();

  const clearBtn = h("button", { class: "btn danger" }, "清空全部记忆");
  clearBtn.onclick = run(clearBtn, async () => {
    const sure = await confirmDialog({
      title: "清空全部记忆？",
      message: "「关于我」、所有记住的事（包括归档和回收站）、改动记录和摘要都会彻底删除，不能恢复。想留一份的话先导出。",
      confirmText: "清空",
      danger: true,
    });
    if (!sure) return false;
    await api("/api/account/memory", { method: "DELETE" });
    toast("已清空");
  });

  // 数据都已就绪再替换；保留用户在等待接口期间滚动到的位置。
  const scroller = panel.closest(".settings-body");
  const scrollTop = scroller?.scrollTop ?? 0;
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
      h("div", { class: "muted" }, "「长期」和置顶的一直放在系统提示里；其余的按最近动过的时间放，放不下的 agent 需要时能搜到。满了会把最久没动过的挪到归档，不会删掉。你加的、你让记的、置顶的，自动整理都不会动。"),
      h("div", { class: "row" }, newItem, addBtn),
      items.length > 8 ? h("div", { class: "row" }, filter) : null,
      listBox,
    ),
    otherItemsSection("归档", "archive", mem.counts?.archive ?? 0, "过时了的事。不放进系统提示，agent 问到以前的情况时能搜到。", reload, run),
    otherItemsSection("回收站", "trash", mem.counts?.trash ?? 0, "删掉的放在这里 30 天，之后彻底删除。", reload, run),
    logSection(reload),
    summariesSection(mem),
    dataSection(mem, reload),
    h(
      "div",
      { class: "section" },
      h("div", { class: "muted" }, "注意：和多用户一样，这不是安全隔离 —— 能读文件的专家（包括内置的 Claude Code / Codex）能读到这台机器上的文件，也包括记忆文件。"),
      h("div", { class: "row" }, clearBtn),
    ),
  );
  if (scroller) scroller.scrollTop = scrollTop;
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
        ["workbuddy", "WorkBuddy"],
        ["pi", "pi"],
        ["dsh", "dsh"],
      ],
      (v) => save({ agent: v, model: "" }),
    );
    const model =
      c.agent === "auto"
        ? null
        : (() => {
            const sel = h("select", { onchange: (e) => save({ model: e.target.value }) }, h("option", { value: "" }, c.agent === "claude" ? "默认：Haiku（最省）" : c.agent === "workbuddy" ? "默认模型" : c.agent === "pi" ? "默认模型（思考程度 minimal）" : c.agent === "dsh" ? "默认模型（思考程度 off）" : "默认模型，思考程度 low（最省）"));
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
              ? `整理了 ${r.conversations} 段对话：新增 ${r.added.length}、更新 ${r.updated.length}、移走 ${r.removed}`
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
    const retryText = mem.curateRetry ? `失败的对话都留着，${new Date(mem.curateRetry.nextAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 之后自动再试。` : "失败的对话都留着，下次再试。";
    const lastText = last
      ? last.error
        ? `上次整理（${relTime(last.at)}）${last.conversations ? `成功 ${last.conversations} 段，其余` : ""}没成功：${last.error}。${retryText}`
        : `上次整理：${relTime(last.at)}，${last.conversations} 段对话${last.by ? `，用 ${last.by}` : ""}，新增 ${last.added.length}、更新 ${last.updated.length}、移走 ${last.removed}${last.summaries ? `、写了 ${last.summaries} 份摘要` : ""}`
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
      h("div", { class: "muted" }, "整理时会对照现有记忆补充、更新、归档过时的条目，顺带给每段对话写摘要。你加的、你让记的、置顶的它不会动；改错了可以在下面的「改动记录」里撤销。"),
    );
  };
  render();
  return box;
}
