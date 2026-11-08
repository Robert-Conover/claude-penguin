import Foundation

/// Product name lives in one place so a rename is one edit.
enum Product {
    static let name = "Claude Penguin"
    static let bundleIdentifier = "io.github.robert-conover.claude-penguin"
    static let dataDirectoryName = "Claude Penguin"
}

/// Where the controller, its runtimes and its data live.
struct AppPaths: Equatable, Sendable {
    var node: URL
    var controllerScript: URL
    var resources: URL
    var runtimes: URL
    var data: URL
    /// True when the UI-only dev bundle's fake controller is used.
    var usesFakeController: Bool

    var controllerLog: URL { data.appendingPathComponent("logs/app/controller.log") }
    var worktrees: URL { data.appendingPathComponent("worktrees") }

    /// Resolves paths. `bundleResources` is `Contents/Resources` of the running bundle (nil when not in a bundle).
    /// `fileExists` is injectable for tests.
    static func resolve(
        env: [String: String],
        bundleResources: URL?,
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        fileExists: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) || FileManager.default.fileExists(atPath: $0) },
        systemNode: () -> URL? = AppPaths.findSystemNode
    ) -> AppPaths {
        func override(_ key: String) -> URL? {
            guard let v = env[key], !v.isEmpty else { return nil }
            return URL(fileURLWithPath: (v as NSString).expandingTildeInPath)
        }
        let res = bundleResources
        let resources = override("CP_APP_DEV_RESOURCES") ?? res?.appendingPathComponent("app") ?? URL(fileURLWithPath: "/nonexistent/app")
        let runtimes = override("CP_APP_DEV_RUNTIMES") ?? res?.appendingPathComponent("runtimes") ?? URL(fileURLWithPath: "/nonexistent/runtimes")
        let data = override("CP_APP_DEV_DATA")
            ?? home.appendingPathComponent("Library/Application Support/\(Product.dataDirectoryName)")

        var node = override("CP_APP_DEV_NODE") ?? runtimes.appendingPathComponent("node/bin/node")
        var script = override("CP_APP_DEV_CONTROLLER") ?? resources.appendingPathComponent("local/controller/main.mjs")
        var fake = false

        // UI-only dev bundle: no runtimes, a fake controller, the system Node.
        if let res, env["CP_APP_DEV_CONTROLLER"] == nil {
            let devFake = res.appendingPathComponent("dev/fake-controller.mjs")
            if !fileExists(script.path), fileExists(devFake.path) {
                script = devFake
                fake = true
            }
        }
        if env["CP_APP_DEV_NODE"] == nil, !fileExists(node.path), let sys = systemNode() {
            node = sys
        }
        if script.lastPathComponent == "fake-controller.mjs" { fake = true }
        return AppPaths(node: node, controllerScript: script, resources: resources,
                        runtimes: runtimes, data: data, usesFakeController: fake)
    }

    static func findSystemNode() -> URL? {
        var candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            candidates += path.split(separator: ":").map { "\($0)/node" }
        }
        for c in candidates where FileManager.default.isExecutableFile(atPath: c) {
            return URL(fileURLWithPath: c)
        }
        return nil
    }

    /// Command-line arguments passed to the controller script.
    var controllerArguments: [String] {
        [controllerScript.path, "--resources", resources.path, "--runtimes", runtimes.path, "--data", data.path]
    }
}
