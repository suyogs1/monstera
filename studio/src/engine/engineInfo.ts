// Identity of the engine bundled in Studio, written by scripts/build-engine.mjs into engine-bundle.json and surfaced by
// EngineClient.engine. gitCommit is the repository commit whose engine files were packed (not the Kiro inventory stamp).
export type EngineInfo =
  /** Built from a git checkout: dirty says whether a packed engine input differed from that commit. */
  | { gitCommit: string; dirty: boolean; source: "git" }
  /** Built from VERCEL_GIT_COMMIT_SHA without git: the working tree was not inspected, so cleanliness is unknown (null). */
  | { gitCommit: string; dirty: null; source: "VERCEL_GIT_COMMIT_SHA" };

/** Validates the `engine` field of the bundle. Throws (never invents a value) when it is missing or malformed. */
export function parseEngineInfo(v: unknown): EngineInfo {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("the engine bundle has no engine identity (rebuild with npm run prepare-assets)");
  const o = v as Record<string, unknown>;
  const sha = o["gitCommit"];
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("the engine bundle's gitCommit is not a 40-character lowercase hex commit");
  const source = o["source"], dirty = o["dirty"];
  if (source === "git") {
    if (typeof dirty !== "boolean") throw new Error("a git-built engine bundle must record dirty as a boolean");
    return { gitCommit: sha, dirty, source };
  }
  if (source === "VERCEL_GIT_COMMIT_SHA") {
    if (dirty !== null) throw new Error("a VERCEL_GIT_COMMIT_SHA engine bundle cannot know its cleanliness; dirty must be null");
    return { gitCommit: sha, dirty: null, source };
  }
  throw new Error("the engine bundle's source is unknown");
}
