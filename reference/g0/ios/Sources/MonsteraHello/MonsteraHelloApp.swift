import SwiftUI
import os

private let log = Logger(subsystem: "app.monstera.hello", category: "lifecycle")

@main
struct MonsteraHelloApp: App {
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .onChange(of: scenePhase) { _, phase in
            // Logged so Device Lab `logs` can verify lifecycle transitions.
            log.info("scenePhase: \(String(describing: phase), privacy: .public)")
        }
    }
}
