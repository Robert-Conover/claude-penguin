import AppKit
import WebKit

/// Development aid: with CP_APP_DEV_SNAPSHOT_DIR set, writes a PNG of the window each time the visible screen
/// changes. It renders the app's own views, so it needs no Screen Recording permission. Off unless the variable is set.
@MainActor
final class DevSnapshot {
    private let directory: URL
    private var lastKey = ""
    private var sequence = 0
    private var timer: Timer?

    init?(env: [String: String]) {
        guard let dir = env["CP_APP_DEV_SNAPSHOT_DIR"], !dir.isEmpty else { return nil }
        directory = URL(fileURLWithPath: dir)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    private var model: AppModel?
    private var windowProvider: (@MainActor () -> NSWindow?)?

    func start(model: AppModel, window: @escaping @MainActor () -> NSWindow?) {
        self.model = model
        windowProvider = window
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    private func tick() {
        guard let model, let window = windowProvider?() else { return }
        let key = String(String(describing: model.screen).prefix(40))
        guard key != lastKey else { return }
        lastKey = key
        sequence += 1
        let name = String(format: "%02d-%@", sequence, key.components(separatedBy: CharacterSet.alphanumerics.inverted).joined(separator: "-"))
        // Let the new screen lay out first.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [directory] in
            MainActor.assumeIsolated {
                let url = directory.appendingPathComponent(name + ".png")
                if let web = WebViewRegistry.shared.current {
                    web.takeSnapshot(with: nil) { image, _ in
                        if let image { Self.write(image, to: url) }
                    }
                } else if let view = window.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
                    view.cacheDisplay(in: view.bounds, to: rep)
                    if let data = rep.representation(using: .png, properties: [:]) { try? data.write(to: url) }
                }
            }
        }
    }

    private static func write(_ image: NSImage, to url: URL) {
        guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
              let data = rep.representation(using: .png, properties: [:]) else { return }
        try? data.write(to: url)
    }
}

/// Development aid: CP_APP_DEV_AUTOPILOT="choose|begin|wait:3|js:document.title|close|reopen|quit" drives the UI through its own
/// model so the walkthrough can be scripted without Accessibility or Screen Recording permission.
/// Each step waits until the screen it needs is showing. Off unless the variable is set.
@MainActor
final class DevAutopilot {
    private var steps: [String]
    private let model: AppModel
    private weak var delegate: AppDelegate?
    private var timer: Timer?
    private var notBefore = Date()

    init?(env: [String: String], model: AppModel, delegate: AppDelegate) {
        guard let raw = env["CP_APP_DEV_AUTOPILOT"], !raw.isEmpty else { return nil }
        steps = raw.split(separator: "|").map { String($0) }
        self.model = model
        self.delegate = delegate
    }

