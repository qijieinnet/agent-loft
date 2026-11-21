import { HttpError } from "../channels/web/http.js";
import { editMemoRange, invalidateMemo, withMemoLock } from "../channels/web/memo-collab.js";
import { memoFile } from "../channels/web/memo-file.js";
import { MemoStorage } from "../channels/web/memo-storage.js";
import { MEMO_TOOLS } from "../mcp/memo-tools.js";
import { searchMemos } from "./memo-index.js";
import { canUseExpert } from "./experts.js";
import { memoAccessFor, memoSources, publicSource, validMemoPath } from "./memo-sources.js";
import { memoryOwnerOf } from "./personal.js";
import { expertIdOf, getConversation } from "./store.js";
import { getUser, isAdmin } from "./users.js";

export async function memoToolCall(owner: string, convKey: string, name: string, args: Record<string, unknown>) {
  const tool = MEMO_TOOLS.find(t => t.name === name);
  if (!tool) throw new HttpError(400, "未知备忘录操作");
  const { properties, required } = tool.inputSchema;
  if (Object.keys(args).some(k => !Object.hasOwn(properties, k) || typeof args[k] !== "string") ||
      required.some(k => typeof args[k] !== "string")) throw new HttpError(400, "备忘录工具参数无效");
  const { source: id, path, version, text, original, folder = "", query, cursor } = args as Record<string, string>;
  if (folder && !validMemoPath(folder)) throw new HttpError(400, "笔记目录无效");
  const authorize = () => {
    const conv = getConversation(convKey), user = getUser(owner);
    if (!conv || !user || user.disabled || memoryOwnerOf(conv) !== owner) throw new HttpError(403, "当前对话无权访问备忘录");
    const expert = expertIdOf(conv);
    if (!canUseExpert(owner, expert)) throw new HttpError(403, "当前对话无权使用此专家");
    const sources = memoSources(owner).map(s => {
      const access = memoAccessFor(s, expert);
      return { ...s, access: conv.plan && access === "write" ? "read" as const : access };
    }).filter(s => s.access !== "off");
    const source = sources.find(s => s.id === id);
    if (id !== undefined && !source) throw new HttpError(404, "未找到已授权的笔记库");
    if (!tool.annotations.readOnlyHint && source?.access !== "write") throw new HttpError(403, "当前笔记库或对话仅允许读取");
    return { user, sources, source };
  };
  const { user, sources, source } = authorize();
  if (name === "list_memo_sources") return sources.map(publicSource);
  if (name === "search_memos") return searchMemos(owner, source ? [source] : sources, query!, folder);
  if (!source) throw new HttpError(400, "请选择笔记库");
  const role = user.role;
  const check = () => {
    if (authorize().user.role !== role) throw new HttpError(403, "账号权限已变更");
  };
  if (name === "list_memo_files") {
    const page = await new MemoStorage(source, isAdmin(user)).list(folder, cursor);
    check();
    return page;
  }
  const file = memoFile(user, source, path!, check);
  return withMemoLock(file.lockKey, async () => {
    check();
    if (name === "create_memo") {
      const saved = await file.persist(text!, null);
      invalidateMemo(file.key);
      return { version: saved };
    }
    const latest = await file.read();
    check();
    if (name === "read_memo") return latest;
    if (version !== latest.version) throw new HttpError(409, "笔记版本已变更，请重新读取后修改");
    let start = latest.text.length, end = start;
    if (name === "edit_memo") {
      if (!original) throw new HttpError(400, "请选择一段非空原文");
      start = latest.text.indexOf(original);
      if (start < 0 || latest.text.indexOf(original, start + 1) >= 0) throw new HttpError(409, "原文未找到或出现多次，请重新选择唯一片段");
      end = start + original.length;
    }
    return { version: await editMemoRange(file.key, file.account, latest.text, version, start, end, text!, file.persist) };
  });
}
