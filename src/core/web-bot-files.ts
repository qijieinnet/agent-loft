// Ordinary chat attachments are private message data. Extract inert text without exposing a server path to an engine.
import { execFile } from "node:child_process";
import { DOMParser } from "@xmldom/xmldom";
import { safeName, sniff } from "./uploads.js";
import { readZip } from "./zip.js";
import { sql } from "./db.js";
import { WebBotError, type BotFile } from "./web-bots.js";

const maxFile = 8 * 1024 * 1024;
const textLimit = 18000;
const types: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json",
  pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
function audioType(bytes: Buffer) {
  const tag = bytes.toString("latin1", 0, 12);
  if (tag.startsWith("OggS")) return "audio/ogg";
  if (bytes.readUInt32BE(0) === 0x1a45dfa3) return "audio/webm";
  if (tag.slice(4, 8) === "ftyp") return "audio/mp4";
  if (tag.startsWith("RIFF") && tag.endsWith("WAVE")) return "audio/wav";
  if (tag.startsWith("ID3") || (bytes[0] === 255 && (bytes[1]! & 224) === 224)) return "audio/mpeg";
  if (tag.startsWith("fLaC")) return "audio/flac";
  return "";
}
export function parseBotFile(value: unknown): BotFile {
  const input = value as { name?: unknown; data?: unknown };
  if (!input || typeof input.name !== "string" || typeof input.data !== "string" || input.data.length > Math.ceil(maxFile / 3) * 4)
    throw new WebBotError(400, "请选择不超过 8 MB 的文件。");
  const name = Buffer.from(safeName(input.name)).toString("utf8"), ext = name.split(".").at(-1)!.toLowerCase();
  const data = Buffer.from(input.data, "base64");
  if (!data.length || data.length > maxFile || data.toString("base64") !== input.data) throw new WebBotError(400, "文件数据无效。");
  const mediaType = Object.hasOwn(types, ext) ? types[ext] : (data.length >= 12 && /^(webm|ogg|opus|mp3|m4a|mp4|wav|flac)$/.test(ext) && audioType(data));
  if (!mediaType) throw new WebBotError(400, "支持 PDF、DOCX、XLSX、文本、CSV、JSON 及常见录音。");
  if (ext === "pdf" && sniff(data)?.ext !== "pdf" || /^(docx|xlsx)$/.test(ext) && !data.subarray(0, 2).equals(Buffer.from("PK")))
    throw new WebBotError(400, "文件内容与扩展名不符。");
  return { name, mediaType, data };
}

function officeText(bytes: Buffer, word: boolean) {
  const entries = readZip(bytes, 20 * 1024 * 1024, 1500);
  const xml = (data: Buffer) => {
    const source = data.toString("utf8");
    if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error("不支持此 XML 文档。");
    return new DOMParser().parseFromString(source, "application/xml");
  };
  if (word) {
    const main = entries.find(e => e.path === "word/document.xml");
    if (!main) throw new Error("没有 Word 正文。");
    return Array.from(xml(main.data).getElementsByTagNameNS("*", "p"), p => p.textContent).join("\n");
  }
  const shared = entries.find(e => e.path === "xl/sharedStrings.xml");
  const strings = shared ? Array.from(xml(shared.data).getElementsByTagNameNS("*", "si"), si => si.textContent) : [];
  let text = "";
  for (const entry of entries.filter(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.path))) {
    text += entry.path.split("/").at(-1) + "\n";
    for (const row of Array.from(xml(entry.data).getElementsByTagNameNS("*", "row"))) {
      text += Array.from(row.getElementsByTagNameNS("*", "c"), cell => {
        const raw = cell.getElementsByTagNameNS("*", "v")[0]?.textContent ?? "";
        const value = cell.getAttribute("t") === "s" ? strings[Number(raw)] : cell.getAttribute("t") === "inlineStr" ? cell.textContent : raw;
        return (cell.getAttribute("r") || "") + "=" + (value || "");
      }).join("\t") + "\n";
      if (text.length > textLimit) return text;
    }
  }
  return text;
}

