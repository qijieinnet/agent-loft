import { isIP } from "node:net";

export async function verifyUpgradeWeb(host: string, port: number): Promise<void> {
  if (host === "0.0.0.0") host = "127.0.0.1";
  if (host === "::") host = "::1";
  const base = `http://${isIP(host) === 6 ? "[" + host + "]" : host}:${port}`;
  async function get(url: string, type: RegExp): Promise<Response> {
    const res = await fetch(base + url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (res.status !== 200 || !type.test(res.headers.get("content-type") || "")) {
      throw new Error(`${url} 响应异常（HTTP ${res.status}）`);
    }
    return res;
  }
  const html = await (await get("/", /text\/html/)).text();
  for (const [file, type] of [["app.js", /javascript/], ["css/base.css", /text\/css/]] as const) {
    const asset = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].find(([, url]) => url?.endsWith("/" + file))?.[1];
    if (!asset || !(await (await get(asset, type)).text()).trim()) throw new Error(`网页资源缺失：${file}`);
  }
  const me = await (await get("/api/me", /application\/json/)).json();
  if (!me || typeof me !== "object" || !("authed" in me) || typeof me.authed !== "boolean") throw new Error("/api/me 响应异常");
}
