// 与 `codex app-server` 的 JSON-RPC 连接：一个进程，多条 thread。
//
// 这是整个im-agent的地基。
//
// 为什么不用官方的 @openai/codex-sdk：它是 `codex exec --json` 的薄封装，
// 事件流够用，但**没有任何审批回调** —— approvalPolicy 只是个启动参数，
// 没有地方接住「Codex 想跑这条命令，准不准」。用它做出来的东西没有卡片授权。
// app-server 才是 Codex 桌面版和 IDE 插件走的那条路：服务端能反过来向我们
// 发起请求，审批和提问都从那儿来。
//
// 为什么一个进程带多条 thread：app-server 的每条消息都带 threadId，天然是
// 多路复用的。给每条飞书会话各拉一个进程也能跑，但那样一个群开几个话题就是
// 几个常驻进程；共用一个进程只需要自己按 threadId 分发，便宜得多。
// 代价是单点故障，由下面的自动重连 + onRestart 兜住。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { config } from "../../core/config.js";
import { agentEnvironment } from "../../core/agent-env.js";
import type { Incoming, InitializeResult, RequestId } from "./protocol.js";
import { UnsupportedRequest } from "./refusals.js";

/** 服务端反过来向我们发起的请求。返回值会作为 result 回给它。 */
export type ServerRequestHandler = (
  method: string,
  params: unknown,
) => Promise<unknown>;

export type NotificationHandler = (method: string, params: unknown) => void;

/** 连接被重建时通知上层：挂着的 thread 需要重新 resume。 */
export type RestartHandler = (reason: string) => void;

const CLIENT_INFO = {
  name: "im-agent",
  title: "im-agent",
  version: "0.1.0",
};

/** stderr 只留最后这么多行，用来给错误诊断当线索，不无限占内存。 */
const STDERR_KEEP = 40;

