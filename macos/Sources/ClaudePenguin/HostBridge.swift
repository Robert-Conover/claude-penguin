import AppKit
import UniformTypeIdentifiers
import WebKit

/// Receives `window.webkit.messageHandlers.claudePenguinHost.postMessage({type, path})`.
@MainActor
final class HostBridge: NSObject, WKScriptMessageHandler {
    static let handlerName = "claudePenguinHost"
    static let editorDefaultsKey = "editorApplicationPath"

    private let policy: () -> OriginPolicy
    private let validator: () -> HostPathValidator
    private let defaults: UserDefaults

    init(policy: @escaping () -> OriginPolicy, validator: @escaping () -> HostPathValidator,
         defaults: UserDefaults = .standard) {
        self.policy = policy
        self.validator = validator
        self.defaults = defaults
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let frame = message.frameInfo
        let origin = frame.securityOrigin
        guard frame.isMainFrame,
              policy().allows(scheme: origin.protocol, host: origin.host, port: origin.port) else {
            DevLog.host("rejected origin \(origin.protocol)://\(origin.host):\(origin.port) mainFrame=\(frame.isMainFrame)")
            return
        }
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String,
              let path = body["path"] as? String else { return }
        guard let url = validator().validate(path) else {
            DevLog.host("rejected path \(path)")
            return
        }
        DevLog.host("valid path, type=\(type) \(url.path)")
        switch type {
        case "reveal": reveal(url)
        case "openInEditor": openInEditor(url)
        default: break
        }
    }

    func reveal(_ url: URL) {
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    func openInEditor(_ url: URL) {
        guard let editor = editorURL() else { reveal(url); return }
        let config = NSWorkspace.OpenConfiguration()
        NSWorkspace.shared.open([url], withApplicationAt: editor, configuration: config) { [weak self] _, error in
            if error != nil { Task { @MainActor in self?.reveal(url) } }
        }
    }

    /// The remembered editor, or one the user picks now. Nil means fall back to Finder.
    private func editorURL() -> URL? {
        if let saved = defaults.string(forKey: Self.editorDefaultsKey),
           FileManager.default.fileExists(atPath: saved) {
            return URL(fileURLWithPath: saved)
        }
        return Self.chooseEditor(defaults: defaults)
    }

    @discardableResult
    static func chooseEditor(defaults: UserDefaults = .standard) -> URL? {
        let panel = NSOpenPanel()
        panel.title = "Choose an Editor"
        panel.message = "Choose the app to open puffle worktrees with. You only need to do this once."
        panel.prompt = "Choose"
        panel.allowedContentTypes = [.application]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        defaults.set(url.path, forKey: editorDefaultsKey)
        return url
    }
}
