// Committed native conformance reports (`monstera conformance`, docs/evidence/**/*.report.json, indexed at build time).
// A report applies only to the exact specification SHA-256 it was recorded for. Nothing here is inferred from the browser.
export interface ConformanceReport { file: string; specSha256: string; verdict: string; platforms: { platform: string; status: string }[]; scenarios: string[] }

export interface NativeEvidence { exact: ConformanceReport[]; otherSpecsOfProject: ConformanceReport[] }

export function nativeEvidence(reports: ConformanceReport[], sha: string | null, projectId: string | null): NativeEvidence {
  return {
    exact: sha ? reports.filter((r) => r.specSha256 === sha) : [],
    otherSpecsOfProject: projectId ? reports.filter((r) => r.file.endsWith(`/${projectId}.report.json`) && r.specSha256 !== sha) : [],
  };
}