export class AppServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 0;
  private readonly pending = new Map<
    RequestId,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly restartHandlers = new Set<RestartHandler>();
  private serverRequestHandler: ServerRequestHandler | null = null;
  private ready: Promise<InitializeResult> | null = null;
  private recentStderr: string[] = [];
  private stopping = false;
  /** 连续拉起失败的次数，用来退避，避免 codex 装坏时疯狂重启刷屏。 */
  private consecutiveFailures = 0;

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  /** 进程一退出就通知（不等重连成功）：在途的轮次得立刻收尾，不能一直显示忙 */
  private readonly exitHandlers = new Set<(reason: string) => void>();

  onExit(handler: (reason: string) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  onRestart(handler: RestartHandler): () => void {
    this.restartHandlers.add(handler);
    return () => this.restartHandlers.delete(handler);
  }

  /** 只能有一个：审批和提问都从这儿进来，分发由上层按 threadId 做。 */
  setServerRequestHandler(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  /** 最近的 stderr，出错时拿去做诊断。 */
  stderrTail(): string {
    return this.recentStderr.join("\n");
  }

  /** 拉起并完成握手。重复调用返回同一个 promise。 */
  start(): Promise<InitializeResult> {
    this.ready ??= this.spawnAndInitialize().catch((err) => {
      // 握手失败要把 promise 清掉，否则这个连接永远是坏的，重试也拿到同一个 rejected
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  private async spawnAndInitialize(): Promise<InitializeResult> {
    const child = spawn(config().agents.codex.path, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...agentEnvironment(),
        ...((config().agents.codex.home || undefined) ? { CODEX_HOME: (config().agents.codex.home || undefined) } : {}),
      },
    });
    this.child = child;
    this.recentStderr = [];

    // 逐行读 JSONL。app-server 的一帧可能很大（整个 turn 的 items），
    // readline 没有行长上限，够用。
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      this.handleLine(line);
    });

    readline.createInterface({ input: child.stderr }).on("line", (line) => {
      this.recentStderr.push(line);
      if (this.recentStderr.length > STDERR_KEEP) this.recentStderr.shift();
      // codex 自己的 tracing 日志噪音很大，只把明显的错误抬到我们的日志里
      if (/\bERROR\b|^Error:/.test(line)) console.error(`[codex] ${line}`);
    });

    child.on("exit", (code, signal) => this.handleExit(code, signal));
    child.on("error", (err) => {
      // spawn 本身失败（找不到 codex）：这条路径上 exit 不一定会来
      this.failAllPending(new Error(`无法启动 ${config().agents.codex.path}: ${err.message}`));
    });

    const result = (await this.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: null,
    })) as InitializeResult;

    // 握手的第二拍。少了它，服务端会一直当我们还没准备好。
    this.notify("initialized", {});
    this.consecutiveFailures = 0;
    return result;
  }

  private handleLine(line: string): void {
    let frame: Incoming;
    try {
      frame = JSON.parse(line) as Incoming;
    } catch {
      // 不是 JSON 的行只可能是 codex 往 stdout 漏的东西，忽略但留个痕
      console.warn(`[codex] stdout 收到非 JSON 行: ${line.slice(0, 200)}`);
      return;
    }

    // 三种帧靠 id / method 的有无区分：
    //   有 id 有 method → 服务端向我们发起的请求（审批、提问）
    //   有 id 无 method → 对我们某个请求的响应
    //   无 id 有 method → 通知
    if (frame.id !== undefined && frame.method) {
      void this.handleServerRequest(frame.id, frame.method, frame.params);
      return;
    }
    if (frame.id !== undefined) {
      const waiter = this.pending.get(frame.id);
      if (!waiter) return;
      this.pending.delete(frame.id);
      if (frame.error) waiter.reject(new Error(frame.error.message));
      else waiter.resolve(frame.result);
      return;
    }
    if (frame.method) {
      for (const handler of this.notificationHandlers) {
        try {
          handler(frame.method, frame.params);
        } catch (err) {
          console.error("[codex] 通知处理出错:", err);
        }
      }
    }
  }

  /**
   * 服务端请求必须**永远**回一帧。
   *
   * 漏回一次，Codex 那一轮就永远卡在等待上 —— 表现是聊天这边彻底没反应，而且
   * 看不出哪儿坏了。所以无论如何都要应答。
   *
   * 但「随便回点什么」也不行：每种请求的响应结构不一样（审批要 `decision`，
   * MCP 的 elicitation 要 `action`），回错结构等于没回。所以答不上来的时候走
   * JSON-RPC 的 error 通道 —— 明确说不支持，好过编一个形状让对端去猜。
   */
  private async handleServerRequest(
    id: RequestId,
    method: string,
    params: unknown,
  ): Promise<void> {
    if (!this.serverRequestHandler) {
      console.warn(`[codex] 没有处理器，自动拒绝服务端请求 ${method}`);
      this.sendError(id, -32601, `im-agent未就绪，无法处理 ${method}`);
      return;
    }
    try {
      const result = await this.serverRequestHandler(method, params);
      this.send({ jsonrpc: "2.0", id, result });
    } catch (err) {
      const unsupported = err instanceof UnsupportedRequest;
      if (!unsupported) {
        console.error(`[codex] 处理服务端请求 ${method} 出错:`, err);
      }
      this.sendError(
        id,
        unsupported ? -32601 : -32603,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private sendError(id: RequestId, code: number, message: string): void {
    try {
      this.send({ jsonrpc: "2.0", id, error: { code, message } });
    } catch (err) {
      console.error("[codex] 连错误响应都发不出去:", err);
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const why = `codex app-server 退出（code=${code ?? "null"} signal=${signal ?? "null"}）`;
    this.child = null;
    this.ready = null;
    this.failAllPending(new Error(why));
    for (const handler of this.exitHandlers) {
      try {
        handler(why);
      } catch (err) {
        console.error("[codex] 退出回调出错:", err);
      }
    }

    if (this.stopping) return;

    this.consecutiveFailures += 1;
    // 退避到最多 30 秒：codex 装坏时（比如二进制缺失）无脑重启只会刷屏
    const delay = Math.min(1000 * 2 ** (this.consecutiveFailures - 1), 30_000);
    console.error(`[codex] ${why}，${delay / 1000}s 后重连`);
    const timer = setTimeout(() => {
      this.start()
        .then(() => {
          console.log("[codex] app-server 已重新拉起");
          for (const handler of this.restartHandlers) handler(why);
        })
        .catch((err) => console.error("[codex] 重连失败:", err));
    }, delay);
    timer.unref?.();
  }

  private failAllPending(err: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
  }

  private send(frame: unknown): void {
    const child = this.child;
    if (!child?.stdin.writable) {
      throw new Error("codex app-server 未运行");
    }
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  /**
   * 发一个请求并等响应。
   *
   * 带超时：进程活着却不响应时，不能让调用方（以及排在它后面的整条会话操作队列）
   * 永远等下去。turn/start 的响应只是「轮次已开始」，同样很快返回，不需要例外。
   */
  request(method: string, params?: unknown, timeoutMs = 60_000): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`codex app-server 在 ${timeoutMs / 1000} 秒内没有响应 ${method}`));
      }, timeoutMs);
      timer.unref?.();
      const done = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => {
        clearTimeout(timer);
        fn(...args);
      };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    try {
      this.send({ jsonrpc: "2.0", method, params });
    } catch (err) {
      console.error(`[codex] 通知 ${method} 发送失败:`, err);
    }
  }

  /** 确保连接可用后再发请求。 */
  async call<T>(method: string, params?: unknown): Promise<T> {
    await this.start();
    return (await this.request(method, params)) as T;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.child?.kill();
    this.child = null;
    this.ready = null;
  }

  /** 配置（codex 路径 / CODEX_HOME）变了：杀掉重拉，挂着的 thread 通过 onRestart 重新 resume。 */
  async restart(reason: string): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    this.ready = null;
    // 旧进程的 exit 不能再触发自动重连，否则会把新拉起的连接冲掉
    child?.removeAllListeners("exit");
    child?.kill();
    this.failAllPending(new Error(reason));
    // 主动重启同样是「旧连接失效」：在途轮次要收尾、thread 要标记为待恢复
    for (const handler of this.exitHandlers) {
      try {
        handler(reason);
      } catch (err) {
        console.error("[codex] 退出回调出错:", err);
      }
    }
    this.stopping = false;
    await this.start();
    for (const handler of this.restartHandlers) handler(reason);
  }

  get running(): boolean {
    return !!this.child;
  }
}

/**
 * 全局唯一的连接。
 *
 * 所有会话共用它，thread 之间靠 threadId 区分。单点故障由上面的自动重连
 * 和 onRestart 兜住：thread 是落在 ~/.codex/sessions 里的，重连后 resume 回来
 * 就行，上下文不丢。
 */
export const appServer = new AppServer();
