import Testing
@testable import ClaudePenguin

@Suite struct ScreenMappingTests {
    func screen(_ edit: (inout ScreenInputs) -> Void) -> Screen {
        var i = ScreenInputs(liveness: .ready)
        edit(&i)
        return ScreenMapping.screen(for: i)
    }

    @Test func installIssueWinsOverEverything() {
        #expect(screen { $0.installIssue = .translocated; $0.state = .running } == .moveToApplications(.translocated))
    }

    @Test func livenessScreens() {
        #expect(screen { $0.liveness = .launching } == .connecting)
        #expect(screen { $0.liveness = .died("boom"); $0.state = .running } == .controllerDied("boom"))
        #expect(screen { $0.state = nil } == .connecting)
    }

    @Test func firstRunFlow() {
        #expect(screen { $0.state = .needsSetup } == .welcome)
        #expect(screen { $0.state = .needsSetup; $0.pendingMode = .code } == .preflight(.code))
        #expect(screen { $0.state = .settingUp } == .setup)
        #expect(screen { $0.state = .stopped; $0.setupComplete = true } == .connecting)
        #expect(screen { $0.state = .stopped } == .welcome)
    }

    @Test func runningFlow() {
        #expect(screen { $0.state = .starting } == .starting)
        #expect(screen { $0.state = .running; $0.setupComplete = true } == .game)
        #expect(screen { $0.state = .stopping } == .stopping)
    }

    @Test func problemScreens() {
        #expect(screen { $0.state = .recovery } == .recovery)
        #expect(screen { $0.state = .error } == .problem)
        #expect(screen { $0.state = .unknown("new-state") } == .connecting)
    }
}
