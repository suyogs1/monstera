import { Card, Field, FieldGrid, KindSelect, useValue } from "../fields";

const SCHEMES: Record<string, string> = {
  drag: "Moves controlled entities by the finger's movement times the drag gain.",
  swipe: "A swipe sets the controlled entity's velocity to the swipe speed in that direction.",
  lanes: "A horizontal swipe moves the controlled entity sideways by the swipe speed, once.",
  tap: "Taps only.",
};

export function Gameplay() {
  const scheme = String(useValue(["game", "input", "scheme"]) ?? "");
  return (
    <section aria-labelledby="gameplay-h">
      <header className="section-head">
        <h2 id="gameplay-h">Gameplay</h2>
        <p>The playing field, how the player controls it, and the fixed-step simulation underneath.</p>
      </header>

      <Card title="Genre and field">
        <FieldGrid>
          <Field path={["game", "genre"]} label="Genre" />
          <Field path={["game", "orientation"]} label="Orientation" />
          <Field path={["game", "world", "width"]} label="World width" />
          <Field path={["game", "world", "height"]} label="World height" />
          <Field path={["game", "targetFps"]} label="Target frame rate" />
          <Field path={["game", "runtime", "maxEntities"]} label="Entity limit" />
        </FieldGrid>
      </Card>

      <Card title="Player input">
        <FieldGrid>
          <Field path={["game", "input", "scheme"]} label="Control scheme" note={SCHEMES[scheme]} />
          <Field path={["game", "input", "dragGain"]} label="Drag gain" />
          <Field path={["game", "input", "swipeSpeed"]} label="Swipe speed" />
          <KindSelect path={["game", "input", "tapKind"]} label="Tap spawns" allowNone />
          <Field path={["game", "input", "tapVx"]} label="Tap velocity, horizontal" />
          <Field path={["game", "input", "tapVy"]} label="Tap velocity, vertical" />
        </FieldGrid>
      </Card>

      <Card title="Simulation">
        <FieldGrid>
          <Field path={["game", "simulation", "tickRate"]} label="Ticks per second" />
          <Field path={["game", "simulation", "maxTicksPerFrame"]} label="Max ticks per frame" />
        </FieldGrid>
      </Card>
    </section>
  );
}
