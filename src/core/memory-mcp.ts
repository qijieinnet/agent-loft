// 怎么拉起记忆工具的 MCP 服务（mcp/memory-server.ts）：Claude 和 Codex 的配置共用这一份。
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { home } from "../home.js";

/** MCP 服务名。Claude 里工具全名是 mcp__<名>__remember，Codex 里按它自己的规则拼 */
export const MEMORY_MCP_NAME = "agent_loft_memory";

const serverPath = fileURLToPath(new URL("../mcp/memory-server.ts", import.meta.url));

/** tsx 的 ESM loader：源码是 TypeScript，子进程和主进程一样靠它直接跑 */
const tsxLoader = (() => {
  const require = createRequire(import.meta.url);
  // tsx/esm 的导出只有 import 条件，require.resolve 解不到；从包目录拼出来
  const pkg = require.resolve("tsx/package.json");
  return new URL("./dist/esm/index.mjs", `file://${pkg}`).href;
})();

export type StdioSpawn = { command: string; args: string[]; env: Record<string, string> };

/**
 * via：日志里标一下是哪个 agent 在写（方便排查），不影响写给谁。
 * search：给不给 search_past_chats；convKey：当前这条对话，搜索时跳过它（它本来就在上下文里）。
 */
export function memoryMcpSpawn(userId: string, via: string, opts: { search?: boolean; convKey?: string } = {}): StdioSpawn {
  return {
    command: process.execPath,
    args: ["--import", tsxLoader, serverPath],
    env: {
      AGENT_LOFT_HOME: home,
      AGENT_LOFT_MEMORY_USER: userId,
      AGENT_LOFT_MEMORY_VIA: via,
      ...(opts.search ? { AGENT_LOFT_MEMORY_SEARCH: "1" } : {}),
      ...(opts.convKey ? { AGENT_LOFT_MEMORY_CONV: opts.convKey } : {}),
    },
  };
}
