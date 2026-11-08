import Foundation

struct Origin: Hashable, Sendable {
    var scheme: String
    var host: String
    var port: Int

    init(scheme: String, host: String, port: Int?) {
        self.scheme = scheme.lowercased()
        self.host = host.lowercased()
        let p = port ?? 0
        self.port = p > 0 ? p : Origin.defaultPort(for: self.scheme)
    }

    init?(url: URL) {
        guard let scheme = url.scheme, let host = url.host else { return nil }
        self.init(scheme: scheme, host: host, port: url.port)
    }

    static func defaultPort(for scheme: String) -> Int {
        switch scheme { case "http": 80; case "https": 443; default: 0 }
    }
}

/// Navigation and host-bridge origin policy: only the controller-reported loopback origins.
struct OriginPolicy: Sendable, Equatable {
    private(set) var allowed: Set<Origin>

    init(urls: [String]) {
        var set = Set<Origin>()
        for s in urls {
            guard let url = URL(string: s), let origin = Origin(url: url), Self.isLoopbackHTTP(origin) else { continue }
            set.insert(origin)
        }
        allowed = set
    }

    static func isLoopbackHTTP(_ o: Origin) -> Bool {
        guard o.scheme == "http" else { return false }
        return o.host == "localhost" || o.host == "127.0.0.1" || o.host == "[::1]" || o.host == "::1"
    }

    func allows(url: URL) -> Bool {
        guard let o = Origin(url: url) else { return false }
        return allowed.contains(o)
    }

    func allows(scheme: String, host: String, port: Int) -> Bool {
        allowed.contains(Origin(scheme: scheme, host: host, port: port))
    }

    /// URLs the web view may show without leaving the app.
    func allowsNavigation(to url: URL) -> Bool {
        if url.absoluteString == "about:blank" { return true }
        return allows(url: url)
    }
}
