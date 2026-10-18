// 附件落盘：每条会话一个上传目录，开新会话就整个删掉。
//
// 放在家目录下而不是项目目录里，免得弄脏用户的仓库。agent 需要能直接读这些文件：
// Claude 通过 additionalDirectories 放行，Codex 的沙箱本来就允许读。
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../home.js";
import type { AttachmentKind, SavedAttachment } from "./types.js";

const uploadsRoot = path.join(dataDir, "uploads");

export function uploadsDirFor(key: string): string {
  return path.join(uploadsRoot, encodeURIComponent(key));
}

export function ensureUploadsDir(key: string): string {
  const dir = uploadsDirFor(key);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function clearUploads(key: string): void {
  try {
    fs.rmSync(uploadsDirFor(key), { recursive: true, force: true });
  } catch (err) {
    console.warn(`[附件] 清理 ${key} 的上传目录失败:`, err);
  }
}

/** 启动时清理：会话没了、或闲置过期的，目录一并删掉。 */
export function sweepUploads(isAlive: (key: string) => boolean): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(uploadsRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    let key: string;
    try {
      key = decodeURIComponent(entry);
    } catch {
      continue;
    }
    if (isAlive(key)) continue;
    fs.rmSync(path.join(uploadsRoot, entry), { recursive: true, force: true });
  }
}

/** 去掉路径分隔符和控制字符，防止文件名把文件写到目录外面去。 */
export function safeName(name: string): string {
  const cleaned = path
    .basename(name)
    .replace(/[\u0000-\u001f/\\]/g, "_")
    .trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned.slice(0, 120) : "file";
}

/** 按文件头判断类型。飞书给的图片没有文件名，扩展名只能靠这个。 */
export function sniff(buf: Buffer): { mediaType: string; ext: string } | undefined {
  const hex = buf.subarray(0, 12).toString("hex");
  if (hex.startsWith("89504e47")) return { mediaType: "image/png", ext: "png" };
  if (hex.startsWith("ffd8ff")) return { mediaType: "image/jpeg", ext: "jpg" };
  if (hex.startsWith("47494638")) return { mediaType: "image/gif", ext: "gif" };
  if (hex.startsWith("52494646") && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mediaType: "image/webp", ext: "webp" };
  }
  if (hex.startsWith("25504446")) return { mediaType: "application/pdf", ext: "pdf" };
  if (buf.subarray(0, 4).toString("ascii") === "OggS") return { mediaType: "audio/ogg", ext: "opus" };
  if (buf.subarray(4, 8).toString("ascii") === "ftyp") return { mediaType: "video/mp4", ext: "mp4" };
  return undefined;
}

/** 同名文件不覆盖，加序号。 */
export function uniquePath(dir: string, name: string): string {
  let candidate = path.join(dir, name);
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem}-${i}${ext}`);
  return candidate;
}

function kindOf(mediaType: string | undefined): AttachmentKind {
  if (mediaType?.startsWith("image/")) return "image";
  if (mediaType?.startsWith("audio/")) return "audio";
  if (mediaType?.startsWith("video/")) return "video";
  return "file";
}

/**
 * 把一段已在内存 / 临时文件里的内容存成附件。
 * kind 不给就按文件头 / 声明的类型猜。
 */
export function saveBuffer(params: {
  key: string;
  data: Buffer;
  name?: string;
  kind?: AttachmentKind;
  mediaType?: string;
  durationMs?: number;
}): SavedAttachment {
  const dir = ensureUploadsDir(params.key);
  const sniffed = sniff(params.data);
  const mediaType = sniffed?.mediaType ?? params.mediaType;
  const kind = params.kind ?? kindOf(mediaType);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const name = params.name ? safeName(params.name) : `${kind}-${stamp}${sniffed ? `.${sniffed.ext}` : ""}`;
  const target = uniquePath(dir, name);
  fs.writeFileSync(target, params.data);
  return {
    kind,
    path: target,
    name: path.basename(target),
    size: params.data.length,
    ...(mediaType ? { mediaType } : {}),
    ...(params.durationMs ? { durationMs: params.durationMs } : {}),
  };
}

/** 已经下载到临时文件的：探测类型后挪进上传目录。 */
export function adoptFile(params: {
  key: string;
  tmpPath: string;
  name?: string;
  kind: AttachmentKind;
  durationMs?: number;
}): SavedAttachment {
  const dir = ensureUploadsDir(params.key);
  const head = Buffer.alloc(12);
  const fd = fs.openSync(params.tmpPath, "r");
  fs.readSync(fd, head, 0, 12, 0);
  fs.closeSync(fd);
  const sniffed = sniff(head);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const name = params.name
    ? safeName(params.name)
    : `${params.kind}-${stamp}${sniffed ? `.${sniffed.ext}` : ""}`;
  const target = uniquePath(dir, name);
  fs.renameSync(params.tmpPath, target);
  return {
    kind: params.kind,
    path: target,
    name: path.basename(target),
    size: fs.statSync(target).size,
    ...(sniffed ? { mediaType: sniffed.mediaType } : {}),
    ...(params.durationMs ? { durationMs: params.durationMs } : {}),
  };
}

export const KIND_LABEL: Record<AttachmentKind, string> = {
  image: "图片",
  file: "文件",
  audio: "语音",
  video: "视频",
};

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 附件清单的文字说明，两个 agent 都用它告诉模型文件在哪。 */
export function describeAttachments(
  saved: SavedAttachment[],
  inlined: (a: SavedAttachment) => boolean,
): string {
  const counters: Partial<Record<AttachmentKind, number>> = {};
  const lines = saved.map((a) => {
    const n = (counters[a.kind] = (counters[a.kind] ?? 0) + 1);
    const details = [
      formatSize(a.size),
      ...(a.durationMs ? [`时长 ${Math.round(a.durationMs / 1000)} 秒`] : []),
      ...(inlined(a) ? ["内容已附在本消息中"] : []),
    ];
    return `- ${KIND_LABEL[a.kind]}${n}：${a.path}（${details.join("，")}）`;
  });
  return ["[用户发来了以下附件，已保存到本地，需要时可以直接读取或处理这些文件]", ...lines].join("\n");
}
