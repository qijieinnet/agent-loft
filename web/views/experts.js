import { agentIcon, h } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { S } from "../state.js";
import { agentLabel } from "./sidebar.js";
import { applyShellInfo } from "../lib/shell.js";

// ---------- 专家：新对话、定时任务里选 ----------
// 内置专家就是能用的 agent（Claude Code / Codex），自定义专家在「设置 → 专家」里建。
// 对话从头到尾一个专家：只有新对话里能选，进了对话只显示。

/** 能用的 agent（启用了、装好登录了的；一个都没有时退回全部启用的） */
function usableEngines() {
  const enabled = S.agents.filter((a) => a.enabled);
  const usable = enabled.filter((a) => a.available !== false);
  return (usable.length ? usable : enabled).map((a) => a.id);
}

/** 能选的专家：内置的在前，再是自己的和共享的（引擎能用的） */
export function expertChoices() {
  const engines = usableEngines();
  return [
    ...engines.filter((id) => S.agents.find((a) => a.id === id)?.allowed !== false).map((id) => ({ id, name: agentLabel(id), engine: id, builtin: true })),
    ...S.experts.filter((e) => engines.includes(e.engine)),
  ];
}

export function findExpert(id) {
  return expertChoices().find((e) => e.id === id) ?? null;
}

/** 选的专家还在不在：不在（删了、引擎关了）就退回第一个能用的。引擎跟着专家 */
export function syncDraftExpert() {
  const choices = expertChoices();
  let e = choices.find((x) => x.id === S.draftExpert);
  // 以前只记了 agent
  if (!e && !S.draftExpert && S.draftAgent) e = choices.find((x) => x.id === S.draftAgent);
  e ??= choices[0] ?? null;
  S.draftExpert = e?.id ?? null;
  S.draftAgent = e?.engine ?? null;
  return e;
}

export function setDraftExpert(id) {
  S.draftExpert = id;
  localStorage.setItem("aim.expert", id);
  const e = syncDraftExpert();
  if (e) localStorage.setItem("aim.agent", e.engine);
  // 换了专家：默认工作目录跟着专家走（没设就是工作区根目录）；自己选过目录的就不动
  if (!S.draftCwdPicked) S.draftCwd = e?.cwd || null;
}

/** 专家的图标：自定义专家上传了头像用头像，以前设过 emoji 的用 emoji，否则用引擎的图标 */
export function expertIcon(e, cls = "agent-icon") {
  if (e?.avatar) return h("span", { class: `${cls} expert-avatar` }, h("img", { src: e.avatar, alt: "", draggable: "false" }));
  if (e?.icon) return h("span", { class: `${cls} expert-emoji` }, e.icon);
  return agentIcon(e?.engine ?? e?.id, cls);
}

/** 对话的专家（服务端给的 c.expert）配上引擎，给 expertIcon 用 */
export function convExpert(c) {
  const badge = c?.expert ?? { id: c?.agent, name: agentLabel(c?.agent ?? ""), builtin: true };
  return { ...badge, engine: c?.agent };
}

/** 设置里改了专家：重新拉一遍 */
export async function reloadExperts() {
  try {
    const d = await api("/api/experts/brief");
    S.experts = d.experts ?? [];
    if (Array.isArray(d.builtin)) for (const a of S.agents) a.allowed = d.builtin.includes(a.id);
    if (d.user) S.user = d.user;
    if ("servers" in d) applyShellInfo(d.servers);
  } catch {
    // 拉不到就先用旧的
  }
  syncDraftExpert();
  document.dispatchEvent(new CustomEvent("aim:experts"));
}
