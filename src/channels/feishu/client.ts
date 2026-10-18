// 飞书客户端封装：一个机器人一个实例（以前是全局单例，现在一个进程可以跑多个机器人）。
import fs from "node:fs";
import * as Lark from "@larksuiteoapi/node-sdk";

function errData(err: unknown): { code?: number; msg?: string } | undefined {
  return (err as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
}

function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V, max = 500): void {
  map.set(key, value);
  if (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

export class FeishuClient {
  readonly lark: Lark.Client;
  /** message_id → card_id；cardkit 的全量更新要求 sequence 严格递增，每张卡自己记着 */
  private cardIdByMessage = new Map<string, string>();
  private sequenceByCard = new Map<string, number>();

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    domain: "feishu" | "lark",
    private readonly tag: string,
  ) {
    this.lark = new Lark.Client({
      appId,
      appSecret,
      domain: domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
    });
  }

  async sendText(chatId: string, text: string): Promise<string | undefined> {
    try {
      const res = await this.lark.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
      });
      return res.data?.message_id;
    } catch (err) {
      const data = errData(err);
      console.error(`[${this.tag}] 发消息失败:`, data ? `code=${data.code} msg=${data.msg}` : err);
      return undefined;
    }
  }

  async sendCard(chatId: string, card: unknown): Promise<string | undefined> {
    try {
      const res = await this.lark.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) },
      });
      const messageId = res.data?.message_id;
      if (!messageId) console.warn(`[${this.tag}] 发卡成功但没拿到 message_id，该卡片将无法更新`);
      return messageId;
    } catch (err) {
      const data = errData(err);
      console.error(`[${this.tag}] 发卡片失败:`, data ? `code=${data.code} msg=${data.msg}` : err);
      return undefined;
    }
  }

  private async resolveCardId(messageId: string): Promise<string | undefined> {
    const cached = this.cardIdByMessage.get(messageId);
    if (cached) return cached;
    try {
      const res = await this.lark.cardkit.v1.card.idConvert({ data: { message_id: messageId } });
      const cardId = res.data?.card_id;
      if (cardId) rememberBounded(this.cardIdByMessage, messageId, cardId);
      return cardId;
    } catch (err) {
      const data = errData(err);
      console.warn(`[${this.tag}] message_id ${messageId} 转 card_id 失败:`, data ? `code=${data.code}` : String(err));
      return undefined;
    }
  }

  /**
   * 原地更新卡片。走 cardkit 的全量更新：它是 JSON 2.0 卡片的正规通道。
   * 老的 im.v1.message.patch 对 2.0 卡片不可靠（带交互组件的更新不动），只作回退。
   */
  async updateCard(messageId: string, card: unknown): Promise<boolean> {
    const cardId = await this.resolveCardId(messageId);
    if (cardId) {
      const sequence = (this.sequenceByCard.get(cardId) ?? Math.floor(Date.now() / 1000)) + 1;
      rememberBounded(this.sequenceByCard, cardId, sequence);
      try {
        const res = await this.lark.cardkit.v1.card.update({
          path: { card_id: cardId },
          data: { card: { type: "card_json", data: JSON.stringify(card) }, sequence },
        });
        if (res.code === 0) return true;
        console.warn(`[${this.tag}] cardkit 更新 ${cardId} 被拒绝: code=${res.code} msg=${res.msg}`);
      } catch (err) {
        const data = errData(err);
        console.warn(`[${this.tag}] cardkit 更新 ${cardId} 失败:`, data ? `code=${data.code} msg=${data.msg}` : String(err));
      }
    }
    try {
      const res = await this.lark.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
      return res.code === 0;
    } catch (err) {
      const data = errData(err);
      console.warn(`[${this.tag}] 更新卡片 ${messageId} 失败:`, data ? `code=${data.code} msg=${data.msg}` : String(err));
      return false;
    }
  }

  /** 飞书没有给机器人开放 typing 指示器，表情回复是最接近的替代。 */
  async addTypingReaction(messageId: string): Promise<string | undefined> {
    try {
      const res = await this.lark.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: "Typing" } },
      });
      return res.data?.reaction_id;
    } catch (err) {
      console.warn(`[${this.tag}] 加表情失败:`, err instanceof Error ? err.message : err);
      return undefined;
    }
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    try {
      await this.lark.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch (err) {
      console.warn(`[${this.tag}] 删表情失败:`, err instanceof Error ? err.message : err);
    }
  }

  /** 下载消息里的资源到 target。失败时把飞书的错误码翻成人话抛出来。 */
  async downloadResource(messageId: string, fileKey: string, type: "image" | "file", target: string): Promise<void> {
    try {
      const res = await this.lark.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      });
      await res.writeFile(target);
    } catch (err) {
      fs.rmSync(target, { force: true });
      const data = await readErrorBody(err);
      if (data?.code === 99991672 || data?.code === 99991679) {
        throw new Error("飞书应用缺少「获取与上传图片或文件资源」(im:resource) 权限");
      }
      if (data) throw new Error(`飞书返回 code=${data.code} ${(data.msg ?? "").slice(0, 120)}`.trim());
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /** 测试连通性：拿一次 tenant token 就知道 appId / secret 对不对。 */
  async probe(): Promise<{ ok: boolean; message: string }> {
    try {
      const res = await this.lark.auth.v3.tenantAccessToken.internal({
        data: { app_id: this.appId, app_secret: this.appSecret },
      });
      return res.code === 0 ? { ok: true, message: "凭据有效" } : { ok: false, message: `code=${res.code} ${res.msg}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** 下载接口按二进制流请求，出错时响应体也是一个流，得先读出来再解析。 */
async function readErrorBody(err: unknown): Promise<{ code?: number; msg?: string } | undefined> {
  const raw = (err as { response?: { data?: unknown } })?.response?.data;
  if (!raw) return undefined;
  if (typeof (raw as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") {
    return raw as { code?: number; msg?: string };
  }
  try {
    let body = "";
    for await (const chunk of raw as AsyncIterable<Buffer | string>) body += chunk.toString();
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
