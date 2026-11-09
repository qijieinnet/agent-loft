// 日历事件和提醒事项（EventKit）。
import EventKit
import Foundation

var store = EKEventStore()

/// 状态按原始值判断：macOS 14 起 3 叫 fullAccess（之前叫 authorized），4 是 writeOnly
func statusName(_ s: EKAuthorizationStatus) -> String {
    switch s.rawValue {
    case 0: return "notDetermined"
    case 1: return "restricted"
    case 2: return "denied"
    case 3: return "fullAccess"
    case 4: return "writeOnly"
    default: return "unknown(\(s.rawValue))"
    }
}

/// 弹系统授权框（只在还没决定过时会弹），返回最后的状态
@discardableResult
func requestAccess(_ type: EKEntityType) -> String {
    let status = EKEventStore.authorizationStatus(for: type)
    if status.rawValue != 0 { return statusName(status) }
    let sem = DispatchSemaphore(value: 0)
    let cb: EKEventStoreRequestAccessCompletionHandler = { _, _ in sem.signal() }
    if #available(macOS 14.0, *) {
        if type == .event { store.requestFullAccessToEvents(completion: cb) } else { store.requestFullAccessToReminders(completion: cb) }
    } else {
        store.requestAccess(to: type, completion: cb)
    }
    sem.wait()
    store = EKEventStore()  // 新授权的数据源要换个 store 才看得到
    return statusName(EKEventStore.authorizationStatus(for: type))
}

func requireAccess(_ type: EKEntityType) {
    let what = type == .event ? "Calendars" : "Reminders"
    let pane = type == .event ? "日历" : "提醒事项"
    let status = requestAccess(type)
    if status == "fullAccess" { return }
    fail("\(what) access is \(status). Ask the user to open Agent Loft → 设置 → 苹果日历 / 提醒事项 / 备忘录, or enable \"Agent Loft Bridge\" with full access in System Settings → Privacy & Security → \(pane).")
}

// MARK: - 日历

func hexColor(_ c: EKCalendar) -> String {
    guard let cg = c.cgColor, let comps = cg.components, comps.count >= 3 else { return "" }
    return String(format: "#%02X%02X%02X", Int(comps[0] * 255), Int(comps[1] * 255), Int(comps[2] * 255))
}

func calDict(_ c: EKCalendar, _ type: EKEntityType) -> [String: Any] {
    [
        "id": c.calendarIdentifier,
        "title": c.title,
        "account": c.source?.title ?? "",
        "kind": type == .event ? "calendar" : "reminderList",
        "writable": c.allowsContentModifications,
        "color": hexColor(c),
    ]
}

func findCalendar(_ name: String, _ type: EKEntityType) -> EKCalendar {
    let cals = store.calendars(for: type)
    if let c = cals.first(where: { $0.calendarIdentifier == name }) { return c }
    let matches = cals.filter { $0.title == name }
    if matches.count == 1 { return matches[0] }
    if matches.count > 1 {
        fail("several \(type == .event ? "calendars" : "lists") named '\(name)'; pass the id instead: "
             + matches.map { "\($0.calendarIdentifier) (\($0.source?.title ?? ""))" }.joined(separator: ", "))
    }
    fail("\(type == .event ? "calendar" : "reminder list") '\(name)' not found; available: "
         + cals.map { $0.title }.joined(separator: ", "))
}

func requireWritable(_ c: EKCalendar) {
    if !c.allowsContentModifications { fail("'\(c.title)' is read-only") }
}

// MARK: - 事件

