// swift-tools-version: 6.0
// Layout follows `xtool new` (xtool 1.24.0): exactly one library product whose target
// contains the @main App. xtool.yml turns it into an iOS .app bundle.
import PackageDescription

let package = Package(
    name: "MonsteraHello",
    platforms: [
        .iOS(.v17),
    ],
    products: [
        .library(
            name: "MonsteraHello",
            targets: ["MonsteraHello"]
        ),
    ],
    targets: [
        .target(
            name: "MonsteraHello"
        ),
    ]
)
