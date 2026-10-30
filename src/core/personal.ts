// 「这条对话是谁的」在个人数据（记忆、飞书绑定）上的落点。
import { deleteMemory, memoryPrompt, readMemory } from "./memory.js";
import { purgeHistory } from "./chat-history.js";
import { unlinkUser } from "./feishu-links.js";
import { deleteUserTasks } from "./tasks.js";
import { purgeUserSkills } from "./skills.js";
import { purgeUserExperts } from "./experts.js";
import { purgeUserMcp } from "./mcp.js";
import type { Conversation } from "./store.js";
import { getUser, legacyOwnerId } from "./users.js";
import { deleteBuiltinAgentDefaults } from "./builtin-agents.js";
import { deleteUiPrefs } from "./ui-prefs.js";

/**
 * 这条对话该用谁的记忆。比会话列表的归属规则（users.ts 的 ownedBy）更严：
 *   - 有主人的，就是主人 —— 主人被删了、停用了，谁的都不用（不像会话那样转给管理员：
 *     别人的个人档案混进管理员的记忆里，agent 会突然以为自己在跟另一个人说话）；
 *   - 升级前就有的 Web 会话没记主人，算迁移出来的那个管理员的（和推送订阅同一个规则）；
 *   - 飞书群聊、没绑定账号的飞书私聊：没有主人，不用记忆。群里不止一个人，没绑定的人身份不明。
 */
export function memoryOwnerOf(conv: Pick<Conversation, "owner" | "channel">): string | undefined {
  if (conv.owner) {
    const user = getUser(conv.owner);
    return user && !user.disabled ? user.id : undefined;
  }
  return conv.channel === "web" ? legacyOwnerId() : undefined;
}

/** 开会话时交给 agent 的记忆（SessionOptions.memory）。没主人或者主人关了记忆就是 undefined */
export function sessionMemory(
  conv: Pick<Conversation, "owner" | "channel"> & { key?: string },
): { userId: string; prompt: string; search?: boolean; convKey?: string } | undefined {
  const userId = memoryOwnerOf(conv);
  if (!userId) return undefined;
  const prompt = memoryPrompt(userId);
  if (!prompt) return undefined;
  return {
    userId,
    prompt,
    ...(readMemory(userId).chatHistory ? { search: true } : {}),
    ...(conv.key ? { convKey: conv.key } : {}),
  };
}

/** 删用户时一起删掉的个人数据：记忆、聊天记录索引、飞书绑定、定时任务、技能（他建的技能，装了的人也就没了）、专家和 MCP */
export function purgeUserData(userId: string): void {
  deleteMemory(userId);
  purgeHistory(userId);
  unlinkUser(userId);
  deleteUserTasks(userId);
  purgeUserSkills(userId);
  purgeUserExperts(userId);
  purgeUserMcp(userId);
  deleteUiPrefs(userId);
  deleteBuiltinAgentDefaults(userId);
}
