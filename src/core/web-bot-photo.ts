import { sniff } from "./uploads.js";
import { WebBotError, type BotImage } from "./web-bots.js";

const maxBytes = 3 * 1024 * 1024;

/** Used by upload, legacy downloads and model input. The marker is set only by the server. */
export async function sanitizeBotImage(image: BotImage): Promise<BotImage> {
  if (image.sanitized === 1) return image;
  const input = Buffer.from(image.data, "base64");
  if (input.length > maxBytes) throw new WebBotError(413, "请选择小于 3 MB 的照片。");
  const type = sniff(input);
  if (!type?.mediaType.startsWith("image/")) throw new WebBotError(400, "请选择 JPEG、PNG、WebP 或 GIF 照片。");
  try {
    const { default: sharp } = await import("sharp");
    const photo = sharp(input, { animated: true, limitInputPixels: 60_000_000 });
    const metadata = await photo.metadata();
    // libvips auto-orients static photos and strips EXIF, XMP, comments and other source metadata by default.
    if ((metadata.pages ?? 1) === 1) photo.autoOrient();
    const output = await photo.toBuffer();
    if (output.length > maxBytes) throw new WebBotError(413, "照片处理后超过 3 MB，请裁剪后重试。");
    return { name: "照片." + type.ext, mediaType: type.mediaType, data: output.toString("base64"), sanitized: 1 };
  } catch (err) {
    if (err instanceof WebBotError) throw err;
    throw new WebBotError(400, "这张照片无法安全处理，请选择清晰的截图或重新导出照片。");
  }
}

/** Reattach an earlier photo only when the user refers to it, not merely because it is in the same thread. */
export function refersToPreviousPhoto(text: string): boolean {
  return /(?:这张|那张|刚才的?|之前的?|上(?:一)?张|前面(?:的)?)(?:照片|图片|图像|截图|图(?!书))|(?:图中|图里|照片上|图片上|截图上)的?|(?:this|that|previous|last|above|attached)\s+(?:image|photo|picture|screenshot)\b|\bin the (?:image|photo|picture|screenshot)\b/i.test(text);
}
