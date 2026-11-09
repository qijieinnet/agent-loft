// 删除、修改前在这台 Mac 上弹原生确认框。不管是谁调用的 Bridge（智能体、别的 node 服务、终端），
// 都得用户在屏幕前点「允许」才执行。桌面端设置里可以关掉（config.json 的 confirmWrites）。
import AppKit

/// 等用户多久，没人点就当拒绝
let confirmTimeout: TimeInterval = 120

/// 弹确认框；拒绝、超时都直接退出（exit 1），返回了就是允许
func confirmWrite(_ action: String, _ detail: String) {
    guard bridgeConfig.confirmWrites else { return }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.activate(ignoringOtherApps: true)

    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "智能体请求\(action)"
    alert.informativeText = detail + "\n\n\(Int(confirmTimeout / 60)) 分钟内不处理会自动拒绝。可以在 Agent Loft 设置 → 苹果日历 / 提醒事项 / 备忘录 里关掉这个确认。"
    alert.addButton(withTitle: "拒绝")
    alert.addButton(withTitle: "允许")
    alert.window.level = .floating

    var timedOut = false
    let timer = Timer(timeInterval: confirmTimeout, repeats: false) { _ in
        timedOut = true
        app.abortModal()
    }
    RunLoop.main.add(timer, forMode: .modalPanel)
    let resp = alert.runModal()
    timer.invalidate()
    if timedOut { fail("the user did not confirm on the Mac within \(Int(confirmTimeout)) seconds; nothing was changed") }
    if resp != .alertSecondButtonReturn { fail("the user declined this \(action) on the Mac; nothing was changed. Do not retry unless the user asks.") }
}

/// 修改命令里传了哪些字段，给确认框看
func describeChanges(_ keys: [String]) -> String {
    let changed = keys.filter { opts[$0] != nil }.map { k -> String in
        let v = opts[k] ?? ""
        let shown = v.count > 80 ? String(v.prefix(80)) + "…" : v
        return "  \(k)：\(shown.isEmpty ? "（清空）" : shown)"
    }
    return changed.isEmpty ? "" : "\n改动：\n" + changed.joined(separator: "\n")
}
