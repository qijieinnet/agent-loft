// Web 上「这个用户能碰哪些东西」。规则本身在 core/users.ts 的 ownedBy。
import { getConversation, sessionOwner, type Conversation } from "../../core/store.js";
import { legacyOwnerId, listUsers, ownedBy, type User } from "../../core/users.js";
import type { OwnerFilter } from "./push.js";

export function canSeeConv(user: User, conv: Conversation | undefined): conv is Conversation {
  return !!conv && ownedBy(user, conv.owner);
}

export function canSeeKey(user: User, key: string): boolean {
  return canSeeConv(user, getConversation(key));
}

/**
 * 这个用户能看到、能恢复哪些 agent 会话。
 * 只有他一个用户时什么都不会被滤掉，返回 undefined —— 列会话时就不用为了过滤多读一大批
 */
export function sessionVisibleTo(user: User): ((sessionId: string) => boolean) | undefined {
  if (listUsers().every((u) => u.id === user.id)) return undefined;
  return (sessionId) => ownedBy(user, sessionOwner(sessionId));
}

/** 推送订阅是不是这个用户的。升级前的订阅没记主人，算迁移出来的那个管理员的 */
export function pushOwnedBy(userId: string): OwnerFilter {
  return (owner) => (owner ?? legacyOwnerId()) === userId;
}
