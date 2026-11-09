// 备忘录：Bridge 把包里的 notes.js 交给 osascript 跑（JXA）。osascript 是 Bridge 的子进程，
// 给「备忘录」发 Apple 事件的权限（自动化）记在 Agent Loft Bridge 名下。
import CoreServices
import Foundation

let notesBundleID = "com.apple.Notes"

/// 跑 notes.js；capture 为 false 时输出直接给调用方，返回退出码
@discardableResult
func runNotes(_ args: [String], capture: Bool = false) -> (Int32, Data) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    p.arguments = ["-l", "JavaScript", resourcesURL.appendingPathComponent("notes.js").path] + args
    let pipe = Pipe()
    if capture { p.standardOutput = pipe }
    do { try p.run() } catch { fail("cannot run osascript: \(error.localizedDescription)") }
    let data = capture ? pipe.fileHandleForReading.readDataToEndOfFile() : Data()
    p.waitUntilExit()
    return (p.terminationStatus, data)
}

/// 确认框里怎么称呼这条备忘录（拿不到就只写 id）
func noteLabel(_ id: String) -> String {
    let (code, data) = runNotes(["read", "--id", id, "--format", "none"], capture: true)
    guard code == 0, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        exit(code == 0 ? 1 : code)  // notes.js 已经把错误写到 stderr 了
    }
    let title = obj["title"] as? String ?? id
    let folder = obj["folder"] as? String ?? ""
    return "「\(title)」\(folder.isEmpty ? "" : "\n文件夹「\(folder)」")"
}

func cmdNotes(_ args: [String]) -> Never {
    let sub = args.first ?? "help"
    if let id = opts["id"] {
        switch sub {
        case "delete": confirmWrite("删除备忘录", noteLabel(id) + "\n\n会移到「最近删除」，30 天内可以恢复。")
        case "update": confirmWrite("改写备忘录", noteLabel(id) + describeChanges(["title", "body"]))
        default: break
        }
    }
    exit(runNotes(args).0)
}

/// 自动化权限：granted / denied / notDetermined；备忘录没在运行时查不了，是 unknown
func notesPermission(ask: Bool) -> String {
    var addr = AEAddressDesc()
    let id = Array(notesBundleID.utf8)
    guard AECreateDesc(DescType(typeApplicationBundleID), id, id.count, &addr) == noErr else { return "unknown" }
    defer { AEDisposeDesc(&addr) }
    let st = AEDeterminePermissionToAutomateTarget(&addr, AEEventClass(typeWildCard), AEEventID(typeWildCard), ask)
    switch Int(st) {
    case Int(noErr): return "granted"
    case -1743: return "denied"           // errAEEventNotPermitted
    case -1744: return "notDetermined"    // errAEEventWouldRequireUserConsent
    default: return "unknown"             // -600 procNotFound：备忘录没在运行
    }
}

/// 申请自动化权限要备忘录在运行：没开就在后台悄悄打开它（不抢焦点）
func requestNotesPermission() -> String {
    let now = notesPermission(ask: false)
    if now == "granted" || now == "denied" { return now }
    let open = Process()
    open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    open.arguments = ["-g", "-j", "-b", notesBundleID]
    try? open.run()
    open.waitUntilExit()
    for _ in 0..<40 {
        let s = notesPermission(ask: false)
        if s != "unknown" { break }
        Thread.sleep(forTimeInterval: 0.25)
    }
    return notesPermission(ask: true)
}
