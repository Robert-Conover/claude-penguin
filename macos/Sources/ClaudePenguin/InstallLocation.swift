import Foundation

enum InstallIssue: Sendable, Equatable {
    /// Gatekeeper path randomization: the app was opened from a quarantined location.
    case translocated
    /// Running from a read-only volume such as a mounted disk image.
    case readOnlyVolume
}

enum InstallLocation {
    /// Pure decision logic so it can be tested without a real volume.
    static func evaluate(bundlePath: String, volumeIsReadOnly: Bool) -> InstallIssue? {
        guard bundlePath.hasSuffix(".app") else { return nil }   // `swift run`, not a bundle
        if bundlePath.contains("/AppTranslocation/") { return .translocated }
        if volumeIsReadOnly { return .readOnlyVolume }
        return nil
    }

    static func evaluateCurrent(env: [String: String] = ProcessInfo.processInfo.environment) -> InstallIssue? {
        if env["CP_APP_DEV_FORCE_MOVE"] == "1" { return .translocated }
        let url = Bundle.main.bundleURL
        let readOnly = (try? url.resourceValues(forKeys: [.volumeIsReadOnlyKey]).volumeIsReadOnly) ?? false
        return evaluate(bundlePath: url.path, volumeIsReadOnly: readOnly)
    }
}
