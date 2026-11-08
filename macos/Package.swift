// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ClaudePenguin",
    platforms: [.macOS("26.0")],
    products: [
        .executable(name: "ClaudePenguin", targets: ["ClaudePenguin"])
    ],
    targets: [
        .executableTarget(
            name: "ClaudePenguin",
            path: "Sources/ClaudePenguin"
        ),
        .testTarget(
            name: "ClaudePenguinTests",
            dependencies: ["ClaudePenguin"],
            path: "Tests/ClaudePenguinTests"
        ),
    ],
    swiftLanguageModes: [.v6]
)