func eventDict(_ e: EKEvent) -> [String: Any] {
    var d: [String: Any] = [
        "id": e.eventIdentifier ?? "",
        "title": e.title ?? "",
        "allDay": e.isAllDay,
        "start": e.isAllDay ? fmtDay(e.startDate) : fmt(e.startDate),
        "end": e.isAllDay ? fmtDay(e.endDate) : fmt(e.endDate),
        "calendar": e.calendar?.title ?? "",
        "recurring": e.hasRecurrenceRules,
    ]
    if let l = e.location, !l.isEmpty { d["location"] = l }
    if let n = e.notes, !n.isEmpty { d["notes"] = n }
    if let u = e.url { d["url"] = u.absoluteString }
    if let a = e.alarms, !a.isEmpty { d["alarmMinutesBefore"] = a.map { Int(-$0.relativeOffset / 60) } }
    return d
}

/// 确认框里怎么称呼这个事件
func eventLabel(_ e: EKEvent) -> String {
    let when = e.isAllDay ? dateOnlyFmt.string(from: e.startDate) + "（全天）" : makeFormatter("yyyy-MM-dd HH:mm").string(from: e.startDate)
    return "「\(e.title ?? "无标题")」\n\(when) · 日历「\(e.calendar?.title ?? "")」\(e.hasRecurrenceRules ? " · 重复事件" : "")"
}

func rangeFromOpts(defaultDays: Int) -> (Date, Date) {
    let from = opts["from"].map { parseDate($0).0 } ?? cal.startOfDay(for: Date())
    var to: Date
    if let t = opts["to"] {
        let (d, hasTime) = parseDate(t)
        to = hasTime ? d : cal.date(byAdding: .day, value: 1, to: d)!  // 只写日期的 --to 包含那一天
    } else {
        to = cal.date(byAdding: .day, value: defaultDays, to: from)!
    }
    if to <= from { fail("--to must be after --from") }
    return (from, to)
}

func cmdEventsList() {
    let (from, to) = rangeFromOpts(defaultDays: 7)
    let cals: [EKCalendar]? = opts["calendar"].map { $0.split(separator: ",").map { findCalendar(String($0), .event) } }
    var seen = Set<String>()
    var events: [EKEvent] = []
    var s = from
    while s < to {  // EventKit 一次最多查 4 年，按 1 年一段查
        let e = min(to, cal.date(byAdding: .year, value: 1, to: s)!)
        for ev in store.events(matching: store.predicateForEvents(withStart: s, end: e, calendars: cals)) {
            let key = "\(ev.eventIdentifier ?? "")|\(ev.startDate.timeIntervalSince1970)"
            if seen.insert(key).inserted { events.append(ev) }
        }
        s = e
    }
    if let q = opts["query"]?.lowercased() {
        events = events.filter { ev in
            [ev.title, ev.location, ev.notes].compactMap { $0?.lowercased() }.contains { $0.contains(q) }
        }
    }
    events.sort { $0.startDate < $1.startDate }
    if let lim = opts["limit"].flatMap(Int.init) { events = Array(events.prefix(lim)) }
    output(["from": fmt(from), "to": fmt(to), "count": events.count, "events": events.map(eventDict)])
}

func findEvent() -> EKEvent {
    guard let id = opts["id"] else { fail("--id is required") }
    if let occ = opts["occurrence"] {
        let (d, _) = parseDate(occ)
        let evs = store.events(matching: store.predicateForEvents(
            withStart: d.addingTimeInterval(-86400), end: d.addingTimeInterval(2 * 86400), calendars: nil))
            .filter { $0.eventIdentifier == id }
        if let e = evs.first(where: { abs($0.startDate.timeIntervalSince(d)) < 60 }) { return e }
        if let e = evs.first(where: { cal.isDate($0.startDate, inSameDayAs: d) }) { return e }
        fail("no occurrence of event \(id) starting at \(occ)")
    }
    guard let e = store.event(withIdentifier: id) else { fail("event not found: \(id)") }
    return e
}

