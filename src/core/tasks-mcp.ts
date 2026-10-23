// 定时任务工具的 MCP 服务（mcp/tasks-server.ts）怎么拉起：Claude 和 Codex 的配置共用这一份。
//
// 和记忆工具不同，它自己不碰数据文件：每次工具调用都经本机的 unix socket 转给主进程（tasks-bridge.ts）——
// 调度器在主进程里（新建的任务要马上排进去），创建 / 修改前要弹授权卡，也只有主进程弹得出来。
//
// 是谁、在哪条对话里，由拉起时的环境变量定死，并带着主进程签的名：工具参数里没有用户，
// 子进程也伪造不了别人的身份（密钥只在主进程内存里，每次启动换一个）。
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { home } from "../home.js";
import { tsxLoader, type StdioSpawn } from "./memory-mcp.js";

export const TASKS_MCP_NAME = "agent_loft_tasks";

const serverPath = fileURLToPath(new URL("../mcp/tasks-server.ts", import.meta.url));

/** unix socket 路径有长度限制（macOS 104 字节）：家目录太深就放到临时目录 */
export const tasksSocketPath = (() => {
  const inHome = path.join(home, "run", "tasks.sock");
  if (inHome.length < 100) return inHome;
  const tag = crypto.createHash("sha256").update(home).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), `agent-loft-${tag}.sock`);
})();

const secret = crypto.randomBytes(32);

export function signTaskCaller(userId: string, convKey: string): string {
  return crypto.createHmac("sha256", secret).update(`${userId}\n${convKey}`).digest("hex");
}

export function verifyTaskCaller(userId: string, convKey: string, sig: string): boolean {
  const want = Buffer.from(signTaskCaller(userId, convKey), "hex");
  const got = Buffer.from(String(sig), "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export function tasksMcpSpawn(userId: string, convKey: string, via: string): StdioSpawn {
  return {
    command: process.execPath,
    args: ["--import", tsxLoader, serverPath],
    env: {
      AGENT_LOFT_TASKS_SOCKET: tasksSocketPath,
      AGENT_LOFT_TASKS_USER: userId,
      AGENT_LOFT_TASKS_CONV: convKey,
      AGENT_LOFT_TASKS_SIG: signTaskCaller(userId, convKey),
      AGENT_LOFT_TASKS_VIA: via,
      AGENT_LOFT_TZ: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    },
  };
}

/** 工具调用最多等多久（含等用户点授权卡）。Codex 默认 60 秒就超时，要显式放宽 */
export const TASK_TOOL_TIMEOUT_SEC = 20 * 60;
