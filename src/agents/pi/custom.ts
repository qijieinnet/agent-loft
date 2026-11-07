// pi 的自定义服务商：data/pi/models.json 里的 providers（本地的 Ollama / LM Studio / vLLM / llama.cpp、
// one-api 之类的 OpenAI 兼容网关、自己部署的 Anthropic 兼容代理……）。格式见 pi 文档 models-configuration.md。
//
// 这份文件归 agent-loft 管（网页上增删改），0600。Key 按字面值写进去：pi 会把 apiKey 里的 $NAME 当环境变量、
// 开头的 ! 当 shell 命令执行，所以写之前转义（$ → $$，开头的 ! → $!），网页上填什么就是什么。
// 网页上不回显 Key，只告诉有没有。
import { modelRuntime, MODELS_FILE } from "./sdk.js";
import { readJson, writeJsonAtomic } from "../../home.js";

export const CUSTOM_APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;
export type CustomApi = (typeof CUSTOM_APIS)[number];

export type CustomModel = { id: string; name?: string; reasoning?: boolean; input?: ("text" | "image")[]; contextWindow?: number; maxTokens?: number };

export type CustomProviderView = {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  hasKey: boolean;
  models: CustomModel[];
};

export type CustomProviderInput = {
  id: string;
  name?: string;
  baseUrl: string;
  api: string;
  /** 不给 = 沿用原来的；空字符串 = 不用 Key（本地服务） */
  apiKey?: string;
  models: CustomModel[];
};

type FileProvider = { name?: string; baseUrl?: string; api?: string; apiKey?: string; models?: CustomModel[]; [k: string]: unknown };
type ModelsFile = { providers?: Record<string, FileProvider>; [k: string]: unknown };

/** 不需要 Key 的本地服务也得填个值，pi 才认为这个服务商「能用」 */
const NO_KEY = "agent-loft-no-key";

/** 字面值 → pi 配置值：不让 $ 变成环境变量、开头的 ! 变成命令 */
export function escapeConfigValue(value: string): string {
  const v = value.replace(/\$/g, "$$$$");
  return v.startsWith("!") ? `$${v}` : v;
}

function readFile(): ModelsFile {
  const v = readJson<ModelsFile>(MODELS_FILE, {});
  return v && typeof v === "object" ? v : {};
}

export function listCustom(): CustomProviderView[] {
  return Object.entries(readFile().providers ?? {})
    .filter(([, p]) => p && typeof p === "object" && typeof p.baseUrl === "string" && Array.isArray(p.models))
    .map(([id, p]) => ({
      id,
      name: p.name || id,
      baseUrl: p.baseUrl!,
      api: p.api ?? "",
      hasKey: typeof p.apiKey === "string" && p.apiKey !== NO_KEY && p.apiKey !== "",
      models: (p.models ?? []).filter((m) => m && typeof m.id === "string"),
    }));
}

function cleanModels(models: unknown): CustomModel[] {
  if (!Array.isArray(models) || models.length === 0) throw new Error("至少填一个模型");
  if (models.length > 200) throw new Error("模型最多 200 个");
  const seen = new Set<string>();
  const out: CustomModel[] = [];
  for (const raw of models as Record<string, unknown>[]) {
    const id = typeof raw?.id === "string" ? raw.id.trim() : "";
    if (!id || id.length > 200 || /\s/.test(id)) throw new Error(`模型 id 不对：${String(raw?.id ?? "")}`);
    if (seen.has(id)) continue;
    seen.add(id);
    const m: CustomModel = { id };
    if (typeof raw.name === "string" && raw.name.trim()) m.name = raw.name.trim().slice(0, 100);
    if (raw.reasoning === true) m.reasoning = true;
    if (raw.image === true || (Array.isArray(raw.input) && raw.input.includes("image"))) m.input = ["text", "image"];
    const ctx = Number(raw.contextWindow);
    if (Number.isFinite(ctx) && ctx >= 1024 && ctx <= 10_000_000) m.contextWindow = Math.round(ctx);
    const max = Number(raw.maxTokens);
    if (Number.isFinite(max) && max >= 256 && max <= 1_000_000) m.maxTokens = Math.round(max);
    out.push(m);
  }
  return out;
}

