import AppKit
import SwiftUI
import WebKit

/// Tracks the live web view so menu commands can reach it and window close can release it.
@MainActor
final class WebViewRegistry {
    static let shared = WebViewRegistry()
    weak var current: WKWebView?
    /// Web views kept alive briefly after `about:blank` so the page can unload and log off.
    private var retiring: [WKWebView] = []

    func reload() { current?.reload() }

    func retire(_ webView: WKWebView) {
        webView.stopLoading()
        webView.load(URLRequest(url: URL(string: "about:blank")!))
        retiring.append(webView)
        if current === webView { current = nil }
        Task { @MainActor [weak self, webView] in
            try? await Task.sleep(for: .seconds(1))
            self?.retiring.removeAll { $0 === webView }
        }
    }
}

struct GameWebView: NSViewRepresentable {
    let model: AppModel

    func makeCoordinator() -> GameWebCoordinator { GameWebCoordinator(model: model) }

    func makeNSView(context: Context) -> WKWebView {
        let coordinator = context.coordinator
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.isElementFullscreenEnabled = true
        // Keep the game running while its window is open but behind other windows (for example the
        // user's editor while a puffle works). The default throttles or suspends an occluded web view,
        // which freezes Ruffle and its game connection. Closing the window still unloads the page.
        config.preferences.inactiveSchedulingPolicy = .none
        config.userContentController.add(coordinator.bridge, name: HostBridge.handlerName)
        DevConsole.install(on: config.userContentController)

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = coordinator
        webView.uiDelegate = coordinator
        webView.allowsBackForwardNavigationGestures = false
        webView.setValue(false, forKey: "drawsBackground")
        if ProcessInfo.processInfo.environment["CP_APP_DEV_INSPECT"] == "1" { webView.isInspectable = true }
        coordinator.webView = webView
        WebViewRegistry.shared.current = webView
        if let url = model.gameURL { coordinator.load(url) }
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {}

    static func dismantleNSView(_ webView: WKWebView, coordinator: GameWebCoordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: HostBridge.handlerName)
        DevConsole.uninstall(from: webView.configuration.userContentController)
        WebViewRegistry.shared.retire(webView)
    }
}

@MainActor
final class GameWebCoordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
    let model: AppModel
    let bridge: HostBridge
    weak var webView: WKWebView?
    private var retries = 0
    private var target: URL?

    init(model: AppModel) {
        self.model = model
        self.bridge = HostBridge(policy: { model.originPolicy }, validator: { model.hostValidator })
        super.init()
    }

    func load(_ url: URL) {
        target = url
        webView?.load(URLRequest(url: url))
    }

    // MARK: Navigation policy

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if model.originPolicy.allowsNavigation(to: url) {
            // A link that asks for a new window stays out of the game view unless it is ours.
            decisionHandler(.allow)
            return
        }
        // Subresource-style schemes inside frames the page itself created.
        if action.targetFrame?.isMainFrame == false, ["blob", "data", "about"].contains(url.scheme ?? "") {
            decisionHandler(.allow)
            return
        }
        if action.targetFrame?.isMainFrame != false { openExternally(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // window.open and target=_blank: never a second in-app web view.
        if let url = action.request.url { openExternally(url) }
        return nil
    }

    private func openExternally(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) else { return }
        NSWorkspace.shared.open(url)
    }

    // MARK: Failure handling

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard let target, retries < 6, (error as NSError).code != NSURLErrorCancelled else { return }
        retries += 1
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(1))
            self?.webView?.load(URLRequest(url: target))
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { retries = 0 }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    // MARK: JavaScript panels

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        let alert = makeAlert(message: message, frame: frame)
        alert.addButton(withTitle: "OK")
        present(alert, in: webView) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        let alert = makeAlert(message: message, frame: frame)
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        present(alert, in: webView) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void) {
        let alert = makeAlert(message: prompt, frame: frame)
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        present(alert, in: webView) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    private func makeAlert(message: String, frame: WKFrameInfo) -> NSAlert {
        let alert = NSAlert()
        alert.messageText = frame.request.url?.host.map { "\($0) says" } ?? Product.name
        alert.informativeText = message
        return alert
    }

    private func present(_ alert: NSAlert, in webView: WKWebView, completion: @escaping @MainActor (NSApplication.ModalResponse) -> Void) {
        if let window = webView.window {
            alert.beginSheetModal(for: window) { response in Task { @MainActor in completion(response) } }
        } else {
            completion(alert.runModal())
        }
    }
}
