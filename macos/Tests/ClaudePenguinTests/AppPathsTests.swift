import Testing
import Foundation
@testable import ClaudePenguin

@Suite struct AppPathsTests {
    let res = URL(fileURLWithPath: "/X/Claude Penguin.app/Contents/Resources")
    let home = URL(fileURLWithPath: "/Users/me")

    @Test func bundledDefaults() {
        let p = AppPaths.resolve(env: [:], bundleResources: res, home: home, fileExists: { _ in true }, systemNode: { nil })
        #expect(p.node.path == "/X/Claude Penguin.app/Contents/Resources/runtimes/node/bin/node")
        #expect(p.controllerArguments == [
            "/X/Claude Penguin.app/Contents/Resources/app/local/controller/main.mjs",
            "--resources", "/X/Claude Penguin.app/Contents/Resources/app",
            "--runtimes", "/X/Claude Penguin.app/Contents/Resources/runtimes",
            "--data", "/Users/me/Library/Application Support/Claude Penguin"])
        #expect(!p.usesFakeController)
        #expect(p.worktrees.path == "/Users/me/Library/Application Support/Claude Penguin/worktrees")
    }

    @Test func devOverrides() {
        let env = ["CP_APP_DEV_NODE": "/n/node", "CP_APP_DEV_CONTROLLER": "/c/fake-controller.mjs",
                   "CP_APP_DEV_RESOURCES": "/r", "CP_APP_DEV_RUNTIMES": "/rt", "CP_APP_DEV_DATA": "/d"]
        let p = AppPaths.resolve(env: env, bundleResources: res, home: home, fileExists: { _ in false }, systemNode: { nil })
        #expect(p.node.path == "/n/node")
        #expect(p.controllerArguments == ["/c/fake-controller.mjs", "--resources", "/r", "--runtimes", "/rt", "--data", "/d"])
        #expect(p.usesFakeController)
    }

    @Test func uiOnlyBundleUsesFakeAndSystemNode() {
        let fake = res.appendingPathComponent("dev/fake-controller.mjs").path
        let p = AppPaths.resolve(env: [:], bundleResources: res, home: home,
                                 fileExists: { $0 == fake }, systemNode: { URL(fileURLWithPath: "/opt/homebrew/bin/node") })
        #expect(p.controllerScript.path == fake)
        #expect(p.node.path == "/opt/homebrew/bin/node")
        #expect(p.usesFakeController)
    }
}
