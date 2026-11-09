import { fill, h } from "../lib/dom.js";
import { agentCatalog } from "./topbar.js";

/**
 * 模型、思考程度：下拉选，选项是引擎的模型列表（和输入框里选模型的一样）。
 * 第一项「默认」= 不指定；已经存的值不在列表里（模型下线、手写的）也留着一项，不会被悄悄改掉
 */
export function modelPicker(src) {
  const model = h("select", {});
  const effort = h("select", {});
  let modelVal = src.model ?? "";
  let effortVal = src.effort ?? "";
  let list = [];
  let engineLoaded = null;
  /** 不指定时实际用的模型（自定义专家自己定了模型）：「默认」后面显示它，而不是引擎的默认 */
  let fallback = "";
  const opt = (value, label, selected) => h("option", { value, selected }, label);
  const renderEffort = () => {
    const picked = list.find((m) => m.id === modelVal) ?? list.find((m) => m.isDefault) ?? list.find((m) => m.efforts?.length);
    const efforts = picked?.efforts ?? [];
    const extra = effortVal && !efforts.includes(effortVal) ? effortVal : null;
    fill(
      effort,
      opt("", "默认", !effortVal),
      efforts.map((x) => opt(x, x, x === effortVal)),
      extra ? opt(extra, list.length ? `${extra}（不在列表里）` : extra, true) : null,
    );
    effort.disabled = !efforts.length && !extra;
  };
  const render = () => {
    const shown = list.filter((m) => m.id !== "default");
    const def = list.find((m) => m.isDefault) ?? list.find((m) => m.id === "default");
    const known = !modelVal || shown.some((m) => m.id === modelVal);
    fill(
      model,
      opt("", fallback ? `默认（${fallback}）` : def ? `默认（${def.label || def.id}）` : "默认", !modelVal),
      shown.map((m) => opt(m.id, m.label && m.label !== m.id ? `${m.label}（${m.id}）` : m.id, m.id === modelVal)),
      known ? null : opt(modelVal, `${modelVal}（不在列表里）`, true),
    );
    renderEffort();
  };
  model.onchange = () => {
    modelVal = model.value;
    // 换了模型：原来的思考程度这个模型不支持就回到默认
    const picked = list.find((m) => m.id === modelVal) ?? list.find((m) => m.isDefault);
    if (effortVal && !(picked?.efforts ?? []).includes(effortVal)) effortVal = "";
    renderEffort();
  };
  effort.onchange = () => (effortVal = effort.value);
  return {
    model,
    effort,
    async load(engine, defaultModel = "") {
      if (engine === engineLoaded) {
        if (fallback !== defaultModel) {
          fallback = defaultModel;
          if (!model.disabled) render();
        }
        return;
      }
      fallback = defaultModel;
      // 换了引擎（只有新建时能换）：原来选的对不上了
      if (engineLoaded) modelVal = effortVal = "";
      engineLoaded = engine;
      list = [];
      fill(model, opt(modelVal, "加载中…", true));
      model.disabled = true;
      renderEffort();
      try {
        list = await agentCatalog(engine);
      } catch {
        // 拿不到列表：只能选默认（已经存的值也留着）
      }
      if (engineLoaded !== engine) return;
      model.disabled = false;
      render();
    },
  };
}
