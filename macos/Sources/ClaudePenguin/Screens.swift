import AppKit
import SwiftUI

struct RootView: View {
    let model: AppModel

    var body: some View {
        Group {
            switch model.screen {
            case .game:
                GameWebView(model: model)
            default:
                ZStack {
                    CozyBackground()
                    ScrollView {
                        VStack { content }
                            .frame(maxWidth: .infinity, minHeight: 520)
                            .padding(40)
                    }
                }
            }
        }
        .frame(minWidth: 760, minHeight: 560)
    }

    @ViewBuilder private var content: some View {
        switch model.screen {
        case .moveToApplications(let issue): MoveToApplicationsView(issue: issue)
        case .connecting: BusyView(title: "Waking up the island", detail: "Getting things ready.")
        case .welcome: WelcomeView(model: model)
        case .preflight(let mode): PreflightView(model: model, mode: mode)
        case .setup: SetupProgressView(model: model)
        case .starting: StartingView(model: model)
        case .stopping: BusyView(title: "Tucking everything in", detail: "Saving your progress and stopping the island.")
        case .recovery: RecoveryView(model: model)
        case .problem: ProblemView(model: model)
        case .controllerDied(let reason): ControllerDiedView(model: model, reason: reason)
        case .game: EmptyView()
        }
    }
}

// MARK: - Shared pieces

struct Heading: View {
    let symbol: String
    let title: String
    var detail: String?
    var tint: Color = Theme.accent

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 44, weight: .semibold))
                .foregroundStyle(tint)
                .symbolRenderingMode(.hierarchical)
            Text(title).font(.cozy(.largeTitle, weight: .bold)).multilineTextAlignment(.center)
            if let detail {
                Text(detail).font(.cozy(.title3)).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center).frame(maxWidth: 520)
            }
        }
    }
}

struct BusyView: View {
    let title: String
    let detail: String
    var body: some View {
        Card {
            VStack(spacing: 18) {
                ProgressView().controlSize(.large)
                Text(title).font(.cozy(.title2, weight: .semibold))
                Text(detail).foregroundStyle(.secondary)
            }
            .frame(minWidth: 320)
        }
    }
}

// MARK: - Welcome

struct WelcomeView: View {
    let model: AppModel

    var body: some View {
        VStack(spacing: 24) {
            Heading(symbol: "snowflake", title: "Welcome to \(Product.name)",
                    detail: "Your own little island, with puffles that can help with real code.")
            Card {
                VStack(spacing: 14) {
                    Image(systemName: "pawprint.fill").font(.system(size: 36)).foregroundStyle(Theme.warm)
                    Text("Set up your island").font(.cozy(.title2, weight: .semibold))
                    Text("This downloads the game and Claude Code, once. Each project you add gets a puffle and its own Claude Code session. You can play without a Claude account: you sign in to Claude yourself, inside a puffle's terminal, the first time you open one.")
                        .font(.cozy(.body)).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(width: 440)
            }
            // Below the card, like Start Setup on the next screen.
            Button("Get Started") { model.chooseMode(.code) }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .keyboardShortcut(.defaultAction)
        }
    }
}

// MARK: - Preflight

struct PreflightView: View {
    let model: AppModel
    let mode: Mode

    var body: some View {
        VStack(spacing: 24) {
            Heading(symbol: "checklist", title: "Before we begin",
                    detail: mode == .code ? "Setting up the island and your puffles." : "Setting up the island to explore.")
            Card {
                VStack(alignment: .leading, spacing: 14) {
                    if model.preflightLoading {
                        HStack(spacing: 12) { ProgressView(); Text("Checking your Mac") }.frame(minWidth: 420)
                    } else if let error = model.preflightError {
                        Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    } else if let p = model.preflight {
                        row("Download", ByteFormat.string(p.downloadBytes))
                        row("Space needed", ByteFormat.string(p.requiredBytes))
                        row("Space free", ByteFormat.string(p.freeBytes),
                            warn: (p.freeBytes ?? .max) < (p.requiredBytes ?? 0))
                        if p.portConflicts.isEmpty {
                            row("Ports", "All free")
                        } else {
                            ForEach(p.portConflicts, id: \.port) { c in
                                row("Port \(c.port)", "In use, needed by \(c.service)", warn: true)
                            }
                            Text("Quit whatever is using these ports, then check again.")
                                .font(.callout).foregroundStyle(.secondary)
                        }
                        ForEach(p.problems, id: \.self) { Label($0, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange) }
                        if mode == .code {
                            Divider()
                            Label("The first time Claude works in a folder like Documents, Desktop or Downloads, macOS will ask for your permission. Everything stays on your Mac.",
                                  systemImage: "lock.shield")
                                .font(.callout).foregroundStyle(.secondary)
                        }
                    }
                }
                .frame(width: 520, alignment: .leading)
            }
            HStack(spacing: 12) {
                Button("Back") { model.backToWelcome() }
                Button("Check Again") { model.chooseMode(mode) }.disabled(model.preflightLoading)
                Button("Start Setup") { model.beginSetup() }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                    .disabled(model.preflightLoading || !(model.preflight?.canProceed ?? false))
                    .keyboardShortcut(.defaultAction)
            }
        }
    }

