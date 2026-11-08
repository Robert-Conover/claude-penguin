import Foundation

enum ControllerLiveness: Sendable, Equatable {
    case launching
    case ready
    case died(String)
}

enum Screen: Sendable, Equatable {
    case moveToApplications(InstallIssue)
    case connecting
    case welcome
    case preflight(Mode)
    case setup
    case starting
    case game
    case stopping
    case recovery
    case problem
    case controllerDied(String)
}

/// Everything the screen choice depends on.
struct ScreenInputs: Sendable, Equatable {
    var installIssue: InstallIssue?
    var liveness: ControllerLiveness = .launching
    var state: ControllerState?
    var setupComplete = false
    /// The mode the user picked on the welcome screen, before setup starts.
    var pendingMode: Mode?
}

enum ScreenMapping {
    static func screen(for i: ScreenInputs) -> Screen {
        if let issue = i.installIssue { return .moveToApplications(issue) }
        switch i.liveness {
        case .died(let reason): return .controllerDied(reason)
        case .launching: return .connecting
        case .ready: break
        }
        guard let state = i.state else { return .connecting }
        switch state {
        case .recovery: return .recovery
        case .error: return .problem
        case .running: return .game
        case .settingUp: return .setup
        case .starting: return .starting
        case .stopping: return .stopping
        case .needsSetup:
            if let mode = i.pendingMode { return .preflight(mode) }
            return .welcome
        case .stopped:
            // A configured environment restarts on its own; a fresh one waits for the welcome choice.
            if i.setupComplete { return .connecting }
            if let mode = i.pendingMode { return .preflight(mode) }
            return .welcome
        case .unknown:
            return .connecting
        }
    }
}