func spanFor(_ e: EKEvent) -> EKSpan {
    let span = opts["span"] ?? "this"
    if !["this", "future"].contains(span) { fail("--span must be 'this' or 'future'") }
    if e.hasRecurrenceRules && opts["occurrence"] == nil && span != "future" {
        fail("recurring event: pass --occurrence <start> to target one occurrence, or --span future (without --occurrence) to target the whole series")
    }
    return span == "future" ? .futureEvents : .thisEvent
}

func spanText(_ e: EKEvent, _ span: EKSpan) -> String {
    guard e.hasRecurrenceRules else { return "" }
    return span == .futureEvents ? "\n范围：这一次及以后所有重复" : "\n范围：只这一次"
}

func applyAlarms(_ item: EKCalendarItem) {
    guard let a = opts["alarm"] else { return }
    item.alarms?.forEach { item.removeAlarm($0) }
    if a == "none" { return }
    for m in a.split(separator: ",") {
        guard let mins = Double(m.trimmingCharacters(in: .whitespaces)) else { fail("--alarm takes minutes-before, comma separated, or 'none'") }
        item.addAlarm(EKAlarm(relativeOffset: -mins * 60))
    }
}

func save(_ e: EKEvent, span: EKSpan) {
    do { try store.save(e, span: span, commit: true) } catch { fail("save failed: \(error.localizedDescription)") }
}

func cmdEventsAdd() {
    guard let title = opts["title"] else { fail("--title is required") }
    guard let startS = opts["start"] else { fail("--start is required") }
    let e = EKEvent(eventStore: store)
    e.title = title
    guard let c = opts["calendar"].map({ findCalendar($0, .event) }) ?? store.defaultCalendarForNewEvents else {
        fail("no default calendar; pass --calendar")
    }
    requireWritable(c)
    e.calendar = c
    let (start, hasTime) = parseDate(startS)
    e.isAllDay = boolOpt("all-day") ?? !hasTime
    e.startDate = start
    if let endS = opts["end"] {
        e.endDate = parseDate(endS).0
    } else if let dur = opts["duration"].flatMap(Double.init) {
        e.endDate = start.addingTimeInterval(dur * 60)
    } else {
        e.endDate = e.isAllDay ? start : start.addingTimeInterval(3600)
    }
    if e.endDate < e.startDate { fail("end is before start") }
    if let v = opts["location"] { e.location = v }
    if let v = opts["notes"] { e.notes = v }
    if let v = opts["url"] { e.url = URL(string: v) }
    applyAlarms(e)
    save(e, span: .thisEvent)
    output(["action": "created", "event": eventDict(e)])
}

func cmdEventsUpdate() {
    let e = findEvent()
    let span = spanFor(e)
    requireWritable(e.calendar)
    confirmWrite("修改日历事件", eventLabel(e) + spanText(e, span)
        + describeChanges(["title", "start", "end", "duration", "all-day", "calendar", "location", "notes", "url", "alarm"]))
    let before = eventDict(e)
    if let v = opts["title"] { e.title = v }
    if let v = boolOpt("all-day") { e.isAllDay = v }
    if let s = opts["start"] {
        let dur = e.endDate.timeIntervalSince(e.startDate)
        e.startDate = parseDate(s).0
        if opts["end"] == nil && opts["duration"] == nil { e.endDate = e.startDate.addingTimeInterval(dur) }
    }
    if let v = opts["end"] { e.endDate = parseDate(v).0 }
    if let dur = opts["duration"].flatMap(Double.init) { e.endDate = e.startDate.addingTimeInterval(dur * 60) }
    if e.endDate < e.startDate { fail("end is before start") }
    if let v = opts["location"] { e.location = v.isEmpty ? nil : v }
    if let v = opts["notes"] { e.notes = v.isEmpty ? nil : v }
    if let v = opts["url"] { e.url = v.isEmpty ? nil : URL(string: v) }
    if let v = opts["calendar"] { let c = findCalendar(v, .event); requireWritable(c); e.calendar = c }
    applyAlarms(e)
    save(e, span: span)
    output(["action": "updated", "before": before, "after": eventDict(e)])
}