    private func row(_ label: String, _ value: String, warn: Bool = false) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).fontWeight(.medium).foregroundStyle(warn ? Color.orange : Color.primary)
        }
    }
}

// MARK: - Setup progress

struct SetupProgressView: View {
    let model: AppModel
    static let order = ["runtime", "media", "extensions", "database", "claude"]

    var body: some View {
        VStack(spacing: 24) {
            Heading(symbol: "arrow.down.circle.fill", title: "Setting up the island",
                    detail: model.message ?? "This only happens once.")
            Card {
                VStack(alignment: .leading, spacing: 18) {
                    let tasks = Self.order.compactMap { model.progress[$0] }
                        + model.progress.values.filter { !Self.order.contains($0.task) }
                    if tasks.isEmpty {
                        HStack(spacing: 12) { ProgressView(); Text("Starting") }
                    }
                    ForEach(tasks, id: \.task) { TaskRow(event: $0) }
                    if let problem = model.lastProblem {
                        Label(problem.message ?? problem.code, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                }
                .frame(width: 520, alignment: .leading)
            }
            HStack(spacing: 12) {
                Button("Cancel") { model.cancelSetup() }
                if model.lastProblem != nil || model.requestError != nil {
                    Button("Retry") { model.retrySetup() }.buttonStyle(.borderedProminent).controlSize(.large)
                }
            }
        }
    }
}

struct TaskRow: View {
    let event: ProgressEvent

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(event.label ?? event.task.capitalized).fontWeight(.medium)
                Spacer()
                Text(detail).font(.callout.monospacedDigit()).foregroundStyle(.secondary)
            }
            if let f = event.fraction {
                ProgressView(value: f)
            } else {
                ProgressView().progressViewStyle(.linear)
            }
        }
    }

    private var detail: String {
        guard let done = event.done else { return "" }
        let isBytes = (event.total ?? done) > 100_000
        func fmt(_ v: Double) -> String {
            isBytes ? ByteCountFormatter.string(fromByteCount: Int64(v), countStyle: .file) : String(Int(v))
        }
        if let total = event.total { return "\(fmt(done)) of \(fmt(total))" }
        return fmt(done)
    }
}

struct StartingView: View {
    let model: AppModel
    var body: some View {
        VStack(spacing: 24) {
            Heading(symbol: "sunrise.fill", title: "Starting the island", detail: model.message ?? "Almost there.", tint: Theme.warm)
            Card {
                VStack(alignment: .leading, spacing: 8) {
                    if model.services.isEmpty { ProgressView().controlSize(.regular) }
                    ForEach(model.services.keys.sorted(), id: \.self) { name in
                        let svc = model.services[name]!
                        HStack {
                            Image(systemName: svc.state == "healthy" ? "checkmark.circle.fill" : svc.state == "exited" ? "xmark.circle.fill" : "circle.dotted")
                                .foregroundStyle(svc.state == "healthy" ? Color.green : svc.state == "exited" ? Color.red : Color.secondary)
                            Text(name.capitalized)
                            Spacer()
                            Text(svc.state).foregroundStyle(.secondary)
                        }
                    }
                }
                .frame(width: 360)
            }
        }
    }
}

// MARK: - Problems

struct ProblemView: View {
    let model: AppModel

