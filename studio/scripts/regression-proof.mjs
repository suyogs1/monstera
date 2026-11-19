// Task 9.2 regression proof (A9, R14.2). Runs the commands the task names and prints each command with its observed
// exit code and output. Statuses: PASS, PENDING (a dependency or an owner decision is outstanding, never a pass), FAIL.
// Exit code is 1 only when a check is FAIL. Nothing here writes into the repository.
//   node scripts/regression-proof.mjs [--json]
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE = "71c77e4";
const G6_REF = "origin/g6/clean-room-regeneration";
// Task 4.2 (#20) added this one test file under tools/monstera after BASE. It is the only known difference.
const KNOWN_ENGINE_DELTA = ["tools/monstera/tests/test_studio_glue.py"];
const CI = process.env.CI === "true";

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { command: [cmd, ...args].join(" "), exit: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
};
const git = (...args) => run("git", args);
const python = (() => {
  for (const c of [["python3"], ["python"], ["py", "-3"]]) {
    const r = spawnSync(c[0], [...c.slice(1), "--version"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  return null;
})();
const monstera = (...args) => run(python[0], [...python.slice(1), join("tools", "monstera", "monstera.py"), ...args]);
const tail = (s, n = 3) => s.split(/\r?\n/).slice(-n).join("\n");
const results = [];
const add = (id, status, summary, runs, detail) => results.push({ id, status, summary, runs, detail });
const haveRef = (ref) => git("cat-file", "-e", `${ref}^{commit}`).exit === 0;

// 1. Engine and schema untouched since BASE.
if (!haveRef(BASE)) {
  add("engine-schema-diff", CI ? "FAIL" : "PENDING", `${BASE} is not available in this checkout (shallow clone?)`, []);
} else {
  const names = git("diff", "--name-only", BASE, "--", "tools/monstera", "spec/schema");
  const stat = git("diff", "--numstat", BASE, "--", "tools/monstera", "spec/schema");
  const files = names.out ? names.out.split(/\r?\n/) : [];
  const unexpected = files.filter((f) => !KNOWN_ENGINE_DELTA.includes(f));
  if (files.length === 0) add("engine-schema-diff", "PASS", "git diff is empty", [names]);
  else if (unexpected.length > 0) add("engine-schema-diff", "FAIL", `unexpected changes: ${unexpected.join(", ")}`, [names, stat]);
  else add("engine-schema-diff", "PENDING", `NOT empty as the task requires. Only the known task 4.2 test addition differs (${files.join(", ")}); owner must accept or amend the criterion`, [names, stat]);
}

// 2. Native gates.
if (!python) add("gates", "FAIL", "no Python 3 found", []);
else {
  const g = monstera("gates");
  add("gates", g.exit === 0 ? "PASS" : "FAIL", tail(g.out, 1), [{ ...g, out: g.exit === 0 ? tail(g.out, 1) : g.out.split(/\r?\n/).filter((l) => /^(FAIL|gates)/.test(l)).map((l) => l.slice(0, 160)).join("\n") }]);
}

// 3. generate --check and verify. Stand-in: the committed specs, because no Studio export exists until tasks 1.6, 1.7 and 9.1 land.
if (python) {
  const specs = [
    ["apps/pumpkin-blaster/monstera.spec.json", "apps/pumpkin-blaster"],
    ["apps/trick-or-treat-rush/monstera.spec.json", "apps/trick-or-treat-rush"],
    ["spec/samples/lantern-run/monstera.spec.json", "generated/lantern-run"],
  ];
  const runs = [];
  for (const [spec, dir] of specs) {
    runs.push(monstera("generate", spec, "--check"), monstera("verify", dir));
  }
  const ok = runs.every((r) => r.exit === 0);
  add("generate-check-verify", ok ? "PASS" : "FAIL", `${specs.length} committed specs (stand-in)`, runs.map((r) => ({ ...r, out: tail(r.out, 1).slice(0, 200) })));
}
add("exported-spec", "PENDING", "no Studio-exported spec was checked: tasks 1.6 and 1.7 (export, re-import) and 9.1 (end-to-end) are not merged. The committed specs above are a stand-in, not the A9 proof", []);

// 4. G6 evidence untouched.
if (!haveRef(G6_REF)) {
  add("g6-evidence-diff", "PENDING", `${G6_REF} is not available in this checkout`, []);
} else {
  const ns = git("diff", "--name-status", G6_REF, "--", "docs/evidence/g6-cleanroom");
  const lines = ns.out ? ns.out.split(/\r?\n/) : [];
  const nonDelete = lines.filter((l) => !l.startsWith("D"));
  if (lines.length === 0) add("g6-evidence-diff", "PASS", "git diff is empty", [ns]);
  else if (nonDelete.length === 0) add("g6-evidence-diff", "PENDING", `NOT empty as the task requires: ${lines.length} files exist on ${G6_REF} and not on this branch (g6 evidence is not merged to main); no file differs in content`, [{ ...ns, out: `${lines.length} lines, all D` }]);
  else add("g6-evidence-diff", "FAIL", `content differs: ${nonDelete.slice(0, 5).join("; ")}`, [ns]);
}

const failed = results.filter((r) => r.status === "FAIL");
if (process.argv.includes("--json")) console.log(JSON.stringify(results, null, 2));
else {
  for (const r of results) {
    console.log(`${r.status.padEnd(8)} ${r.id}: ${r.summary}`);
    for (const c of r.runs) console.log(`  $ ${c.command}\n    exit=${c.exit}${c.out ? `\n    ${c.out.split(/\r?\n/).join("\n    ")}` : ""}`);
  }
  console.log(`\nregression-proof: ${results.filter((r) => r.status === "PASS").length} pass, ${results.filter((r) => r.status === "PENDING").length} pending, ${failed.length} fail`);
}
process.exit(failed.length ? 1 : 0);
