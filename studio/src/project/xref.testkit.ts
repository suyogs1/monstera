// Test fixtures for the cross-reference index, the aggregator and the kind rename/delete (task 1.4). Imported by tests only.
// A realistic project: the real Pumpkin Blaster spec (kinds player, bullet, pumpkin, bat, ember, star) with the golden
// manifest fixtures retargeted to those kinds, so every manifest type holds references to kinds the spec defines.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SchemaModel, type Json } from "../schema/schema";
import { MANIFEST_NAMES, validateManifest, type ManifestMap, type ManifestName } from "./manifests";
import { kindIdCheck, type KindIdCheck } from "./kindOps";
import { pumpkinText } from "./testkit";
const fixture = (n: ManifestName): string =>
  readFileSync(join(__dirname, "manifests", "fixtures", `${n}.valid.json`), "utf8")
    .replaceAll('"lantern"', '"star"').replaceAll('"keeper"', '"player"').replaceAll('"wisp"', '"bat"');
export const pumpkinDoc = (): Json => JSON.parse(pumpkinText) as Json;
/** Fresh, independent copies on every call. Validated, so a broken fixture fails loudly here and not in a test. */
export function xrefManifests(): ManifestMap {
  const m = Object.fromEntries(MANIFEST_NAMES.map((n) => [n, JSON.parse(fixture(n))])) as unknown as ManifestMap;
  m.project = { ...m.project, projectId: "pumpkin-blaster" };
  // the second (audio) asset links two kinds, sorted, so one asset holds several references
  m.assets = { ...m.assets, assets: m.assets.assets.map((a, i) => (i === 1 ? { ...a, kindRefs: ["bat", "bullet"] } : a)) };
  for (const n of MANIFEST_NAMES) {
    const r = validateManifest(n, m[n]);
    if (!r.ok) throw new Error(`xref fixture ${n} is invalid: ${r.issues[0]?.path.join(".")} ${r.issues[0]?.message}`);
  }
  return m;
}
const schemaDir = join(__dirname, "..", "..", "..", "spec", "schema");
/** The engine's kind-id pattern, read through the same SchemaModel Session uses (never written out in a test). */
export const kindIdPattern = (): string | undefined =>
  new SchemaModel(Object.fromEntries(["monstera.spec.schema.json", "project.schema.json", "game.schema.json"].map((n) => [n, readFileSync(join(schemaDir, n), "utf8")])))
    .field("game.runtime.kinds[].id")?.regex;
export const realKindCheck = (): KindIdCheck => kindIdCheck(kindIdPattern());