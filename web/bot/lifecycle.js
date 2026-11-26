import { api, button, h } from "./client.js";
import { action, currentPanel, note, panel } from "./panel.js";

const botPath = (bot) => "/api/bots/" + encodeURIComponent(bot.id);
const date = (time) => new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function confirmBotChange(title, explanation, label, submit, back) {
  panel(title, note(explanation), button("返回", back, "secondary"), action(label, submit, "row danger"));
}

export function manageBot(bot, { owner, refresh, back }) {
  const path = botPath(bot);
  const hub = () => manageBot(bot, { owner, refresh, back });
  if (!owner) {
    confirmBotChange("退出「" + bot.name + "」？", "退出后，你将无法打开这个 Bot 的私聊和共享记录。再次受邀加入后可以找回自己的私聊。", "确认退出", async () => {
      await api(path + "/leave", "POST", {});
      await refresh();
    }, back);
    return;
  }
  const members = bot.members.filter(member => member.id !== bot.ownerId);
  const transfer = () => panel("选择新所有者", ...members.map(member => button(member.name, () =>
    confirmBotChange("移交给 " + member.name + "？", "对方将可以管理成员、资料和当前共享对话。技能随 Bot 移交，原有的 MCP 连接和 Codex 工具授权会清除。你会保留成员身份、自己的私聊及自己封存的共享归档。",
      "确认移交", async () => {
        await api(path + "/owner", "POST", { userId:member.id });
        await refresh(bot.id);
      }, transfer))), button("返回", hub, "secondary"));
  panel("管理 Bot", members.length > 0 && button("移交所有权", transfer),
    button("删除这个 Bot", () => confirmBotChange("删除「" + bot.name + "」？",
      "所有成员在这个 Bot 的私聊、照片、记忆、共享记录、归档和提醒都会永久删除。" +
        (bot.isDefault ? "系统会为你创建一个空白的默认助手。" : ""),
      "永久删除 Bot", async () => { await api(path, "DELETE"); await refresh(); }, hub), "row danger"),
    button("返回", back, "secondary"));
}

export async function openArchives(bot, back) {
  const valid = currentPanel();
  const path = botPath(bot) + "/archives";
  const { archives } = await api(path);
  if (!valid()) return;
  const home = () => openArchives(bot, back);
  panel("共享归档", note("这里只能查看你收回共用时保存的记录。"),
    ...archives.map(archive => action(date(archive.archivedAt) + " · " + archive.messages + " 条消息",
      () => viewArchive(path, archive.id, "messages", home))),
    !archives.length && note("这里还没有共享归档。"), action("返回", back, "secondary"));
}

async function viewArchive(path, id, section, back, pages = [null]) {
  const valid = currentPanel();
  const url = path + "/" + encodeURIComponent(id);
  const before = pages.at(-1);
  const { items, nextBefore } = await api(url + "?section=" + section + (before ? "&before=" + before : ""));
  if (!valid()) return;
  const sections = { messages:"消息", memories:"共享记忆", followups:"跟进记录" };
  const tabs = h("div", { class:"chips archive-sections", role:"group", "aria-label":"归档分类" }, ...Object.entries(sections).map(([key, name]) => {
    const tab = action(name, () => viewArchive(path, id, key, back), "chip");
    tab.setAttribute("aria-pressed", String(key === section));
    return tab;
  }));
  panel("共享归档 · " + sections[section], tabs,
    ...items.map(item => h("article", { class:"record" },
      h("header", {class:"record-summary"}, h("strong", {},item.label),
        h("small", {}, (item.actor ? item.actor + " · " : "") + date(item.at))),
      h("p", {},item.text),
      !!item.image && h("details", {class:"archive-photo"}, h("summary", {}, "查看照片"),
        h("img", {src:url + "/photos/" + item.cursor, alt:"共享归档中的照片", loading:"lazy"})))),
    !items.length && note("这里没有" + sections[section] + "。"),
    pages.length > 1 && action("查看较新的记录", () => viewArchive(path, id, section, back, pages.slice(0,-1))),
    nextBefore && action("查看更早的记录", () => viewArchive(path, id, section, back, [...pages, nextBefore])),
    action("返回归档列表", back, "secondary"));
}
