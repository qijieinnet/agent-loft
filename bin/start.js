// Keep explicit system/both startup arguments working for existing service definitions.
export async function startServices(args) {
  const mode = args[0] ?? process.env.AGENT_LOFT_WEB_MODE ?? "system";
  if (mode === "bot") throw new Error("独立 Web Bot 已移除。");
  if (args.length > 1 || !["system", "both"].includes(mode)) {
    throw new Error("用法：agent-loft start");
  }
  await import("../src/main.ts");
}