async function extract(file: BotFile, signal: AbortSignal) {
  const data = Buffer.from(file.data);
  if (file.mediaType.startsWith("audio/")) {
    const endpoint = process.env.AGENT_LOFT_BOT_TRANSCRIPTION_URL;
    if (!endpoint) throw new WebBotError(422, "录音已保存，可在对话中播放。要让 Bot 听懂录音，请配置语音转写服务，或使用语音输入。");
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(data)], { type: file.mediaType }), file.name);
    form.set("model", process.env.AGENT_LOFT_BOT_TRANSCRIPTION_MODEL || "whisper-1");
    const key = process.env.AGENT_LOFT_BOT_TRANSCRIPTION_KEY;
    const response = await fetch(endpoint, { method: "POST", body: form, redirect: "error", signal,
      headers: key ? { Authorization: "Bearer " + key } : {} });
    if (!response.ok) throw new WebBotError(502, "录音转写失败，请检查转写服务后重新发送。");
    const result = await response.json() as { text?: unknown };
    return typeof result.text === "string" ? result.text : "";
  }
  if (file.mediaType === "application/pdf") return await new Promise<string>((resolve, reject) => {
    const child = execFile("pdftotext", ["-f","1","-l","100","-layout","-","-"], { signal, timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => err ? reject(new WebBotError(422, "PDF 解析失败。请确认服务器已安装 pdftotext，且文档可提取文字。")) : resolve(stdout));
    child.stdin?.on("error", () => {});
    child.stdin?.end(data);
  });
  if (file.mediaType.includes("openxmlformats")) return officeText(data, file.mediaType.includes("wordprocessing"));
  return new TextDecoder("utf-8", { fatal: true }).decode(data);
}

export async function fileContext(message: number, check: () => void) {
  const files = sql("SELECT slot,name,mediaType,data,extracted FROM web_bot_files WHERE message=? ORDER BY slot").all(message) as (BotFile & { slot: number })[];
  const results = [];
  const perFile = Math.min(textLimit, Math.floor(36000 / Math.max(files.length, 1)));
  for (const file of files) {
    check();
    let text = file.extracted;
    if (text == null) {
      try { text = (await extract(file, AbortSignal.timeout(60000))).trim(); }
      catch (err) { if (err instanceof WebBotError) throw err; throw new WebBotError(422, "未能读取文件「" + file.name + "」。请检查格式或重新导出。"); }
      if (!text) throw new WebBotError(422, file.mediaType.startsWith("audio/")
        ? "未识别到清晰的语音。可以重新录制，或用语音输入文字。"
        : "「" + file.name + "」没有可读文字。扫描件可改发页面截图。");
      if (text.length > textLimit) text = text.slice(0, textLimit) + "\n[正文已截断]";
      check();
      sql("UPDATE web_bot_files SET extracted=? WHERE message=? AND slot=?").run(text, message, file.slot);
    }
    results.push({ name: file.name, kind: file.mediaType.startsWith("audio/") ? "语音转写" : "文件正文", text: text.length > perFile ? text.slice(0, perFile) + "\n[正文已截断]" : text });
  }
  return results;
}

export function filesInPage(thread: string, first: number, last: number) {
  const files = sql(`SELECT f.message,f.slot,f.name,f.mediaType,
    CASE WHEN f.mediaType LIKE 'audio/%' THEN f.extracted END AS transcript FROM web_bot_files f JOIN web_bot_messages m ON m.id=f.message
    WHERE m.thread=? AND m.id BETWEEN ? AND ? ORDER BY f.message,f.slot`).all(thread, first, last);
  const grouped = new Map<number, { slot: number; name: string; mediaType: string; transcript?: string }[]>();
  for (const row of files) {
    const id = Number(row.message), list = grouped.get(id) || [];
    list.push({ slot: Number(row.slot), name: String(row.name), mediaType: String(row.mediaType), ...(row.transcript ? { transcript: String(row.transcript) } : {}) });
    grouped.set(id, list);
  }
  return grouped;
}
