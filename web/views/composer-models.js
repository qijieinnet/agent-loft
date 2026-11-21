import { api } from "../lib/api.js";
import { fill, h, icon } from "../lib/dom.js";
import { closeMenu, placePopover, showPopover } from "../lib/overlay.js";
import { S, ui } from "../state.js";
import { doAction } from "./conv-actions.js";
import { findExpert } from "./experts.js";
import { agentCatalog, catalogDefaults, catalogLoaded, draftPick, effortLabel, composerModelLabel, modelName, renderContext, saveDraftPick, visibleModels } from "./topbar.js";

export async function openModelPicker(view = "effort", catalog) {
  const anchor = ui.modelSlot;
  if (!anchor) return;
  if (ui.menu?.dataset.for === "model") return closeMenu();
  const key = S.current;
  const expertId = S.draftExpert;
  const conv = S.convs.get(key);
  const agent = conv?.agent ?? S.draftAgent;
  const pop = showPopover(anchor);
  pop.dataset.for = "model";
  pop.matchesContext = () => S.current === key && (!!key || (S.draftExpert === expertId && S.draftAgent === agent));
  pop.classList.add("model-pop");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "模型设置");
  const trigger = () => anchor.querySelector("button");
  trigger()?.setAttribute("aria-expanded", "true");
  const position = () => {
    pop.style.maxHeight = `min(480px, ${Math.max(0, anchor.getBoundingClientRect().top - 16)}px)`;
    placePopover(pop, anchor);
    pop.style.setProperty("--picker-left", pop.style.left);
  };
  window.addEventListener("resize", position);
  window.visualViewport?.addEventListener("resize", position);
  pop.onMenuClose = () => {
    delete anchor.dataset.picker;
    trigger()?.setAttribute("aria-expanded", "false");
    window.removeEventListener("resize", position);
    window.visualViewport?.removeEventListener("resize", position);
    if (pop.contains(document.activeElement)) trigger()?.focus({ preventScroll: true });
  };
  let models, current, currentEffort, fastModel;
  let effortSupported, configuredEffort;
  let provisional = false;
  function render(data) {
    const focus = !pop.dataset.view || pop.contains(document.activeElement);
    ({ models, current, currentEffort, fastModel, effortSupported = true } = data);
    current ||= (models.find((m) => m.isDefault) ?? models.find((m) => m.id === "default"))?.id;
    currentEffort ||= catalogDefaults.get(agent)?.effort;
    configuredEffort = [findExpert(conv ? (conv.expert?.id ?? agent) : expertId)?.effort, catalogDefaults.get(agent)?.effort];
    if (view === "model" || !supportsControls()) showModels(focus);
    else showEffort(focus);
  }
  const selectedModel = () => {
    const exact = models.find((m) => m.id === current);
    if (exact) return exact;
    const name = modelName(agent, current);
    return models.find((m) => m.id !== "default" && (m.label || m.id) === name);
  };

  let busy = false;
  async function save(kind, value) {
    if (!pop.matchesContext()) return false;
    if (conv) {
      const res = await doAction(kind, value, {}, { quiet: true });
      if (!res) return false;
      fastModel = res.info.fastModel;
      currentEffort = res.info.runtimeEffort ?? res.info.effort ?? currentEffort;
    } else {
      const pick = draftPick();
      if (kind === "fastModel") S.draftFastModel = value || null;
      else {
        if (kind === "model") {
          if (S.draftFastModel !== value) S.draftFastModel = null;
          const supported = models.find((m) => m.id === value)?.efforts;
          if (pick.effort && !supported?.includes(pick.effort)) delete pick.effort;
          currentEffort = pick.effort || configuredEffort.find(Boolean);
        }
        pick[kind] = value;
        saveDraftPick();
      }
      fastModel = S.draftFastModel;
      renderContext();
    }
    if (kind === "effort") currentEffort = value;
    if (kind === "model") current = value;
    return true;
  }

  function setView(name) {
    anchor.dataset.picker = pop.dataset.view = name;
  }

  function showModels(focus) {
    setView("models");
    const selected = selectedModel();
    const list = h("div", { class: "picker-options", "aria-label": "选择模型", role: "group" });
    const shown = visibleModels(agent, models);
    for (const m of shown) {
      list.append(h("button", {
        class: "picker-option", "aria-pressed": String(m === selected),
        onclick: async () => {
          if (busy) return;
          busy = true;
          const ok = (!provisional && m === selected) || await save("model", m.id);
          busy = false;
          if (ok && ui.menu === pop) {
            if (supportsControls()) showEffort(true);
            else closeMenu();
          }
        },
      }, composerModelLabel(agent, m.label || m.id), m === selected ? icon("check") : null));
    }
    list.onkeydown = (e) => {
      const option = e.target;
      const to = { ArrowDown: option.nextElementSibling, ArrowUp: option.previousElementSibling,
        Home: list.firstElementChild, End: list.lastElementChild };
      if (Object.hasOwn(to, e.key)) { e.preventDefault(); to[e.key]?.focus(); }
    };
    fill(pop, h("div", { class: "pop-head" }, "选择模型"), list);
    if (!shown.length) fill(list, h("div", { class: "pop-error" }, "暂无可选模型"));
    position();
    const active = list.querySelector('[aria-pressed="true"]') ?? list.querySelector("button");
    active?.scrollIntoView({ block: "nearest" });
    if (focus) active?.focus({ preventScroll: true });
  }

  function supportedEfforts() {
    const m = selectedModel() ?? models.find((m) => m.efforts?.length);
    return effortSupported ? m?.efforts ?? [] : [];
  }
  function supportsControls() { return supportedEfforts().length || selectedModel()?.fastMode; }

  function showEffort(focus) {
    setView("effort");
    const model = selectedModel();
    const levels = supportedEfforts();
    if (!levels.length) anchor.dataset.picker = "model";
    const fallback = [...configuredEffort, model?.defaultEffort].find((v) => levels.includes(v));
    const initial = levels.includes(currentEffort) ? currentEffort : fallback;
    const resetTo = fallback ?? initial;
    const title = h("strong", { class: "effort-value" }, initial ? effortLabel(initial) : "默认");
    const name = h("button", {
      class: "picker-model-link", "aria-label": "选择模型", onclick: () => { if (!busy) showModels(true); },
    }, h("span", {}, composerModelLabel(agent, modelName(agent, current) || "选择模型")), icon("back"));
    const reset = h("button", {
      class: "picker-icon picker-reset", title: fallback ? "恢复默认思考程度" : "还原打开时的思考程度",
      onclick: () => slider?.select(resetTo),
    }, icon("undo"));
    let nextEffort;
    let slider;
    async function commit(value) {
      nextEffort = value;
      if (busy) return;
      busy = true;
      while (nextEffort && pop.matchesContext()) {
        const next = nextEffort;
        nextEffort = undefined;
        if (next !== currentEffort && !await save("effort", next) && !nextEffort) slider.restore(currentEffort ?? initial);
      }
      busy = false;
    }
    if (levels.length) slider = effortSlider(levels, initial, (value) => {
      title.textContent = value ? effortLabel(value) : "默认";
      reset.disabled = !resetTo || value === resetTo;
    }, commit);

    let fast;
    if (model?.fastMode) {
      const speed = model.fastMode.description?.match(/(\d+(?:\.\d+)?)\s*[x×]/i)?.[1];
      fast = h("button", {
        class: "picker-icon picker-fast", role: "switch", "aria-label": "快速模式",
        "aria-checked": String(fastModel === model.id), "aria-describedby": "picker-fast-tip",
        onclick: async () => {
          if (busy) return;
          busy = true;
          const ok = await save("fastModel", fastModel === model.id ? "" : model.id);
          busy = false;
          if (ok) fast.setAttribute("aria-checked", String(fastModel === model.id));
          if (nextEffort) void commit(nextEffort);
        },
      }, icon("bolt"), h("span", { class: "picker-tip", role: "tooltip", id: "picker-fast-tip" },
        speed ? h("strong", {}, `${speed} 倍速度`) : null, h("span", {}, "用量更多")));
    }
    fill(pop, h("div", { class: "effort-header" }, fast,
      h("div", { class: "effort-center" }, levels.length ? title : null, name),
      resetTo ? reset : null), slider?.el);
    position();
    if (focus) (slider?.el ?? name).focus({ preventScroll: true });
  }

  const isOpen = () => ui.menu === pop && pop.matchesContext();
  const cached = catalogLoaded.get(agent);
  let interacted = false;
  if (conv && catalog && cached) return render(catalog);
  if (conv && cached?.length) {
    provisional = true;
    render({
      models: cached,
      current: conv.runtimeModel ?? conv.model ?? catalogDefaults.get(agent)?.model,
      currentEffort: conv.runtimeEffort ?? conv.effort,
      fastModel: conv.fastModel,
      effortSupported: S.agents.find((a) => a.id === agent)?.capabilities?.effort,
    });
    // 一旦开始操作，保留这次打开的控件与选择，避免迟到的响应打断点击或拖动。
    const markInteraction = () => { interacted = true; };
    for (const event of ["pointerdown", "keydown", "click"]) {
      pop.addEventListener(event, markInteraction, { capture: true, once: true });
    }
  } else {
    fill(pop, h("div", { class: "pop-loading", role: "status", "aria-label": "正在读取模型" }, h("span", { class: "spinner" })));
    position();
  }
  try {
    if (conv) {
      const [data] = await Promise.all([
        catalog ?? api(`/api/conversations/${encodeURIComponent(key)}/models`),
        cached ?? agentCatalog(agent).catch(() => []),
      ]);
      if (isOpen() && !interacted) {
        provisional = false;
        render(data);
      }
    } else {
      const models = await agentCatalog(agent);
      if (!isOpen()) return;
      const expert = findExpert(expertId);
      render({
        models,
        current: draftPick().model || expert?.model || catalogDefaults.get(agent)?.model,
        currentEffort: draftPick().effort || expert?.effort,
        fastModel: S.draftFastModel,
      });
    }
  } catch (err) {
    if (isOpen() && !provisional) fill(pop, h("div", { class: "pop-error", role: "alert" }, err.message));
  }
}

