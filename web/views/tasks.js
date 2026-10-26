import { fill, h, icon, starsLoader, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { clockTime } from "../lib/time.js";
import { confirmDialog, modal, showMenu } from "../lib/overlay.js";
import { S, ui } from "../state.js";
import { WS } from "../lib/ws.js";
import { agentLabel, closeSide, renderSidebar } from "./sidebar.js";
import { baseName, renderTopbar, usableAgents } from "./topbar.js";
import { openConversation } from "./messages.js";
import { changeCwd } from "./conv-actions.js";
import { attachMention } from "./mention.js";

// ---------- 定时任务页 ----------
// 到点让 agent 按提示词干活，结果回到一条对话里；「有需要才提醒」时由 agent 判断这次要不要打扰你。
// 列表只有自己的任务（服务端按人过滤）。任务有变化时服务端推 { t: "tasks" }，这里重新拉一遍。

const T = { list: [], tz: "", token: 0, reloadTimer: 0 };

const STATUS = {
  running: { text: "运行中", cls: "run" },
  notified: { text: "已提醒", cls: "ok" },
  silent: { text: "无需提醒", cls: "quiet" },
  error: { text: "出错", cls: "bad" },
  skipped: { text: "跳过", cls: "quiet" },
  interrupted: { text: "中断", cls: "bad" },
};

const FREQS = [
  ["once", "一次"],
  ["daily", "每天"],
  ["weekdays", "工作日（周一到周五）"],
  ["weekly", "每周"],
  ["monthly", "每月"],
  ["hourly", "每隔几小时"],
  ["cron", "自定义（cron）"],
];

const EXAMPLES = [
  {
    title: "检查 agent-loft 更新",
    prompt: "查一下 npm 上 agent-loft 的最新版本（https://www.npmjs.com/package/agent-loft），和当前服务端版本比较。有新版本就告诉我新版本号和主要更新内容。",
    schedule: { kind: "daily", time: "09:00" },
    notify: "smart",
    mode: "chat",
  },
  {
    title: "科技新闻早报",
    prompt: "搜一下过去 24 小时最重要的科技新闻，挑 5 条，每条用一两句话说明为什么值得关注，附上链接。",
    schedule: { kind: "daily", time: "08:30" },
    notify: "always",
    mode: "chat",
  },
  {
    title: "下班前看看改了什么",
    prompt: "用 git status 和 git log --since=midnight 看看这个目录今天改了什么，帮我列一个简短的日报草稿。今天没有任何改动的话就不用提醒我。",
    schedule: { kind: "weekdays", time: "18:00" },
    notify: "smart",
    mode: "work",
  },
];

/** 「今天 09:00」「明天 02:00」「10月25日 08:30」 */
function whenText(ms) {
  const d = new Date(ms);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86400000);
  if (diff === 0) return `今天 ${hm}`;
  if (diff === 1) return `明天 ${hm}`;
  if (diff === 2) return `后天 ${hm}`;
  return d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}月${d.getDate()}日 ${hm}` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** <input type="datetime-local"> 要的本地时间格式 */
function toLocalInput(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export async function openTasks() {
  if (S.current) WS.raw({ t: "unsub", key: S.current });
  S.current = null;
  // 远程控制页藏起来，连接留着（views/remote.js）
  document.dispatchEvent(new Event("aim:leave-view"));
  S.view = "tasks";
  S.items = [];
  S.turnAi = null;
  history.replaceState(history.state, "", "#tasks");
  WS.presence();
  ui.spacer.style.height = "0px";
  // 对话页的「贴底跟随」在这里不要：内容一变它就会滚到最底下
  ui.follow = false;
  // 输入框、「回到底部」藏起来（样式见 css/tasks.css 的 .tasks-view）
  ui.main.classList.add("tasks-view");
  closeSide();
  renderTopbar();
  renderSidebar();
  fill(ui.msgInner, h("div", { class: "empty" }, starsLoader("lg")));
  await reload();
  // 从对话切过来时滚动条还停在对话底部
  ui.messages.scrollTop = 0;
}

async function reload() {
  const my = ++T.token;
  try {
    const data = await api("/api/tasks");
    if (my !== T.token || S.view !== "tasks") return;
    T.list = data.tasks;
    T.tz = data.tz;
    render();
  } catch (err) {
    if (my === T.token && S.view === "tasks") fill(ui.msgInner, h("div", { class: "empty" }, err.message));
  }
}

// 服务端说任务变了（别的设备改了、跑完了一次）：在这个页面上就重新拉，连着来的合成一次
document.addEventListener("aim:tasks", () => {
  if (S.view !== "tasks") return;
  clearTimeout(T.reloadTimer);
  T.reloadTimer = setTimeout(() => void reload(), 300);
});

function render() {
  fill(
    ui.msgInner,
    h(
      "div",
      { class: "tasks-page" },
      h(
        "div",
        { class: "tasks-head" },
        h(
          "div",
          { class: "grow" },
          h("h2", {}, "定时任务"),
          h("p", {}, `到点让 agent 自动去做，结果发回对话；可以只在有需要时才提醒你。时间按服务端时区（${T.tz}）。`),
        ),
        h("button", { class: "btn primary", onclick: () => openTaskForm() }, icon("plus"), "新建"),
      ),
      T.list.length ? h("div", { class: "task-list" }, T.list.map(taskCard)) : emptyState(),
      h(
        "p",
        { class: "tasks-tip" },
        "也可以直接在对话里说「每天早上 9 点帮我……」，agent 会帮你建好（会先弹一张卡让你确认）。",
      ),
    ),
  );
}

function emptyState() {
  return h(
    "div",
    { class: "tasks-empty" },
    h("div", { class: "tasks-empty-icon" }, icon("clock")),
    h("div", { class: "t" }, "还没有定时任务"),
    h("div", { class: "s" }, "从一个例子开始："),
    h(
      "div",
      { class: "task-examples" },
      EXAMPLES.map((ex) =>
        h("button", { class: "task-example", onclick: () => openTaskForm(null, ex) }, h("div", { class: "t" }, ex.title), h("div", { class: "s" }, ex.prompt)),
      ),
    ),
  );
}

function openConv(key) {
  if (!key) return;
  void openConversation(key);
}

function runLine(run, compact) {
  const st = STATUS[run.status] ?? { text: run.status, cls: "quiet" };
  const detail = run.preview || run.note || "";
  return h(
    run.convKey ? "button" : "div",
    {
      class: `task-run${compact ? " compact" : ""}`,
      ...(run.convKey ? { title: "打开这次运行所在的对话", onclick: () => openConv(run.convKey) } : {}),
    },
    h("span", { class: `task-status ${st.cls}` }, run.status === "running" ? h("span", { class: "conv-spin" }) : null, st.text),
    h("span", { class: "task-run-at" }, clockTime(run.at)),
    detail ? h("span", { class: "task-run-text" }, detail) : null,
  );
}

function taskCard(t) {
  const once = t.schedule.kind === "once";
  const state = t.running
    ? "运行中"
    : t.enabled && t.nextRunAt
      ? `下次 ${whenText(t.nextRunAt)}`
      : once && t.runs.some((r) => r.status !== "skipped")
        ? "已完成"
        : "已暂停";
  const where =
    t.target.kind === "conv"
      ? `发到「${t.convTitle || "对话"}」`
      : `${agentLabel(t.agent)} · ${t.mode === "work" ? "工作模式" : "聊天模式"}${t.mode === "work" && t.cwd ? ` · ${baseName(t.cwd)}` : ""}`;
  const toggle = h("input", { type: "checkbox", checked: t.enabled, title: t.enabled ? "暂停" : "启用" });
  toggle.onchange = async () => {
    try {
      await api(`/api/tasks/${encodeURIComponent(t.id)}`, { method: "PATCH", body: { enabled: toggle.checked } });
      toast(toggle.checked ? "已启用" : "已暂停");
      void reload();
    } catch (err) {
      toggle.checked = !toggle.checked;
      toast(err.message);
    }
  };
  const more = h("button", { class: "icon-btn", title: "更多" }, icon("more"));
  more.onclick = () =>
    showMenu(more, [
      { label: "编辑…", onclick: () => openTaskForm(t) },
      { label: "立即运行", onclick: () => runNow(t) },
      ...(t.convKey ? [{ label: "打开对话", onclick: () => openConv(t.convKey) }] : []),
      "sep",
      { label: "删除", danger: true, onclick: () => removeTask(t) },
    ]);
  const [last, ...older] = t.runs;
  return h(
    "div",
    { class: `task-card${t.enabled ? "" : " off"}` },
    h(
      "div",
      { class: "task-top" },
      h("button", { class: "task-title", title: "编辑", onclick: () => openTaskForm(t) }, t.title),
      h("label", { class: "switch", title: t.enabled ? "已启用，点击暂停" : "已暂停，点击启用" }, toggle, h("span", { class: "slider" })),
      more,
    ),
    h(
      "div",
      { class: "task-meta" },
      h("span", {}, t.summary),
      h("span", {}, state),
      h("span", {}, t.notify === "smart" ? "有需要才提醒" : "每次都提醒"),
      h("span", {}, where),
    ),
    h("div", { class: "task-prompt" }, t.prompt),
    last ? runLine(last) : h("div", { class: "task-run muted" }, "还没有运行过"),
    older.length
      ? h("details", { class: "task-history" }, h("summary", {}, `更早的 ${older.length} 次`), older.map((r) => runLine(r, true)))
      : null,
  );
}

async function runNow(t) {
  try {
    await api(`/api/tasks/${encodeURIComponent(t.id)}/run`, { method: "POST" });
    toast("已开始运行，结果会发到对话里");
    void reload();
  } catch (err) {
    toast(err.message);
  }
}

async function removeTask(t) {
  const sure = await confirmDialog({
    title: `删除「${t.title}」？`,
    message: "删除后不会再运行。之前运行的结果还留在对话里。",
    confirmText: "删除",
    danger: true,
  });
  if (!sure) return;
  try {
    await api(`/api/tasks/${encodeURIComponent(t.id)}`, { method: "DELETE" });
    toast("已删除");
    void reload();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- 新建 / 编辑 ----------

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WEEK_NAME = ["日", "一", "二", "三", "四", "五", "六"];

/** task：编辑这个；preset：新建时预填（例子） */
export function openTaskForm(task, preset) {
  const src = task ?? preset ?? {};
  const agents = usableAgents();
  const title = h("input", { value: src.title ?? "", maxlength: "60", placeholder: "比如：检查 agent-loft 更新" });
  const prompt = h("textarea", { rows: 5, maxlength: "4000", placeholder: "到点让 agent 做什么。写成完整的指令：那时你多半不在，它没法再问你。可以用 @ 指定技能。" });
  prompt.value = src.prompt ?? "";
  // @ 技能：和输入框一样，到点时服务端认提示词里的 @name
  const mentionMenu = h("div", { class: "slash-menu below", hidden: true });
  const mention = attachMention(prompt, mentionMenu);
  prompt.addEventListener("input", () => void mention.update());
  prompt.addEventListener("blur", () => setTimeout(mention.close, 150));
  prompt.addEventListener("keydown", (e) => {
    if (mention.keydown(e)) e.preventDefault();
  });

  // ---- 频率 ----
  const sch = { kind: "daily", time: "09:00", days: [1], day: 1, every: 2, minute: 0, expr: "0 9 * * *", at: Date.now() + 3600_000, ...(src.schedule ?? {}) };
  if (sch.kind === "weekdays" || sch.kind === "daily") sch.days = sch.days ?? [1];
  const freq = h("select", {}, FREQS.map(([v, label]) => h("option", { value: v, selected: v === sch.kind }, label)));
  const freqBox = h("div", { class: "task-freq" });
  const timeInput = () => {
    const el = h("input", { type: "time", value: sch.time, required: true });
    el.oninput = () => (sch.time = el.value);
    return el;
  };
  const renderFreq = () => {
    sch.kind = freq.value;
    const parts = [];
    if (sch.kind === "once") {
      const at = h("input", { type: "datetime-local", value: toLocalInput(sch.at) });
      at.oninput = () => (sch.at = new Date(at.value).getTime());
      parts.push(at);
    } else if (sch.kind === "daily" || sch.kind === "weekdays") {
      parts.push(timeInput());
    } else if (sch.kind === "weekly") {
      parts.push(
        h(
          "div",
          { class: "day-chips" },
          WEEK_ORDER.map((d) => {
            const b = h("button", { type: "button", class: `day-chip${sch.days.includes(d) ? " on" : ""}` }, WEEK_NAME[d]);
            b.onclick = () => {
              sch.days = sch.days.includes(d) ? sch.days.filter((x) => x !== d) : [...sch.days, d];
              b.classList.toggle("on", sch.days.includes(d));
            };
            return b;
          }),
        ),
        timeInput(),
      );
    } else if (sch.kind === "monthly") {
      const day = h("input", { type: "number", min: "1", max: "31", value: String(sch.day), class: "narrow" });
      day.oninput = () => (sch.day = Number(day.value));
      parts.push(h("span", { class: "freq-word" }, "每月"), day, h("span", { class: "freq-word" }, "日"), timeInput());
    } else if (sch.kind === "hourly") {
      const every = h("select", { class: "narrow" }, [1, 2, 3, 4, 6, 8, 12].map((n) => h("option", { value: String(n), selected: n === sch.every }, String(n))));
      every.onchange = () => (sch.every = Number(every.value));
      const minute = h("input", { type: "number", min: "0", max: "59", value: String(sch.minute), class: "narrow" });
      minute.oninput = () => (sch.minute = Number(minute.value));
      parts.push(h("span", { class: "freq-word" }, "每"), every, h("span", { class: "freq-word" }, "小时，第"), minute, h("span", { class: "freq-word" }, "分"));
    } else {
      const expr = h("input", { value: sch.expr, placeholder: "分 时 日 月 周", spellcheck: "false" });
      expr.oninput = () => (sch.expr = expr.value);
      parts.push(expr);
    }
    fill(freqBox, parts);
  };
  freq.onchange = renderFreq;
  renderFreq();
  const freqHint = `按服务端时区（${T.tz || "本地时间"}）。两次运行至少隔 15 分钟。`;

  // ---- 提醒 ----
  const notify = h(
    "select",
    {},
    h("option", { value: "smart", selected: (src.notify ?? "smart") === "smart" }, "有需要才提醒（agent 判断，没事不打扰）"),
    h("option", { value: "always", selected: src.notify === "always" }, "每次都提醒"),
  );

  // ---- 结果发到哪 ----
  const convTarget = task?.target.kind === "conv";
  const target = convTarget
    ? h(
        "select",
        {},
        h("option", { value: "conv", selected: true }, `原来的对话「${task.convTitle || "对话"}」`),
        h("option", { value: "dedicated" }, "专用对话（单独开一条）"),
      )
    : null;
  const agent = h(
    "select",
    {},
    agents.map((a) => h("option", { value: a.id, selected: a.id === (src.agent ?? S.draftAgent) }, a.label)),
  );
  const mode = h(
    "select",
    {},
    h("option", { value: "chat", selected: (src.mode ?? "chat") === "chat" }, "聊天模式：只能联网搜索，开销小，不需要授权"),
    h("option", { value: "work", selected: src.mode === "work" }, "工作模式：能执行命令、读写本机文件"),
  );
  let cwd = src.cwd || "";
  const cwdBtn = h("button", { type: "button", class: "btn task-cwd" });
  const showCwd = () => {
    cwdBtn.textContent = cwd ? baseName(cwd) : `${baseName(S.workspaceRoot) || "工作区"}（工作区根目录）`;
    cwdBtn.title = cwd || S.workspaceRoot || "";
  };
  showCwd();
  cwdBtn.onclick = () =>
    changeCwd({
      current: cwd || S.workspaceRoot || "",
      onPick: (p) => {
        cwd = p === S.workspaceRoot ? "" : p;
        showCwd();
      },
    });
  const cwdField = field("工作目录", cwdBtn, "工作模式下 agent 在这个目录里干活。需要授权时会推送给你，没人处理就按拒绝。");
  const dedicatedBox = h(
    "div",
    { class: "task-dedicated" },
    agents.length > 1 ? field("Agent", agent) : null,
    field("模式", mode),
    cwdField,
  );
  const syncVisibility = () => {
    const dedicated = !target || target.value === "dedicated";
    dedicatedBox.hidden = !dedicated;
    cwdField.hidden = mode.value !== "work";
  };
  mode.onchange = syncVisibility;
  if (target) target.onchange = syncVisibility;
  syncVisibility();

  const body = h(
    "div",
    { class: "modal-body task-form" },
    field("名称", title),
    field("要做的事", h("div", { class: "mention-wrap" }, prompt, mentionMenu), "需要对比的写清楚怎么判断，比如「和上次的结果比」「版本号比当前的新才算更新」。输入 @ 可以指定这次要用的技能。"),
    field("频率", h("div", { class: "task-freq-row" }, freq, freqBox), freqHint),
    field("提醒", notify),
    target ? field("结果发到", target) : field("结果发到", h("div", { class: "task-static" }, task?.convKey ? `专用对话「${task.convTitle || "对话"}」` : "专用对话（第一次运行时新建，之后都发到这条）")),
    dedicatedBox,
  );
  const save = h("button", { class: "btn primary" }, task ? "保存" : "创建");
  const close = modal({ title: task ? "编辑定时任务" : "新建定时任务", body, foot: h("div", { class: "modal-foot" }, save) });
  (task ? title : prompt).focus();

  save.onclick = async () => {
    if (!prompt.value.trim()) return toast("写一下要让 agent 做什么");
    const schedule =
      sch.kind === "once"
        ? { kind: "once", at: sch.at }
        : sch.kind === "daily" || sch.kind === "weekdays"
          ? { kind: sch.kind, time: sch.time }
          : sch.kind === "weekly"
            ? { kind: "weekly", days: sch.days, time: sch.time }
            : sch.kind === "monthly"
              ? { kind: "monthly", day: sch.day, time: sch.time }
              : sch.kind === "hourly"
                ? { kind: "hourly", every: sch.every, minute: sch.minute }
                : { kind: "cron", expr: sch.expr };
    if (schedule.kind === "once" && !(schedule.at > Date.now())) return toast("运行时间要在现在之后");
    const dedicated = !target || target.value === "dedicated";
    const payload = {
      title: title.value,
      prompt: prompt.value,
      schedule,
      notify: notify.value,
      target: dedicated ? { kind: "dedicated" } : { kind: "conv", key: task.target.key },
      ...(dedicated ? { agent: agent.value || agents[0]?.id, mode: mode.value, cwd: mode.value === "work" ? cwd : "" } : {}),
    };
    save.disabled = true;
    try {
      if (task) await api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "PATCH", body: payload });
      else await api("/api/tasks", { method: "POST", body: payload });
      close();
      toast(task ? "已保存" : "已创建");
      if (S.view === "tasks") void reload();
      else void openTasks();
    } catch (err) {
      save.disabled = false;
      toast(err.message);
    }
  };
}

/** 不用 <label>：里面有按钮（星期、选目录），点标题文字会把按钮也点了 */
function field(label, input, hint) {
  return h("div", { class: "field" }, h("span", {}, label), input, hint ? h("small", {}, hint) : null);
}