    var body: some View {
        let problem = model.lastProblem
        VStack(spacing: 24) {
            Heading(symbol: "exclamationmark.triangle.fill", title: Self.title(for: problem?.code),
                    detail: problem?.message ?? model.requestError ?? model.message ?? "Something did not go as expected.",
                    tint: .orange)
            if let problem {
                Text("Code: \(problem.code)").font(.caption.monospaced()).foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
                Button("Show Log") { revealLog(model.paths.controllerLog) }
                Button("Quit") { quitApp() }
                Button("Try Again") { model.retryStart() }.buttonStyle(.borderedProminent).controlSize(.large)
            }
        }
    }

    static func title(for code: String?) -> String {
        switch code {
        case "PORT_IN_USE": "Something else is using a port"
        case "DISK_SPACE": "Not enough space"
        case "DOWNLOAD": "The download did not finish"
        case "VERIFY": "A download did not check out"
        case "SERVICE_FAILED": "A part of the island stopped"
        case "SURVIVOR": "A leftover process is still running"
        default: "Something went wrong"
        }
    }
}

struct ControllerDiedView: View {
    let model: AppModel
    let reason: String

    var body: some View {
        VStack(spacing: 24) {
            Heading(symbol: "bolt.slash.fill", title: "The island stopped unexpectedly",
                    detail: "\(Product.name)'s background helper is no longer running.", tint: .orange)
            Card {
                Text(reason).font(.callout.monospaced()).textSelection(.enabled)
                    .frame(width: 520, alignment: .leading)
            }
            HStack(spacing: 12) {
                Button("Show Log") { revealLog(model.paths.controllerLog) }
                Button("Quit") { quitApp() }
                Button("Restart") { model.restartController() }.buttonStyle(.borderedProminent).controlSize(.large)
            }
        }
    }
}

func revealLog(_ url: URL) {
    if FileManager.default.fileExists(atPath: url.path) {
        NSWorkspace.shared.activateFileViewerSelecting([url])
    } else {
        NSWorkspace.shared.open(url.deletingLastPathComponent())
    }
}

// MARK: - Recovery

struct RecoveryView: View {
    let model: AppModel

    var body: some View {
        VStack(spacing: 24) {
            Heading(symbol: "arrow.triangle.2.circlepath", title: "Leftovers from last time",
                    detail: model.message ?? "Parts of a previous session are still running. They need to be stopped before the island can start.",
                    tint: Theme.warm)
            if let error = model.requestError {
                Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            }
            HStack(spacing: 12) {
                Button("Quit") { quitApp() }
                Button("Stop Leftover Processes") { model.recover(stopSurvivors: true) }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                    .disabled(model.recoveryBusy)
            }
            if model.recoveryBusy { ProgressView() }
        }
    }
}

// MARK: - Move to Applications

struct MoveToApplicationsView: View {
    let issue: InstallIssue

    var body: some View {
        VStack(spacing: 24) {
            Heading(symbol: "arrow.down.app.fill", title: "Move \(Product.name) to Applications",
                    detail: explanation, tint: Theme.warm)
            Card {
                VStack(alignment: .leading, spacing: 10) {
                    Label("Drag \(Product.name) into your Applications folder.", systemImage: "1.circle.fill")
                    Label("Open it from there.", systemImage: "2.circle.fill")
                    if issue == .readOnlyVolume {
                        Label("Then eject the disk image.", systemImage: "3.circle.fill")
                    }
                }
                .font(.cozy(.body))
                .frame(width: 440, alignment: .leading)
            }
            HStack(spacing: 12) {
                Button("Quit") { quitApp() }
                Button("Show This App") { NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL]) }
                Button("Show Applications") { NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications")) }
                    .buttonStyle(.borderedProminent).controlSize(.large)
            }
        }
    }

    private var explanation: String {
        switch issue {
        case .translocated:
            "macOS opened this copy from a temporary, read-only location that can disappear. Moving it to Applications lets it run normally and keeps your island and future updates in one steady place."
        case .readOnlyVolume:
            "This copy is running from a disk image, which is read-only and goes away when you eject it. Install it in Applications so it can run normally."
        }
    }
}

/// Terminates from a run-loop source, never from inside a dispatch-queue block or a Swift task. `terminate`
/// spins a nested run loop while the quit sequence (async, main actor) runs, and a nested loop cannot service the
/// main dispatch queue that it was itself called from.
func quitApp() {
    RunLoop.main.perform(inModes: [.common]) { NSApp.terminate(nil) }
}
