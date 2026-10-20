// agent-loft pair list | approve <配对码> | revoke <机器人id> <open_id>
import { approve, listApproved, listPending, revoke } from "../core/pairing.js";
import { loadConfig } from "../core/config.js";

loadConfig();
const [sub, ...rest] = process.argv.slice(2);

switch (sub) {
  case "approve": {
    const code = rest[0];
    if (!code) throw new Error("用法：agent-loft pair approve <配对码>");
    const result = approve(code);
    if (!result.ok) throw new Error(`配对码 ${code} 不存在或已过期`);
    console.log(`已批准 ${result.request.userId}（机器人 ${result.channelId}）。正在运行的 agent-loft 会通知对方。`);
    break;
  }
  case "revoke": {
    const [channelId, userId] = rest;
    if (!channelId || !userId) throw new Error("用法：agent-loft pair revoke <机器人id> <open_id>");
    console.log(revoke(channelId, userId) ? "已撤销" : "没有这个已配对用户");
    break;
  }
  default: {
    const pending = listPending();
    console.log(pending.length ? "待批准：" : "没有待批准的请求。");
    for (const { channelId, request } of pending) {
      console.log(`  ${request.code}  ${request.userId}  机器人 ${channelId}  ${new Date(request.createdAt).toLocaleString()}`);
    }
    const approved = listApproved();
    if (approved.length) {
      console.log("已配对：");
      for (const a of approved) console.log(`  ${a.userId}  机器人 ${a.channelId}`);
    }
  }
}
