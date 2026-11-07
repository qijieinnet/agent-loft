// pi（earendil-works/pi，原 @mariozechner/pi-coding-agent）的官方 TypeScript SDK，进程内运行。
//
// pi 不是账号制，是「模型服务商」制：每家服务商一份凭据（API Key 或 OAuth），由 ModelRuntime 统一管。
// agent-loft 自己管这些凭据：所有东西都放在 data/pi/ 下，不读也不写机器上的 ~/.pi：
//   data/pi/auth.json     各服务商的凭据（pi 自己写，0600）
//   data/pi/models.json   自定义服务商 / 模型（可选，比如本地的 llama.cpp、OpenAI 兼容的网关）
//   data/pi/sessions/     会话记录（JSONL，一个会话一个文件，文件名以会话 id 结尾）
// 也认 agent-loft 服务进程的环境变量（DEEPSEEK_API_KEY 之类，pi 的规则）。
//
// SDK 依赖不少（TUI、wasm 图片处理……），按需 import：没启用 pi 的机器启动时不加载它。
// pi 1.x 要求 Node ≥ 22.19，比 agent-loft 本身的要求高，版本不够时体检里报出来。
import fs from "node:fs";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { dataDir } from "../../home.js";
import type { ModelInfo } from "../../core/types.js";

export const AGENT_DIR = path.join(dataDir, "pi");
export const AUTH_FILE = path.join(AGENT_DIR, "auth.json");
export const MODELS_FILE = path.join(AGENT_DIR, "models.json");
export const SESSIONS_DIR = path.join(AGENT_DIR, "sessions");