/** 拖动时按连续坐标绘制，释放时吸附到最近档位并保存。 */
function effortSlider(levels, initial, preview, commit) {
  const last = levels.length - 1;
  const lane = h("span", { class: "effort-lane", "aria-hidden": "true" },
    h("span", { class: "effort-fill" }),
    levels.map((_, i) => h("i", { style: { left: `${last ? i / last * 100 : 0}%` } })),
    h("span", { class: "effort-handle" }));
  const el = h("div", {
    class: "effort-slider", role: "slider", tabindex: "0", "aria-label": "思考程度",
    "aria-valuemin": "0", "aria-valuemax": last, "aria-disabled": String(!last),
  }, lane);
  const ticks = lane.querySelectorAll("i");
  let value = initial;
  let index = Math.max(0, levels.indexOf(value));
  let drag;
  function draw(position, label = levels[Math.round(position)]) {
    index = Math.round(position);
    ticks.forEach((tick, i) => tick.classList.toggle("passed", i < position));
    lane.style.setProperty("--position", `${last ? position / last * 100 : 0}%`);
    el.setAttribute("aria-valuenow", String(index));
    el.setAttribute("aria-valuetext", label ? effortLabel(label) : "默认");
    preview(label);
  }
  function restore(saved) {
    value = saved;
    if (!drag) draw(Math.max(0, levels.indexOf(value)), value ?? null);
  }
  function select(next) {
    restore(next);
    void commit(next);
  }
  function move(e) {
    const fraction = (e.clientX - drag.left - drag.offset) / drag.width;
    draw(Math.max(0, Math.min(1, fraction)) * last);
  }
  el.onpointerdown = (e) => {
    if (drag || !last || e.button !== 0) return;
    const { left, width } = lane.getBoundingClientRect();
    const offset = e.clientX - (left + width * index / last);
    drag = { id: e.pointerId, left, width, offset: Math.abs(offset) < 13 ? offset : 0 };
    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
    move(e);
  };
  el.onpointermove = (e) => { if (drag?.id === e.pointerId) move(e); };
  el.onpointerup = (e) => {
    if (drag?.id !== e.pointerId) return;
    move(e);
    drag = null;
    el.classList.remove("dragging");
    select(levels[index]);
  };
  el.onlostpointercapture = el.onpointercancel = () => {
    if (!drag) return;
    drag = null;
    el.classList.remove("dragging");
    restore(value);
  };
  el.onkeydown = (e) => {
    if (drag || !last) return;
    const steps = { ArrowRight: index + 1, ArrowUp: index + 1, ArrowLeft: index - 1, ArrowDown: index - 1, Home: 0, End: last };
    if (!Object.hasOwn(steps, e.key)) return;
    e.preventDefault();
    select(levels[Math.max(0, Math.min(last, steps[e.key]))]);
  };
  restore(initial);
  return { el, restore, select };
}
