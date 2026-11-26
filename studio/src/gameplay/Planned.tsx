import { REGISTRY } from "../app/capabilities";

export interface PlannedGameplayAudit {
  id: string;
  label: string;
  missing: string;
  schemaSupport: string;
  pythonOracle: string;
  kotlinRuntime: string;
  swiftRuntime: string;
  missingState: string;
  conformanceTests: string;
}

/**
 * Contract audit for unbuilt gameplay systems. Text only: there is no editing control for any of these
 * (design: planned modules show no form).
 */
export const PLANNED_GAMEPLAY: readonly PlannedGameplayAudit[] = [
  {
    id: "health",
    label: "Health",
    missing:
      "The v4/v5 contract has a global lives counter only. Health needs a per-entity value that changes over time (timed state / damage cooldowns), which the runtime contract does not define.",
    schemaSupport:
      "spec/schema/game.schema.json defines global game.runtime.lives and per-collision delta lives, plus KindConfig.lifetimeTicks. There is no per-kind maxHealth, damage, or invulnerabilityTicks field.",
    pythonOracle:
      "tools/monstera/monstera/oracle/sim.py tracks a single World.lives integer and Entity(id, kind, controlled, x, y, vx, vy, age). step() has no per-entity HP, damage accumulation, or hit-cooldown state.",
    kotlinRuntime:
      "Simulation.kt defines World.lives: Long and Entity(..., var age: UInt = 0u). observableNames records [tick, score, lives, entityCount, ended, nextId] with no per-entity hp or damage events.",
    swiftRuntime:
      "Simulation.swift mirrors Kotlin with World.lives: Int64 and Entity(..., age: UInt32). Identical fixed-point arithmetic and checkpoint observables must be extended in lockstep.",
    missingState:
      "Per-entity hp: Int32 (clamped 0..maxHp), maxHp on KindConfig, damage/heal collision deltas, optional invulnerabilityTicks timer, and deterministic despawn-on-zero-HP ordering.",
    conformanceTests:
      "Deterministic multi-hit scenarios verifying identical entityCount, hp/lives, and despawn tick across Python oracle, Kotlin Simulation.kt, and Swift Simulation.swift.",
  },
  {
    id: "power-ups",
    label: "Power-ups",
    missing:
      "A power-up has a duration. The contract has no timed state, so there is nothing for the engine to count down, and the Kotlin and Swift cores could not stay equal.",
    schemaSupport:
      "spec/schema/game.schema.json supports static collision rules (score, lives, despawnA, despawnB) only. No effect duration, modifier kind (speed/shield/weapon), or stack policy exists.",
    pythonOracle:
      "oracle/sim.py reads static Config.drag_gain, swipe_speed, tap_vx/tap_vy, and collision rules. World holds no active-buff list or remaining-ticks countdown.",
    kotlinRuntime:
      "Simulation.kt has no timed modifier table on World or Entity; input velocity and collision outcomes are fixed from RuntimeConfig at startup.",
    swiftRuntime:
      "Simulation.swift has no timed modifier table; extending it requires deterministic fixed-order expiry (decrement before/after input) matching Kotlin and Python.",
    missingState:
      "Active timed effects array with (effectId, remainingTicks), deterministic stack/refresh rules, and modifier hooks in input/collision resolution.",
    conformanceTests:
      "Scenario tests covering pickup activation, tick-accurate expiry boundary (tick N active vs tick N+1 expired), refresh/stacking, and replay hash parity.",
  },
  {
    id: "progression",
    label: "Progression",
    missing:
      "Progression has to survive between sessions. The contract has no persistence, so an unlocked level or upgrade would be lost on the next launch.",
    schemaSupport:
      "spec/schema/game.schema.json models a single stateless run (world, spawners, lives, winScore). No campaign/level graph, unlock criteria, or persistent profile schema exists.",
    pythonOracle:
      "oracle/sim.py initializes a fresh World(cfg, seed) per run and resets on restart; there is no cross-run state input/output contract.",
    kotlinRuntime:
      "Simulation.kt is pure in-memory Kotlin with no persistence port; GameScreen.kt does not serialize unlocked levels, high scores, or upgrades across launches.",
    swiftRuntime:
      "Simulation.swift is pure in-memory Swift with no persistence port; ContentView.swift does not persist progression state across app restarts.",
    missingState:
      "Versioned serializable progression snapshot (unlocked level IDs, best score, currency/upgrades), deterministic run-end commit rules, and platform storage adapters.",
    conformanceTests:
      "Round-trip serialization and cross-run unlock conformance tests verifying identical progression state transitions on Python oracle, Android, and iOS.",
  },
];

/** The Planned section: contract audit with no editing controls. */
export function GameplayPlanned() {
  const cap = REGISTRY.capabilities.find((c) => c.id === "gameplay-unbuilt-modules");
  return (
    <section aria-labelledby="gp-planned-h" data-testid="gameplay-planned">
      <header className="section-head">
        <h2 id="gp-planned-h">Planned &amp; Contract Audit</h2>
        <p>
          These gameplay systems are roadmap items and cannot be authored on the current engine contract. Nothing here is saved, compiled, or exported.
        </p>
      </header>
      <ul className="planned-list">
        {PLANNED_GAMEPLAY.map((p) => (
          <li key={p.id} className="card" data-testid={`planned-${p.id}`}>
            <h3>
              {p.label} <span className="muted small">planned</span>
            </h3>
            <p>
              <strong>Missing contract piece.</strong> {p.missing}
            </p>
            <dl className="audit-grid">
              <div>
                <dt>Current Schema Support</dt>
                <dd>{p.schemaSupport}</dd>
              </div>
              <div>
                <dt>Python Engine / Oracle</dt>
                <dd>{p.pythonOracle}</dd>
              </div>
              <div>
                <dt>Kotlin Runtime</dt>
                <dd>{p.kotlinRuntime}</dd>
              </div>
              <div>
                <dt>Swift Runtime</dt>
                <dd>{p.swiftRuntime}</dd>
              </div>
              <div>
                <dt>Missing State &amp; Behavior</dt>
                <dd>{p.missingState}</dd>
              </div>
              <div>
                <dt>Required Conformance Tests</dt>
                <dd>{p.conformanceTests}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
      {cap && (
        <p className="muted small" data-testid="planned-registry">
          Registry: <code>{cap.id}</code> is <strong>{cap.status}</strong>. {cap.limits} Requires: {cap.requires}
        </p>
      )}
    </section>
  );
}
