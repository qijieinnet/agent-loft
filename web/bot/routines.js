import { api, button, field, h, requestId } from "./client.js";
import { action, formPanel, note, panel, panelError, run } from "./panel.js";

const days = [..."日一二三四五六"];
const pathFor = thread => "/api/bots/threads/" + encodeURIComponent(thread) + "/routines";
const when = (ms, timezone) => new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium", timeStyle: "short", timeZone: timezone,
}).format(ms);

function number(text) {
  if (/^\d+$/.test(text)) return Number(text);
  const digit = s => "零一二三四五六七八九".indexOf(s.replace("两", "二"));
  if (text.includes("十")) {
    const [tens, ones] = text.split("十");
    return (tens ? digit(tens) : 1) * 10 + (ones ? digit(ones) : 0);
  }
  return digit(text);
}

// Only prefill explicit commands. The form is the user's editable confirmation.
export function routineDraft(text) {
  const prefix = /^(?:请|帮我|请帮我)?\s*(每天|每日|(?:每个?)?工作日|每(?:周|星期)([一二三四五六日天]))\s*/u.exec(text);
  if (!prefix || /[?？]|(?:怎么办|为什么|怎么做|吗)[。！!]?$/u.test(text)) return;
  let prompt = text.slice(prefix[0].length);
  const clock = /^(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上)?\s*([\d零一二两三四五六七八九十]+)\s*(?:[:：](\d{2})|[点时](?:\s*(半|[\d零一二三四五六七八九十]+)\s*分?)?)\s*/u.exec(prompt);
  let time = "";
  if (clock) {
    let hour = number(clock[2]);
    const minute = clock[3] ? Number(clock[3]) : clock[4] === "半" ? 30 : clock[4] ? number(clock[4]) : 0;
    if (["下午","傍晚","晚上"].includes(clock[1]) && hour < 12 || clock[1] === "中午" && hour < 11) hour += 12;
    if (clock[1] === "凌晨" && hour === 12) hour = 0;
    if (hour <= 23 && minute <= 59) time = [hour, minute].map(n => String(n).padStart(2,"0")).join(":");
    prompt = prompt.slice(clock[0].length);
  }
  prompt = prompt.replace(/^[，,、\s]*(?:请|帮我)?\s*/u, "");
  if (!/^(提醒|通知|检查|查看|巡检|核对|查询|汇总|总结|统计|整理|生成|发送|报告|运行|执行|监测|监控)/u.test(prompt)) return;
  const remind = /^(?:提醒|通知)(?:我)?/u.exec(prompt);
  return {
    prompt: remind ? prompt.slice(remind[0].length).trim() : prompt,
    kind: prefix[2] ? "weekly" : prefix[1].includes("工作日") ? "weekdays" : "daily",
    day: days.indexOf(prefix[2] === "天" ? "日" : prefix[2]), time,
    mode: remind ? "remind" : "run", smart: /(?:异常|出错|失败|有问题).{0,8}(?:提醒|通知)|仅.{0,4}(?:异常|失败)/u.test(prompt),
  };
}

function select(id, pairs, value) {
  const control = h("select", { id }, pairs.map(([key, label]) => h("option", { value: key }, label)));
  control.value = String(value);
  return control;
}

