import { useSession } from "../../app/hooks";
import { seconds, spawnTicks } from "../../brain/summary";
import { addSpawner, removeSpawner } from "../../draft/ops";
import { getAt, toIssuePath, type Path } from "../../draft/path";
import type { Json } from "../../schema/schema";
import { formatUnits } from "../../units/q16";
import { Card, Field, FieldGrid, KindSelect, useDoc } from "../fields";

const RT: Path = ["game", "runtime"];
const HORIZON_SECONDS = 30;

function Timeline() {
  const doc = useDoc();
  if (doc === null) return null;
  const rate = Number(getAt(doc, ["game", "simulation", "tickRate"]) ?? 0);
  const spawners = Array.isArray(getAt(doc, [...RT, "spawners"])) ? (getAt(doc, [...RT, "spawners"]) as Json[]) : [];
  if (!(rate > 0) || spawners.length === 0) return null;
  const horizon = rate * HORIZON_SECONDS;
  // Row labels sit in their own gutter on the left so they never cover a spawn mark.
  const W = 640, ROW = 22, PAD = 4, GUTTER = 110;
  const xAt = (t: number) => GUTTER + (t / horizon) * (W - GUTTER - PAD);
  return (
    <figure className="timeline" data-testid="spawn-timeline">
      <figcaption>First {HORIZON_SECONDS} seconds: each mark is one spawn.</figcaption>
      <svg viewBox={`0 0 ${W} ${spawners.length * ROW + 18}`} role="img"
        aria-label={`Spawn timeline for the first ${HORIZON_SECONDS} seconds, one row per spawner`}>
        {spawners.map((s, i) => {
          const kind = String(getAt(s, ["kind"]) ?? "?");
          const ticks = spawnTicks(Number(getAt(s, ["startTick"])), Number(getAt(s, ["intervalTicks"])), horizon);
          return (
            <g key={i} transform={`translate(0 ${i * ROW})`}>
              <line x1={GUTTER} x2={W - PAD} y1={ROW / 2} y2={ROW / 2} className="tl-axis" />
              {ticks.map((t) => <rect key={t} x={xAt(t) - 1} y={3} width={2} height={ROW - 6} className="tl-mark" />)}
              <text x={PAD} y={ROW - 7} className="tl-label" data-testid="tl-label">{kind.slice(0, 12)} #{i + 1}</text>
            </g>
          );
        })}
        {[0, 10, 20, 30].map((sec) => (
          <text key={sec} x={xAt((sec / HORIZON_SECONDS) * horizon)} y={spawners.length * ROW + 13} textAnchor={sec === 30 ? "end" : "start"} className="tl-label">{sec} s</text>
        ))}
      </svg>
    </figure>
  );
}

export function Spawns() {
  const { store } = useSession();
  const doc = useDoc();
  const rate = doc === null ? 0 : Number(getAt(doc, ["game", "simulation", "tickRate"]) ?? 0);
  const rows = doc === null ? [] : (Array.isArray(getAt(doc, [...RT, "spawners"])) ? (getAt(doc, [...RT, "spawners"]) as Json[]) : []);
  const perSecond = (raw: unknown) => (typeof raw === "number" && rate > 0 ? `${formatUnits(Math.round(raw * rate))} units per second at ${rate} ticks per second` : undefined);

  return (
    <section aria-labelledby="spawns-h">
      <header className="section-head">
        <h2 id="spawns-h">Spawns &amp; difficulty</h2>
        <p>
          A spawner creates one entity at its start tick and again every interval, at a random position inside its spawn box.
          There is no difficulty setting: difficulty is what you build here. Add spawners with a later start and a shorter
          interval and the game gets harder as it goes.
        </p>
      </header>

      <Timeline />

      {rows.map((s, i) => {
        const base = [...RT, "spawners", i];
        const interval = getAt(s, ["intervalTicks"]), start = getAt(s, ["startTick"]);
        return (
          <Card key={i} dataPath={toIssuePath(base)} title={<>Spawner {i + 1}: <span className="mono">{String(getAt(s, ["kind"]) ?? "?")}</span></>}>
            <FieldGrid>
              <KindSelect path={[...base, "kind"]} label="Spawns kind" />
              <Field path={[...base, "stream"]} label="Random stream" />
              <Field path={[...base, "startTick"]} label="First spawn (tick)" note={typeof start === "number" ? `= ${seconds(start, rate)} s` : undefined} />
              <Field path={[...base, "intervalTicks"]} label="Interval (ticks)" note={typeof interval === "number" ? `= ${seconds(interval, rate)} s between spawns` : undefined} />
            </FieldGrid>
            <h4 className="subhead">Spawn box</h4>
            <FieldGrid>
              <Field path={[...base, "xMin"]} label="Left, from" />
              <Field path={[...base, "xMax"]} label="Left, to" />
              <Field path={[...base, "yMin"]} label="Top, from" />
              <Field path={[...base, "yMax"]} label="Top, to" />
            </FieldGrid>
            <h4 className="subhead">Velocity</h4>
            <FieldGrid>
              <Field path={[...base, "vx"]} label="Horizontal (per tick)" note={perSecond(getAt(s, ["vx"]))} />
              <Field path={[...base, "vy"]} label="Vertical (per tick)" note={perSecond(getAt(s, ["vy"]))} />
            </FieldGrid>
            <div className="row-actions">
              <button type="button" className="danger" onClick={() => doc !== null && store.replace(removeSpawner(doc, i))}>Remove spawner</button>
            </div>
          </Card>
        );
      })}
      <button type="button" className="primary" onClick={() => doc !== null && store.replace(addSpawner(doc))}>Add spawner</button>
    </section>
  );
}
