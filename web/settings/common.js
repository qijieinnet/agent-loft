import { h, toast } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { S } from "../state.js";
import { renderSidebar } from "../views/sidebar.js";
import { loadQuota, scheduleIdleQuota } from "../views/quota.js";
import { catalogCache, catalogDefaults, catalogLoaded, renderContext, renderTopbar } from "../views/topbar.js";

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
