// Web 服务监听在哪个地址、哪个端口，以及不重启进程就换地址。
//
// http.Server 自己不 listen，由一个 net.Server 收连接再交给它（emit "connection"）。
// 这样换地址时可以先在新地址上监听成功、再关掉旧的监听：
//   - 新端口被占用 / 没权限：直接报错，旧的照常工作，配置也不改；
//   - 已经连着的页面、WebSocket 属于 http.Server，关掉旧监听不影响它们（只是不再接新连接）。
import net from "node:net";
import os from "node:os";
import type http from "node:http";

let target: http.Server | null = null;
let listener: net.Server | null = null;
let bound: { host: string; port: number } | null = null;

/** 只有本机能连的地址 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\./.test(h);
}

/** 这条连接是不是从本机来的（直连本机，或者经由本机上的反代 / 隧道） */
export function fromThisMachine(remote: string | undefined): boolean {
  if (!remote) return false;
  return isLoopbackHost(remote.replace(/^::ffff:/, ""));
}

function open(host: string, port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((socket) => target?.emit("connection", socket));
    const onError = (err: NodeJS.ErrnoException) => {
      srv.close();
      if (err.code === "EADDRINUSE") reject(new Error(`端口 ${port} 已经被别的程序占用了`));
      else if (err.code === "EACCES") reject(new Error(`没有权限监听端口 ${port}（1024 以下的端口一般需要管理员权限）`));
      else if (err.code === "EADDRNOTAVAIL") reject(new Error(`这台机器上没有地址 ${host}`));
      else reject(err);
    };
    srv.once("error", onError);
    srv.listen(port, host, () => {
      srv.off("error", onError);
      srv.on("error", (err) => console.error("[web] 监听出错:", err));
      resolve(srv);
    });
  });
}

/**
 * 关掉监听。不等 close 的回调：它要等这个监听接过的所有连接都断开才回调，
 * 而连接已经交给 http.Server 了（包括正在请求改地址的这一条），等它会卡死。
 */
function shut(srv: net.Server): void {
  srv.close();
}

/** 刚关掉的端口要等一下才真正放出来：被占用就稍等重试几次 */
async function openRetry(host: string, port: number): Promise<net.Server> {
  for (let i = 0; ; i++) {
    try {
      return await open(host, port);
    } catch (err) {
      if (i >= 20 || !String((err as Error).message).includes("占用")) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/** 启动时第一次监听 */
export async function listen(server: http.Server, host: string, port: number): Promise<void> {
  target = server;
  listener = await open(host, port);
  bound = { host, port };
}

/** 换到新的地址 / 端口：新的监听成功了才关旧的；失败抛出能直接给人看的错误 */
export async function rebind(host: string, port: number): Promise<void> {
  if (!target) throw new Error("Web 服务没有在运行");
  if (bound && bound.host === host && bound.port === port) return;
  const old = listener;
  // 同一个端口只换地址（比如 0.0.0.0 → 127.0.0.1）：两个监听会冲突，只能先关旧的；
  // 新的失败了再把旧的开回来
  if (old && bound?.port === port) {
    const prev = bound;
    shut(old);
    try {
      listener = await openRetry(host, port);
    } catch (err) {
      listener = await openRetry(prev.host, prev.port);
      throw err;
    }
  } else {
    listener = await open(host, port);
    if (old) shut(old);
  }
  bound = { host, port };
  console.log(`[web] 已改为监听 http://${host}:${port}`);
}

export function listening(): { host: string; port: number } | null {
  return bound;
}

export function closeListener(): void {
  const l = listener;
  listener = null;
  bound = null;
  target = null;
  if (l) shut(l);
}

/** 这台机器在局域网里的 IPv4 地址（给设置页显示「其他设备用这个地址访问」） */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      // 169.254：没拿到地址时的自分配地址；198.18/15：Clash、Surge 等代理软件虚拟网卡用的，都不是真的局域网地址
      if (a.family !== "IPv4" || a.internal || /^169\.254\.|^198\.1[89]\./.test(a.address)) continue;
      out.push(a.address);
    }
  }
  return [...new Set(out)];
}