export async function saveCustom(input: CustomProviderInput): Promise<void> {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) throw new Error("id 只能用小写字母、数字和 -，最长 41 个字符");
  const rt = await modelRuntime();
  const file = readFile();
  const providers = { ...(file.providers ?? {}) };
  const prev = providers[id];
  // 内置服务商不能在这里改（改了会盖掉它的模型目录）
  if (!prev && rt.getProvider(id)) throw new Error(`${id} 是 pi 内置的服务商，换个 id`);
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim().replace(/\/+$/, "") : "";
  if (!/^https?:\/\/[^\s]+$/i.test(baseUrl) || baseUrl.length > 500) throw new Error("地址要以 http:// 或 https:// 开头");
  if (!(CUSTOM_APIS as readonly string[]).includes(input.api)) throw new Error("接口类型不对");
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 60) : id;
  let apiKey: string;
  if (input.apiKey === undefined) apiKey = prev?.apiKey ?? NO_KEY;
  else if (typeof input.apiKey !== "string" || input.apiKey.length > 4096 || /\s/.test(input.apiKey.trim())) throw new Error("API Key 不能带空格");
  else apiKey = input.apiKey.trim() ? escapeConfigValue(input.apiKey.trim()) : NO_KEY;
  providers[id] = { name, baseUrl, api: input.api, apiKey, models: cleanModels(input.models) };
  writeJsonAtomic(MODELS_FILE, { ...file, providers });
  await rt.refresh({ allowNetwork: false });
}

export async function deleteCustom(id: string): Promise<void> {
  const file = readFile();
  if (!file.providers?.[id]) throw new Error("没有这个自定义服务商");
  const providers = { ...file.providers };
  delete providers[id];
  writeJsonAtomic(MODELS_FILE, { ...file, providers });
  await (await modelRuntime()).refresh({ allowNetwork: false });
}

/**
 * 问服务要模型列表（OpenAI 兼容的 GET /models，Ollama、LM Studio、vLLM、one-api 都有）。
 * key 不给就用已保存的（编辑时不用重新填）。只有管理员能调
 */
export async function discoverModels(baseUrl: string, api: string, key?: string, savedId?: string): Promise<string[]> {
  const url = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error("地址要以 http:// 或 https:// 开头");
  let secret = key?.trim() || "";
  if (!secret && savedId) {
    const saved = readFile().providers?.[savedId]?.apiKey;
    // 存的是转义过的字面值：还原（只有 agent-loft 写的这种格式）
    if (saved && saved !== NO_KEY) secret = saved.replace(/^\$!/, "!").replace(/\$\$/g, "$");
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (api === "anthropic-messages") {
    if (secret) headers["x-api-key"] = secret;
    headers["anthropic-version"] = "2023-06-01";
  } else if (api === "google-generative-ai") {
    if (secret) headers["x-goog-api-key"] = secret;
  } else if (secret) headers.authorization = `Bearer ${secret}`;
  const res = await fetch(`${url}/models`, { headers, signal: AbortSignal.timeout(10_000), redirect: "error" });
  if (!res.ok) throw new Error(`服务返回 ${res.status}`);
  const body = (await res.json()) as { data?: { id?: unknown }[]; models?: { id?: unknown; name?: unknown }[] };
  const ids = [
    ...(body.data ?? []).map((m) => m?.id),
    ...(body.models ?? []).map((m) => (typeof m?.id === "string" ? m.id : typeof m?.name === "string" ? m.name.replace(/^models\//, "") : undefined)),
  ].filter((v): v is string => typeof v === "string" && !!v.trim());
  return [...new Set(ids)].slice(0, 200);
}
