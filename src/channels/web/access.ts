// Web 上「这个用户能碰哪些东西」。规则本身在 core/users.ts 的 ownedBy。
import { assistantSessionOwner, getConversation, sessionOwner, type Conversation } from "../../core/store.js";
import { legacyOwnerId, listUsers, ownedBy, type User } from "../../core/users.js";
import type { OwnerFilter } from "./push.js";

export function canSeeConv(user: User, conv: Conversation | undefined): conv is Conversation {
  return !!conv && (conv.assistant ? conv.owner === user.id : ownedBy(user, conv.owner));
}

export function canSeeKey(user: User, key: string): boolean {
  return canSeeConv(user, getConversation(key));
}

/**
 * 这个用户能看到、能恢复哪些 agent 会话。
 * 单用户可恢复旧的无主会话，bot 的历史始终属于原来的账号。
 */
export function sessionVisibleTo(user: User): ((sessionId: string) => boolean) | undefined {
  const alone = listUsers().every((u) => u.id === user.id);
  return (id) => {
    const owner = assistantSessionOwner(id);
    return owner ? owner === user.id : alone || ownedBy(user, sessionOwner(id));
  };
}

/** 推送订阅是不是这个用户的。升级前的订阅没记主人，算迁移出来的那个管理员的 */
export function pushOwnedBy(userId: string): OwnerFilter {
  return (owner) => (owner ?? legacyOwnerId()) === userId;
}
