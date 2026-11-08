import Foundation

// MARK: - Loose JSON

/// A small JSON tree used to build requests and to hold fields the app does not model.
enum JSONValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else if let v = try? c.decode([String: JSONValue].self) { self = .object(v) }
        else { self = .null }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }

    var stringValue: String? { if case .string(let s) = self { s } else { nil } }
    var intValue: Int? { if case .number(let n) = self { Int(n) } else { nil } }
}

extension KeyedDecodingContainer {
    /// Decodes a value if present and well-typed; a wrongly typed field is treated as absent.
    func lenient<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        (try? decodeIfPresent(type, forKey: key)) ?? nil
    }
}

// MARK: - Enumerations (unknown values survive)

enum Mode: String, Codable, Sendable, Equatable {
    case explore
    case code
}

enum ControllerState: Sendable, Equatable, Codable {
    case needsSetup, settingUp, starting, running, stopping, stopped, recovery, error
    case unknown(String)

    init(rawValue: String) {
        switch rawValue {
        case "needs-setup": self = .needsSetup
        case "setting-up": self = .settingUp
        case "starting": self = .starting
        case "running": self = .running
        case "stopping": self = .stopping
        case "stopped": self = .stopped
        case "recovery": self = .recovery
        case "error": self = .error
        default: self = .unknown(rawValue)
        }
    }

    var rawValue: String {
        switch self {
        case .needsSetup: "needs-setup"
        case .settingUp: "setting-up"
        case .starting: "starting"
        case .running: "running"
        case .stopping: "stopping"
        case .stopped: "stopped"
        case .recovery: "recovery"
        case .error: "error"
        case .unknown(let s): s
        }
    }

    init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

// MARK: - Payloads

struct ControllerURLs: Codable, Sendable, Equatable {
    var game: String?
    var agents: String?

    init(game: String? = nil, agents: String? = nil) {
        self.game = game
        self.agents = agents
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        game = c.lenient(String.self, .game)
        agents = c.lenient(String.self, .agents)
    }

    enum CodingKeys: String, CodingKey { case game, agents }
}

struct StateEvent: Codable, Sendable, Equatable {
    var state: ControllerState
    var mode: Mode?
    var urls: ControllerURLs?
    var message: String?

    init(state: ControllerState, mode: Mode? = nil, urls: ControllerURLs? = nil, message: String? = nil) {
        self.state = state; self.mode = mode; self.urls = urls; self.message = message
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try c.decode(ControllerState.self, forKey: .state)
        mode = c.lenient(Mode.self, .mode)
        urls = c.lenient(ControllerURLs.self, .urls)
        message = c.lenient(String.self, .message)
    }

    enum CodingKeys: String, CodingKey { case state, mode, urls, message }
}

struct ProgressEvent: Codable, Sendable, Equatable {
    var task: String
    var label: String?
    var done: Double?
    var total: Double?

    init(task: String, label: String? = nil, done: Double? = nil, total: Double? = nil) {
        self.task = task; self.label = label; self.done = done; self.total = total
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        task = try c.decode(String.self, forKey: .task)
        label = c.lenient(String.self, .label)
        done = c.lenient(Double.self, .done)
        total = c.lenient(Double.self, .total)
    }

    enum CodingKeys: String, CodingKey { case task, label, done, total }

    /// 0...1 when the total is known and positive.
    var fraction: Double? {
        guard let total, total > 0, let done else { return nil }
        return min(max(done / total, 0), 1)
    }
}

struct ServiceEvent: Codable, Sendable, Equatable {
    var name: String
    var state: String
    var pid: Int?
    var code: Int?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        state = c.lenient(String.self, .state) ?? "unknown"
        pid = c.lenient(Int.self, .pid)
        code = c.lenient(Int.self, .code)
    }

    init(name: String, state: String, pid: Int? = nil, code: Int? = nil) {
        self.name = name; self.state = state; self.pid = pid; self.code = code
    }

    enum CodingKeys: String, CodingKey { case name, state, pid, code }
}

struct ProblemEvent: Codable, Sendable, Equatable {
    var code: String
    var message: String?
    var detail: JSONValue?

    init(code: String, message: String? = nil, detail: JSONValue? = nil) {
        self.code = code; self.message = message; self.detail = detail
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = c.lenient(String.self, .code) ?? "UNKNOWN"
        message = c.lenient(String.self, .message)
        detail = c.lenient(JSONValue.self, .detail)
    }

    enum CodingKeys: String, CodingKey { case code, message, detail }
}

enum ControllerEvent: Sendable, Equatable {
    case state(StateEvent)
    case progress(ProgressEvent)
    case service(ServiceEvent)
    case problem(ProblemEvent)
    /// An event type this app does not know about. Ignored by the model.
    case unknown(String)
}

struct ControllerError: Codable, Sendable, Equatable, Error {
    var code: String
    var message: String

    init(code: String, message: String) { self.code = code; self.message = message }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = c.lenient(String.self, .code) ?? "UNKNOWN"
        message = c.lenient(String.self, .message) ?? ""
    }

    enum CodingKeys: String, CodingKey { case code, message }
}

