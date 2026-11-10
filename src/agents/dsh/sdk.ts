// DeepSeek Harness（dsh，@deepseek-ai/dsh）：怎么拉起、数据在哪、模型 id 怎么换算。
//
// dsh 是全局装的 npm 命令（npm i -g @deepseek-ai/dsh），不随 agent-loft 安装。数据都在 DSH_HOME（默认 ~/.dsh）：
//   .credentials.yaml          凭据（DEEPSEEK_API_KEY 等，dsh web 里填的）
//   sessions/<目录编码>/<会话 id>/session.v4.jsonl.zstd   会话记录（见 history.ts）
//   profiles/acp/              ACP profile，第一次用时 dsh 自己从模板建
//
// 每个会话一个 `dsh --profile acp` 进程。按会话不同的东西都在启动时给：
//   DSH_PERMISSION_MODE   沙箱档位（read-only / workspace-write / danger-full-access），见 modeOf
//   --patch <文件>         追加的系统提示（system-prompt.personaSuffix）、成员不加载机器技能
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentEnvironment } from "../../core/agent-env.js";
import { config } from "../../core/config.js";
import type { PermissionLevel } from "../../core/permission.js";
import type { ModelInfo } from "../../core/types.js";
import { dataDir } from "../../home.js";
import { AcpConnection, flatOptions, initialize, type AcpSpawn, type ConfigOption } from "./acp.js";

