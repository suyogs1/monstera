import SpriteKit

/// Minimal SpriteKit scene: a pulsing circle that grows briefly on each tap.
final class PulseScene: SKScene {
    private let circle = SKShapeNode(circleOfRadius: 40)

    override init(size: CGSize) {
        super.init(size: size)
        scaleMode = .resizeFill
        backgroundColor = SKColor(red: 0.10, green: 0.07, blue: 0.18, alpha: 1)

        circle.fillColor = .orange
        circle.strokeColor = .clear
        addChild(circle)

        let pulse = SKAction.sequence([
            .scale(to: 1.15, duration: 0.6),
            .scale(to: 1.0, duration: 0.6),
        ])
        circle.run(.repeatForever(pulse), withKey: "pulse")
    }

    @available(*, unavailable)
    required init?(coder aDecoder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func didChangeSize(_ oldSize: CGSize) {
        super.didChangeSize(oldSize)
        circle.position = CGPoint(x: size.width / 2, y: size.height / 2)
    }

    func burst() {
        circle.run(.sequence([.scale(to: 1.6, duration: 0.1), .scale(to: 1.0, duration: 0.2)]))
    }
}
