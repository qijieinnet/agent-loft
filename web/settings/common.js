import { h, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { S } from "../state.js";
import { renderSidebar } from "../views/sidebar.js";
import { loadQuota, scheduleIdleQuota } from "../views/quota.js";
import { catalogCache, catalogDefaults, catalogLoaded, renderContext, renderTopbar } from "../views/topbar.js";
import { applyShellInfo } from "../lib/shell.js";

export async function saveConfig(cfg, patch) {
  try {
    const next = await api("/api/config", { method: "PUT", body: patch });
    Object.assign(cfg, next);
    toast("已保存");
    // 默认模型 / 可选模型可能改了：模型列表和默认值重新拿
    catalogCache.clear();
    catalogLoaded.clear();
    catalogDefaults.clear();
    const boot2 = await api("/api/bootstrap");
    S.agents = boot2.agents;
    S.bots = boot2.bots;
    S.workspaceRoot = boot2.workspaceRoot;
    // 左上角切换的服务器可能改了
    applyShellInfo(boot2.servers);
    const quotaOn = boot2.quotaEnabled !== false;
    if (boot2.quotaRefreshMin !== S.quotaRefreshMin || quotaOn !== S.quotaEnabled) {
      const turnedOn = quotaOn && !S.quotaEnabled;
      S.quotaRefreshMin = boot2.quotaRefreshMin ?? 10;
      S.quotaEnabled = quotaOn;
      // 刚打开就马上查一次；关掉就清掉侧栏的额度
      if (turnedOn || !quotaOn) void loadQuota();
      else scheduleIdleQuota();
    }
    renderTopbar();
    renderSidebar();
    renderContext();
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

export function field(label, input, hint) {
  return h("label", { class: "field" }, h("span", {}, label), input, hint ? h("small", {}, hint) : null);
}

// ---------- 要点「保存」的表单 ----------
// 容器上标 data-form，「保存」用 saveButton()。里面的输入框改过（index.js 在整页上统一监听 input / change），
// 保存按钮才能点；还没保存就切页、关设置时先问一句。改了马上生效的开关（记忆页那些）不放进 data-form。
// 不想算作改动的输入框（筛选框之类）标 data-nodirty。

export function markDirty(form) {
  if (!form) return;
  form.dataset.dirty = "1";
  for (const b of form.querySelectorAll(".save-btn")) b.disabled = false;
}

export function markClean(form) {
  if (!form) return;
  delete form.dataset.dirty;
  for (const b of form.querySelectorAll(".save-btn")) b.disabled = true;
}

export const hasDirty = (root) => !!root.querySelector("[data-form][data-dirty]");

/** onSave 返回 false（或抛错）= 没存成，按钮保持可点 */
export function saveButton(onSave, label = "保存") {
  const btn = h("button", { class: "btn primary save-btn", disabled: true }, label);
  btn.onclick = async () => {
    const form = btn.closest("[data-form]");
    btn.disabled = true;
    let ok = false;
    try {
      ok = (await onSave()) !== false;
    } catch (err) {
      toast(err.message);
    }
    if (ok) markClean(form);
    else btn.disabled = false;
  };
  return btn;
}
