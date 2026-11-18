import { REGISTRY } from "../app/capabilities";

/** What the native app cannot do per level, with the reason. Text only: no control exists for any of these (design: S4). */
export const UNSUPPORTED_LEVEL_FEATURES: readonly { id: string; label: string; reason: string }[] = [
  { id: "wave-end", label: "Wave end or spawn count", reason: "Spawners cannot stop and cannot count; schema v4 has no wave end or spawn count (E3)." },
  { id: "level-win", label: "Win condition per level", reason: "Winning is one rule of the whole game (win score). A level cannot have its own." },
  { id: "level-lives", label: "Lives per level", reason: "Lives belong to the whole game, not to a level." },
  { id: "level-sequence", label: "Next level and level order in the app", reason: "The generated app has one runtime; the order here is only the list order in Studio." },
  { id: "level-select", label: "Level selection in the app", reason: "Only the active level is compiled into the native spec. Other levels export as standalone spec variants that the app cannot choose." },
];
export function Unsupported() {
  const cap = REGISTRY.capabilities.find((c) => c.id === "multi-level-in-app");
  return (
    <div data-testid="unsupported-list">
      <ul>
        {UNSUPPORTED_LEVEL_FEATURES.map((u) => <li key={u.id} data-testid={`unsupported-${u.id}`}><strong>{u.label}.</strong> <span className="muted">{u.reason}</span></li>)}
      </ul>
      {cap && <p className="muted small">Registry: <code>{cap.id}</code> is <strong>{cap.status}</strong>. {cap.limits} Requires: {cap.requires}</p>}
    </div>
  );
}
