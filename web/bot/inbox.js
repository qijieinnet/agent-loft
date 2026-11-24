import { api, h } from "./client.js";
import { action, note, panel } from "./panel.js";

export async function openBotInbox(openMessage) {
  const { items } = await api("/api/bot-inbox");
  const type = { "delegation-failed": "协作未完成", reply: "新回复", reminder: "到时提醒", followup: "跟进更新" };
  const rows = items.map((item) => {
    const label = item.botName + " · " + (type[item.kind] || "新消息");
    const row = action(label, () => openMessage(item.threadId, item.messageId, item.delegationId), item.seen ? "row" : "row active");
    row.setAttribute("aria-label", (item.seen ? "已读，" : "未读，") + label);
    row.append(
      h(
        "small",
        {},
        new Date(item.createdAt).toLocaleString(undefined, {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }),
      ),
    );
    return row;
  });
  panel("最近通知", ...rows, !rows.length && note("收到的回复、提醒和跟进更新会留在这里。"));
}