export function newRoutine(thread, draft = {}, onSaved) {
  const editing = !!draft.id;
  const id = draft.id || requestId(), path = pathFor(thread) + (editing ? "/" + id : "");
  const prompt = h("textarea", { id: "routine-prompt", required: true, maxlength: 4000, rows: 3 }, draft.prompt);
  const mode = select("routine-mode", [["remind","到点提醒我"],["run","让 Bot 执行任务"]], draft.mode || "remind");
  const kind = select("routine-kind", [["daily","每天"],["weekdays","工作日（周一至周五）"],["weekly","每周"]], draft.kind || "daily");
  const selected = draft.days || [draft.day >= 0 ? draft.day : 1];
  const weekdays = days.map((_, i) => h("input", { type: "checkbox", id: "routine-day-" + i, value: i, checked: selected.includes(i) }));
  const dayField = h("fieldset", { class: "routine-days" }, h("legend", {}, "星期"),
    weekdays.map((input, i) => h("label", { for: input.id }, input, "周" + days[i])));
  const time = h("input", { type: "time", id: "routine-time", required: true, value: draft.time ?? "09:00" });
  const zone = h("input", { id: "routine-zone", required: true, maxlength: 100, value: draft.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
  const notification = select("routine-notification", [["always","每次通知"],["smart","仅有异常或需要处理时通知"]], draft.smart ? "smart" : "always");
  const noticeField = field("通知方式", notification);
  const update = () => { dayField.hidden = kind.value !== "weekly"; noticeField.hidden = mode.value !== "run"; };
  kind.onchange = update;
  mode.onchange = update;
  update();
  const form = h("form", { class: "sheet-form", "aria-labelledby": "panel-title", method: "post", action: path }, field("任务内容", prompt), field("执行方式", mode),
    field("频率", kind), dayField, field("当地时间", time), field("时区", zone), noticeField,
    note("任务和执行结果保存在你与这个 Bot 的私聊中。"));
  const submit = h("button", { type: "submit" }, editing ? "保存更改" : "确认启用");
  const live = formPanel(editing ? "编辑周期任务" : "确认周期任务", form, submit, editing ? () => openRoutines(thread) : undefined);
  form.onsubmit = event => {
    event.preventDefault();
    if (!prompt.value.trim()) { panelError("请填写任务内容。"); return; }
    const selectedDays = weekdays.filter(input => input.checked).map(input => Number(input.value));
    if (kind.value === "weekly" && !selectedDays.length) { panelError("每周至少选一天。"); weekdays[0].focus(); return; }
    run(submit, async () => {
      await api(path, "POST", { id, ...(editing && { action: "edit", revision: draft.revision }), mode: mode.value, prompt: prompt.value.trim(), timezone: zone.value.trim(),
        schedule: { kind: kind.value, time: time.value, ...(kind.value === "weekly" && { days: selectedDays }) },
        smart: mode.value === "run" && notification.value === "smart" });
      if (!live()) return;
      onSaved?.();
      await openRoutines(thread);
    });
  };
}

export async function openRoutines(thread, enabled = true) {
  const list = h("div"), path = pathFor(thread);
  const live = panel("周期任务", enabled ? button("新建周期任务", () => newRoutine(thread)) : note("Bot 的提醒能力已关闭，仍可查看记录和删除任务。"), list);
  try {
    const { tasks } = await api(path);
    if (!live()) return;
    if (!tasks.length) list.append(note("还没有周期任务。"));
    for (const task of tasks) {
      const url = path + "/" + task.id;
      const change = async value => {
        await api(url, "POST", { action: value });
        if (live()) await openRoutines(thread, enabled);
      };
      const history = () => openRoutineHistory(thread, task, enabled);
      const runNow = () => {
        const key = requestId();
        const here = panel("立即执行一次", note(task.prompt),
          note(task.mode === "run" ? "将按当前配置实际调用工具并投递通知，下次定时执行时间保持原计划。" : "现在发送一次提醒，下次定时提醒仍按原计划。"),
          action("确认执行", async () => {
            await api(url, "POST", { action: "run", revision: task.revision, requestId: key });
            if (here()) history();
          }), button("返回周期任务", () => openRoutines(thread, enabled)));
      };
      list.append(h("section", {}, h("h3", {}, task.prompt), note(task.schedule + " · " + task.timezone),
        note(task.nextAt ? "下次执行 " + when(task.nextAt, task.timezone) : "已暂停"),
        enabled && button("编辑任务", () => newRoutine(thread, { ...task, ...task.timing })),
        enabled && button("立即执行一次", runNow), action("执行记录", history), (task.nextAt || enabled) && action(task.nextAt ? "暂停任务" : "恢复任务", () => change(task.nextAt ? "pause" : "resume")),
        button("删除任务", () => {
          const confirm = panel("删除周期任务", note(task.prompt), note("这项任务和执行记录将一起删除。"),
            action("确认删除", async () => { await api(url, "POST", { action: "delete" }); if (confirm()) await openRoutines(thread, enabled); }),
            button("取消", () => openRoutines(thread, enabled)));
        })));
    }
  } catch (error) { if (live()) panelError(error.message); }
}

async function openRoutineHistory(thread, task, enabled) {
  const results = h("div", { "aria-live": "polite" });
  const here = panel("执行记录", note(task.prompt), results, button("返回周期任务", () => openRoutines(thread, enabled)));
  const labels = { done: "已完成", quiet: "正常，已静默", failed: "失败", running: "执行中" };
  async function refresh() {
    if (!here()) return;
    try {
      const { runs } = await api(pathFor(thread) + "/" + task.id);
      if (!here()) return;
      results.replaceChildren(...runs.map(r => h("section", {},
        h("strong", {}, when(r.dueAt, task.timezone) + " · " + (r.manual ? "手动执行" : "定时执行") + " · " + labels[r.status]),
        h("p", {}, r.result))));
      if (!runs.length) results.append(note("还没有执行记录。"));
      if (runs.some(r => r.status === "running")) setTimeout(refresh, 1800);
    } catch (error) { if (here()) panelError(error.message); }
  }
  await refresh();
}
