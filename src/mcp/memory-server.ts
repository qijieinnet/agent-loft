// 记忆工具的 MCP 服务（stdio）：给 agent 用的 remember / forget。
//
// Claude 和 Codex 都按「一个会话一个子进程」拉起它（见 core/memory-mcp.ts），记给谁由拉起时的
// 环境变量 AGENT_LOFT_MEMORY_USER 定死 —— 工具参数里没有用户，模型想写别人的记忆也无从写起。
//
// 只实现 MCP 里用得到的那一小块：initialize、tools/list、tools/call、ping。
// 传输是一行一条 JSON（MCP stdio 的规定），stdout 只能写协议消息，日志一律走 stderr。
import path from "node:path";
import { addMemoryEntry, localDate, MEMORY_LIMITS, removeMemoryItem } from "../core/memory.js";
import { searchHistory } from "../core/chat-history.js";
import { dataDir, readJson } from "../home.js";

const userId = process.env.AGENT_LOFT_MEMORY_USER ?? "";
const via = process.env.AGENT_LOFT_MEMORY_VIA ?? "";
/** 开着「参考以前的聊天」才有搜索工具 */
const searchEnabled = process.env.AGENT_LOFT_MEMORY_SEARCH === "1";
/** 当前这条对话：它本来就在上下文里，搜的时候跳过 */
const currentConv = process.env.AGENT_LOFT_MEMORY_CONV ?? "";

type Request = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

const TOOLS = [
  {
    name: "remember",
    description:
      "记住一件关于用户的、以后长期有用的事（身份、偏好、习惯、长期在做的事、重要决定）。一句话，写清主语和背景。不要记密码、密钥等敏感信息。",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: `要记住的内容，一句话，最多 ${MEMORY_LIMITS.item} 字` } },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: { title: "记住", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "forget",
    description: "删掉一条过时、错误或者用户要求忘掉的记忆。id 是系统提示里「记住的事」每条前面方括号里的那个。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "记忆的 id，形如 m_1a2b3c" } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { title: "忘掉", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "search_past_chats",
    description:
      "搜用户以前的聊天记录（只有他自己的对话，不含当前这条）。关键词匹配，不是语义搜索：用对话里可能出现的原词，搜不到就换个说法再搜。返回相关的问答片段、日期和对话标题。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词，多个词用空格隔开，比如「软路由 DNS 污染」" },
        limit: { type: "number", description: "最多返回几段，默认 6，最多 15" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { title: "搜以前的聊天", readOnlyHint: true, openWorldHint: false },
  },
].filter((t) => t.name !== "search_past_chats" || searchEnabled);

type ConvMeta = { title?: string; hidden?: boolean; agent?: string };

function search(query: string, limit: number) {
  if (!searchEnabled) return text("没有开启「参考以前的聊天」。", true);
  if (!query.trim()) return text("要给关键词。", true);
  // 每次现读：用户在 Web 上删掉的对话（隐藏）立刻搜不到
  const convs = readJson<Record<string, ConvMeta>>(path.join(dataDir, "conversations.json"), {});
  const hits = searchHistory(userId, query, {
    limit: Math.max(1, Math.min(15, Math.round(limit) || 6)),
    skip: (k) => k === currentConv || !!convs[k]?.hidden,
  });
  if (hits.length === 0) return text(`以前的聊天里没找到「${query}」相关的内容。可以换个说法再搜。`);
  const blocks = hits.map((h, i) => {
    const title = convs[h.key]?.title ?? (h.key.startsWith("feishu:") ? "飞书私聊" : "未命名对话");
    return [
      `[${i + 1}] ${localDate(h.ts)} · 「${title}」`,
      ...(h.user ? [`用户：${h.user}`] : []),
      ...(h.assistant ? [`助手：${h.assistant}`] : []),
    ].join("\n");
  });
  return text(`找到 ${hits.length} 段相关的聊天（越相关越靠前）：\n\n${blocks.join("\n\n")}`);
}

function text(t: string, isError = false) {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

function callTool(name: string, args: Record<string, unknown>) {
  if (!userId) return text("记忆没有开启（没有指定用户）。", true);
  try {
    if (name === "remember") {
      const { item, created, evicted } = addMemoryEntry(userId, String(args.text ?? ""), "agent");
      console.error(`[记忆] ${via} 记下 ${item.id}`);
      if (!created) return text(`本来就记着（${item.id}）：${item.text}`);
      return text(`已记住（${item.id}）：${item.text}${evicted ? `\n（记忆满了，挤掉了最久没用的一条：${evicted.text}）` : ""}`);
    }
    if (name === "search_past_chats") return search(String(args.query ?? ""), Number(args.limit ?? 6));
    if (name === "forget") {
      const removed = removeMemoryItem(userId, String(args.id ?? "").trim());
      return removed ? text(`已忘掉（${removed.id}）：${removed.text}`) : text(`没有 id 为 ${String(args.id)} 的记忆。`, true);
    }
    return text(`没有工具 ${name}`, true);
  } catch (err) {
    return text(err instanceof Error ? err.message : String(err), true);
  }
}

function handle(req: Request): unknown {
  switch (req.method) {
    case "initialize":
      return {
        // 对端要哪个版本就回哪个：这里用到的几个方法在各版本里都没变
        protocolVersion: typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-loft-memory", version: "1.0.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const params = req.params ?? {};
      return callTool(String(params.name ?? ""), (params.arguments as Record<string, unknown> | undefined) ?? {});
    }
    default:
      throw Object.assign(new Error(`不支持 ${req.method}`), { code: -32601 });
  }
}

function reply(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function onLine(line: string): void {
  if (!line.trim()) return;
  let req: Request;
  try {
    req = JSON.parse(line) as Request;
  } catch {
    reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败" } });
    return;
  }
  // 通知（没有 id）不回
  const isRequest = req.id !== undefined && req.id !== null;
  try {
    const result = handle(req);
    if (isRequest) reply({ jsonrpc: "2.0", id: req.id, result });
  } catch (err) {
    if (!isRequest) return;
    const code = (err as { code?: number }).code ?? -32603;
    reply({ jsonrpc: "2.0", id: req.id, error: { code, message: err instanceof Error ? err.message : String(err) } });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let n: number;
  while ((n = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, n);
    buf = buf.slice(n + 1);
    onLine(line);
  }
});
process.stdin.on("end", () => process.exit(0));
