import Testing
@testable import ClaudePenguin

@Suite struct InstallLocationTests {
    @Test func translocated() {
        let path = "/private/var/folders/ab/xyz/AppTranslocation/1234-ABCD/d/Claude Penguin.app"
        #expect(InstallLocation.evaluate(bundlePath: path, volumeIsReadOnly: true) == .translocated)
        #expect(InstallLocation.evaluate(bundlePath: path, volumeIsReadOnly: false) == .translocated)
    }

    @Test func readOnlyDiskImage() {
        #expect(InstallLocation.evaluate(bundlePath: "/Volumes/Claude Penguin/Claude Penguin.app", volumeIsReadOnly: true) == .readOnlyVolume)
    }

    @Test func normalLocationsPass() {
        #expect(InstallLocation.evaluate(bundlePath: "/Applications/Claude Penguin.app", volumeIsReadOnly: false) == nil)
        #expect(InstallLocation.evaluate(bundlePath: "/Users/me/Applications/Claude Penguin.app", volumeIsReadOnly: false) == nil)
        #expect(InstallLocation.evaluate(bundlePath: "/Users/me/Downloads/Claude Penguin.app", volumeIsReadOnly: false) == nil)
    }

    @Test func nonBundlesAreIgnored() {
        #expect(InstallLocation.evaluate(bundlePath: "/Users/me/p/.build/debug", volumeIsReadOnly: true) == nil)
    }
}
