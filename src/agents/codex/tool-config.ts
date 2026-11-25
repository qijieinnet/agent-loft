import type { CodexTool } from "../../core/experts.js";

/** 专家勾了的 Codex 自带能力在 CHAT_CONFIG 上打开哪些（core/experts.ts 的 CODEX_TOOLS） */
export const CODEX_TOOL_CONFIG: Record<CodexTool, Record<string, unknown>> = {
  image_generation: { "features.image_generation": true },
  multi_agent: { "features.multi_agent": true },
  browser: { "features.browser_use": true, "features.in_app_browser": true },
  computer_use: { "features.computer_use": true },
  apps: { "features.plugins": true, "features.apps": true, include_apps_instructions: true },
};
