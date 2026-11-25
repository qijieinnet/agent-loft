import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { modelKey, modelRuntime } from "../agents/pi/sdk.js";
import { config } from "./config.js";
import { hub } from "./hub.js";
import { recordUsage } from "./usage.js";
import type { BotCodexTools, EngineReplyRequest } from "./types.js";
import { getUser } from "./users.js";
import { engineModels, pickBotModel, requireBotEngine, type BotProfile } from "./web-bot-profile.js";
import { getBot, WebBotError } from "./web-bots.js";

type BotRequest = {
  claudeTools?: EngineReplyRequest["claudeTools"];
  codexTools?: BotCodexTools;
  userId: string;
  botId: string;
  threadId: string;
  profile: BotProfile;
  system: string;
  content: string | (TextContent | ImageContent)[];
  maxTokens: number;
  signal: AbortSignal;
  checkAccess: () => void;
};

export function checkBotEngineAccess(userId: string, botId: string, profile: BotProfile) {
  if (profile.engine === "pi") return; // Existing pi Bot access is governed by the installation's Bot model list.
  requireBotEngine(userId, profile.engine);
  requireBotEngine(getBot(userId, botId).ownerId, profile.engine);
}

export async function generateBotText(req: BotRequest): Promise<string> {
  const { userId, botId, threadId, profile, system, content, signal } = req;
  const image = typeof content === "string" ? undefined : content.find(block => block.type === "image");
  const { engine } = profile;
  if (engine !== "pi") {
    req.checkAccess();
    const driver = hub.driver(engine);
    if (!driver?.reply) throw new WebBotError(503, "这个 Bot 的引擎暂不可用，请检查引擎连接。");
    if (profile.model && !engineModels(engine).includes(profile.model)) throw new WebBotError(503, "这个 Bot 的模型已停用，请重新选择。");
    const model = profile.model || config().agents[engine].defaultModel;
    const prompt = typeof content === "string" ? content : content.filter(b => b.type === "text").map(b => b.text).join("\n");
    return driver.reply({ system, prompt, signal, ...(engine === "claude" && req.claudeTools ? { claudeTools: req.claudeTools } : {}), ...(engine === "codex" && req.codexTools ? { codexTools: req.codexTools } : {}), ...(model ? { model } : {}), ...(image ? { image } : {}),
      onUsage: (usage, actualModel) => recordUsage("bot:" + threadId, usage, false, { owner: userId, agent: engine, model: actualModel || model }),
    });
  }

  const model = await pickBotModel(userId, botId, !!image);
  const rt = await modelRuntime();
  req.checkAccess();
  signal.throwIfAborted();
  const result = await rt.completeSimple(model, { systemPrompt: system, messages: [{ role: "user", content, timestamp: Date.now() }] }, {
    signal, maxTokens: Math.min(model.maxTokens, req.maxTokens),
  });
  const usage = result.usage;
  recordUsage("bot:" + threadId, { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, costUsd: usage.cost.total },
    false, { owner: userId, agent: engine, model: modelKey(model) });
  if (result.stopReason !== "stop") {
    const reason = result.errorMessage ?? "";
    if (/api.?key|unauthori[sz]ed|credentials?|\b401\b/i.test(reason)) throw new WebBotError(503, getUser(userId)?.role === "admin" ? "模型连接失败，请检查 pi 的服务商授权后重新发送。" : "模型连接失败，请联系管理这个 Bot 的人。");
    if (/rate.limit|quota|\b429\b/i.test(reason)) throw new WebBotError(503, "模型暂时繁忙或额度不足。消息已保留，请稍后重试。");
    if (result.stopReason === "length") throw new WebBotError(503, "这次回复太长了，可以把问题分成两部分再问。");
    throw new Error("incomplete answer");
  }
  return result.content.filter(block => block.type === "text").map(block => block.text).join("");
}