func cmdEventsDelete() {
    let e = findEvent()
    let span = spanFor(e)
    requireWritable(e.calendar)
    confirmWrite("删除日历事件", eventLabel(e) + spanText(e, span))
    let d = eventDict(e)
    do { try store.remove(e, span: span, commit: true) } catch { fail("delete failed: \(error.localizedDescription)") }
    output(["action": "deleted", "span": span == .futureEvents ? "future" : "this", "event": d])
}

// MARK: - 提醒事项

func dueDate(_ r: EKReminder) -> Any {
    guard let c = r.dueDateComponents, let d = cal.date(from: c) else { return NSNull() }
    return c.hour == nil ? fmtDay(d) : fmt(d)
}

func priorityName(_ p: Int) -> String {
    switch p {
    case 0: return "none"
    case 1...4: return "high"
    case 5: return "medium"
    default: return "low"
    }
}

func reminderDict(_ r: EKReminder) -> [String: Any] {
    var d: [String: Any] = [
        "id": r.calendarItemIdentifier,
        "title": r.title ?? "",
        "list": r.calendar?.title ?? "",
        "completed": r.isCompleted,
        "due": dueDate(r),
        "priority": priorityName(r.priority),
    ]
    if let n = r.notes, !n.isEmpty { d["notes"] = n }
    if let u = r.url { d["url"] = u.absoluteString }
    if let c = r.completionDate { d["completedAt"] = fmt(c) }
    if let c = r.creationDate { d["createdAt"] = fmt(c) }
    return d
}

func reminderLabel(_ r: EKReminder) -> String {
    var s = "「\(r.title ?? "无标题")」\n列表「\(r.calendar?.title ?? "")」"
    if let due = dueDate(r) as? String { s += " · 截止 \(due)" }
    return s
}

func fetchReminders(_ pred: NSPredicate) -> [EKReminder] {
    let sem = DispatchSemaphore(value: 0)
    var res: [EKReminder] = []
    store.fetchReminders(matching: pred) { r in res = r ?? []; sem.signal() }
    sem.wait()
    return res
}

func cmdRemindersList() {
    let lists: [EKCalendar]? = opts["list"].map { $0.split(separator: ",").map { findCalendar(String($0), .reminder) } }
    let status = opts["status"] ?? "incomplete"
    let pred: NSPredicate
    switch status {
    case "incomplete": pred = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: lists)
    case "completed": pred = store.predicateForCompletedReminders(withCompletionDateStarting: nil, ending: nil, calendars: lists)
    case "all": pred = store.predicateForReminders(in: lists)
    default: fail("--status must be incomplete, completed or all")
    }
    var rs = fetchReminders(pred)
    if let q = opts["query"]?.lowercased() {
        rs = rs.filter { r in [r.title, r.notes].compactMap { $0?.lowercased() }.contains { $0.contains(q) } }
    }
    if opts["due-before"] != nil || opts["due-after"] != nil {
        let before = opts["due-before"].map { s -> Date in let (d, t) = parseDate(s); return t ? d : cal.date(byAdding: .day, value: 1, to: d)! }
        let after = opts["due-after"].map { parseDate($0).0 }
        rs = rs.filter { r in
            guard let c = r.dueDateComponents, let d = cal.date(from: c) else { return false }
            return (before.map { d < $0 } ?? true) && (after.map { d >= $0 } ?? true)
        }
    }
    let far = Date.distantFuture
    func due(_ r: EKReminder) -> Date { r.dueDateComponents.flatMap { cal.date(from: $0) } ?? far }
    if status == "completed" {
        rs.sort { ($0.completionDate ?? .distantPast) > ($1.completionDate ?? .distantPast) }
    } else {
        rs.sort { due($0) != due($1) ? due($0) < due($1) : ($0.creationDate ?? far) < ($1.creationDate ?? far) }
    }
    if let lim = opts["limit"].flatMap(Int.init) { rs = Array(rs.prefix(lim)) }
    output(["count": rs.count, "reminders": rs.map(reminderDict)])
}

