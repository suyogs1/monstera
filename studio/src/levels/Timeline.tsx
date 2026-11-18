import { seconds, spawnTicks } from "../brain/summary";
import type { CompiledSpawner } from "../derive/levels";

const W = 640, ROW = 22, PAD = 4, GUTTER = 120, HORIZON_SECONDS = 60;

/**
 * Spawn timeline of one compiled level: a row per spawner, a start marker where it begins and a tick for each spawn
 * (the interval). Difficulty steps are the last `steps` spawners and are drawn in a second colour.
 */
export function Timeline({ spawners, steps, tickRate }: { spawners: readonly CompiledSpawner[]; steps: number; tickRate: number }) {
  if (!(tickRate > 0) || spawners.length === 0) return <p className="muted small" data-testid="level-timeline-empty">No spawners in this level.</p>;
  const horizon = tickRate * HORIZON_SECONDS;
  const xAt = (t: number) => GUTTER + (Math.min(t, horizon) / horizon) * (W - GUTTER - PAD);
  const firstStep = spawners.length - steps;
  return (
    <figure className="timeline" data-testid="level-timeline">
      <figcaption>First {HORIZON_SECONDS} seconds. The triangle is where a spawner starts; each mark is one spawn, so the gap between marks is the interval.</figcaption>
      <svg viewBox={`0 0 ${W} ${spawners.length * ROW + 18}`} role="img" aria-label={`Spawn timeline for the first ${HORIZON_SECONDS} seconds, one row per spawner`}>
        {spawners.map((s, i) => {
          const isStep = i >= firstStep;
          const ticks = spawnTicks(s.startTick, s.intervalTicks, horizon);
          return (
            <g key={i} transform={`translate(0 ${i * ROW})`} data-testid={`tl-row-${i}`} data-kind={isStep ? "step" : "wave"} data-start={s.startTick} data-interval={s.intervalTicks}>
              <line x1={GUTTER} x2={W - PAD} y1={ROW / 2} y2={ROW / 2} className="tl-axis" />
              {ticks.map((t) => <rect key={t} x={xAt(t) - 1} y={5} width={2} height={ROW - 10} className={isStep ? "tl-mark step" : "tl-mark"} />)}
              {s.startTick <= horizon && <path d={`M${xAt(s.startTick) - 4} 2 L${xAt(s.startTick) + 4} 2 L${xAt(s.startTick)} 8 Z`} className="tl-start" />}
              <text x={PAD} y={ROW - 7} className="tl-label">{isStep ? "step" : "wave"} {s.kind.slice(0, 10)} {seconds(s.startTick, tickRate)}s/{seconds(s.intervalTicks, tickRate)}s</text>
            </g>
          );
        })}
        {[0, 20, 40, 60].map((sec) => (
          <text key={sec} x={xAt(sec * tickRate)} y={spawners.length * ROW + 13} textAnchor={sec === HORIZON_SECONDS ? "end" : "start"} className="tl-label">{sec} s</text>
        ))}
      </svg>
    </figure>
  );
}
