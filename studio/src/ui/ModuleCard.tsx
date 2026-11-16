import type { CapabilityEntry, ModuleId } from "../app/capabilities";
import { moduleOf, STATUS_MEANING, unbuilt } from "../app/shell";

/** Status as text first: the colour is only a second cue. */
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <span className={`badge status-${status.replace(/\s+/g, "-")}`} data-status={status}>{label ?? status}</span>;
}

function CapabilityRow({ c }: { c: CapabilityEntry }) {
  return (
    <li data-testid="capability" data-capability={c.id} data-status={c.status}>
      <div><strong>{c.title}</strong> <StatusBadge status={c.status} /></div>
      <p className="small">{c.limits}</p>
      {c.requires !== "" && <p className="small muted"><strong>{c.status === "unsupported" ? "Why not:" : "Needs:"}</strong> {c.requires}</p>}
    </li>
  );
}

/** Heading block shown at the top of every module: status, target status and what reaches the native apps. All values come from the registry. */
export function ModuleHeader({ module }: { module: ModuleId }) {
  const m = moduleOf(module);
  const rest = unbuilt(module);
  return (
    <header className="module-head" data-testid="module-header" data-module={m.id} data-status={m.status} data-native-output={m.nativeOutput}>
      <h1>{m.title}</h1>
      <p className="module-facts">
        <span>Status: <StatusBadge status={m.status} /></span>
        {m.targetStatus !== m.status && <span>Target: <StatusBadge status={m.targetStatus} /></span>}
        <span>Native output: <StatusBadge status={m.nativeOutput} /></span>
      </p>
      <p className="small muted">{STATUS_MEANING[m.status]} {m.limits}</p>
      {m.status !== "planned" && rest.length > 0 && (
        <details className="module-limits" data-testid="module-limits">
          <summary>Not available here ({rest.length})</summary>
          <ul className="cap-list">{rest.map((c) => <CapabilityRow key={c.id} c={c} />)}</ul>
        </details>
      )}
    </header>
  );
}

/**
 * The page for a module that is not built. It explains what is missing and why, and offers nothing to edit:
 * no forms, no inputs and no buttons, so nothing here can look like a working feature.
 */
export function ModuleCard({ module }: { module: ModuleId }) {
  const m = moduleOf(module);
  const caps = unbuilt(module);
  return (
    <section className="card module-card" data-testid="module-card" data-module={m.id} aria-labelledby="module-card-h">
      <ModuleHeader module={module} />
      <h2 id="module-card-h">Not available yet</h2>
      <p>This module is <strong>{m.status}</strong>. {STATUS_MEANING[m.status]} Nothing on this page can be edited.</p>
      <ul className="cap-list">{caps.map((c) => <CapabilityRow key={c.id} c={c} />)}</ul>
    </section>
  );
}
