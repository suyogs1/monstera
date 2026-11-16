// Scans a built Studio directory (default dist/) for credential-shaped strings and for source maps.
// Findings name the rule, the file and a count. A matched value is never printed, stored or returned.
// Usage: node scripts/scan-secrets.mjs [dir] [--json <path>]    Exit 1 when anything is found.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RULES = [
  { id: "private-key-block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY/g },
  { id: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
  { id: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "stripe-live-key", re: /\b[sr]k_live_[0-9a-zA-Z]{20,}\b/g },
  { id: "llm-api-key", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/g },
  { id: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { id: "url-with-credentials", re: /\bhttps?:\/\/[^/\s:@"'`]+:[^/\s:@"'`]{3,}@[A-Za-z0-9.-]+/g },
  { id: "named-secret-assignment", re: /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)\b["']?\s*[:=]\s*["'][^"'\s]{12,}["']/g },
];
const INLINE_SOURCE_MAP = /[#@]\s*sourceMappingURL\s*=\s*data:/g; // a reference to a map that is not shipped (vendored Pyodide has one) leaks nothing
const LOCAL_PATH = /(?:[A-Za-z]:\\\\?Users\\\\?|\/home\/runner\/|\/Users\/[a-z][\w.-]*\/)/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const count = (text, re) => { re.lastIndex = 0; let n = 0; while (re.exec(text)) n++; return n; };

/** @returns {{ scanned: number, findings: { file: string, rule: string, count: number }[] }} */
export function scan(dir) {
  const root = resolve(dir);
  const findings = [];
  const files = walk(root);
  for (const file of files) {
    const rel = relative(root, file).split("\\").join("/");
    const text = readFileSync(file).toString("latin1");
    for (const rule of RULES) {
      const n = count(text, rule.re);
      if (n) findings.push({ file: rel, rule: rule.id, count: n });
    }
    if (rel.endsWith(".map")) {
      findings.push({ file: rel, rule: "source-map-file", count: 1 });
      const n = count(text, LOCAL_PATH);
      if (n) findings.push({ file: rel, rule: "source-map-local-path", count: n });
    } else if (/\.(?:js|mjs|css)$/.test(rel)) {
      const n = count(text, INLINE_SOURCE_MAP);
      if (n) findings.push({ file: rel, rule: "source-map-inline", count: n });
    }
  }
  return { scanned: files.length, findings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const jsonAt = args.indexOf("--json");
  const jsonPath = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : null;
  const dir = args[0] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
  const result = scan(dir);
  const summary = { directory: "dist", rules: RULES.map((r) => r.id).concat(["source-map-file", "source-map-local-path", "source-map-inline"]), scanned: result.scanned, findings: result.findings, verdict: result.findings.length ? "FAIL" : "PASS" };
  if (jsonPath) { mkdirSync(dirname(resolve(jsonPath)), { recursive: true }); writeFileSync(jsonPath, JSON.stringify(summary, null, 2) + "\n"); }
  console.log(`secret scan: ${summary.verdict}, ${result.scanned} files, ${result.findings.length} finding(s) (values are never printed)`);
  for (const f of result.findings) console.log(`  ${f.rule}  ${f.file}  x${f.count}`);
  process.exit(result.findings.length ? 1 : 0);
}
