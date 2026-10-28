// 定时任务每次运行时发给 agent 的话：用户写的提示词 + 一段 agent-loft 附上的说明（用户看不到）。
//
// 「只在需要时提醒」靠一个暗号：agent 判断这次没什么要说的，就在回复第一行只写 SILENT_MARK，
// hub 看到它就把这一轮标成 silent，推送和飞书都不发。没写暗号一律当成要提醒 —— 宁可多提醒一次，
// 也不能漏掉。
import { wrapContext } from "./expert-prompt.js";
import { formatDateTime, serverTimeZone } from "./task-schedule.js";

export const SILENT_MARK = "[[静默]]";

export function isSilentReply(text: string): boolean {
  return text.trimStart().startsWith(SILENT_MARK);
}

/** 去掉暗号，剩下的是 agent 顺手记的检查结果 */
export function stripSilentMark(text: string): string {
  return isSilentReply(text) ? text.trimStart().slice(SILENT_MARK.length).trim() : text;
}

export function taskMessage(
  task: { title: string; prompt: string; notify: "smart" | "always" },
  opts: { now?: number; manual?: boolean; version?: string } = {},
): string {
  const now = opts.now ?? Date.now();
  const lines = [
    `这条消息是定时任务「${task.title}」${opts.manual ? "（用户刚才手动点了「立即运行」）" : "到点自动发来的"}，现在是 ${formatDateTime(now)}（${serverTimeZone()}）。${opts.manual ? "" : "用户此刻多半不在屏幕前，不要向他提问、等他回答。"}`,
    ...(opts.version ? [`agent-loft 服务端当前版本：${opts.version}。`] : []),
    "按上面的要求做；这条对话里以前运行的结果可以拿来对比（比如「和上次比有没有变化」）。",
  ];
  if (task.notify === "smart") {
    lines.push(
      "",
      `用户希望只在有需要时才被提醒：如果按上面的要求，这次没有需要告诉他的事（比如没有更新、没有变化、条件没满足），回复的第一行只写 ${SILENT_MARK}，后面用一两句话记下这次检查的结果（下次可以对比），他就不会收到通知。`,
      `有需要告诉他的事时正常回复，开头直接说结论，不要写 ${SILENT_MARK}。`,
    );
  }
  return `${task.prompt}\n\n${wrapContext(lines)}`;
}
