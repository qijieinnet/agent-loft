// 「探针」query：拉一个从不发消息的 CLI 进程，只用来问控制请求（额度、模型列表），问完就关。
//
// 这些控制方法挂在 Query 上，正常要借活会话才能问；但 /status、设置页不该依赖
// 「当前恰好有活会话」。不发消息就不耗 token，代价只是起一次进程（两三秒）。
import os from "node:os";
import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { agentEnvironment } from "../../core/agent-env.js";

/** 永远不产出消息的输入流：query 必须是流式输入模式才能发控制请求 */
async function* silence(): AsyncGenerator<SDKUserMessage> {
  await new Promise<never>(() => {});
}

/** cwd 会影响项目级的东西（.claude/commands、项目 skills），不关心就用家目录 */
export async function withProbe<T>(fn: (q: Query) => Promise<T>, cwd = os.homedir()): Promise<T> {
  const q = query({ prompt: silence(), options: { cwd, env: agentEnvironment() } });
  try {
    return await fn(q);
  } finally {
    q.close();
  }
}

/**
 * 带缓存、并发合并的读取：同一时刻多个调用方共用一次探针，结果缓存 ttl 毫秒。
 * 给了 fallback 就是「读不到也无所谓」：失败记日志、返回并缓存 fallback，免得每次都再等几秒；
 * 没给就把错误抛给调用方，也不缓存，下次重试。
 */
export function cachedProbe<T>(
  ttl: number,
  what: string,
  fetch: () => Promise<T>,
  ...fallback: [] | [T]
): () => Promise<T> {
  let cache: { at: number; value: T } | null = null;
  let inflight: Promise<T> | null = null;
  return () => {
    if (cache && Date.now() - cache.at < ttl) return Promise.resolve(cache.value);
    inflight ??= fetch()
      .catch((err) => {
        console.error(`[${what}] 读取失败:`, err instanceof Error ? err.message : err);
        if (fallback.length === 0) throw err;
        return fallback[0] as T;
      })
      .then((value) => {
        cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}
