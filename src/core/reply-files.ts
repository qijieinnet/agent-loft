// agent 回复里提到的文件：网页上点开预览 / 下载。
//
// 只放行这条会话的 agent 回复里真的写过的路径（防止拼个地址就读服务器上任意文件），
// 再挡掉密钥、凭据一类的敏感文件 —— agent 写过也不给看。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { home } from "../home.js";
import { uploadsRoot } from "./uploads.js";

/** 路径里出现这些目录名就不给看（私钥、云凭据、密码库…） */
const SENSITIVE_DIRS = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".password-store", ".gcloud"]);

/** 家目录下这些位置不给看（相对家目录） */
const SENSITIVE_HOME = [
  ".config/gcloud",
  ".config/gh",
  ".claude/.credentials.json",
  ".codex/auth.json",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
];

/** 系统里不给看的 */
const SENSITIVE_SYSTEM = ["/proc", "/sys", "/dev", "/etc/shadow", "/etc/gshadow", "/etc/sudoers", "/etc/sudoers.d"];

/** 文件名：.env（示例文件除外）、私钥、证书私钥、密钥库 */
function sensitiveName(name: string): boolean {
  const n = name.toLowerCase();
  if (/^\.env(\.|$)/.test(n) && !/\.(example|sample|template)$/.test(n)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(n)) return true;
  return /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/.test(n);
}

function within(file: string, dir: string): boolean {
  return file === dir || file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

export function isSensitivePath(file: string): boolean {
  const parts = file.split(path.sep);
  if (parts.some((p) => SENSITIVE_DIRS.has(p))) return true;
  if (sensitiveName(path.basename(file))) return true;
  const userHome = os.homedir();
  if (SENSITIVE_HOME.some((p) => within(file, path.join(userHome, p)))) return true;
  if (SENSITIVE_SYSTEM.some((p) => within(file, p))) return true;
  // agent-loft 自己的配置和数据（飞书密钥、账号、登录态…）；上传的附件除外，那些本来就能看
  return within(file, home) && !within(file, uploadsRoot);
}

/** 「file:///a/b」「~/a」「相对路径」→ 绝对路径（相对路径按会话的工作目录算） */
export function expandPath(p: string, cwd: string): string {
  let s = p.trim();
  if (s.startsWith("file://")) {
    s = s.slice("file://".length);
    try {
      s = decodeURIComponent(s);
    } catch {
      // 编码坏了就按原样
    }
  }
  if (s === "~" || s.startsWith("~/")) s = path.join(os.homedir(), s.slice(1));
  return path.resolve(cwd, s);
}

/**
 * 解析成可以给前端看的真实文件路径：存在、是普通文件、解析符号链接前后都不敏感。不行返回 undefined
 */
export function resolveReplyFile(p: string, cwd: string): string | undefined {
  if (!p.trim() || p.includes("\0")) return undefined;
  try {
    const abs = expandPath(p, cwd);
    if (isSensitivePath(abs)) return undefined;
    const real = fs.realpathSync(abs);
    if (isSensitivePath(real)) return undefined;
    return fs.statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** 回复里百分号编码的路径（链接地址常见）也解开一份，两种写法都能对上 */
function withDecoded(text: string): string {
  if (!text.includes("%")) return text;
  const decoded = text.replace(/(?:%[0-9a-f]{2})+/gi, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m;
    }
  });
  return decoded === text ? text : `${text}\n${decoded}`;
}

/** 路径里能出现的字符：前后挨着这些就说明只对上了别的路径的一截（比如 a.ts 对上 src/a.ts） */
const PATH_CHAR = /[\p{L}\p{N}_\-./~@+]/u;

/** text 里有没有完整地写着 p（不是别的路径的一部分） */
export function mentions(text: string, p: string): boolean {
  const needle = p.trim();
  if (!needle) return false;
  const hay = withDecoded(text);
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const before = hay[i - 1];
    const after = hay[i + needle.length];
    // 末尾的「.」是句号，不算路径的一部分
    const afterOk = !after || !PATH_CHAR.test(after) || (after === "." && !PATH_CHAR.test(hay[i + needle.length + 1] ?? " "));
    if ((!before || !PATH_CHAR.test(before)) && afterOk) return true;
  }
  return false;
}

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
};

/** 浏览器里直接打开的类型；其余（包括 HTML）一律当下载 / 纯文本，不在本站域名下当网页执行 */
export function replyFileType(file: string): string | undefined {
  return TYPES[path.extname(file).slice(1).toLowerCase()];
}
