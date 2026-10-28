// MCP 服务：由 agent-loft 按人管理，专家（core/experts.ts）勾选了哪些，开会话时就挂哪些。
//
// 两种：
//   - stdio：本机起一个进程（command + args + 环境变量）；
//   - http：连一个地址（url + 请求头）。
// 环境变量和请求头可以标成密钥：网页上不回显，只说填没填。值只交给 MCP 进程 / 请求头，不进 agent 的提示词。
// 和技能一样是「信任型」的：能执行命令的专家读得到 data/ 下的文件，包括这里的值。
//
// 机器上原有的 MCP（Claude 的 ~/.claude.json、Codex 的 config.toml）只给管理员选，id 写成 machine:<名字>。
// 内置的 Claude Code / Codex 专家不经过这里：它们照旧加载机器上的配置。
//
// 存储：data/mcp.json，所有人的放在一起，只有主进程读写。
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { dataDir, readJson, writeJsonAtomic } from "../home.js";
import { MEMORY_MCP_NAME } from "./memory-mcp.js";
import { SKILLS_MCP_NAME, TASKS_MCP_NAME } from "./tasks-mcp.js";

export type McpPair = { name: string; value: string; secret: boolean };

export type McpServer = {
  id: string;
  owner: string;
  /** 服务名：工具在 agent 里叫 mcp__<name>__<工具>，同一个人的不能重名 */
  name: string;
  description: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  /** stdio 的环境变量 */
  env: McpPair[];
  /** http 的请求头 */
  headers: McpPair[];
  /** 调用这个服务的工具前先弹授权卡（默认不问：是用户自己给专家挂的） */
  ask: boolean;
  createdAt: number;
  updatedAt: number;
};

/** 开会话时交给 agent 的样子（Claude 的 McpServerConfig 同形） */
export type McpSpec =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { type: "http"; url: string; headers: Record<string, string> };

export const MCP_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const PAIR_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const RESERVED = new Set([MEMORY_MCP_NAME, TASKS_MCP_NAME, SKILLS_MCP_NAME]);
export const MACHINE_PREFIX = "machine:";

export const MCP_LIMITS = { perUser: 50, description: 500, command: 1000, args: 50, arg: 2000, pairs: 30, value: 4000, url: 2000 };

const storePath = path.join(dataDir, "mcp.json");

/** 有变化。owner：谁的；他用着这个服务的会话空闲下来要换上新的 */
export const mcpEvents = new EventEmitter<{ changed: [owner: string, id: string] }>();

let cache: McpServer[] | null = null;

function load(): McpServer[] {
  cache ??= readJson<McpServer[]>(storePath, []).filter((s) => s && typeof s.id === "string" && typeof s.owner === "string" && MCP_NAME.test(s.name));
  return cache;
}

function save(): void {
  writeJsonAtomic(storePath, load());
}

export function resetMcpCache(): void {
  cache = null;
}

export function listMcp(owner: string): McpServer[] {
  return load()
    .filter((s) => s.owner === owner)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getMcp(id: string): McpServer | undefined {
  return load().find((s) => s.id === id);
}

export type McpInput = {
  name?: unknown;
  description?: unknown;
  type?: unknown;
  command?: unknown;
  args?: unknown;
  url?: unknown;
  env?: unknown;
  headers?: unknown;
  ask?: unknown;
};

const str = (v: unknown, max: number, what: string): string => {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length > max) throw new Error(`${what}太长（最多 ${max} 个字）`);
  return s;
};

/**
 * 键值对：密钥留空表示「不改」（网页上看不到原值，没重新填就沿用 prev 里的）。
 * 不是密钥的留空就是空字符串。
 */
function cleanPairs(raw: unknown, prev: McpPair[], what: string): McpPair[] {
  if (raw === undefined) return prev;
  if (!Array.isArray(raw)) throw new Error(`${what}格式不对`);
  if (raw.length > MCP_LIMITS.pairs) throw new Error(`${what}太多（最多 ${MCP_LIMITS.pairs} 个）`);
  const out: McpPair[] = [];
  const seen = new Set<string>();
  for (const item of raw as Record<string, unknown>[]) {
    const name = str(item?.name, 64, `${what}名`);
    if (!name) continue;
    if (!PAIR_NAME.test(name)) throw new Error(`${what}名「${name}」不合法：字母、数字、下划线和 -`);
    if (seen.has(name)) throw new Error(`${what}「${name}」重复了`);
    seen.add(name);
    const secret = item?.secret === true;
    let value = typeof item?.value === "string" ? item.value : "";
    if (value.length > MCP_LIMITS.value) throw new Error(`${what}「${name}」的值太长`);
    if (secret && value === "") value = prev.find((p) => p.name === name)?.value ?? "";
    out.push({ name, value, secret });
  }
  return out;
}

