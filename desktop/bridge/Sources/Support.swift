// 输出、参数解析、日期：几个命令共用。
import CryptoKit
import Foundation

func writeJSON(_ obj: Any, to handle: FileHandle) {
    let opts: JSONSerialization.WritingOptions = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    if let d = try? JSONSerialization.data(withJSONObject: obj, options: opts) {
        handle.write(d)
        handle.write("\n".data(using: .utf8)!)
    }
}

func fail(_ msg: String) -> Never {
    writeJSON(["error": msg], to: FileHandle.standardError)
    exit(1)
}

func output(_ obj: Any) { writeJSON(obj, to: FileHandle.standardOutput) }

// MARK: - 参数：先是位置参数，然后 --key value / --key=value / --flag

var positional: [String] = []
var opts: [String: String] = [:]

func parseArguments(_ args: [String]) {
    var i = 0
    while i < args.count {
        let a = args[i]
        if a.hasPrefix("--") {
            let key = String(a.dropFirst(2))
            if let eq = key.firstIndex(of: "=") {
                opts[String(key[..<eq])] = String(key[key.index(after: eq)...])
            } else if i + 1 < args.count && !args[i + 1].hasPrefix("--") {
                opts[key] = args[i + 1]; i += 1
            } else {
                opts[key] = "true"
            }
        } else {
            positional.append(a)
        }
        i += 1
    }
}

func boolOpt(_ k: String) -> Bool? {
    guard let v = opts[k]?.lowercased() else { return nil }
    return ["true", "yes", "1", "y"].contains(v)
}

// MARK: - 日期（本地时区）

let cal = Calendar.current
func makeFormatter(_ f: String) -> DateFormatter {
    let df = DateFormatter()
    df.locale = Locale(identifier: "en_US_POSIX")
    df.timeZone = TimeZone.current
    df.dateFormat = f
    return df
}
let dateOnlyFmt = makeFormatter("yyyy-MM-dd")
let dateTimeFmts = ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd HH:mm"].map(makeFormatter)
let outFmt = makeFormatter("yyyy-MM-dd'T'HH:mm:ssXXXXX")

/// 返回日期，以及输入里带没带时刻
func parseDate(_ s: String) -> (Date, Bool) {
    let today = cal.startOfDay(for: Date())
    switch s.lowercased() {
    case "now": return (Date(), true)
    case "today": return (today, false)
    case "tomorrow": return (cal.date(byAdding: .day, value: 1, to: today)!, false)
    case "yesterday": return (cal.date(byAdding: .day, value: -1, to: today)!, false)
    default: break
    }
    let iso = ISO8601DateFormatter()
    if let d = iso.date(from: s) { return (d, true) }
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = iso.date(from: s) { return (d, true) }
    for f in dateTimeFmts { if let d = f.date(from: s) { return (d, true) } }
    if let d = dateOnlyFmt.date(from: s) { return (d, false) }
    fail("cannot parse date '\(s)'; use YYYY-MM-DD, 'YYYY-MM-DD HH:mm', ISO8601, today, tomorrow, now")
}

func fmt(_ d: Date?) -> Any { d.map { outFmt.string(from: $0) } ?? NSNull() }
func fmtDay(_ d: Date?) -> Any { d.map { dateOnlyFmt.string(from: $0) } ?? NSNull() }

// MARK: - 自己在哪

/// 可执行文件的真实路径（经软链接调用时也解析到 .app 里面）
func executablePath() -> String {
    var size: UInt32 = 0
    _ = _NSGetExecutablePath(nil, &size)
    var buf = [CChar](repeating: 0, count: Int(size) + 1)
    guard _NSGetExecutablePath(&buf, &size) == 0 else { fail("cannot locate own executable") }
    var real = [CChar](repeating: 0, count: Int(PATH_MAX))
    guard realpath(buf, &real) != nil else { fail("cannot resolve own executable path") }
    return String(cString: real)
}

/// Agent Loft Bridge.app 的路径：可执行文件在 Contents/MacOS 下
let bundleURL = URL(fileURLWithPath: executablePath()).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
let resourcesURL = bundleURL.appendingPathComponent("Contents/Resources")

/// 桌面端写给 Bridge 的设置，和 .app 放在同一个目录（~/Library/Application Support/Agent Loft/apple-bridge/config.json）
struct BridgeConfig {
    var confirmWrites = true
    /// 调用密钥的 SHA-256（十六进制）。没有就谁都调用不了
    var keyHash: String? = nil
    /// 哪些应用开着（桌面端设置里的开关）。没写的按默认：日历、提醒事项、备忘录开，通讯录、照片、邮件关
    var services: [String: Bool] = [:]

    func enabled(_ service: String) -> Bool {
        services[service] ?? ["calendars", "reminders", "notes"].contains(service)
    }
}

let bridgeConfig: BridgeConfig = {
    var c = BridgeConfig()
    let file = bundleURL.deletingLastPathComponent().appendingPathComponent("config.json")
    if let d = try? Data(contentsOf: file),
       let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
        if let v = obj["confirmWrites"] as? Bool { c.confirmWrites = v }
        if let v = obj["keyHash"] as? String { c.keyHash = v.lowercased() }
        if let v = obj["services"] as? [String: Bool] { c.services = v }
    }
    return c
}()

// MARK: - 只认 Agent Loft 桌面端

/// 智能体要通过桌面端的 MCP 服务（带 token）来用，不能直接运行 Bridge。桌面端调用时把密钥写进 stdin 第一行
/// （不放命令行参数、环境变量，别的进程看不到），这里和 config.json 里的哈希比对。
func requireCallerKey() {
    let reject = "Agent Loft Bridge only accepts calls from the Agent Loft desktop app. Use its MCP server (Agent Loft → 设置 → 苹果应用)."
    guard let want = bridgeConfig.keyHash, !want.isEmpty else { fail(reject) }
    // 终端里直接敲的：没有密钥，别傻等输入
    if isatty(STDIN_FILENO) != 0 { fail(reject) }
    var pfd = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
    guard poll(&pfd, 1, 5000) > 0 else { fail(reject) }
    // 一个字节一个字节读到换行，不多读：后面的 stdin 还要原样留给子进程
    var bytes: [UInt8] = []
    var b: UInt8 = 0
    while bytes.count < 512, read(STDIN_FILENO, &b, 1) == 1, b != 10 { bytes.append(b) }
    let got = sha256Hex(bytes)
    // 定长比较，不提前退出
    guard got.count == want.count else { fail(reject) }
    var diff: UInt8 = 0
    for (x, y) in zip(got.utf8, want.utf8) { diff |= x ^ y }
    if diff != 0 { fail(reject) }
}

func sha256Hex(_ bytes: [UInt8]) -> String {
    SHA256.hash(data: Data(bytes)).map { String(format: "%02x", $0) }.joined()
}
