// 微信渠道发给 Web 的事件。单独一个文件：Web 只想听事件时不用把轮询和发送都带上。
import { EventEmitter } from "node:events";

/** undelivered：微信发不出去的提醒，改走系统推送 */
export const weixinEvents = new EventEmitter<{ undelivered: [{ key: string; userId: string; body: string }] }>();