function validate(owner: string, input: McpInput, prev?: McpServer): Omit<McpServer, "id" | "owner" | "createdAt" | "updatedAt"> {
  const name = prev ? prev.name : str(input.name, 32, "名字").toLowerCase();
  if (!MCP_NAME.test(name)) throw new Error("名字只能用小写字母、数字、- 和 _，以字母或数字开头，最长 32 个字");
  if (RESERVED.has(name)) throw new Error(`「${name}」是 agent-loft 自己用的名字`);
  if (!prev && listMcp(owner).some((s) => s.name === name)) throw new Error(`已经有一个叫「${name}」的 MCP 了`);
  const type = input.type === undefined && prev ? prev.type : input.type === "http" ? "http" : input.type === "stdio" ? "stdio" : null;
  if (!type) throw new Error("类型只能是 stdio 或 http");
  const description = input.description === undefined && prev ? prev.description : str(input.description, MCP_LIMITS.description, "说明");
  const ask = input.ask === undefined && prev ? prev.ask : input.ask === true;
  if (type === "stdio") {
    const command = input.command === undefined && prev?.command ? prev.command : str(input.command, MCP_LIMITS.command, "命令");
    if (!command) throw new Error("stdio 要填启动命令");
    let args = prev?.args ?? [];
    if (input.args !== undefined) {
      if (!Array.isArray(input.args)) throw new Error("参数格式不对");
      if (input.args.length > MCP_LIMITS.args) throw new Error(`参数太多（最多 ${MCP_LIMITS.args} 个）`);
      args = input.args.map((a) => String(a ?? ""));
      if (args.some((a) => a.length > MCP_LIMITS.arg)) throw new Error("有个参数太长");
    }
    return { name, description, type, command, args, env: cleanPairs(input.env, prev?.env ?? [], "环境变量"), headers: [], ask };
  }
  const url = input.url === undefined && prev?.url ? prev.url : str(input.url, MCP_LIMITS.url, "地址");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("地址不对：要写完整的 http:// 或 https:// 地址");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("地址只能是 http:// 或 https://");
  return { name, description, type, url, env: [], headers: cleanPairs(input.headers, prev?.headers ?? [], "请求头"), ask };
}

export function createMcp(owner: string, input: McpInput): McpServer {
  if (listMcp(owner).length >= MCP_LIMITS.perUser) throw new Error(`每人最多 ${MCP_LIMITS.perUser} 个 MCP`);
  const now = Date.now();
  const server: McpServer = { id: `m_${crypto.randomBytes(6).toString("hex")}`, owner, ...validate(owner, input), createdAt: now, updatedAt: now };
  load().push(server);
  save();
  mcpEvents.emit("changed", owner, server.id);
  return server;
}

export function updateMcp(owner: string, id: string, input: McpInput): McpServer {
  const list = load();
  const idx = list.findIndex((s) => s.id === id && s.owner === owner);
  if (idx < 0) throw new Error("这个 MCP 不存在");
  const prev = list[idx]!;
  const next: McpServer = { ...prev, ...validate(owner, input, prev), updatedAt: Date.now() };
  list[idx] = next;
  save();
  mcpEvents.emit("changed", owner, id);
  return next;
}

export function deleteMcp(owner: string, id: string): void {
  const list = load();
  const idx = list.findIndex((s) => s.id === id && s.owner === owner);
  if (idx < 0) throw new Error("这个 MCP 不存在");
  list.splice(idx, 1);
  save();
  mcpEvents.emit("changed", owner, id);
}

export function purgeUserMcp(owner: string): void {
  const list = load();
  const kept = list.filter((s) => s.owner !== owner);
  if (kept.length === list.length) return;
  cache = kept;
  save();
}

/** 网页上看的样子：密钥不回显 */
export function mcpView(s: McpServer) {
  const pairs = (list: McpPair[]) => list.map((p) => (p.secret ? { name: p.name, secret: true, set: p.value !== "" } : { name: p.name, value: p.value, secret: false }));
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    type: s.type,
    ...(s.type === "stdio" ? { command: s.command ?? "", args: s.args ?? [], env: pairs(s.env) } : { url: s.url ?? "", headers: pairs(s.headers) }),
    ask: s.ask,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export function specOf(s: McpServer): McpSpec {
  return s.type === "stdio"
    ? { type: "stdio", command: s.command ?? "", args: s.args ?? [], env: Object.fromEntries(s.env.map((p) => [p.name, p.value])) }
    : { type: "http", url: s.url ?? "", headers: Object.fromEntries(s.headers.filter((p) => p.value !== "").map((p) => [p.name, p.value])) };
}

// ---------- 机器上原有的 ----------

/**
 * Claude 机器级（用户范围）的 MCP：~/.claude.json 顶层的 mcpServers（设了 CLAUDE_CONFIG_DIR 就在那下面）。
 * 项目范围、插件带的不列。只认 stdio / http / sse 三种。
 */
export function claudeMachineMcp(): Record<string, McpSpec | { type: "sse"; url: string; headers: Record<string, string> }> {
  const dir = process.env.CLAUDE_CONFIG_DIR || os.homedir();
  const raw = readJson<{ mcpServers?: Record<string, Record<string, unknown>> }>(path.join(dir, ".claude.json"), {});
  const out: Record<string, McpSpec | { type: "sse"; url: string; headers: Record<string, string> }> = {};
  for (const [name, cfg] of Object.entries(raw.mcpServers ?? {})) {
    if (!cfg || typeof cfg !== "object" || RESERVED.has(name)) continue;
    const headers = (cfg.headers && typeof cfg.headers === "object" ? cfg.headers : {}) as Record<string, string>;
    if ((cfg.type === "http" || cfg.type === "sse") && typeof cfg.url === "string") {
      out[name] = { type: cfg.type, url: cfg.url, headers };
    } else if (typeof cfg.command === "string") {
      out[name] = {
        type: "stdio",
        command: cfg.command,
        args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
        env: (cfg.env && typeof cfg.env === "object" ? cfg.env : {}) as Record<string, string>,
      };
    }
  }
  return out;
}

export function isMachineId(id: string): boolean {
  return id.startsWith(MACHINE_PREFIX);
}

export function machineName(id: string): string {
  return id.slice(MACHINE_PREFIX.length);
}
