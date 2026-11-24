// A model may propose an operation. The user's message and the currently stored reminders determine consent.
import { listBotReminders, type ReminderAction } from "./web-bot-reminders.js";

export const recurrenceNotice = "目前只支持一次性提醒。请告诉我下一次要提醒的日期和时间。";
const reminderWord = /提醒|闹钟|通知我|叫我|\bremind(?:er(?:s)?)?\b|\balarm\b/i;
const periodicPatterns = [
  /每(?:隔|逢|次|日|天|晚|早|夜|年|季|分钟|个?(?:工作日|周末|月|星期|礼拜|周|小时)|[一二两三四五六七八九十\d]+.{0,4}(?:天|周|日|小时|分钟|月))/,
  /天天|隔(?:天|日|周|月)|(?:^|[在，。\s])工作日|工作日(?:都|早|晚|上午|下午|中午)|(?:周|星期|礼拜)一[至到~～-](?:周|星期|礼拜)?五/,
  /(?:循环|重复|定期|周期)(?:性)?提醒|\b(?:every|recurr(?:ing|ence)|repeat(?:ed(?:ly)?|ing)?|daily|weekly|monthly|yearly|hourly|weekdays|weekends|(?:mon|tues|wednes|thurs|fri|satur|sun)days)\b/i,
];
const modifyingSchedule = /改到|改成|修改|改为|调整|推迟|延后|提前|延迟|挪到|改在|推后|换到|\b(?:reschedule|move|postpone|delay|snooze|change|update)\b/i;
const createCommand = /提醒(?:一下)?(?:我|我们)|(?:设(?:置)?|加|建|创建|安排|添加|定|订)(?:置)?(?:一下)?(?:个|一条|一个)?(?:.{0,16}的)?(?:提醒|闹钟)|叫我|通知我|\b(?:remind me|remind us|(?:set|add|create|schedule) (?:a |an |the )?(?:reminder|alarm))\b/i;
const readQuestion = /(?:查看|查查|看看|列出|列一下|有哪些|有哪[些几]|有什么|还有什么|多少|哪些).{0,16}(?:提醒|闹钟)|(?:提醒|闹钟).{0,16}(?:列表|清单|有哪|有哪些|是什么|列出)|\b(?:list|show|what|which|how many)\b.{0,30}\breminders?\b/i;
const negatedCommand = /(?:不(?:要|用|必|需要)|别|无需).{0,8}(?:设置|修改|调整|改到|提前|推迟|提醒|取消|删除)|\b(?:do not|don't|don’t|never)\s+(?:set|schedule|add|create|move|change|cancel|delete|remind)\b/i;
const readOnlyQualifier = /只(?:要|是|想|把|看|查|列|显示|需|给)|\b(?:just|only)\s+(?:show|list|display)\b/i;

export function asksForRecurringReminder(request: string): boolean {
  if (/^(?:请|帮我|麻烦)?(?:取消|删除)|^(?:please )?(?:delete|cancel) /i.test(request.trim())) return false;
  return (reminderWord.test(request) || modifyingSchedule.test(request)) && periodicPatterns.some(pattern => pattern.test(request));
}

export function isReminderListRequest(request: string): boolean {
  if (!readQuestion.test(request)) return false;
  return readOnlyQualifier.test(request) || negatedCommand.test(request)
    || (!createCommand.test(request) && !modifyingSchedule.test(request) && !/取消|删除|\bcancel\b/i.test(request));
}

export function reminderListAnswer(userId: string, threadId: string, timezone: string): string {
  const items = listBotReminders(userId, threadId);
  if (!items.length) return "你在这段对话里没有待提醒的事。";
  const format = new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, dateStyle: "short", timeStyle: "short" });
  const visible = items.slice(0, 12).map(item => "- " + format.format(item.dueAt) + "　" + item.text);
  if (items.length > visible.length) visible.push("其余提醒可以在「我的提醒」查看。");
  return ["你在这段对话里的待提醒事项", ...visible].join("\n");
}

function normalizedCommand(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().replace(/[。.!！]+$/u, "");
}

function namesCancellation(request: string, text: string): boolean {
  const title = normalizedCommand(text);
  const command = normalizedCommand(request).replace(/^(?:请(?:你)?(?:帮我)?|帮我|麻烦(?:你)?(?:帮我)?)\s*/, "");
  const verb = command.match(/^(?:取消|删除|移除)(?:一下)?\s*/u);
  if (verb) {
    const target = command.slice(verb[0].length);
    return [title, title + "提醒", title + "的提醒", "提醒：" + title, "提醒:" + title, "「" + title + "」提醒", "「" + title + "」"].includes(target);
  }
  const target = command.replace(/^(?:please )?(?:cancel|delete|remove) (?:my |the )?(?:reminder (?:to |for )?)?/i, "");
  return target !== command && (target === title || target === title + " reminder");
}

/** Return explanatory copy to the chat when the proposed operation needs a human choice. */
export function reminderIntentFeedback(userId: string, threadId: string, request: string, action: ReminderAction): string | undefined {
  if (action.kind === "cancel") {
    const named = listBotReminders(userId, threadId).filter(item => namesCancellation(request, item.text));
    if (named.length !== 1 || named[0]!.id !== action.id)
      return "提醒仍然保留。要取消一项，请在「我的提醒」里选中并确认，或说“取消「提醒内容」”。";
    return;
  }
  if (asksForRecurringReminder(request)) return recurrenceNotice;
  if (negatedCommand.test(request) || !(action.kind === "create" ? createCommand : modifyingSchedule).test(request))
    return "这次没有更改提醒。可以告诉我具体安排，或在「我的提醒」里选择要调整的一项。";
}
