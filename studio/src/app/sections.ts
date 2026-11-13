import type { Path } from "../draft/path";

export type SectionId =
  | "overview" | "platforms" | "gameplay" | "entities" | "rules" | "spawns" | "presentation" | "spec" | "integration";

export interface SectionInfo { id: SectionId; title: string; blurb: string }

export const SECTIONS: SectionInfo[] = [
  { id: "overview", title: "Overview", blurb: "The game at a glance, and its identity." },
  { id: "platforms", title: "Platforms", blurb: "Which native apps are generated, and their minimum OS." },
  { id: "gameplay", title: "Gameplay", blurb: "World, input and simulation settings." },
  { id: "entities", title: "Entities", blurb: "The player, enemies, pickups and their starting placement." },
  { id: "rules", title: "Rules & scoring", blurb: "What happens when things touch: score, lives, winning." },
  { id: "spawns", title: "Spawns & difficulty", blurb: "What appears, how often, and when." },
  { id: "presentation", title: "Presentation", blurb: "Colours, HUD and screen text." },
  { id: "spec", title: "Spec", blurb: "The canonical specification this draft produces." },
  { id: "integration", title: "Developer Integration", blurb: "How Kiro works on this repository." },
];

const has = (path: Path, ...prefix: (string | number)[]) => prefix.every((s, i) => path[i] === s);

/** Which section edits the field at `path` (used to jump from a validation issue to its control). */
export function sectionForPath(path: Path): SectionId {
  if (has(path, "project", "platforms") || has(path, "project", "targets")) return "platforms";
  if (has(path, "project") || path[0] === "specVersion") return "overview";
  if (has(path, "game", "palette") || has(path, "game", "hud") || has(path, "game", "screens")) return "presentation";
  if (has(path, "game", "runtime", "kinds") || has(path, "game", "runtime", "initialEntities")) return "entities";
  if (has(path, "game", "runtime", "spawners")) return "spawns";
  if (has(path, "game", "runtime", "collisions") || has(path, "game", "runtime", "lives") || has(path, "game", "runtime", "winScore")) return "rules";
  if (path[0] === "game") return "gameplay";
  return "overview";
}

export function sectionFromHash(hash: string): SectionId {
  const id = hash.replace(/^#\/?/, "");
  return SECTIONS.some((s) => s.id === id) ? (id as SectionId) : "overview";
}
