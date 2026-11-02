// 微信这边只有文字：把回复、授权请求、提问和命令结果都画成纯文本，把数字回复解析回来。
import { albumsToText } from "../../core/albums.js";
import { chartsToTables } from "../../core/charts.js";
import type { CommandReply } from "../../core/hub.js";
import type { Interaction } from "../../core/interactions.js";
import type { ApprovalDecision } from "../../core/types.js";
import type { WeixinMessage } from "./client.js";

/** 官方插件的单条上限是 4000。留点余量，分段提示接在最后一段后面 */
export const CHUNK_LIMIT = 3800;

const ITEM_TEXT = 1;
const ITEM_VOICE = 3;

/** 入站消息里的文字：文字项，或者微信给语音转好的文字。其它类型 unsupported=true */
export function inboundText(msg: WeixinMessage): { text: string; unsupported: boolean } {
  const items = msg.item_list ?? [];
  for (const item of items) {
    if (item.type === ITEM_TEXT && item.text_item?.text != null) return { text: String(item.text_item.text).trim(), unsupported: false };
    if (item.type === ITEM_VOICE && item.voice_item?.text) return { text: String(item.voice_item.text).trim(), unsupported: false };
  }
  return { text: "", unsupported: items.length > 0 };
}

/** 回复正文：图表换成表格、相册换成摘要；微信发不了 Markdown 图片，只留说明文字 */
export function toWeixinText(markdown: string): string {
  return chartsToTables(albumsToText(markdown))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_all, alt: string) => (alt ? `[图片：${alt}]` : "[图片]"))
    .trim();
}

/** 按行切成不超过 limit 的段；单行太长就硬切，但不切开 emoji 这种代理对 */
export function splitText(text: string, limit = CHUNK_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let at = rest.lastIndexOf("\n", limit);
    if (at < limit / 2) {
      at = limit;
      const code = rest.charCodeAt(at - 1);
      if (code >= 0xd800 && code <= 0xdbff) at -= 1;
    }
    chunks.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).replace(/^\n+/, "");
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

// ---------- 授权 ----------
//
// 数字的含义固定，不按显示的项目重新编号：1 永远是允许一次、0 永远是拒绝，手滑也不会点到别的权限上。

export function canAlways(spec: Extract<Interaction["spec"], { kind: "approval" }>, isAdmin: boolean): boolean {
  return !!spec.alwaysLabel && (!spec.alwaysGlobal || isAdmin);
}

export function approvalPrompt(i: Interaction, isAdmin: boolean, timeoutMin: number): string {
  const spec = i.spec;
  if (spec.kind !== "approval") throw new Error("不是审批");
  return [
    `🔐 ${spec.title}`,
    "",
    clip(spec.detail, 2500),
    "",
    "回复数字：",
    "1 允许一次",
    ...(spec.allowSession ? ["2 本会话全部允许"] : []),
    ...(canAlways(spec, isAdmin) ? [`3 ${spec.alwaysLabel}`] : []),
    "0 拒绝",
    "",
    `网页上也能处理。${timeoutMin} 分钟没回应按拒绝。`,
  ].join("\n");
}

/** 解析授权回复。undefined：这条消息不是在回答授权 */
export function parseApproval(text: string, i: Interaction, isAdmin: boolean): ApprovalDecision | undefined {
  const spec = i.spec;
  if (spec.kind !== "approval") return undefined;
  const t = text.trim();
  if (t === "1" || t === "允许") return "allow-once";
  if (t === "0" || t === "拒绝") return "deny";
  if (t === "2" && spec.allowSession) return "allow-session";
  if (t === "3" && canAlways(spec, isAdmin)) return "allow-always";
  return undefined;
}

// ---------- 提问 ----------

/** 第一个还没答的问题的下标，都答了就是 -1 */
export function currentQuestion(i: Interaction): number {
  return i.selections.findIndex((picked, q) => picked.length === 0 && !i.freeText[q]);
}

