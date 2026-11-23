// Test-only: builds a bundle archive WITHOUT the export guard, so tests can present hostile archives (a credential in a
// manifest or the spec) to importBundle. Production code never imports this.
import { bundleEntries, type BundleProject } from "./bundle";
import { buildZip } from "./zip";
export const unguardedBundle = (p: BundleProject): Uint8Array<ArrayBuffer> => buildZip(bundleEntries(p));
