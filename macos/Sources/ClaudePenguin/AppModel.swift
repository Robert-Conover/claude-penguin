import AppKit
import Foundation
import Observation

/// The app's single source of UI truth. It mirrors the controller's state; it never invents progress.
@MainActor
@Observable
final class AppModel {
    // Controller mirror
    var liveness: ControllerLiveness = .launching
    var state: ControllerState?
    var mode: Mode?
    var urls: ControllerURLs?
    var message: String?
    var setupComplete = false
    var sessionsRunning = 0

    // Flow
    var installIssue: InstallIssue?
    var pendingMode: Mode?
    var preflight: PreflightResult?
    var preflightError: String?
    var preflightLoading = false
    var setupMode: Mode?
    var progress: [String: ProgressEvent] = [:]
    var services: [String: ServiceEvent] = [:]
    var lastProblem: ProblemEvent?
    var requestError: String?
    var recoveryBusy = false

    let paths: AppPaths
    private let environment: [String: String]
    private(set) var client = ControllerClient()
    private var controllerEverReady = false

    init(paths: AppPaths, environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.paths = paths
        self.environment = environment
        self.installIssue = InstallLocation.evaluateCurrent(env: environment)
    }

    // MARK: Derived

    var screenInputs: ScreenInputs {
        ScreenInputs(installIssue: installIssue, liveness: liveness, state: state,
                     setupComplete: setupComplete, pendingMode: pendingMode)
    }

    var screen: Screen { ScreenMapping.screen(for: screenInputs) }

    var effectiveMode: Mode { mode ?? setupMode ?? pendingMode ?? .code }

    var gameURL: URL? {
        let s = effectiveMode == .code ? (urls?.agents ?? urls?.game) : (urls?.game ?? urls?.agents)
        return s.flatMap(URL.init(string:))
    }

    var originPolicy: OriginPolicy {
        OriginPolicy(urls: [urls?.game, urls?.agents].compactMap { $0 })
    }

    var hostValidator: HostPathValidator { HostPathValidator(worktreesRoot: paths.worktrees) }

    // MARK: Launch

    func launch() {
        guard installIssue == nil else { return }   // never start servers from a translocated copy
        startController()
    }

    func restartController() {
        state = nil
        lastProblem = nil
        requestError = nil
        client = ControllerClient()
        startController()
    }

    private func startController() {
        liveness = .launching
        var env = environment
        for key in env.keys where key.hasPrefix("CP_APP_DEV_") { env.removeValue(forKey: key) }
        env["HOME"] = env["HOME"] ?? NSHomeDirectory()
        let launch = ControllerLaunch(node: paths.node, arguments: paths.controllerArguments,
                                      environment: env, logFile: paths.controllerLog)
        client.onEvent = { [weak self] in self?.apply($0) }
        client.onExit = { [weak self] status, expected in self?.controllerExited(status: status, expected: expected) }
        do {
            try client.start(launch)
        } catch {
            liveness = .died(error.localizedDescription)
            return
        }
        Task { await bootstrap() }
    }

    private func bootstrap() async {
        do {
            let response = try await client.request("status", timeout: .seconds(20))
            guard response.ok, let status = response.decodeResult(StatusResult.self) else {
                if response.error?.code == "LOCKED" {
                    liveness = .died("Another copy of \(Product.name), or a ./launch session, is already using this data folder. Quit it and try again.")
                } else {
                    liveness = .died(response.error?.message ?? "The controller sent an unreadable status.")
                }
                return
            }
            liveness = .ready
            controllerEverReady = true
            applyStatus(status)
            if status.setupComplete, status.state == .stopped || status.state == .needsSetup {
                if status.mode == .explore {
                    // Earlier builds could set up the game alone. The app now always sets up code mode;
                    // the controller runs only the missing Claude step, then the environment starts.
                    runSetup(mode: .code)
                } else {
                    await startEnvironment()
                }
            }
        } catch {
            if case .died = liveness { return }
            liveness = .died(error.localizedDescription)
        }
    }

    private func controllerExited(status: Int32, expected: Bool) {
        if expected { return }
        let tail = Self.logTail(paths.controllerLog)
        var reason = "The controller exited unexpectedly (status \(status))."
        if !tail.isEmpty { reason += "\n\n" + tail }
        liveness = .died(reason)
    }

    static func logTail(_ url: URL, lines: Int = 6) -> String {
        guard let data = try? Data(contentsOf: url), let text = String(data: data.suffix(4000), encoding: .utf8) else { return "" }
        return text.split(separator: "\n").suffix(lines).joined(separator: "\n")
    }

    // MARK: Events

    func apply(_ event: ControllerEvent) {
        switch event {
        case .state(let s):
            if liveness == .launching { liveness = .ready }
            state = s.state
            if let m = s.mode { mode = m }
            if let u = s.urls { urls = u }
            message = s.message
            if s.state == .running { lastProblem = nil; requestError = nil }
            if s.state == .needsSetup || s.state == .stopped { sessionsRunning = 0 }
        case .progress(let p):
            progress[p.task] = p
        case .service(let svc):
            services[svc.name] = svc
        case .problem(let p):
            lastProblem = p
        case .unknown:
            break
        }
    }