    func start() {
        timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    private func tick() {
        guard let step = steps.first, Date() >= notBefore else { return }
        let screen = model.screen
        var done = false
        switch step {
        case let s where s.hasPrefix("choose"):
            if screen == .welcome { model.chooseMode(.code); done = true } // the app always sets up code mode
        case "begin":
            if case .preflight = screen, !model.preflightLoading, model.preflight?.canProceed == true { model.beginSetup(); done = true }
        case "cancel":
            if screen == .setup { model.cancelSetup(); done = true }
        case "retry":
            if screen == .setup && model.lastProblem != nil { model.retrySetup(); done = true }
            else if screen == .problem { model.retryStart(); done = true }
        case "recover":
            if screen == .recovery { model.recover(stopSurvivors: true); done = true }
        case "restart":
            if case .controllerDied = screen { model.restartController(); done = true }
        case "close":
            if screen == .game, let w = NSApp.windows.first(where: { $0.isVisible && $0.title == Product.name }) { w.performClose(nil); done = true }
        case "reopen":
            if NSApp.windows.allSatisfy({ !$0.isVisible }) { delegate?.showWindow(); done = true }
        case let s where s.hasPrefix("js:"):
            if screen == .game, let web = WebViewRegistry.shared.current {
                let code = String(s.dropFirst(3))
                let log = ProcessInfo.processInfo.environment["CP_APP_DEV_SNAPSHOT_DIR"].map { URL(fileURLWithPath: $0).appendingPathComponent("js.log") }
                web.evaluateJavaScript(code) { value, error in
                    let line = "\(code) => \(value.map { "\($0)" } ?? "nil") \(error.map { "ERR \($0)" } ?? "")\n"
                    if let log, let data = line.data(using: .utf8) {
                        if let h = try? FileHandle(forWritingTo: log) { _ = try? h.seekToEnd(); try? h.write(contentsOf: data); try? h.close() }
                        else { try? data.write(to: log) }
                    }
                }
                done = true
            }
        case let s where s.hasPrefix("snap:"):
            // A web-view picture on demand (the game renders after its screen first appears).
            if screen == .game, let web = WebViewRegistry.shared.current,
               let dir = ProcessInfo.processInfo.environment["CP_APP_DEV_SNAPSHOT_DIR"] {
                let url = URL(fileURLWithPath: dir).appendingPathComponent(String(s.dropFirst(5)) + ".png")
                web.takeSnapshot(with: nil) { image, _ in
                    guard let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                          let data = rep.representation(using: .png, properties: [:]) else { return }
                    try? data.write(to: url)
                }
                done = true
            }
        case "front":
            // An app started from a script opens behind the active app; WebKit then reports the page hidden.
            NSApp.activate()
            NSApp.windows.first(where: { $0.isVisible && $0.title == Product.name })?.orderFrontRegardless()
            done = true
        case "quit":
            quitApp(); done = true
        case let s where s.hasPrefix("wait:"):
            notBefore = Date().addingTimeInterval(Double(s.dropFirst(5)) ?? 1); done = true
        default:
            done = true
        }
        if done {
            steps.removeFirst()
            if notBefore < Date() { notBefore = Date().addingTimeInterval(1.6) }   // give snapshots time to settle
        }
    }
}

/// Development aid: appends a line to `$CP_APP_DEV_SNAPSHOT_DIR/host.log` (no-op when unset).
enum DevLog {
    static func host(_ line: String) {
        NSLog("claudePenguinHost: %@", line)
        guard let dir = ProcessInfo.processInfo.environment["CP_APP_DEV_SNAPSHOT_DIR"] else { return }
        let url = URL(fileURLWithPath: dir).appendingPathComponent("host.log")
        let data = Data((line + "\n").utf8)
        if let h = try? FileHandle(forWritingTo: url) { _ = try? h.seekToEnd(); try? h.write(contentsOf: data); try? h.close() }
        else { try? data.write(to: url) }
    }
}

/// Development aid: with CP_APP_DEV_SNAPSHOT_DIR set, copies the page's console output and uncaught
/// errors to `$CP_APP_DEV_SNAPSHOT_DIR/console.log`. Not installed otherwise.
@MainActor
final class DevConsole: NSObject, WKScriptMessageHandler {
    static let handlerName = "claudePenguinDevConsole"
    private static var shared: DevConsole?
    private let file: URL

    private init(file: URL) { self.file = file }

    static func install(on controller: WKUserContentController) {
        guard let dir = ProcessInfo.processInfo.environment["CP_APP_DEV_SNAPSHOT_DIR"], !dir.isEmpty else { return }
        let console = shared ?? DevConsole(file: URL(fileURLWithPath: dir).appendingPathComponent("console.log"))
        shared = console
        controller.add(console, name: handlerName)
        let source = """
        (() => {
          const post = (level, args) => { try { window.webkit.messageHandlers.\(handlerName).postMessage(level + ' ' + args.map(a => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); } }).join(' ')); } catch {} };
          for (const level of ['log', 'info', 'warn', 'error', 'debug']) { const original = console[level]; console[level] = (...args) => { post(level, args); original.apply(console, args); }; }
          window.addEventListener('error', e => post('uncaught', [e.message, e.filename + ':' + e.lineno]));
          window.addEventListener('unhandledrejection', e => post('unhandled', [String(e.reason)]));
        })();
        """
        controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    static func uninstall(from controller: WKUserContentController) {
        guard shared != nil else { return }
        controller.removeScriptMessageHandler(forName: handlerName)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let text = message.body as? String, let data = (text.prefix(2000) + "\n").data(using: .utf8) else { return }
        if let handle = try? FileHandle(forWritingTo: file) { _ = try? handle.seekToEnd(); try? handle.write(contentsOf: data); try? handle.close() }
        else { try? data.write(to: file) }
    }
}