func findReminder() -> EKReminder {
    guard let id = opts["id"] else { fail("--id is required") }
    guard let r = store.calendarItem(withIdentifier: id) as? EKReminder else { fail("reminder not found: \(id)") }
    return r
}

func parsePriority(_ s: String) -> Int {
    switch s.lowercased() {
    case "none": return 0
    case "high": return 1
    case "medium": return 5
    case "low": return 9
    default:
        guard let n = Int(s), (0...9).contains(n) else { fail("--priority: none|low|medium|high or 0-9") }
        return n
    }
}

func setDue(_ r: EKReminder, _ s: String) {
    r.alarms?.forEach { r.removeAlarm($0) }
    if s == "none" { r.dueDateComponents = nil; return }
    let (d, hasTime) = parseDate(s)
    let units: Set<Calendar.Component> = hasTime ? [.year, .month, .day, .hour, .minute] : [.year, .month, .day]
    r.dueDateComponents = cal.dateComponents(units, from: d)
    if hasTime { r.addAlarm(EKAlarm(absoluteDate: d)) }  // 和「提醒事项」App 一样，到点提醒
}

func saveReminder(_ r: EKReminder) {
    do { try store.save(r, commit: true) } catch { fail("save failed: \(error.localizedDescription)") }
}

func cmdRemindersAdd() {
    guard let title = opts["title"] else { fail("--title is required") }
    let r = EKReminder(eventStore: store)
    r.title = title
    guard let c = opts["list"].map({ findCalendar($0, .reminder) }) ?? store.defaultCalendarForNewReminders() else {
        fail("no default reminder list; pass --list")
    }
    requireWritable(c)
    r.calendar = c
    if let v = opts["due"] { setDue(r, v) }
    if let v = opts["notes"] { r.notes = v }
    if let v = opts["url"] { r.url = URL(string: v) }
    if let v = opts["priority"] { r.priority = parsePriority(v) }
    saveReminder(r)
    output(["action": "created", "reminder": reminderDict(r)])
}

func cmdRemindersUpdate() {
    let r = findReminder()
    requireWritable(r.calendar)
    // 只勾完成 / 取消完成不用确认，和 complete / reopen 一样
    let fields = ["title", "due", "notes", "url", "priority", "list"]
    if fields.contains(where: { opts[$0] != nil }) {
        confirmWrite("修改提醒事项", reminderLabel(r) + describeChanges(fields + ["completed"]))
    }
    let before = reminderDict(r)
    if let v = opts["title"] { r.title = v }
    if let v = opts["due"] { setDue(r, v) }
    if let v = opts["notes"] { r.notes = v.isEmpty ? nil : v }
    if let v = opts["url"] { r.url = v.isEmpty ? nil : URL(string: v) }
    if let v = opts["priority"] { r.priority = parsePriority(v) }
    if let v = boolOpt("completed") { r.isCompleted = v }
    if let v = opts["list"] { let c = findCalendar(v, .reminder); requireWritable(c); r.calendar = c }
    saveReminder(r)
    output(["action": "updated", "before": before, "after": reminderDict(r)])
}

func cmdRemindersComplete(_ done: Bool) {
    let r = findReminder()
    requireWritable(r.calendar)
    r.isCompleted = done
    saveReminder(r)
    output(["action": done ? "completed" : "reopened", "reminder": reminderDict(r)])
}

func cmdRemindersDelete() {
    let r = findReminder()
    requireWritable(r.calendar)
    confirmWrite("删除提醒事项", reminderLabel(r))
    let d = reminderDict(r)
    do { try store.remove(r, commit: true) } catch { fail("delete failed: \(error.localizedDescription)") }
    output(["action": "deleted", "reminder": d])
}
