// Pack layout (design 3.1, 3.4): which ownership class a path of the exported project belongs to. Pure, no I/O.
// The pack reuses the Task 4.3 level path (`studio-pack/derived/levels/<id>/monstera.spec.json`); it adds no second format.
export const MANIFEST_PATH = "MONSTERA-STUDIO-MANIFEST.json";
/** Classes recorded in MONSTERA-STUDIO-MANIFEST.json. */
export type ManifestClass = "studio-data" | "studio-scaffold" | "write-once";
/** Every class a path can have. `spec` and `engine-owned` files travel in the archive but are not in the Studio manifest. */
export type PackClass = ManifestClass | "spec" | "engine-owned";
export const MANIFEST_CLASSES: readonly ManifestClass[] = ["studio-data", "studio-scaffold", "write-once"];
export const isManifestClass = (c: unknown): c is ManifestClass => typeof c === "string" && (MANIFEST_CLASSES as readonly string[]).includes(c);

/** The class of an archive path, or null when the path belongs to no part of the layout (including the manifest itself). */
export function classOf(path: string): PackClass | null {
  if (path === "monstera.spec.json") return "spec";
  if (path === "MONSTERA-MANIFEST.json" || path === ".kiro/steering/monstera-generated.md") return "engine-owned";
  if (path.startsWith("android/") || path.startsWith("ios/")) return "engine-owned";
  if (path.startsWith("studio-pack/scaffold/") || path.startsWith("studio-pack/derived/") || path.startsWith("tools/")) return "studio-scaffold";
  if (path === "studio-pack/PROJECT-NOTES.md") return "write-once";
  if (path.startsWith("studio-pack/assets/")) return "studio-data";
  if (/^studio-pack\/[^/]+\.json$/.test(path)) return "studio-data";
  if (path.startsWith("extensions/")) return "write-once";
  if (path.startsWith(".kiro/steering/") || path.startsWith(".kiro/specs/") || path.startsWith(".kiro/hooks/")) return "write-once";
  if (path === ".gitignore") return "write-once";
  return null;
}

