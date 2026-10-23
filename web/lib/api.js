import { showAuth } from "../views/auth.js";

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    credentials: "same-origin",
    headers: opts.body !== undefined && !(opts.body instanceof Blob) ? { "Content-Type": "application/json" } : opts.headers,
    body: opts.body === undefined ? undefined : opts.body instanceof Blob ? opts.body : JSON.stringify(opts.body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // 没有 body
  }
  if (res.status === 401 && !path.startsWith("/api/me") && !path.startsWith("/api/login")) {
    showAuth();
    throw new Error("请先登录");
  }
  if (!res.ok) {
    const err = new Error(data?.error ?? `请求失败（${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return data;
}
