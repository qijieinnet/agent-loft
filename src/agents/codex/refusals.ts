// 「我不同意 / 我答不了」这句话，每一种反向请求都有自己的说法。
//
// 这件事值得单独一个模块，因为回错结构的代价特别不直观：Codex 那一轮会挂在
// 等待上，而聊天这边只是安静地没反应 —— 既没有报错也没有超时，看不出哪儿坏了。
// 实测就撞到过：MCP 的 elicitation 要的是 `{action}`，不是审批那套 `{decision}`。
//
// 所以这里把每种请求的「安全否定」集中列出来，任何新增的反向请求都必须先在
// 这儿登记，否则一律走 unsupported 那条路 —— 明确报错，好过瞎猜一个形状。

/** 无法应答的请求：交给 JSON-RPC 的 error 通道，而不是编一个结构出来。 */
export class UnsupportedRequest extends Error {
  constructor(method: string) {
    super(`im-agent不支持 ${method}`);
    this.name = "UnsupportedRequest";
  }
}

/**
 * 某种反向请求的「安全否定」。
 *
 * 用在两处：找不到对应会话时的兜底，以及处理器自己出错时的收尾。
 * 认不出来的方法返回 null，调用方应当抛 UnsupportedRequest。
 */
export function refusalFor(method: string): unknown | null {
  switch (method) {
    // v2 的三种审批
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };

    case "item/permissions/requestApproval":
      // 拒绝 = 一样都不给，而不是原样放行
      return { permissions: {}, scope: "turn" };

    case "item/tool/requestUserInput":
      return { answers: {} };

    // MCP 服务器想向用户要一份表单输入。我们还没做表单渲染，明确拒绝。
    // 注意字段是 action 而不是 decision，content / _meta 必须显式给 null。
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null, _meta: null };

    // 老协议里的两种审批。新版 codex 走上面的 v2 方法，但握手后到底发哪一套
    // 取决于对端版本，两边都接住才不会在升级时突然卡住。
    // 它们用的是 ReviewDecision，拒绝要带一句理由。
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: { denied: { rejection: "im-agent未获授权" } } };

    // 服务端让我们代为调一个工具。没实现，如实说失败。
    case "item/tool/call":
      return {
        contentItems: [{ type: "text", text: "im-agent不提供客户端工具" }],
        success: false,
      };

    // 刷新 ChatGPT 令牌、生成设备证明 —— 这两件事只有真正的 Codex 客户端做得了，
    // 我们编不出合法的返回值，只能走 error 通道。
    default:
      return null;
  }
}
