import { fill, h, icon, starsLoader, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { clockTime } from "../lib/time.js";
import { confirmDialog, modal, showMenu } from "../lib/overlay.js";
import { isAdmin, S, ui } from "../state.js";
import { WS } from "../lib/ws.js";
import { agentLabel, closeSide, renderSidebar } from "./sidebar.js";
import { baseName, renderTopbar } from "./topbar.js";
import { openConversation } from "./messages.js";
import { changeCwd } from "./conv-actions.js";
import { convExpert, expertChoices, findExpert } from "./experts.js";
import { capOfAccess, FULL_WARNING, minPermission, PERMISSIONS, permissionsUpTo } from "../lib/permission.js";

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
  },
  {
    title: "科技新闻早报",
    prompt: "搜一下过去 24 小时最重要的科技新闻，挑 5 条，每条用一两句话说明为什么值得关注，附上链接。",
    schedule: { kind: "daily", time: "08:30" },
    notify: "always",
  },
  {
    title: "下班前看看改了什么",
    prompt: "用 git status 和 git log --since=midnight 看看这个目录今天改了什么，帮我列一个简短的日报草稿。今天没有任何改动的话就不用提醒我。",
    schedule: { kind: "weekdays", time: "18:00" },
    notify: "smart",
    // 要跑 git 命令：用能执行命令的内置专家
    expert: "claude",
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
      : `${findExpert(t.expert ?? t.agent)?.name ?? (t.expert ? "（已删除的专家）" : agentLabel(t.agent))}${t.cwd ? ` · ${baseName(t.cwd)}` : ""}`;
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
      t.freshContext ? h("span", {}, "不带上下文") : null,
      t.target.kind === "dedicated" && t.permission ? h("span", { class: t.permission === "full" ? "task-perm-full" : "" }, PERMISSIONS[t.permission].label) : null,
      t.target.kind === "conv" && t.convPermission === "full" ? h("span", { class: "task-perm-full" }, "跟随对话：完全允许") : null,
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

/** 对话页的「更多」菜单：先现拉一遍任务（这时任务页可能还没打开过），改完留在对话里 */
export async function editTaskById(id) {
  try {
    const data = await api("/api/tasks");
    T.tz = data.tz;
    const task = data.tasks.find((t) => t.id === id);
    if (!task) return toast("这个任务不存在了");
    openTaskForm(task);
  } catch (err) {
    toast(err.message);
  }
}

export function runTaskById(id) {
  return runNow({ id });
}

/** 一条对话绑了好几个任务：先选是哪个 */
export function openConvTasks(tasks) {
  const close = modal({
    title: "这条对话的定时任务",
    body: h(
      "div",
      { class: "modal-body conv-tasks" },
      tasks.map((t) =>
        h(
          "div",
          { class: "conv-task-row" },
          h("span", { class: "grow", title: t.title }, t.title),
          h("button", { class: "btn", onclick: () => (close(), editTaskById(t.id)) }, "编辑"),
          h("button", { class: "btn", onclick: () => (close(), runTaskById(t.id)) }, "立即运行"),
        ),
      ),
    ),
  });
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

/** 「结果发到」可选的对话：自己的、不是别的任务专用的。正在用的那条一定在 */
function targetChoices(current) {
  const convs = [...S.convs.values()].filter((c) => c.personal && !c.hidden && !c.taskId && c.key !== current).sort((a, b) => b.activeAt - a.activeAt);
  return convs.slice(0, 50);
}

/** 对话的专家、目录、权限：优先用页面上的（是最新的），对话还没加载就用任务接口带的 */
function convTargetInfo(key, task) {
  const c = S.convs.get(key);
  if (c) return { title: c.title, expert: convExpert(c), cwd: c.cwd, permission: c.permission, max: c.permissionMax, locked: !!c.taskId };
  if (task?.convKey !== key) return null;
  return { title: task.convTitle, expert: task.convExpert, cwd: task.convCwd, permission: task.convPermission, max: task.convPermissionMax, locked: false };
}

/** task：编辑这个；preset：新建时预填（例子） */
export function openTaskForm(task, preset) {
  const src = task ?? preset ?? {};
  const experts = expertChoices();
  const title = h("input", { value: src.title ?? "", maxlength: "60", placeholder: "比如：检查 agent-loft 更新" });
  const prompt = h("textarea", { rows: 5, maxlength: "4000", placeholder: "到点让 agent 做什么。写成完整的指令：那时你多半不在，它没法再问你。" });
  prompt.value = src.prompt ?? "";

  // ---- 频率 ----
  const sch = { kind: "daily", time: "09:00", days: [1], day: 1, every: 2, minute: 0, expr: "0 9 * * *", at: Date.now() + 3600_000, ...(src.schedule ?? {}) };
  if (sch.kind === "daily") sch.days = [...WEEK_ORDER];
  else if (sch.kind === "weekdays") sch.days = [1, 2, 3, 4, 5];
  const freq = h("select", {}, FREQS.map(([v, label]) => h("option", { value: v, selected: v === sch.kind }, label)));
  const freqBox = h("div", { class: "task-freq" });
  const timeInput = () => {
    const el = h("input", { type: "time", value: sch.time, required: true, "aria-label": "执行时刻" });
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
    } else if (["daily", "weekdays", "weekly"].includes(sch.kind)) {
      parts.push(
        h(
          "div",
          { class: "task-weekly-controls" },
          h("div", { class: "task-weekly-heading" }, h("span", {}, "重复日期"), h("span", { class: "task-weekly-hint" }, "可多选")),
          h(
            "div",
            { class: "task-weekdays", role: "group", "aria-label": "执行星期（可多选）" },
            WEEK_ORDER.map((d) => {
              const b = h("button", { type: "button", class: "task-weekday", "aria-pressed": String(sch.days.includes(d)) }, `周${WEEK_NAME[d]}`);
              b.onclick = () => {
                sch.days = sch.days.includes(d) ? sch.days.filter((x) => x !== d) : [...sch.days, d];
                // 改了预设的星期，就按自选的每周计划保存。
                sch.kind = freq.value = "weekly";
                b.setAttribute("aria-pressed", String(sch.days.includes(d)));
              };
              return b;
            }),
          ),
          h("label", { class: "task-clock-row" }, h("span", {}, "执行时刻"), timeInput()),
        ),
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
  freq.onchange = () => {
    if (freq.value === "daily") sch.days = [...WEEK_ORDER];
    else if (freq.value === "weekdays") sch.days = [1, 2, 3, 4, 5];
    renderFreq();
  };
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
  const currentTarget = task?.target?.kind === "conv" ? task.target.key : "dedicated";
  const target = h(
    "select",
    { class: "task-target" },
    h("option", { value: "dedicated", selected: currentTarget === "dedicated" }, task?.target?.kind === "dedicated" && task.convKey ? `专用对话「${task.convTitle || "对话"}」` : "专用对话（第一次运行时新建，之后都发到这条）"),
    currentTarget !== "dedicated" ? h("option", { value: currentTarget, selected: true }, `对话「${convTargetInfo(currentTarget, task)?.title || "对话"}」`) : null,
    targetChoices(currentTarget).map((c) => h("option", { value: c.key }, `对话「${c.title || "未命名"}」`)),
  );
  const picked = src.expert ?? src.agent ?? S.draftExpert;
  // 任务用的专家被删了：列表里没有它，留一项占位，免得一打开就悄悄换成别的
  const missing = task && !experts.some((e) => e.id === picked);
  const expert = h(
    "select",
    {},
    missing ? h("option", { value: "", selected: true, disabled: true }, "（专家已删除，选一个）") : null,
    experts.map((e) => h("option", { value: e.id, selected: !missing && e.id === picked }, `${e.icon ? `${e.icon} ` : ""}${e.name}`)),
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
  const cwdField = field("工作目录", cwdBtn, "专家在这个目录里干活。没选就用专家默认的目录。");
  // ---- 权限（专用对话的在任务上；发到已有对话的就是那条对话的，见下面的 convBox）----
  const permission = h("select", {});
  const permissionHint = h("small", {});
  const permissionField = h("div", { class: "field" }, h("span", {}, "权限"), permission, permissionHint);
  let permissionValue = src.permission ?? "";
  const syncPermission = () => {
    const max = minPermission(isAdmin() ? "full" : "edit", capOfAccess(findExpert(expert.value)?.access));
    const levels = permissionsUpTo(max);
    // 已经存着的级别高过现在的上限（被降级了、换了专家）：不留着，免得显示的和实际跑的不一样
    if (permissionValue && !levels.includes(permissionValue)) permissionValue = "";
    fill(
      permission,
      h("option", { value: "", selected: !permissionValue }, "默认（Claude 逐次询问，Codex 按沙箱设置）"),
      levels.map((l) => h("option", { value: l, selected: l === permissionValue }, `${PERMISSIONS[l].label}：${PERMISSIONS[l].desc}`)),
    );
    permissionHint.textContent =
      permission.value === "full" ? "⚠️ 到点无人值守地执行，不会询问任何操作。提示词要写清楚，只给信得过的任务用。" : "需要授权时会推送给你，没人处理就按拒绝。";
    permissionHint.classList.toggle("task-perm-full", permission.value === "full");
  };
  permission.onchange = () => {
    permissionValue = permission.value;
    syncPermission();
  };
  // ---- 上下文 ----
  const keepOption = h("option", { value: "keep", selected: !src.freshContext });
  const context = h("select", { class: "task-context" }, keepOption, h("option", { value: "fresh", selected: !!src.freshContext }, "不携带（每次都从头开始）"));
  const contextHint = h("small", {});
  const contextField = h("div", { class: "field" }, h("span", {}, "上下文"), context, contextHint);
  const dedicatedBox = h("div", { class: "task-dedicated" }, field("专家", expert, "到点由这个专家来做。要联网、读文件还是跑命令，看专家的权限（设置 → 专家）。"), cwdField, permissionField);
  // 发到已有对话：专家、目录属于对话，中途换不了，只显示；权限可以改，改的是对话自己的
  const convBox = h("div", { class: "task-dedicated task-conv" });
  let convPermission = null;
  const syncConvBox = () => {
    convPermission = null;
    const info = target.value === "dedicated" ? null : convTargetInfo(target.value, task);
    if (!info) return fill(convBox);
    const label = PERMISSIONS[info.permission]?.label ?? "默认";
    const levels = info.max ? permissionsUpTo(info.max) : [];
    if (!info.locked && levels.length > 1) {
      convPermission = h("select", { class: "task-conv-permission" }, levels.map((l) => h("option", { value: l, selected: l === info.permission }, `${PERMISSIONS[l].label}：${PERMISSIONS[l].desc}`)));
    }
    fill(
      convBox,
      field("专家", h("div", { class: "task-static" }, info.expert?.name ?? "（已删除的专家）"), "跟随这条对话，对话中途不能换专家。要换专家，改发到专用对话。"),
      info.expert?.access === "web" ? null : field("工作目录", h("div", { class: "task-static", title: info.cwd ?? "" }, baseName(info.cwd ?? "") || info.cwd || ""), "跟随这条对话。"),
      field("权限", convPermission ?? h("div", { class: "task-static" }, label), convPermission ? "这是这条对话自己的权限：改了之后，你在这条对话里聊天也按这一级。" : "跟随这条对话。"),
    );
  };
  const syncContext = () => {
    const dedicated = target.value === "dedicated";
    keepOption.textContent = dedicated ? "携带（能看到之前几次运行的内容）" : "携带（接着这条对话的聊天内容）";
    contextHint.textContent = dedicated
      ? "不携带时结果还留在这条对话里，只是 agent 看不到，没法和上次对比，也更省 token。改回携带后只能接上最后一次运行的内容。"
      : "不携带时任务在独立的会话里运行，看不到聊天内容，也不会打乱聊天的上下文；结果照样显示在这条对话里，你下一条消息会带给 agent。运行期间发的消息要等它结束（可以打断）。";
  };
  const syncVisibility = () => {
    const dedicated = target.value === "dedicated";
    dedicatedBox.hidden = !dedicated;
    convBox.hidden = dedicated;
    syncConvBox();
    syncContext();
    // 只能联网的专家不碰目录
    const access = findExpert(expert.value)?.access;
    cwdField.hidden = access === "web";
    syncPermission();
    permissionField.hidden = capOfAccess(access) === "ask";
  };
  expert.onchange = syncVisibility;
  target.onchange = syncVisibility;
  syncVisibility();

  const body = h(
    "div",
    { class: "modal-body task-form" },
    field("名称", title),
    field("要做的事", prompt, "需要对比的写清楚怎么判断，比如「和上次的结果比」「版本号比当前的新才算更新」。"),
    field("频率", freq),
    field("执行时间", freqBox, freqHint),
    field("提醒", notify),
    field("结果发到", target),
    convBox,
    dedicatedBox,
    contextField,
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
    if (schedule.kind === "weekly" && !schedule.days.length) return toast("至少选择一个执行星期");
    const dedicated = target.value === "dedicated";
    if (dedicated && !expert.value) return toast("选一个专家");
    const level = dedicated && !permissionField.hidden ? permission.value : "";
    if (
      level === "full" &&
      task?.permission !== "full" &&
      !(await confirmDialog({ title: "让这个任务以「完全允许」运行？", sub: "到点无人值守地执行，不会询问任何操作：可以跑任意命令、改写或删除这台机器上的任意文件。", message: "只给信得过的任务用，并把提示词写清楚。", confirmText: "完全允许", danger: true }))
    ) {
      return;
    }
    const convLevel = convPermission?.value;
    const convInfo = dedicated ? null : convTargetInfo(target.value, task);
    const convLevelChanged = !!convLevel && convLevel !== convInfo?.permission;
    if (convLevelChanged && convLevel === "full" && !(await confirmDialog(FULL_WARNING))) return;
    const fresh = context.value === "fresh";
    if (
      task?.freshContext &&
      !fresh &&
      !(await confirmDialog({
        title: "改回携带上下文？",
        sub: "之前不携带时运行的内容不会恢复：对话里还看得到，但 agent 看不到。",
        message: dedicated ? "之后只能接上最后一次运行的内容，更早的接不回来。" : "之后每次运行都接着这条对话的聊天内容，运行结果也会进入聊天的上下文。",
        confirmText: "改回携带",
      }))
    ) {
      return;
    }
    const payload = {
      title: title.value,
      prompt: prompt.value,
      schedule,
      notify: notify.value,
      target: dedicated ? { kind: "dedicated" } : { kind: "conv", key: target.value },
      freshContext: fresh,
      ...(dedicated ? { expert: expert.value, cwd: findExpert(expert.value)?.access === "web" ? "" : cwd, permission: level } : {}),
      ...(convLevelChanged ? { convPermission: convLevel } : {}),
    };
    save.disabled = true;
    try {
      if (task) await api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "PATCH", body: payload });
      else await api("/api/tasks", { method: "POST", body: payload });
      close();
      toast(task ? "已保存" : "已创建");
      if (S.view === "tasks") void reload();
      else if (!task) void openTasks();
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