struct ControllerResponse: Sendable, Equatable {
    var id: Int
    var ok: Bool
    var result: JSONValue?
    var error: ControllerError?

    /// Decodes `result` into a typed value; nil when absent or malformed.
    func decodeResult<T: Decodable>(_ type: T.Type) -> T? {
        guard let result, let data = try? JSONEncoder().encode(result) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}

enum ControllerMessage: Sendable, Equatable {
    case response(ControllerResponse)
    case event(ControllerEvent)
    case unrecognized(String)

    /// Parses one stdout line. Never throws; unparseable lines come back as `.unrecognized`.
    static func parse(_ line: String) -> ControllerMessage {
        guard let data = line.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return .unrecognized(line) }

        let decoder = JSONDecoder()
        if let name = object["event"] as? String {
            switch name {
            case "state":
                if let v = try? decoder.decode(StateEvent.self, from: data) { return .event(.state(v)) }
            case "progress":
                if let v = try? decoder.decode(ProgressEvent.self, from: data) { return .event(.progress(v)) }
            case "service":
                if let v = try? decoder.decode(ServiceEvent.self, from: data) { return .event(.service(v)) }
            case "problem":
                if let v = try? decoder.decode(ProblemEvent.self, from: data) { return .event(.problem(v)) }
            default:
                return .event(.unknown(name))
            }
            return .unrecognized(line)
        }
        if let id = object["id"] as? Int {
            struct Wire: Decodable {
                var ok: Bool?
                var result: JSONValue?
                var error: ControllerError?
            }
            let wire = try? decoder.decode(Wire.self, from: data)
            let ok = wire?.ok ?? false
            return .response(ControllerResponse(id: id, ok: ok, result: wire?.result, error: wire?.error))
        }
        return .unrecognized(line)
    }
}

// MARK: - Result shapes

struct PortConflict: Codable, Sendable, Equatable {
    var port: Int
    var service: String

    init(port: Int, service: String) { self.port = port; self.service = service }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        port = c.lenient(Int.self, .port) ?? 0
        service = c.lenient(String.self, .service) ?? "service"
    }

    enum CodingKeys: String, CodingKey { case port, service }
}

struct PreflightResult: Codable, Sendable, Equatable {
    var downloadBytes: Int64?
    var requiredBytes: Int64?
    var freeBytes: Int64?
    var portConflicts: [PortConflict]
    var problems: [String]

    init(downloadBytes: Int64? = nil, requiredBytes: Int64? = nil, freeBytes: Int64? = nil,
         portConflicts: [PortConflict] = [], problems: [String] = []) {
        self.downloadBytes = downloadBytes; self.requiredBytes = requiredBytes
        self.freeBytes = freeBytes; self.portConflicts = portConflicts; self.problems = problems
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        downloadBytes = c.lenient(Int64.self, .downloadBytes)
        requiredBytes = c.lenient(Int64.self, .requiredBytes)
        freeBytes = c.lenient(Int64.self, .freeBytes)
        portConflicts = c.lenient([PortConflict].self, .portConflicts) ?? []
        // Problems may be plain strings or objects carrying a message.
        let raw = c.lenient([JSONValue].self, .problems) ?? []
        problems = raw.compactMap { value in
            switch value {
            case .string(let s): return s
            case .object(let o): return o["message"]?.stringValue ?? o["code"]?.stringValue
            default: return nil
            }
        }
    }

    enum CodingKeys: String, CodingKey { case downloadBytes, requiredBytes, freeBytes, portConflicts, problems }

    /// Whether setup may start from this report.
    var canProceed: Bool {
        if !portConflicts.isEmpty || !problems.isEmpty { return false }
        if let free = freeBytes, let required = requiredBytes, free < required { return false }
        return true
    }
}

struct StatusResult: Codable, Sendable, Equatable {
    struct Sessions: Codable, Sendable, Equatable {
        var running: Int
        init(running: Int) { self.running = running }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            running = c.lenient(Int.self, .running) ?? 0
        }
        enum CodingKeys: String, CodingKey { case running }
    }

    var state: ControllerState
    var mode: Mode?
    var setupComplete: Bool
    var urls: ControllerURLs?
    var sessions: Sessions?

    init(state: ControllerState, mode: Mode? = nil, setupComplete: Bool = false,
         urls: ControllerURLs? = nil, sessions: Sessions? = nil) {
        self.state = state; self.mode = mode; self.setupComplete = setupComplete
        self.urls = urls; self.sessions = sessions
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try c.decode(ControllerState.self, forKey: .state)
        mode = c.lenient(Mode.self, .mode)
        setupComplete = c.lenient(Bool.self, .setupComplete) ?? false
        urls = c.lenient(ControllerURLs.self, .urls)
        sessions = c.lenient(Sessions.self, .sessions)
    }

    enum CodingKeys: String, CodingKey { case state, mode, setupComplete, urls, sessions }
}
