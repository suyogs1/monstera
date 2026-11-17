// Identity of the engine bundled in Studio, written by scripts/build-engine.mjs into engine-bundle.json and surfaced by
// EngineClient.engine. gitCommit is the repository commit whose engine files were packed (not the Kiro inventory stamp).
export interface EngineInfo {
  /** 40 lowercase hex characters. */
  gitCommit: string;
  /** True when a packed engine input differed from that commit at build time. */
  dirty: boolean;
  source: "git" | "VERCEL_GIT_COMMIT_SHA";
}

/** Validates the `engine` field of the bundle. Throws (never invents a value) when it is missing or malformed. */
export function parseEngineInfo(v: unknown): EngineInfo {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("the engine bundle has no engine identity (rebuild with npm run prepare-assets)");
  const o = v as Record<string, unknown>;
  const sha = o["gitCommit"];
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("the engine bundle's gitCommit is not a 40-character lowercase hex commit");
  if (typeof o["dirty"] !== "boolean") throw new Error("the engine bundle's dirty flag is not a boolean");
  const source = o["source"];
  if (source !== "git" && source !== "VERCEL_GIT_COMMIT_SHA") throw new Error("the engine bundle's source is unknown");
  return { gitCommit: sha, dirty: o["dirty"], source };
}