export const MIN_NODE = [22, 19] as const;
export function nodeOk(version = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

type Sdk = typeof import("@earendil-works/pi-coding-agent");
type Ai = typeof import("@earendil-works/pi-ai");
let sdk: Promise<{ pi: Sdk; ai: Ai }> | null = null;

export function loadSdk(): Promise<{ pi: Sdk; ai: Ai }> {
  sdk ??= (async () => {
    if (!nodeOk()) throw new Error(`pi 需要 Node ${MIN_NODE.join(".")} 以上，现在是 ${process.versions.node}`);
    const [pi, ai] = await Promise.all([import("@earendil-works/pi-coding-agent"), import("@earendil-works/pi-ai")]);
    return { pi, ai };
  })().catch((err) => {
    sdk = null;
    throw err;
  });
  return sdk;
}

let runtime: Promise<ModelRuntime> | null = null;

/** 整个进程共用一个 ModelRuntime：凭据、模型目录、可用性都在这里 */
export function modelRuntime(): Promise<ModelRuntime> {
  runtime ??= (async () => {
    const { pi } = await loadSdk();
    fs.mkdirSync(AGENT_DIR, { recursive: true, mode: 0o700 });
    fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
    return pi.ModelRuntime.create({ authPath: AUTH_FILE, modelsPath: MODELS_FILE });
  })().catch((err) => {
    runtime = null;
    throw err;
  });
  return runtime;
}

/** 测试用：换一个 runtime（比如注册了假服务商的） */
export function setModelRuntime(rt: ModelRuntime | null): void {
  runtime = rt ? Promise.resolve(rt) : null;
}

// ---------- 模型 ----------

/** agent-loft 里的模型 id 是「服务商/模型」（模型 id 自己也可能带斜杠，比如 OpenRouter 的） */
export function modelKey(m: Pick<Model<Api>, "provider" | "id">): string {
  return `${m.provider}/${m.id}`;
}

export function splitModelKey(key: string): { provider: string; id: string } | null {
  const i = key.indexOf("/");
  if (i <= 0 || i === key.length - 1) return null;
  return { provider: key.slice(0, i), id: key.slice(i + 1) };
}

export async function findModel(key: string): Promise<Model<Api> | undefined> {
  const parts = splitModelKey(key);
  if (!parts) return undefined;
  return (await modelRuntime()).getModel(parts.provider, parts.id);
}

/** 模型支持的思考程度（不支持思考的模型没有） */
export async function effortsOf(model: Model<Api>): Promise<string[]> {
  if (!model.reasoning) return [];
  const { ai } = await loadSdk();
  return ai.getSupportedThinkingLevels(model).filter((l) => l !== "off");
}

export async function modelInfo(model: Model<Api>, providerName?: string): Promise<ModelInfo> {
  const efforts = await effortsOf(model);
  return {
    id: modelKey(model),
    label: model.name || model.id,
    ...(providerName ? { description: providerName } : {}),
    ...(efforts.length ? { efforts } : {}),
  };
}

/** 配好了凭据的服务商下的所有模型 */
export async function availableModels(): Promise<ModelInfo[]> {
  const rt = await modelRuntime();
  const models = await rt.getAvailable();
  const names = new Map(rt.getProviders().map((p) => [p.id, p.name]));
  return Promise.all(models.map((m) => modelInfo(m, names.get(m.provider))));
}

/**
 * 没指定模型时用哪个：设置里的默认 → 能用的里面按常见的顺序挑一个。
 * 都没有（一家服务商都没配）返回 undefined，由调用方报「先配服务商」
 */
const PREFERRED_PROVIDERS = ["deepseek", "zai-coding-cn", "kimi-coding", "moonshotai-cn", "qwen-token-plan-cn", "minimax-cn", "anthropic", "openai", "openrouter"];
export async function pickModel(preferred?: string): Promise<Model<Api> | undefined> {
  if (preferred) {
    const m = await findModel(preferred);
    if (m) return m;
  }
  const rt = await modelRuntime();
  const models = await rt.getAvailable();
  if (!models.length) return undefined;
  for (const p of PREFERRED_PROVIDERS) {
    const hit = models.find((m) => m.provider === p);
    if (hit) return hit;
  }
  return models[0];
}

// ---------- 服务商凭据 ----------

export type ProviderView = {
  id: string;
  name: string;
  /** 能填 API Key */
  apiKey: boolean;
  /** 能用 OAuth 登录（订阅账号）：登录方式的名字，如「Anthropic (Claude Pro/Max)」 */
  oauth?: string;
  /** OAuth 是订阅账号（Claude Pro、ChatGPT Plus、Copilot……） */
  subscription?: boolean;
  /** 能用了（存了凭据，或者服务进程有对应的环境变量 / 云凭据） */
  configured: boolean;
  /** 凭据在 data/pi/auth.json 里（能在网页上删） */
  stored?: "api_key" | "oauth";
  models: number;
  /** 在 data/pi/models.json 里自定义的（网页上「自定义服务商」那一块管） */
  custom?: boolean;
};

export async function listProviders(): Promise<ProviderView[]> {
  const rt = await modelRuntime();
  const stored = new Map((await rt.listCredentials()).map((c) => [c.providerId, c.type]));
  let custom = new Set<string>();
  try {
    custom = new Set(Object.keys((JSON.parse(fs.readFileSync(MODELS_FILE, "utf8")) as { providers?: object }).providers ?? {}));
  } catch {
    // 没有 models.json
  }
  return rt
    .getProviders()
    .map((p) => {
      const auth = (p as { auth?: { apiKey?: { login?: unknown }; oauth?: { name?: string; isSubscription?: boolean } } }).auth ?? {};
      const kind = stored.get(p.id);
      return {
        id: p.id,
        name: p.name,
        apiKey: !!auth.apiKey?.login,
        ...(auth.oauth ? { oauth: auth.oauth.name || p.name, ...(auth.oauth.isSubscription ? { subscription: true } : {}) } : {}),
        configured: rt.hasConfiguredAuth(p.id),
        ...(kind ? { stored: kind } : {}),
        models: rt.getModels(p.id).length,
        ...(custom.has(p.id) ? { custom: true } : {}),
      };
    })
    .filter((p) => p.models > 0 && (p.apiKey || p.oauth || p.configured));
}

/**
 * 存一家服务商的 API Key：走 pi 自己的登录流程（它负责格式、落盘、刷新可用模型）。
 * 有的服务商除了 Key 还要别的（Cloudflare 的账号 id 之类），网页上暂不支持，直接报错
 */
export async function setApiKey(providerId: string, key: string): Promise<void> {
  const rt = await modelRuntime();
  const provider = rt.getProvider(providerId);
  if (!provider) throw new Error(`没有这个服务商：${providerId}`);
  let asked = 0;
  await rt.login(providerId, "api_key", {
    prompt: async (p) => {
      asked++;
      if (p.type === "secret" && asked === 1) return key;
      throw new Error(`${provider.name} 除了 API Key 还要填别的信息（${p.message}），网页上暂不支持；可以给 agent-loft 服务设环境变量`);
    },
    notify: () => {},
  });
}

export async function removeCredential(providerId: string): Promise<void> {
  const rt = await modelRuntime();
  await rt.logout(providerId);
}