    private func applyStatus(_ s: StatusResult) {
        state = s.state
        if let m = s.mode { mode = m }
        if let u = s.urls { urls = u }
        setupComplete = s.setupComplete
        sessionsRunning = s.sessions?.running ?? 0
    }

    func refreshStatus() async {
        guard let response = try? await client.request("status", timeout: .seconds(10)),
              response.ok, let status = response.decodeResult(StatusResult.self) else { return }
        applyStatus(status)
    }

    // MARK: Actions

    func chooseMode(_ mode: Mode) {
        pendingMode = mode
        preflight = nil
        preflightError = nil
        preflightLoading = true
        Task {
            do {
                let response = try await client.request("preflight", ["mode": .string(mode.rawValue)], timeout: .seconds(60))
                guard pendingMode == mode else { return }
                if response.ok, let result = response.decodeResult(PreflightResult.self) {
                    preflight = result
                } else {
                    preflightError = response.error?.message ?? "The preflight check failed."
                }
            } catch {
                preflightError = error.localizedDescription
            }
            preflightLoading = false
        }
    }

    func backToWelcome() {
        pendingMode = nil
        preflight = nil
        preflightError = nil
    }

    func beginSetup() {
        guard let mode = pendingMode ?? setupMode else { return }
        runSetup(mode: mode)
    }

    func retrySetup() {
        guard let mode = setupMode ?? mode ?? pendingMode else { return }
        runSetup(mode: mode)
    }

    private func runSetup(mode: Mode) {
        setupMode = mode
        pendingMode = nil
        progress = [:]
        lastProblem = nil
        requestError = nil
        state = .settingUp
        Task {
            do {
                let response = try await client.request("setup", ["mode": .string(mode.rawValue)])
                if response.ok {
                    setupComplete = true
                    await startEnvironment()
                } else if response.error?.code == "CANCELLED" || response.error?.code == "CANCELED" {
                    // The state event decides where the user lands.
                } else {
                    requestError = response.error?.message
                    if state == .settingUp { state = .error }
                }
            } catch {
                if case .died = liveness { return }
                requestError = error.localizedDescription
            }
        }
    }

    func cancelSetup() {
        Task {
            _ = try? await client.request("cancel", timeout: .seconds(20))
            await refreshStatus()
            if state == .settingUp { state = .needsSetup }
            if !setupComplete { backToWelcome() }
        }
    }

    func startEnvironment() async {
        if state == .starting || state == .running { return }
        do {
            let response = try await client.request("start")
            if !response.ok {
                requestError = response.error?.message
                if state != .error { lastProblem = lastProblem ?? ProblemEvent(code: response.error?.code ?? "UNKNOWN", message: response.error?.message) }
                state = .error
            }
        } catch {
            if case .died = liveness { return }
            requestError = error.localizedDescription
        }
    }

    func retryStart() {
        if setupComplete {
            state = .stopped
            lastProblem = nil
            Task { await startEnvironment() }
        } else {
            retrySetup()
        }
    }

    func recover(stopSurvivors: Bool) {
        recoveryBusy = true
        Task {
            defer { recoveryBusy = false }
            do {
                let response = try await client.request("recover", ["action": .string(stopSurvivors ? "stop-survivors" : "ignore")], timeout: .seconds(60))
                if !response.ok { requestError = response.error?.message }
            } catch {
                requestError = error.localizedDescription
            }
            await refreshStatus()
            if setupComplete, state == .stopped || state == .needsSetup { await startEnvironment() }
        }
    }

    // MARK: Quit support

    /// True when something is running that a quit would interrupt.
    func runningSessionCount() async -> Int {
        guard client.isRunning else { return 0 }
        guard let response = try? await client.request("status", timeout: .seconds(5)),
              response.ok, let status = response.decodeResult(StatusResult.self) else { return 0 }
        return status.sessions?.running ?? 0
    }

    var needsStopBeforeQuit: Bool {
        guard client.isRunning else { return false }
        switch state {
        case nil, .needsSetup?, .stopped?: return false
        default: return true
        }
    }

    /// Sends `stop` and waits for the `stopped` state (event or response), bounded by `timeout`.
    func stopEnvironment(timeout: Duration) async -> Bool {
        guard client.isRunning else { return true }
        var responded = false
        let client = self.client
        Task { @MainActor in
            if let r = try? await client.request("stop"), r.ok { responded = true }
        }
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if responded || state == .stopped || state == .needsSetup { return true }
            if !client.isRunning { return true }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return false
    }

    var controllerIsAlive: Bool { client.isRunning }
    func closeControllerInput() { client.closeInput() }
    func waitForControllerExit(_ timeout: Duration) async -> Bool { await client.waitForExit(timeout: timeout) }
    func forceKillController() { client.forceKill() }
}
