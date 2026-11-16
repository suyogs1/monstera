// Entry point for Studio sidecar manifests: strict read, envelope and version check, schema validation, internal checks,
// and canonical serialization. The engine is not involved; it validates the canonical spec only.
import animationsSchema from "../../../schemas/animations.schema.json";
import assetsSchema from "../../../schemas/assets.schema.json";
import gameplaySchema from "../../../schemas/gameplay.schema.json";
import integrationsSchema from "../../../schemas/integrations.schema.json";
import levelsSchema from "../../../schemas/levels.schema.json";
import projectSchema from "../../../schemas/project.schema.json";
import proposalSchema from "../../../schemas/proposal.schema.json";
import { checkManifest, type ManifestName } from "./checks";
import { compileSchema, inSchemaOrder, validate, type CompiledSchema, type Issue } from "./schema";
import { decodeUtf8Strict, parseStrictJson } from "./strictJson";
import type {
  AnimationsManifest, AssetsManifest, GameplayManifest, IntegrationsManifest, LevelsManifest, ProjectManifest, ProposalManifest,
} from "./types";

export const MANIFEST_VERSION = 1;
export const MANIFEST_NAMES: readonly ManifestName[] = ["project", "assets", "animations", "levels", "gameplay", "integrations", "proposal"];

const SCHEMAS: Record<ManifestName, CompiledSchema> = {
  project: compileSchema(projectSchema), assets: compileSchema(assetsSchema), animations: compileSchema(animationsSchema),
  levels: compileSchema(levelsSchema), gameplay: compileSchema(gameplaySchema), integrations: compileSchema(integrationsSchema),
  proposal: compileSchema(proposalSchema),
};

export interface ManifestMap {
  project: ProjectManifest; assets: AssetsManifest; animations: AnimationsManifest; levels: LevelsManifest;
  gameplay: GameplayManifest; integrations: IntegrationsManifest; proposal: ProposalManifest;
}
export type ManifestResult<N extends ManifestName> = { ok: true; value: ManifestMap[N] } | { ok: false; issues: Issue[] };

/** Validates an already parsed value. Order of checks: envelope, version, schema, internal checks. */
export function validateManifest<N extends ManifestName>(name: N, value: unknown): ManifestResult<N> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const env = value as Record<string, unknown>;
    if (typeof env["schema"] === "string" && env["schema"] !== `monstera.studio.${name}`) {
      return { ok: false, issues: [{ path: ["schema"], code: "wrong-schema", message: `expected "monstera.studio.${name}", found "${env["schema"]}"` }] };
    }
    const v = env["version"];
    if (typeof v === "number" && Number.isInteger(v) && v > MANIFEST_VERSION) {
      return { ok: false, issues: [{ path: ["version"], code: "newer-version", message: `version ${v} was written by a newer Studio; this one reads version ${MANIFEST_VERSION}` }] };
    }
  }
  const issues = validate(value, SCHEMAS[name]);
  if (issues.length > 0) return { ok: false, issues };
  const semantic = checkManifest(name, value);
  if (semantic.length > 0) return { ok: false, issues: semantic };
  return { ok: true, value: value as ManifestMap[N] };
}

/** Parses manifest text. Text and bytes use the strict reader (no BOM, duplicate keys, floats or forbidden keys). */
export function parseManifest<N extends ManifestName>(name: N, input: string | Uint8Array): ManifestResult<N> {
  let text: string;
  if (typeof input === "string") text = input;
  else {
    const d = decodeUtf8Strict(input);
    if (!d.ok) return { ok: false, issues: [{ path: [], code: d.issue.code, message: d.issue.message }] };
    text = d.text;
  }
  const parsed = parseStrictJson(text);
  if (!parsed.ok) return { ok: false, issues: [{ path: [], code: parsed.issue.code, message: `${parsed.issue.message} (at offset ${parsed.issue.offset})` }] };
  return validateManifest(name, parsed.value);
}

/** Canonical text: schema key order, two-space indent, LF, one trailing newline. Throws if the value is invalid. */
export function serializeManifest<N extends ManifestName>(name: N, value: ManifestMap[N]): string {
  const result = validateManifest(name, value);
  if (!result.ok) throw new Error(`cannot serialize an invalid ${name} manifest: ${result.issues[0]?.path.join(".")} ${result.issues[0]?.message}`);
  return JSON.stringify(inSchemaOrder(value, SCHEMAS[name]), null, 2) + "\n";
}

export const schemaFor = (name: ManifestName): CompiledSchema => SCHEMAS[name];
export type { Issue } from "./schema";
export type { ManifestName } from "./checks";
export * from "./types";
