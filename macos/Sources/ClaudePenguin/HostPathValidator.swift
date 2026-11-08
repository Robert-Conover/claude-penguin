import Foundation

/// Accepts only real paths that lie strictly inside `<data>/worktrees/`.
struct HostPathValidator: Sendable {
    let worktreesRoot: String

    init(worktreesRoot: URL) { self.worktreesRoot = worktreesRoot.path }
    init(worktreesRoot: String) { self.worktreesRoot = worktreesRoot }

    /// Returns the resolved (symlink-free) URL, or nil when the path must be refused.
    func validate(_ raw: String) -> URL? {
        guard !raw.isEmpty, raw.hasPrefix("/"), !raw.contains("\0") else { return nil }
        // Refuse traversal outright instead of trusting normalization.
        if raw.split(separator: "/").contains("..") { return nil }
        guard let root = Self.realPath(worktreesRoot), let resolved = Self.realPath(raw) else { return nil }
        // Compare with a trailing separator so `worktrees-evil` never matches `worktrees`.
        let prefix = root.hasSuffix("/") ? root : root + "/"
        guard resolved.hasPrefix(prefix), resolved.count > prefix.count else { return nil }
        return URL(fileURLWithPath: resolved)
    }

    static func realPath(_ path: String) -> String? {
        guard let p = realpath(path, nil) else { return nil }
        defer { free(p) }
        return String(cString: p)
    }
}
