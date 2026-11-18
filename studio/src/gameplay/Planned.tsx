import { REGISTRY } from "../app/capabilities";

/** What is not built, and the contract piece it needs. Text only: there is no control for any of these (design: planned modules show no form). */
export const PLANNED_GAMEPLAY: readonly { id: string; label: string; missing: string }[] = [
  { id: "health", label: "Health", missing: "The v4 contract has a lives counter only. Health needs a per-entity value that changes over time (timed state), which the runtime contract does not define." },
  { id: "power-ups", label: "Power-ups", missing: "A power-up has a duration. The contract has no timed state, so there is nothing for the engine to count down, and the Kotlin and Swift cores could not stay equal." },
  { id: "progression", label: "Progression", missing: "Progression has to survive between sessions. The contract has no persistence, so an unlocked level or upgrade would be lost on the next launch." },
];

/** The Planned section: an explanation and no editing control. */
export function GameplayPlanned() {
  const cap = REGISTRY.capabilities.find((c) => c.id === "gameplay-unbuilt-modules");
  return (
    <section aria-labelledby="gp-planned-h" data-testid="gameplay-planned">
      <header className="section-head">
        <h2 id="gp-planned-h">Planned</h2>
        <p>These gameplay systems are designed but cannot be built on the current engine contract. Nothing here is saved, compiled or exported.</p>
      </header>
      <ul className="planned-list">
        {PLANNED_GAMEPLAY.map((p) => (
          <li key={p.id} className="card" data-testid={`planned-${p.id}`}>
            <h3>{p.label} <span className="muted small">planned</span></h3>
            <p><strong>Missing contract piece.</strong> {p.missing}</p>
          </li>
        ))}
      </ul>
      {cap && <p className="muted small" data-testid="planned-registry">Registry: <code>{cap.id}</code> is <strong>{cap.status}</strong>. {cap.limits} Requires: {cap.requires}</p>}
    </section>
  );
}
