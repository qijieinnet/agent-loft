// Agent Loft Bridge：让智能体读写这台 Mac 上的「日历」「提醒事项」「备忘录」。
// 只有 Agent Loft 桌面端能调用（见 requireCallerKey），智能体走桌面端的 MCP 服务。
//
// 权限归属：macOS 按「负责进程」记隐私权限。直接运行的话，负责进程是最上面那个启动它的程序（比如 node），
// 权限会记到 node 头上，本机所有 node 程序都跟着拿到。所以一启动就用 responsibility_spawnattrs_setdisclaim
// 把自己重新拉起一次：新进程不再认上面的程序，自己当负责进程，权限只记在 Agent Loft Bridge 名下。
//
// 输出一律是 JSON（stdout）；出错时 stderr 输出 {"error": ...}，退出码 1。
import Darwin
import EventKit
import Foundation

let bridgeVersion = (Bundle(url: bundleURL)?.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "dev"

// MARK: - disclaim 后重新拉起自己

private let childEnv = "AGENT_LOFT_BRIDGE_DISCLAIMED"
private var childPid: pid_t = 0

typealias DisclaimFn = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32

func respawnDisclaimed() -> Never {
    var attr: posix_spawnattr_t? = nil
    posix_spawnattr_init(&attr)
    // 私有接口，从 libSystem 里找；找不到（极老或改了名的系统）就不能保证权限归属，宁可不跑
    guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") else {
        fail("this macOS version does not support running Agent Loft Bridge as its own responsible process")
    }
    let setDisclaim = unsafeBitCast(sym, to: DisclaimFn.self)
    guard setDisclaim(&attr, 1) == 0 else { fail("cannot set up Agent Loft Bridge as its own responsible process") }
    setenv(childEnv, "1", 1)
    let exe = executablePath()
    var argv: [UnsafeMutablePointer<CChar>?] = [strdup(exe)] + CommandLine.arguments.dropFirst().map { strdup($0) } + [nil]
    let rc = posix_spawn(&childPid, exe, nil, &attr, &argv, environ)
    if rc != 0 { fail("cannot start Agent Loft Bridge: \(String(cString: strerror(rc)))") }
    // 调用方超时杀掉我们时，把信号转给真正干活的那个
    for sig in [SIGTERM, SIGINT, SIGHUP] {
        signal(sig) { s in if childPid > 0 { kill(childPid, s) } }
    }
    var status: Int32 = 0
    while waitpid(childPid, &status, 0) == -1 && errno == EINTR {}
    let low = status & 0x7f
    if low == 0 { exit((status >> 8) & 0xff) }
    exit(128 + low)
}

if ProcessInfo.processInfo.environment[childEnv] == nil { respawnDisclaimed() }
unsetenv(childEnv)  // 别传给 osascript 之类的子进程

// MARK: - 命令

parseArguments(Array(CommandLine.arguments.dropFirst()))
// help / version 谁都能看，其余要是桌面端调用的
if !["help", "-h", "--help", "version", "--version"].contains(positional.first ?? "help") { requireCallerKey() }

let help = """
Agent Loft Bridge \(bridgeVersion) — Apple Calendar, Reminders & Notes (JSON output).\nOnly the Agent Loft desktop app can run these commands; agents use its MCP server.

  status                                   permission status of calendars / reminders / notes
  request calendars|reminders|notes        show the macOS permission prompt (only if not decided yet)

  calendars                                list event calendars
  events list    [--from D] [--to D] [--calendar NAME[,NAME]] [--query TEXT] [--limit N]
                 (default: today + 7 days; date-only --to is inclusive)
  events add     --title T --start D [--end D | --duration MIN] [--all-day] [--calendar NAME]
                 [--location L] [--notes N] [--url U] [--alarm MIN[,MIN]]
  events update  --id ID [--occurrence START] [--span this|future] [--title ..] [--start ..]
                 [--end ..] [--duration MIN] [--all-day true|false] [--calendar ..] [--location ..]
                 [--notes ..] [--url ..] [--alarm MIN|none]   (empty string clears a text field)
  events delete  --id ID [--occurrence START] [--span this|future]

  reminders lists
  reminders list     [--list NAME[,NAME]] [--status incomplete|completed|all] [--query TEXT]
                     [--due-before D] [--due-after D] [--limit N]
  reminders add      --title T [--list NAME] [--due D|'D HH:mm'] [--notes N] [--priority none|low|medium|high] [--url U]
  reminders update   --id ID [--title ..] [--due ..|none] [--notes ..] [--priority ..] [--list ..] [--completed true|false]
  reminders complete --id ID        reminders reopen --id ID        reminders delete --id ID

  notes help                               Apple Notes commands (folders, list, search, read, create,
                                           append, update, move, delete, create-folder, export)
  mail help                                Apple Mail: accounts, search, read, draft (never sends)

  contacts search [--query TEXT] [--limit N]      name / organization / email / phone fragment
  contacts get --id ID        contacts groups
  contacts add    [--given-name ..] [--family-name ..] [--nickname ..] [--organization ..] [--job-title ..]
                  [--birthday YYYY-MM-DD|MM-DD] [--phones JSON] [--emails JSON] [--urls JSON]
                  (JSON: [{"label":"mobile","value":"..."}] or ["..."])
  contacts update --id ID [same fields; a list replaces the whole list; --birthday none clears]
  contacts delete --id ID

  photos albums
  photos search  [--from D] [--to D] [--album NAME|ID] [--type image|video|all] [--favorite]
                 [--near LAT,LON] [--radius KM] [--order newest|oldest] [--offset N] [--limit N]
  photos thumbnails --ids ID[,ID] [--size PX]     JPEG, base64 (max 10)
  photos export     --ids ID[,ID] --out DIR       originals (downloads from iCloud if needed)

Dates: YYYY-MM-DD, 'YYYY-MM-DD HH:mm', ISO8601, today, tomorrow, yesterday, now (local time).
Recurring events: target one occurrence with --occurrence <its start>; --span future without
--occurrence targets the whole series.
Deleting or rewriting (events / reminders / contacts update & delete, notes update & delete) may pop up
a confirmation on the Mac; if the user declines, the command fails and nothing changes.
"""

