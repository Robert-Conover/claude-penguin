import Testing
import Foundation
@testable import ClaudePenguin

@Suite struct OriginPolicyTests {
    let policy = OriginPolicy(urls: ["http://localhost:47080/", "http://localhost:47081/"])

    @Test func allowsReportedOrigins() {
        #expect(policy.allows(url: URL(string: "http://localhost:47080/play")!))
        #expect(policy.allows(url: URL(string: "http://localhost:47081/x?y=1")!))
        #expect(policy.allows(scheme: "http", host: "localhost", port: 47081))
        #expect(policy.allowsNavigation(to: URL(string: "about:blank")!))
    }

    @Test func rejectsEverythingElse() {
        #expect(!policy.allows(url: URL(string: "http://localhost:47082/")!))
        #expect(!policy.allows(url: URL(string: "http://127.0.0.1:47080/")!))
        #expect(!policy.allows(url: URL(string: "https://localhost:47080/")!))
        #expect(!policy.allows(url: URL(string: "https://example.com/")!))
        #expect(!policy.allows(url: URL(string: "http://localhost.evil.com:47080/")!))
        #expect(!policy.allows(url: URL(string: "file:///etc/passwd")!))
    }

    @Test func nonLoopbackUrlsFromControllerAreIgnored() {
        let p = OriginPolicy(urls: ["http://example.com:80/", "http://localhost:1/"])
        #expect(!p.allows(url: URL(string: "http://example.com/")!))
        #expect(p.allows(url: URL(string: "http://localhost:1/")!))
    }
}
