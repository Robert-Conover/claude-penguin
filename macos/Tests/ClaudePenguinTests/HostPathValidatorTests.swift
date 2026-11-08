import Testing
import Foundation
@testable import ClaudePenguin

@Suite struct HostPathValidatorTests {
    let root: URL
    let validator: HostPathValidator

    init() throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("cp-test-\(UUID().uuidString)")
        let fm = FileManager.default
        try fm.createDirectory(at: base.appendingPathComponent("worktrees/proj/sub"), withIntermediateDirectories: true)
        try fm.createDirectory(at: base.appendingPathComponent("worktrees-evil/proj"), withIntermediateDirectories: true)
        try fm.createDirectory(at: base.appendingPathComponent("outside"), withIntermediateDirectories: true)
        try fm.createSymbolicLink(at: base.appendingPathComponent("worktrees/escape"),
                                  withDestinationURL: base.appendingPathComponent("outside"))
        try fm.createSymbolicLink(at: base.appendingPathComponent("worktrees/inside-link"),
                                  withDestinationURL: base.appendingPathComponent("worktrees/proj"))
        root = base
        validator = HostPathValidator(worktreesRoot: base.appendingPathComponent("worktrees"))
    }

    @Test func acceptsRealWorktree() {
        let url = validator.validate(root.appendingPathComponent("worktrees/proj/sub").path)
        #expect(url != nil)
    }

    @Test func acceptsSymlinkThatStaysInside() {
        #expect(validator.validate(root.appendingPathComponent("worktrees/inside-link").path) != nil)
    }

    @Test func rejectsSymlinkEscape() {
        #expect(validator.validate(root.appendingPathComponent("worktrees/escape").path) == nil)
    }

    @Test func rejectsDotDot() {
        #expect(validator.validate(root.path + "/worktrees/proj/../../outside") == nil)
        #expect(validator.validate(root.path + "/worktrees/proj/../proj") == nil)
    }

    @Test func rejectsSiblingPrefix() {
        #expect(validator.validate(root.appendingPathComponent("worktrees-evil/proj").path) == nil)
    }

    @Test func rejectsRootItselfRelativeMissingAndEmpty() {
        #expect(validator.validate(root.appendingPathComponent("worktrees").path) == nil)
        #expect(validator.validate("worktrees/proj") == nil)
        #expect(validator.validate("") == nil)
        #expect(validator.validate(root.appendingPathComponent("worktrees/missing").path) == nil)
        #expect(validator.validate("/etc/hosts") == nil)
        #expect(validator.validate(root.path + "/worktrees/proj\0/../x") == nil)
    }
}
