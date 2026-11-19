// Pure edit operations for the integrations manifest (task 6.3). Each returns the next manifest or a reason; every result is
// checked by validateIntegrations (secret guard, schema, internal checks), so a refused edit never reaches the project.
// There is deliberately no operation for production or live modes, ad unit ids or keys: the manifest has no place for them.
import type { AdPlacement, IntegrationsManifest } from "../project/manifests";
import { validateIntegrations } from "./manifest";
export type IntegrationsOpResult = { ok: true; integrations: IntegrationsManifest } | { ok: false; reason: string };
export type PlacementField = "id" | "type" | "trigger" | "minSecondsBetween" | "maxPerSession" | "rewardKind" | "rewardAmount";
const DEFAULT_REWARD = { rewardKind: "reward", rewardAmount: 1 } as const;
function check(m: IntegrationsManifest): IntegrationsOpResult {
  const r = validateIntegrations(m);
  if (r.ok) return { ok: true, integrations: m };
  const first = r.issues[0];
  return { ok: false, reason: `${first?.path.join(".") ?? ""} ${first?.message ?? "invalid"}`.trim() };
}
const withPlacements = (m: IntegrationsManifest, placements: AdPlacement[]): IntegrationsManifest => ({
  ...m,
  monetization: { ...m.monetization, placements: [...placements].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) },
});
export function setService(m: IntegrationsManifest, name: string, on: boolean): IntegrationsOpResult {
  if (!Object.prototype.hasOwnProperty.call(m.backend.services, name)) return { ok: false, reason: `unknown service "${name}"` };
  return check({ ...m, backend: { ...m.backend, services: { ...m.backend.services, [name]: on } } });
}
/** Only `mock` and `test` exist. Any other value, including production, is refused at run time as well as by the type. */
export function setMode(m: IntegrationsManifest, mode: "mock" | "test"): IntegrationsOpResult {
  if (mode !== "mock" && mode !== "test") return { ok: false, reason: `mode "${String(mode)}" is not available; Studio supports mock and test only` };
  return check({ ...m, monetization: { ...m.monetization, mode } });
}
export function addPlacement(m: IntegrationsManifest): IntegrationsOpResult {
  const used = new Set(m.monetization.placements.map((p) => p.id));
  let n = 1;
  while (used.has(`placement-${n}`)) n += 1;
  const p: AdPlacement = { id: `placement-${n}`, type: "banner", trigger: "manual", minSecondsBetween: 60, maxPerSession: 3, rewardKind: "", rewardAmount: 0 };
  return check(withPlacements(m, [...m.monetization.placements, p]));
}
export function setPlacement(m: IntegrationsManifest, id: string, field: PlacementField, value: string | number): IntegrationsOpResult {
  const cur = m.monetization.placements.find((p) => p.id === id);
  if (!cur) return { ok: false, reason: `no placement "${id}"` };
  let next: AdPlacement = { ...cur, [field]: value } as AdPlacement;
  if (field === "type") {
    if (value === "rewarded") next = { ...next, ...(cur.type === "rewarded" ? {} : DEFAULT_REWARD) };
    else next = { ...next, rewardKind: "", rewardAmount: 0 };
  }
  return check(withPlacements(m, m.monetization.placements.map((p) => (p.id === id ? next : p))));
}
export function removePlacement(m: IntegrationsManifest, id: string): IntegrationsOpResult {
  if (!m.monetization.placements.some((p) => p.id === id)) return { ok: false, reason: `no placement "${id}"` };
  return check(withPlacements(m, m.monetization.placements.filter((p) => p.id !== id)));
}
