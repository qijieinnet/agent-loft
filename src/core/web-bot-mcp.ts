import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { Agent, fetch as fetchMcp } from "undici";
import ipaddr from "ipaddr.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebBotError } from "./web-bots.js";
import type { Connection, ToolSpec } from "./web-bot-extensions.js";

const localDenied = () => new WebBotError(403, "本机进程和内网地址需要由管理员连接。");

async function withClient<T>(config: Connection, signal: AbortSignal, access: () => boolean,
  operation: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "agent-loft-web-bot", version: "1" });
  let agent: Agent | undefined, http: StreamableHTTPClientTransport | undefined;
  try {
    const admin = access();
    signal.throwIfAborted();
    let transport;
    if (config.kind === "stdio") {
      if (!admin) throw localDenied();
      transport = new StdioClientTransport({ command: config.endpoint, args: config.args, cwd: tmpdir(),
        env: config.secret ? JSON.parse(config.secret) : {}, stderr: "ignore", maxBufferSize: 1024 * 1024 });
    } else {
      const url = new URL(config.endpoint);
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const address = isIP(host) ? host : (await lookup(host)).address;
      const restricted = url.protocol !== "https:" || ipaddr.process(address).range() !== "unicast";
      if (restricted && !admin) throw localDenied();
      // Keep TLS verification against the original hostname while pinning the address we checked.
      const family = isIP(address);
      agent = new Agent({ maxResponseSize: 1024 * 1024, connect: { lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      } } });
      http = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: config.secret ? { Authorization: "Bearer " + config.secret } : {}, redirect: "error" },
        fetch: async (target, init) => {
          const adminNow = access();
          if (new URL(target).href !== url.href || (restricted && !adminNow)) throw localDenied();
          const response = await fetchMcp(target, {
            dispatcher: agent, redirect: "error", method: init?.method,
            headers: Object.fromEntries(new Headers(init?.headers)),
            body: typeof init?.body === "string" ? init.body : undefined,
            signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
          });
          return new Response(response.body, { status: response.status, headers: Object.fromEntries(response.headers) });
        },
      });
      transport = http;
    }
    signal.throwIfAborted();
    await client.connect(transport, { signal });
    if (!access() && config.kind === "stdio") throw localDenied();
    signal.throwIfAborted();
    return await operation(client);
  } catch (err) {
    if (err instanceof WebBotError) throw err;
    throw new WebBotError(502, "MCP 请求未完成，请检查连接、凭据和服务状态。");
  } finally {
    if (http?.sessionId && !signal.aborted) await http.terminateSession().catch(() => {});
    await client.close().catch(() => {});
    await agent?.destroy();
  }
}

export async function listTools(config: Connection, access: () => boolean): Promise<ToolSpec[]> {
  const signal = AbortSignal.timeout(15000);
  return withClient(config, signal, access, async client => {
    const tools: ToolSpec[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools({ cursor }, { signal });
      for (const { name, description, inputSchema } of page.tools) {
        if (tools.length >= 256 || name.length > 128 || JSON.stringify(inputSchema).length > 24000)
          throw new WebBotError(422, "工具数量或参数说明超出限制。");
        tools.push({ name, description: description?.slice(0, 1000) ?? "", inputSchema });
      }
      cursor = page.nextCursor;
      if (cursor && (seen.has(cursor) || seen.size >= 64)) throw new WebBotError(502, "MCP 工具分页无效。");
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (JSON.stringify(tools).length > 256000) throw new WebBotError(422, "此连接的工具清单过大。");
    return tools;
  });
}

export async function callTool(config: Connection, name: string, args: Record<string, unknown>, turnSignal: AbortSignal, access: () => boolean, beforeDispatch: () => void) {
  const signal = AbortSignal.any([turnSignal, AbortSignal.timeout(30000)]);
  return withClient(config, signal, access, async client => {
    beforeDispatch();
    const result = await client.callTool({ name, arguments: args }, undefined, { signal });
    const content = Array.isArray(result.content) ? result.content.flatMap(item => item.type === "text" ? [item.text] : []) : [];
    let text = content.length ? content.join("\n") : JSON.stringify(result.structuredContent ?? {});
    const secrets: string[] = config.kind === "stdio" ? Object.values(JSON.parse(config.secret || "{}")) : [config.secret];
    for (const secret of secrets) if (secret) text = text.replaceAll(secret, "[已隐藏]");
    return { isError: !!result.isError, text: text.slice(0, 12000), truncated: text.length > 12000 };
  });
}
