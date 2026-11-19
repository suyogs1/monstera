import type { Path } from "../draft/path";

export type SectionId =
  | "overview" | "platforms" | "gameplay" | "entities" | "rules" | "spawns" | "presentation" | "spec" | "determinism" | "export" | "integration" | "levels" | "gameplay-modules" | "gameplay-planned" | "assets" | "sprites" | "completeness" | "readiness" | "dashboard-projects" | "dashboard-status" | "kiro-drift" | "kiro-proposals" | "backend-firebase" | "monetization-placements" | "monetization-mock";

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
  { id: "determinism", title: "Determinism", blurb: "The engine's oracle against the recorded golden scenarios." },
  { id: "export", title: "Native source", blurb: "The generated Android and iOS projects, as a ZIP." },
  { id: "integration", title: "Developer Integration", blurb: "How Kiro works on this repository." },
  { id: "levels", title: "Level Studio", blurb: "Levels: placements, spawn waves, difficulty, variants." },
  { id: "gameplay-modules", title: "Modules", blurb: "Lives, score, collectibles and enemies, compiled into the spec on request." },
  { id: "gameplay-planned", title: "Planned", blurb: "Health, power-ups and progression: not buildable on the current contract." },
  { id: "assets", title: "Asset library", blurb: "Import images and audio with provenance, filter, preview, delete." },
  { id: "sprites", title: "Sprites and animation", blurb: "Slice sprite sheets, edit frames, build animation sequences." },
  { id: "completeness", title: "Completeness", blurb: "What blocks export: errors block, warnings do not." },
  { id: "readiness", title: "Readiness", blurb: "What is proven for this spec hash and what only you can do." },
  { id: "kiro-drift", title: "Drift", blurb: "Which Studio-written files of a re-imported export were edited, are missing or unknown." },
  { id: "kiro-proposals", title: "Proposals", blurb: "Review a change prepared elsewhere: check, compare, accept or reject." },
  { id: "backend-firebase", title: "Firebase", blurb: "Firebase services for the exported scaffold. Scaffold text only, not connected to any backend." },
  { id: "monetization-placements", title: "Placements", blurb: "Mock ad placements, frequency and mode (mock or test)." },
  { id: "monetization-mock", title: "Mock behaviour", blurb: "What the mock rewarded ad does, and the scaffold that carries it." },
  { id: "dashboard-projects", title: "Projects", blurb: "Every project in this browser: create, open, rename, duplicate, delete." },
  { id: "dashboard-status", title: "Status", blurb: "Validation, hash, determinism, native evidence and populated modules of the open project." },
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
