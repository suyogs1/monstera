import SpriteKit
import SwiftUI

struct ContentView: View {
    @State private var taps = 0
    // Created once per view identity; SpriteView keeps rendering the same scene.
    @State private var scene = PulseScene(size: CGSize(width: 300, height: 200))

    var body: some View {
        VStack(spacing: 16) {
            Text("MONSTERA")
                .font(.largeTitle.bold())
            Text("iOS Hello World (SwiftUI + SpriteKit)")
            SpriteView(scene: scene)
                .frame(width: 300, height: 200)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .accessibilityLabel("SpriteKit scene with a pulsing orange circle")
            Button("Tap me") {
                taps += 1
                scene.burst()
            }
            .buttonStyle(.borderedProminent)
            Text("Taps: \(taps)")
        }
        .padding()
    }
}
