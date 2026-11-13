import { Card, EnumSetField, Field, FieldGrid } from "../fields";

export function Platforms() {
  return (
    <section aria-labelledby="platforms-h">
      <header className="section-head">
        <h2 id="platforms-h">Platforms</h2>
        <p>Which native applications MONSTERA generates from this specification, and the oldest OS each one supports.</p>
      </header>
      <Card title="Targets">
        <EnumSetField path={["project", "targets"]} label="Generate for" />
        <p className="muted small">
          Android is Kotlin with Jetpack Compose; iOS is Swift with SwiftUI and SpriteKit. Studio never compiles them: the
          generated source is built with Gradle or Xcode.
        </p>
      </Card>
      <div className="two-col">
        <Card title="Android">
          <FieldGrid><Field path={["project", "platforms", "android", "minSdk"]} label="Minimum SDK" /></FieldGrid>
        </Card>
        <Card title="iOS">
          <FieldGrid><Field path={["project", "platforms", "ios", "deploymentTarget"]} label="Deployment target" /></FieldGrid>
        </Card>
      </div>
    </section>
  );
}
