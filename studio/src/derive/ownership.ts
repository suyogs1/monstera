// Pointer ownership (design risk 4): which module writes which spec pointer. The tables are disjoint by construction and a
// test asserts it. A Designer control is read-only exactly while the owning module's derivation switch is on.
import { startsWith, type Path } from "../draft/path";
import type { ProjectManifest } from "../project/manifests";
export type DerivingModule = "levels" | "gameplay";
const RT = ["game", "runtime"] as const;
export const POINTER_OWNERS: Readonly<Record<DerivingModule, readonly Path[]>> = {
  levels: [[...RT, "initialEntities"], [...RT, "spawners"]],
  gameplay: [[...RT, "lives"], [...RT, "winScore"], [...RT, "collisions"]],
};
/** The module that owns `path` while its derivation is on, or null when the Designer owns it. */
export function lockedBy(path: Path, derivation: ProjectManifest["derivation"] | null | undefined): DerivingModule | null {
  if (!derivation) return null;
  for (const m of ["levels", "gameplay"] as const) {
    if (derivation[m] && POINTER_OWNERS[m].some((p) => startsWith(path, p))) return m;
  }
  return null;
}
