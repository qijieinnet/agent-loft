// 资料库页面的接口：/api/library。每个人只看得到、删得了自己的文件（别人的一律当不存在），规则见 core/library.ts。
// 放进对话里用的接口在 api.ts（/api/conversations/<key>/attach），要和上传的附件一起认领。
import type { IncomingMessage, ServerResponse } from "node:http";
import { canSeeFile, deleteLibraryFile, getLibraryFile, librarySummary, listLibrary, type LibraryFile, type LibraryKind } from "../../core/library.js";
import { getConversation } from "../../core/store.js";
import type { User } from "../../core/users.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";

export function fileView(f: LibraryFile) {
  const conv = getConversation(f.convKey);
  return {
    id: f.id,
    name: f.name,
    kind: f.kind,
    size: f.size,
    source: f.source,
    createdAt: f.createdAt,
    url: `/api/file?path=${encodeURIComponent(f.path)}`,
    conv: { key: f.convKey, title: conv?.title ?? "", ...(conv?.hidden ? { hidden: true } : {}) },
  };
}

const KINDS = new Set<LibraryKind>(["image", "file", "media"]);

export async function handleLibraryApi(req: IncomingMessage, res: ServerResponse, p: string, user: User): Promise<boolean> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://x");

  if (p === "/api/library" && method === "GET") {
    const kind = url.searchParams.get("kind") as LibraryKind | null;
    const beforeAt = Number(url.searchParams.get("beforeAt"));
    const beforeId = url.searchParams.get("beforeId");
    const { files, more } = listLibrary(user, {
      ...(kind && KINDS.has(kind) ? { kind } : {}),
      q: url.searchParams.get("q") ?? "",
      ...(beforeId && Number.isFinite(beforeAt) ? { before: { at: beforeAt, id: beforeId } } : {}),
      limit: Number(url.searchParams.get("limit")) || 60,
    });
    sendJson(res, 200, { files: files.map(fileView), more, summary: librarySummary(user) });
    return true;
  }

  // 删掉几个（批量）：{ ids: [...] }。别人的、不存在的跳过，返回实际删了几个
  if (p === "/api/library/delete" && method === "POST") {
    const body = await readJsonBody<{ ids?: unknown }>(req);
    if (!Array.isArray(body.ids) || body.ids.length === 0) throw new HttpError(400, "要给出删哪些文件");
    let deleted = 0;
    for (const id of body.ids.slice(0, 500)) {
      const file = typeof id === "string" ? getLibraryFile(id) : undefined;
      if (!file || file.source === "copy" || !canSeeFile(user, file)) continue;
      deleteLibraryFile(file);
      deleted++;
    }
    sendJson(res, 200, { deleted, summary: librarySummary(user) });
    return true;
  }

  return false;
}
