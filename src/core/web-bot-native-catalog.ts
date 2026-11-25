import { CODEX_TOOL_CONFIG } from "../agents/codex/tool-config.js";
import { getBotProfile, requireBotEngine } from "./web-bot-profile.js";
import { requireOwner, WebBotError } from "./web-bots.js";

export const nativeOptions = {
  view_image: { label: "查看工作目录中的图片", flags: { "features.view_image": true } },
  image_generation: { label: "生成图片", flags: CODEX_TOOL_CONFIG.image_generation },
  multi_agent: { label: "调用 Codex 子智能体", flags: { ...CODEX_TOOL_CONFIG.multi_agent, "features.multi_agent_v2": true } },
  browser: { label: "使用引擎已连接的浏览器", flags: CODEX_TOOL_CONFIG.browser },
  computer_use: { label: "操作引擎已连接的桌面", flags: CODEX_TOOL_CONFIG.computer_use },
  apps: { label: "使用引擎账号已连接的应用", flags: CODEX_TOOL_CONFIG.apps },
};
export type BotNativeOption = keyof typeof nativeOptions;

export async function nativeCatalog(user: string, bot: string) {
  requireOwner(user, bot);
  const engine = getBotProfile(user, bot).engine;
  if (engine !== "codex") return { engine, options: [] };
  requireBotEngine(user, engine);
  const flags = new Set<string>();
  let cursor: string | null = null;
  try {
    const { appServer } = await import("../agents/codex/app-server.js");
    do {
      const page: { data: { name: string; stage: string }[]; nextCursor: string | null } =
        await appServer.call("experimentalFeature/list", { limit: 256, cursor });
      for (const f of page.data) if (f.stage !== "removed") flags.add(f.name);
      cursor = page.nextCursor;
    } while (cursor);
  } catch { throw new WebBotError(503, "无法读取此 Codex 版本的能力清单。"); }
  requireOwner(user, bot);
  return { engine, options: (Object.keys(nativeOptions) as BotNativeOption[]).map(id => {
    const supported = Object.keys(nativeOptions[id].flags).filter(k => k.startsWith("features.")).every(k => flags.has(k.slice(9)));
    const reason = !supported ? "此 Codex 版本不支持" : id === "multi_agent" ? "子智能体需要持久会话，Bot 使用临时会话" : "";
    return { id, label: nativeOptions[id].label, available: !reason, reason };
  }) };
}
