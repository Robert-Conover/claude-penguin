import AppKit
import SwiftUI
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private(set) var model: AppModel!
    private var window: NSWindow?
    private var quitting = false
    private var quitPanel: NSPanel?
    private var devSnapshot: DevSnapshot?
    private var devAutopilot: DevAutopilot?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let env = ProcessInfo.processInfo.environment
        let bundled = Bundle.main.bundleURL.pathExtension == "app" ? Bundle.main.resourceURL : nil
        model = AppModel(paths: AppPaths.resolve(env: env, bundleResources: bundled), environment: env)
        NSApp.mainMenu = MainMenu.build(target: self)
        showWindow()
        model.launch()
        devSnapshot = DevSnapshot(env: env)
        devSnapshot?.start(model: model) { [weak self] in self?.window }
        devAutopilot = DevAutopilot(env: env, model: model, delegate: self)
        devAutopilot?.start()
        NSApp.activate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showWindow() }
        return true
    }

    // MARK: Window

    func showWindow() {
        if let window { window.makeKeyAndOrderFront(nil); return }
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 780),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable],
                         backing: .buffered, defer: false)
        w.title = Product.name
        w.isReleasedWhenClosed = false
        w.collectionBehavior = [.fullScreenPrimary]
        w.contentMinSize = NSSize(width: 760, height: 560)
        w.delegate = self
        let hosting = NSHostingView(rootView: RootView(model: model))
        hosting.sizingOptions = []
        w.contentView = hosting
        w.setFrameAutosaveName("MainWindow")
        if !w.setFrameUsingName("MainWindow") { w.center() }
        w.makeKeyAndOrderFront(nil)
        window = w
    }

    /// Closing the window logs the penguin off: the web view is replaced by `about:blank` and released.
    /// The app and the controller keep running.
    func windowWillClose(_ notification: Notification) {
        guard let w = notification.object as? NSWindow, w === window else { return }
        w.delegate = nil
        w.contentView = nil   // dismantles GameWebView, which loads about:blank and retires the web view
        window = nil
    }

    // MARK: Menu actions

    @objc func reloadPage(_ sender: Any?) { WebViewRegistry.shared.reload() }

    @objc func toggleFullScreenWindow(_ sender: Any?) { window?.toggleFullScreen(nil) }

    @objc func chooseEditor(_ sender: Any?) { HostBridge.chooseEditor() }

    @objc func showControllerLog(_ sender: Any?) { revealLog(model.paths.controllerLog) }

    @objc func showDataFolder(_ sender: Any?) { NSWorkspace.shared.open(model.paths.data) }

    @objc func showMainWindow(_ sender: Any?) { showWindow() }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(reloadPage(_:)) { return WebViewRegistry.shared.current != nil }
        return true
    }

    // MARK: Quit

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitting { return .terminateLater }
        guard let model, model.controllerIsAlive else { return .terminateNow }
        quitting = true
        Task { @MainActor in
            let proceed = await self.runQuitSequence()
            self.quitting = false
            self.dismissQuitPanel()
            NSApp.reply(toApplicationShouldTerminate: proceed)
        }
        return .terminateLater
    }

    /// 1. confirm if sessions run, 2. stop and wait (bounded, with Force Quit), 3. close stdin and let the controller exit.
    private func runQuitSequence() async -> Bool {
        let running = await model.runningSessionCount()
        if running > 0 {
            let alert = NSAlert()
            alert.messageText = "Quit \(Product.name)?"
            alert.informativeText = running == 1
                ? "A Claude coding session is running. Quitting ends it. Saved conversations can be resumed next time."
                : "\(running) Claude coding sessions are running. Quitting ends them. Saved conversations can be resumed next time."
            alert.addButton(withTitle: "Quit")
            alert.addButton(withTitle: "Cancel")
            alert.alertStyle = .warning
            if alert.runModal() != .alertFirstButtonReturn { return false }
        }

        if model.needsStopBeforeQuit {
            var forced = false
            showQuitPanel(forceQuit: { forced = true })
            var stopped = false
            while !stopped && !forced {
                stopped = await model.stopEnvironment(timeout: .seconds(30))
                if forced { break }
                if !stopped {
                    let alert = NSAlert()
                    alert.messageText = "\(Product.name) is taking a while to stop"
                    alert.informativeText = "You can keep waiting, or force quit. Force quitting stops the background helper immediately and may leave a service to be cleaned up on the next launch."
                    alert.addButton(withTitle: "Keep Waiting")
                    alert.addButton(withTitle: "Force Quit")
                    if alert.runModal() == .alertSecondButtonReturn { forced = true }
                }
            }
            if forced {
                model.closeControllerInput()
                model.forceKillController()
                return true
            }
        }

        model.closeControllerInput()
        if !(await model.waitForControllerExit(.seconds(10))) {
            model.forceKillController()
        }
        return true
    }

    private func showQuitPanel(forceQuit: @escaping () -> Void) {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 340, height: 130),
                            styleMask: [.titled, .fullSizeContentView], backing: .buffered, defer: false)
        panel.title = Product.name
        panel.isReleasedWhenClosed = false
        panel.center()
        panel.contentView = NSHostingView(rootView: QuitPanelView(forceQuit: forceQuit))
        panel.makeKeyAndOrderFront(nil)
        quitPanel = panel
    }

    private func dismissQuitPanel() {
        quitPanel?.orderOut(nil)
        quitPanel = nil
    }
}

struct QuitPanelView: View {
    let forceQuit: () -> Void
    var body: some View {
        VStack(spacing: 14) {
            HStack(spacing: 12) {
                ProgressView().controlSize(.small)
                Text("Stopping the island…").font(.headline)
            }
            Button("Force Quit") { forceQuit() }
        }
        .padding(24)
        .frame(width: 340, height: 130)
    }
}
