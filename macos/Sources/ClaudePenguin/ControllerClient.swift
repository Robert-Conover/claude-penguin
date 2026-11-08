import Foundation

struct ControllerLaunch: Sendable {
    var node: URL
    var arguments: [String]
    var environment: [String: String]
    var logFile: URL
}

enum ControllerClientError: Error, Sendable, Equatable, LocalizedError {
    case notRunning
    case exited
    case timedOut
    case spawnFailed(String)

    var errorDescription: String? {
        switch self {
        case .notRunning: "The controller is not running."
        case .exited: "The controller stopped."
        case .timedOut: "The controller did not answer in time."
        case .spawnFailed(let why): "The controller could not be started: \(why)"
        }
    }
}

/// Owns the controller child process and speaks the JSON-lines protocol over its pipes.
/// The stdin pipe stays open for the app's lifetime; when the app dies it closes and the controller shuts down.
@MainActor
final class ControllerClient {
    var onEvent: ((ControllerEvent) -> Void)?
    /// Called once when the process ends. `expected` is true after `closeInput()`/`terminate`.
    var onExit: ((_ status: Int32, _ expected: Bool) -> Void)?
    var onUnrecognizedLine: ((String) -> Void)?

    private var process: Process?
    private var stdinHandle: FileHandle?
    private var nextID = 1
    private var pending: [Int: CheckedContinuation<ControllerResponse, Error>] = [:]
    private var expectedExit = false
    private var exited = false

    var isRunning: Bool { process?.isRunning == true && !exited }
    var processIdentifier: Int32? { process?.processIdentifier }

    func start(_ launch: ControllerLaunch) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: launch.logFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !fm.fileExists(atPath: launch.logFile.path) {
            fm.createFile(atPath: launch.logFile.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        let log = try FileHandle(forWritingTo: launch.logFile)
        try log.seekToEnd()
        let banner = "\n--- controller starting \(ISO8601DateFormatter().string(from: Date())) ---\n"
        try log.write(contentsOf: Data(banner.utf8))

        let p = Process()
        p.executableURL = launch.node
        p.arguments = launch.arguments
        p.environment = launch.environment
        let stdin = Pipe(), stdout = Pipe()
        p.standardInput = stdin
        p.standardOutput = stdout
        p.standardError = log

        exited = false
        expectedExit = false
        p.terminationHandler = { [weak self] proc in
            let status = proc.terminationStatus
            Task { @MainActor in
                // Let the reader drain what the controller wrote last.
                try? await Task.sleep(for: .milliseconds(150))
                self?.handleExit(status)
            }
        }
        do { try p.run() } catch {
            try? log.close()
            throw ControllerClientError.spawnFailed(error.localizedDescription)
        }
        process = p
        stdinHandle = stdin.fileHandleForWriting

        let reader = stdout.fileHandleForReading
        Task.detached { [weak self] in
            do {
                for try await line in reader.bytes.lines {
                    let message = ControllerMessage.parse(line)
                    await MainActor.run { self?.handle(message) }
                }
            } catch {}
        }
    }

    private func handle(_ message: ControllerMessage) {
        switch message {
        case .event(let e): onEvent?(e)
        case .response(let r):
            if let c = pending.removeValue(forKey: r.id) { c.resume(returning: r) }
        case .unrecognized(let line): onUnrecognizedLine?(line)
        }
    }

    private func handleExit(_ status: Int32) {
        guard !exited else { return }
        exited = true
        let waiting = pending
        pending = [:]
        for (_, c) in waiting { c.resume(throwing: ControllerClientError.exited) }
        try? stdinHandle?.close()
        stdinHandle = nil
        onExit?(status, expectedExit)
    }

    /// Sends a request and awaits its response. Fails if the process ends first.
    func request(_ cmd: String, _ params: [String: JSONValue] = [:], timeout: Duration? = nil) async throws -> ControllerResponse {
        guard isRunning, let stdinHandle else { throw ControllerClientError.notRunning }
        let id = nextID
        nextID += 1
        var body = params
        body["id"] = .number(Double(id))
        body["cmd"] = .string(cmd)
        var data = try JSONEncoder().encode(JSONValue.object(body))
        data.append(0x0A)

        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            do {
                try stdinHandle.write(contentsOf: data)
            } catch {
                pending.removeValue(forKey: id)
                continuation.resume(throwing: ControllerClientError.notRunning)
                return
            }
            if let timeout {
                Task { [weak self] in
                    try? await Task.sleep(for: timeout)
                    if let c = self?.pending.removeValue(forKey: id) {
                        c.resume(throwing: ControllerClientError.timedOut)
                    }
                }
            }
        }
    }

    /// Closes stdin: the controller's signal to stop everything and exit.
    func closeInput() {
        expectedExit = true
        try? stdinHandle?.close()
        stdinHandle = nil
    }

    /// Waits for the process to end, up to `timeout`. Returns whether it ended.
    func waitForExit(timeout: Duration) async -> Bool {
        let deadline = ContinuousClock.now + timeout
        while isRunning, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(50))
        }
        return !isRunning
    }

    func terminate() {
        expectedExit = true
        process?.terminate()
    }

    func forceKill() {
        expectedExit = true
        if let pid = process?.processIdentifier, process?.isRunning == true { kill(pid, SIGKILL) }
    }
}