export function questionPrompt(i: Interaction, agentLabel: string): string {
  const spec = i.spec;
  if (spec.kind !== "question") throw new Error("不是提问");
  const qi = Math.max(0, currentQuestion(i));
  const q = spec.questions[qi]!;
  const lines = [`❓ ${spec.title || `${agentLabel} 想确认一下`}${spec.questions.length > 1 ? `（第 ${qi + 1}/${spec.questions.length} 问）` : ""}`, ""];
  lines.push([q.header, q.question].filter(Boolean).join("："));
  if (q.options.length > 0) {
    lines.push("");
    q.options.forEach((opt, oi) => lines.push(`${oi + 1} ${clip(opt.label, 80)}${opt.description ? ` —— ${clip(opt.description, 120)}` : ""}`));
    lines.push("", q.multiSelect ? "回复数字，多选用空格隔开。" : "回复数字。", "都不合适就直接回复文字。回复「跳过」让 agent 按默认继续。");
  } else {
    lines.push("", "直接回复文字。回复「跳过」让 agent 按默认继续。");
  }
  return lines.join("\n");
}

export type QuestionAnswer =
  | { kind: "skip" }
  /** 选项下标（从 0 开始） */
  | { kind: "options"; options: number[] }
  /** 是数字，但没有这个选项 */
  | { kind: "invalid" }
  /** 不是选项，当成自由作答 */
  | { kind: "text" };

export function parseQuestionAnswer(text: string, i: Interaction): QuestionAnswer {
  const spec = i.spec;
  if (spec.kind !== "question") return { kind: "text" };
  const t = text.trim();
  if (t === "跳过") return { kind: "skip" };
  const q = spec.questions[Math.max(0, currentQuestion(i))];
  if (!q || q.options.length === 0) return { kind: "text" };
  const tokens = t.split(/[\s,，、]+/).filter(Boolean);
  if (tokens.length === 0 || !tokens.every((s) => /^\d{1,3}$/.test(s))) return { kind: "text" };
  if (!q.multiSelect && tokens.length > 1) return { kind: "invalid" };
  const options = [...new Set(tokens.map((s) => Number(s) - 1))];
  return options.every((o) => o >= 0 && o < q.options.length) ? { kind: "options", options } : { kind: "invalid" };
}

// ---------- 命令结果 ----------

export function commandReplyText(reply: CommandReply, label: (agent: string) => string): string | undefined {
  switch (reply.type) {
    case "text":
      return reply.text;
    case "sessions":
      if (reply.sessions.length === 0) return `${label(reply.agent)} 还没有历史会话。`;
      return [
        `${label(reply.agent)} 的历史会话${reply.fellBack ? "（当前目录没有，列出全部目录）" : ""}：`,
        "",
        ...reply.sessions.map((s) => `${s.id === reply.current ? "▶ " : ""}${clip(s.title || "（未命名）", 40)}\n/resume ${s.id}`),
      ].join("\n");
    case "models":
      return [
        `${label(reply.agent)} 的模型${reply.current ? `（当前 ${reply.current}）` : ""}：`,
        "",
        ...reply.models.map((m) => `/model ${m.id}${m.label && m.label !== m.id ? ` —— ${m.label}` : ""}`),
        ...(reply.effortSupported ? ["", `思考程度${reply.currentEffort ? `（当前 ${reply.currentEffort}）` : ""}：发 /effort 程度`] : []),
      ].join("\n");
    case "agents":
      return ["可用的专家（换了会开新会话）：", "", ...reply.agents.map((a) => `${a.id === reply.current ? "▶ " : ""}${a.label}\n/expert ${a.id}`)].join("\n");
    case "commands":
      return ["可用的命令：", "", ...reply.commands.slice(0, 40).map((c) => `/${c.name}${c.args ? ` ${c.args}` : ""} —— ${c.description}`)].join("\n");
    case "none":
      return undefined;
  }
}
