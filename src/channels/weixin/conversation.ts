// 设置页和微信入站共用同一条会话、同一份专家选择。
import { hub } from "../../core/hub.js";
import { getConversation } from "../../core/store.js";
import { weixinKey } from "../../core/weixin-accounts.js";

export function weixinExpertChoices(userId: string) {
  const allowed = hub.enabledAgents().map((d) => d.id);
  return { allowed, choices: hub.expertChoices(userId, allowed) };
}

/** 新会话选第一个可用专家；原专家不可用时换掉。 */
export async function ensureWeixinConversation(userId: string): Promise<string[] | undefined> {
  const { allowed, choices } = weixinExpertChoices(userId);
  const first = choices[0];
  if (!first) return undefined;
  const key = weixinKey(userId);
  const existed = getConversation(key);
  if (!existed) {
    hub.ensure({
      key,
      channel: "weixin",
      channelId: userId,
      defaultAgent: first.engine,
      expert: first.id,
      owner: userId,
      title: "微信",
    });
  } else if (!choices.some((e) => e.id === (existed.expert ?? existed.agent))) {
    await hub.setExpert(key, first.id, allowed);
  }
  return allowed;
}