let cmd = positional.first ?? "help"
let sub = positional.count > 1 ? positional[1] : ""

// 用户在桌面端关掉的应用一律不碰（MCP 那边也不会列出它的工具，这里再兜一道）
let serviceOf = ["calendars": "calendars", "events": "calendars", "reminders": "reminders", "notes": "notes",
                 "contacts": "contacts", "photos": "photos", "mail": "mail"]
if let service = serviceOf[cmd], !bridgeConfig.enabled(service) {
    fail("\(service) is turned off in Agent Loft → 设置 → 苹果应用. Ask the user to turn it on if they want this.")
}

switch (cmd, sub) {
case ("help", _), ("-h", _), ("--help", _):
    print(help)
case ("version", _), ("--version", _):
    output(["version": bridgeVersion])
case ("status", _):
    output([
        "version": bridgeVersion,
        "calendars": statusName(EKEventStore.authorizationStatus(for: .event)),
        "reminders": statusName(EKEventStore.authorizationStatus(for: .reminder)),
        "notes": automationPermission(notesBundleID, ask: false),
        "contacts": contactsStatusName(),
        "photos": photosStatusName(),
        "mail": automationPermission(mailBundleID, ask: false),
        "confirmWrites": bridgeConfig.confirmWrites,
        "enabled": Dictionary(uniqueKeysWithValues: ["calendars", "reminders", "notes", "contacts", "photos", "mail"].map { ($0, bridgeConfig.enabled($0)) }),
    ])
case ("request", "calendars"):
    output(["calendars": requestAccess(.event)])
case ("request", "reminders"):
    output(["reminders": requestAccess(.reminder)])
case ("request", "notes"):
    output(["notes": requestAutomation(notesBundleID)])
case ("request", "contacts"):
    output(["contacts": requestContacts()])
case ("request", "photos"):
    output(["photos": requestPhotos()])
case ("request", "mail"):
    output(["mail": requestAutomation(mailBundleID)])
case ("request", _):
    fail("usage: request calendars|reminders|notes|contacts|photos|mail")
case ("calendars", _):
    requireAccess(.event)
    output(store.calendars(for: .event).map { calDict($0, .event) })
case ("events", let s):
    requireAccess(.event)
    switch s {
    case "list": cmdEventsList()
    case "add": cmdEventsAdd()
    case "update": cmdEventsUpdate()
    case "delete": cmdEventsDelete()
    default: fail("unknown: events \(s). Try: list, add, update, delete")
    }
case ("reminders", let s):
    requireAccess(.reminder)
    switch s {
    case "lists": output(store.calendars(for: .reminder).map { calDict($0, .reminder) })
    case "list": cmdRemindersList()
    case "add": cmdRemindersAdd()
    case "update": cmdRemindersUpdate()
    case "complete": cmdRemindersComplete(true)
    case "reopen": cmdRemindersComplete(false)
    case "delete": cmdRemindersDelete()
    default: fail("unknown: reminders \(s). Try: lists, list, add, update, complete, reopen, delete")
    }
case ("notes", _):
    // 原样把 notes 后面的参数交给 notes.js
    cmdNotes(Array(CommandLine.arguments.dropFirst(2)))
case ("mail", _):
    cmdMail(Array(CommandLine.arguments.dropFirst(2)))
case ("contacts", let s):
    requireContacts()
    switch s {
    case "search": cmdContactsSearch()
    case "get": cmdContactsGet()
    case "groups": cmdContactsGroups()
    case "add": cmdContactsAdd()
    case "update": cmdContactsUpdate()
    case "delete": cmdContactsDelete()
    default: fail("unknown: contacts \(s). Try: search, get, groups, add, update, delete")
    }
case ("photos", let s):
    requirePhotos()
    switch s {
    case "albums": cmdPhotosAlbums()
    case "search": cmdPhotosSearch()
    case "thumbnails": cmdPhotosThumbnails()
    case "export": cmdPhotosExport()
    default: fail("unknown: photos \(s). Try: albums, search, thumbnails, export")
    }
default:
    fail("unknown command '\(cmd)'. Run with 'help'.")
}
