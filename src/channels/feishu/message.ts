// 飞书消息解析：文字 + 附件引用（还没下载）。
import type { AttachmentKind } from "../../core/types.js";

export type AttachmentRef = { kind: AttachmentKind; key: string; name?: string; durationMs?: number };
export type ParsedMessage = { text: string; attachments: AttachmentRef[] };

const UNSUPPORTED_TYPES: Record<string, string> = {
  sticker: "表情包",
  merge_forward: "合并转发",
  interactive: "卡片",
  share_chat: "群名片",
  share_user: "个人名片",
  location: "位置",
  todo: "任务",
  vote: "投票",
};

export function unsupportedTypeLabel(messageType: string | undefined): string {
  return (messageType && UNSUPPORTED_TYPES[messageType]) ?? "这种";
}

/** 不认识的消息类型返回 null，调用方据此回一句「不支持」。 */
export function parseMessage(message: { message_type?: string; content?: string }): ParsedMessage | null {
  let content: any;
  try {
    content = JSON.parse(message.content ?? "{}");
  } catch {
    return null;
  }
  switch (message.message_type) {
    case "text":
      return { text: String(content.text ?? ""), attachments: [] };
    case "image":
      return content.image_key ? { text: "", attachments: [{ kind: "image", key: content.image_key }] } : null;
    case "file":
      return content.file_key
        ? { text: "", attachments: [{ kind: "file", key: content.file_key, name: content.file_name }] }
        : null;
    case "audio":
      return content.file_key
        ? {
            text: "",
            attachments: [{ kind: "audio", key: content.file_key, durationMs: Number(content.duration) || undefined }],
          }
        : null;
    case "media":
      return content.file_key
        ? {
            text: "",
            attachments: [
              {
                kind: "video",
                key: content.file_key,
                name: content.file_name,
                durationMs: Number(content.duration) || undefined,
              },
            ],
          }
        : null;
    case "post":
      return parsePost(content);
    default:
      return null;
  }
}

/** 富文本：文字按原顺序拼起来，图片和视频在原位置留个占位（「看第二张图」才对得上号）。 */
function parsePost(content: any): ParsedMessage | null {
  const body = Array.isArray(content?.content)
    ? content
    : Object.values(content ?? {}).find((v: any) => Array.isArray(v?.content));
  if (!body) return null;
  const attachments: AttachmentRef[] = [];
  const lines: string[] = [];
  if ((body as any).title) lines.push(String((body as any).title));
  const count = (kind: AttachmentKind) => attachments.filter((a) => a.kind === kind).length;
  for (const paragraph of (body as any).content as any[][]) {
    if (!Array.isArray(paragraph)) continue;
    let line = "";
    for (const el of paragraph) {
      switch (el?.tag) {
        case "text":
        case "md":
          line += el.text ?? "";
          break;
        case "a":
          line += el.text && el.href && el.text !== el.href ? `[${el.text}](${el.href})` : (el.href ?? el.text ?? "");
          break;
        case "at":
          line += el.user_id ?? "";
          break;
        case "code_block":
          line += `\n\`\`\`${el.language ?? ""}\n${el.text ?? ""}\n\`\`\`\n`;
          break;
        case "emotion":
          line += el.emoji_type ? `[${el.emoji_type}]` : "";
          break;
        case "img":
          if (el.image_key) {
            attachments.push({ kind: "image", key: el.image_key });
            line += `[图片${count("image")}]`;
          }
          break;
        case "media":
          if (el.file_key) {
            attachments.push({ kind: "video", key: el.file_key });
            line += `[视频${count("video")}]`;
          }
          break;
      }
    }
    lines.push(line);
  }
  return { text: lines.join("\n"), attachments };
}