export function dshHome(): string {
  const c = config().agents.dsh;
  return c.home || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

export function sessionsRoot(): string {
  return path.join(dshHome(), "sessions");
}

/** 级别 → dsh 的权限预设。不给 = dsh 默认（工作区可写，越界才问） */
export function modeOf(level: PermissionLevel | undefined, plan?: boolean): "read-only" | "workspace-write" | "danger-full-access" {
  if (plan || level === "ask") return "read-only";
  if (level === "full") return "danger-full-access";
  return "workspace-write";
}

/** 每个进程的 --patch 文件放这里，进程退了就删 */
const PATCH_DIR = path.join(dataDir, "dsh");

export type LaunchSpec = {
  cwd: string;
  mode: ReturnType<typeof modeOf>;
  /** 追加在 dsh 系统提示后面 */
  append?: string;
  /** 成员：不加载机器上的技能 */
  noMachineSkills?: boolean;
  env?: Record<string, string>;
};

/** 生成启动参数；返回的 cleanup 删掉临时 patch 文件 */
export function launchSpec(spec: LaunchSpec): { spawn: AcpSpawn; cleanup: () => void } {
  const c = config().agents.dsh;
  const args = ["--profile", "acp"];
  if (c.patch) args.push("--patch", c.patch);
  // YAML 是 JSON 的超集，直接写 JSON，免得自己转义
  const entries: object[] = [];
  if (spec.append) {
    // personaSuffix 是模板，{{model}} 这类会被替换：拆开花括号
    const suffix = spec.append.replace(/\{\{/g, "{ {").replace(/\}\}/g, "} }");
    entries.push({ id: "system-prompt", config: { personaPrefix: "You are a coding agent powered by the {{model}} model.", personaSuffix: suffix } });
  }
  if (spec.noMachineSkills) entries.push({ id: "skill-filesystem", disabled: true });
  let file: string | undefined;
  if (entries.length) {
    fs.mkdirSync(PATCH_DIR, { recursive: true, mode: 0o700 });
    file = path.join(PATCH_DIR, `patch-${process.pid}-${crypto.randomBytes(6).toString("hex")}.yml`);
    fs.writeFileSync(file, JSON.stringify(entries, null, 2), { mode: 0o600 });
    args.push("--patch", file);
  }
  const env: NodeJS.ProcessEnv = {
    ...agentEnvironment(process.env),
    ...(spec.env ?? {}),
    DSH_PERMISSION_MODE: spec.mode,
    ...(c.home ? { DSH_HOME: c.home } : {}),
  };
  return {
    spawn: { command: c.path || "dsh", args, cwd: spec.cwd, env },
    cleanup: () => {
      if (file) fs.rmSync(file, { force: true });
    },
  };
}

/** 上次异常退出留下的 patch 文件 */
export function sweepPatches(): void {
  try {
    for (const n of fs.readdirSync(PATCH_DIR)) if (n.startsWith("patch-")) fs.rmSync(path.join(PATCH_DIR, n), { force: true });
  } catch {
    // 目录还没有
  }
}

// ---------- 模型 ----------

/** ACP 的模型选项值是 JSON 数组字符串 ["provider","model"]；agent-loft 里用 provider/model */
export function modelIdOf(value: string): string | undefined {
  try {
    const v = JSON.parse(value) as unknown;
    if (Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "string") return `${v[0]}/${v[1]}`;
  } catch {
    // 不是数组
  }
  return undefined;
}

export function modelValueOf(id: string): string {
  const i = id.indexOf("/");
  // 只写了模型名：按官方 DeepSeek 算
  return i < 0 ? JSON.stringify(["deepseek-official", id]) : JSON.stringify([id.slice(0, i), id.slice(i + 1)]);
}

/** 从 session/new 返回的配置选项里读出模型列表 */
export function modelsOf(opts: ConfigOption[]): ModelInfo[] {
  const model = opts.find((o) => o.id === "model");
  const effort = opts.find((o) => o.id === "reasoning_effort");
  const efforts = flatOptions(effort).map((o) => o.value);
  const out: ModelInfo[] = [];
  for (const o of flatOptions(model)) {
    const id = modelIdOf(o.value);
    if (!id) continue;
    out.push({
      id,
      label: o.name || id,
      ...(o.description ? { description: o.description } : {}),
      ...(efforts.length ? { efforts } : {}),
      ...(o.value === model?.currentValue ? { isDefault: true } : {}),
    });
  }
  return out;
}

/** 当前选中的模型 / 思考程度 */
export function runtimeOf(opts: ConfigOption[]): { model?: string; effort?: string } {
  const model = opts.find((o) => o.id === "model")?.currentValue;
  const effort = opts.find((o) => o.id === "reasoning_effort")?.currentValue;
  const id = model ? modelIdOf(model) : undefined;
  return { ...(id ? { model: id } : {}), ...(effort ? { effort } : {}) };
}

// ---------- 一次性的探测进程 ----------

/** 探测用的工作目录：建出来的会话事后删掉，不进会话列表 */
const PROBE_CWD = path.join(os.tmpdir(), "agent-loft-dsh-probe");

/**
 * 拉一个临时进程、建一个临时会话，交给 fn 用完就关、连会话记录一起删。
 * 模型列表、后台整理记忆都走这里（ACP 没有不建会话就能问的接口）
 */
export async function withProbe<T>(
  fn: (conn: AcpConnection, sessionId: string, options: ConfigOption[]) => Promise<T>,
  launch: Partial<LaunchSpec> = {},
): Promise<T> {
  fs.mkdirSync(PROBE_CWD, { recursive: true });
  const { spawn, cleanup } = launchSpec({ cwd: PROBE_CWD, mode: "read-only", ...launch });
  const conn = new AcpConnection(spawn);
  let sessionId: string | undefined;
  try {
    await initialize(conn);
    const res = await conn.request<{ sessionId: string; configOptions?: ConfigOption[] }>("session/new", { cwd: PROBE_CWD, mcpServers: [] });
    sessionId = res.sessionId;
    return await fn(conn, sessionId, res.configOptions ?? []);
  } finally {
    if (sessionId) await conn.request("session/close", { sessionId }).catch(() => {});
    await conn.shutdown(3000).catch(() => {});
    cleanup();
    if (sessionId) removeSession(sessionId);
  }
}

/** 删掉一条会话的记录目录（只给探测用的临时会话用） */
function removeSession(id: string): void {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) return;
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(sessionsRoot());
  } catch {
    return;
  }
  for (const d of dirs) {
    const dir = path.join(sessionsRoot(), d, id);
    if (!fs.existsSync(dir)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    // 探测目录下没别的会话了：目录也删掉
    try {
      fs.rmdirSync(path.join(sessionsRoot(), d));
    } catch {
      // 不空
    }
  }
}
