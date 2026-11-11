#!/usr/bin/env python3
"""One-off: classify every probe of the G1.5 adversarial review (attack.md) and write
docs/G15-REVIEW-TRIAGE.md. Kept so the classification is reproducible and auditable.

Usage: python3 tools/kiro/triage_g15.py .kiro/workflow-output/adversarial/attack.md docs/G15-REVIEW-TRIAGE.md
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# Root causes of genuine findings: id -> (fix, regression test). Probe ids map to a root cause below.
ROOT = {
    "R1": ("Links (junctions/reparse points) treated like symlinks: never followed, written or deleted through; junction output root refused", "OwnershipAttackTests.test_force_never_deletes_through_a_junction, test_verify_reports_a_junction_without_following_it, test_junction_output_root_is_refused_like_a_symlink; McpContainmentTests.test_inspect_manifest_does_not_list_files_behind_a_junction"),
    "R2": ("Files replaced via temp file + rename, never rewritten in place (hard links)", "test_force_never_writes_through_a_hardlink_to_a_user_file"),
    "R3": ("Interrupted first run: files identical to the plan are accepted as own output", "test_interrupted_first_generation_can_be_rerun"),
    "R4": ("Manifest strictly validated (layout + ownedRoots required and consistent, typed fields, entries inside ownedRoots); invalid -> OutputError; --force never deletes unlisted files", "test_forged_manifest_without_layout_cannot_widen_ownership, test_malformed_manifest_is_a_refusal_not_a_traceback, test_user_data_in_a_replaced_guidance_path_survives_force"),
    "R5": ("Recorded file mode compared by verify/check (read-only bit on Windows)", "test_mode_only_change_is_reported"),
    "R6": ("MCP out confined to the project's own folder (apps/<id> for app specs, generated/<name> otherwise)", "McpContainmentTests (3 tests)"),
    "R7": ("Guard: \\\\?\\ and \\\\localhost\\X$ spellings mapped, other UNC fails closed; case-folded comparison", "test_extended_length_and_unc_spellings_are_blocked"),
    "R8": ("Guard: directories containing owned paths blocked (move/delete)", "test_moving_or_deleting_a_directory_that_contains_owned_files_is_blocked"),
    "R9": ("Guard: invalid manifest fails closed; any ancestor manifest's claim wins (decoys can't release)", "test_malformed_manifest_fails_closed, test_nested_decoy_manifest_does_not_unprotect_owned_files"),
    "R10": ("Guard: list values under path keys inspected; extra path keys", "test_path_list_value_is_inspected"),
    "R11": ("archcheck: obfuscation forbidden (YAML escapes, multi-line quoted scalars); pull_request_target case-insensitive", "test_pull_request_target_escaped_in_a_quoted_key, test_permissions_hidden_inside_a_quoted_multiline_scalar"),
    "R12": ("archcheck: permissions must be read-all/{}/read|none scopes; write needs an allow-list entry", "CiFollowUpTests.test_broad_permissions_are_flagged"),
    "R13": ("archcheck: uses: detected in every spelling, composite and root action.yml scanned, .YML case-insensitive", "test_unpinned_actions_in_other_yaml_spellings, test_unpinned_action_inside_a_local_composite_action, test_upper_case_extension_and_root_action_are_scanned"),
    "R14": ("archcheck: any pull_request/workflow_run trigger + any secrets reference (index, toJSON, case, inherit, secrets: key)", "test_secrets_in_pull_request_workflows_in_other_spellings, test_workflow_run_with_secrets_is_flagged"),
    "R15": ("archcheck: Apple SDK rule covers sdk install/setup, .xip, Xcode*.app, platforms, swift-sdks, artifactbundle, line continuations, SDK packaging, linux-build.sh arguments", "test_apple_sdk_generation_and_transfer_beyond_three_keywords, test_remaining_spelling_variants_from_the_probe_log"),
    "R16": ("archcheck: in native trees only VCS/interpreter caches skipped", "test_forbidden_framework_files_in_dirs_named_build_or_xtool"),
    "R17": ("Robustness: kirocheck reports malformed config; MCP catches deep nesting", "RobustnessTests.test_kirocheck_reports_malformed_config_instead_of_crashing; MCP validate_spec RecursionError -> ToolError"),
    "R18": ("App-layout ownedRoots fixed, independent of targets", "test_targets_filter_owned_roots"),
}

GENUINE_FIRST = {  # first probe of each root cause
    "1.03": "R1", "2.12": "R1", "4.06": "R1", "1.05": "R2", "1.06": "R3", "2.07": "R4", "1.11": "R4",
    "2.05a": "R4", "2.04h": "R4", "3.10": "R5", "4.02[apps]": "R6", "4.03": "R6", "4.02[apps/x/assets/gen]": "R6",
    "5.01": "R7", "5.05": "R8", "5.07": "R9", "5.07b": "R9", "5.03b": "R10", "5.03": "R10", "6.07": "R16",
    "7.01": "R17", "4.12": "R17", "2.03": "R18", "6.04[workflow_run]": "R14", "6.06[.YML]": "R13",
    "6.03[root action.yml]": "R13", "6.03[composite action]": "R13",
}
DUPLICATE = {"5.01b": "5.01", "4.02b": "4.02[apps]", "4.02c": "4.02[apps]", "3.23": "4.06",
             "2.05b": "2.05a", "2.05c": "2.05a", "2.05d": "2.05a", "2.05f": "2.05a"}
FALSE_POSITIVE = {"6.04[expr github_token lower (safe)]":
                  "secrets.github_token is GITHUB_TOKEN; now exempt in any case (test_github_token_in_any_case_is_not_a_secret_finding)"}
EXPECTED = {
    "1.07": "Refusal is the correct outcome after an interrupted regeneration plus a new spec edit",
    "2.06": "The manifest is the root of trust; forging a hash to match a hand edit is a deliberate act",
    "3.21": "android/app/build is tool build output by design (fixed location)",
    "3.22": "Empty directories carry no data; not tracked by the manifest",
    "3.26": "verify checks a tree against its own manifest; a self-consistently shrunk manifest is caught by generate --check",
    "5.09": "A PreToolUse hook covers file tools only; shell writes are caught by verify/--check/CI",
    "6.02[dq key]": "Rule fired as intended (recorded NOTE)",
    "6.06[nested .github]": "GitHub does not load workflows outside the root .github/",
}
RULE_FAMILY = {"6.01": "R11", "6.02": "R12", "6.03": "R13", "6.04": "R14", "6.05": "R15"}


def classify(pid: str, verdict: str) -> tuple[str, str]:
    if verdict == "HELD":
        return "held", ""
    if verdict == "UNTESTABLE":
        return "expected limitation", "could not be exercised on this host (symlink privilege / invalid probe YAML)"
    if pid in FALSE_POSITIVE:
        return "false positive", FALSE_POSITIVE[pid]
    if pid in DUPLICATE:
        return "duplicate", f"of {DUPLICATE[pid]}"
    if pid in GENUINE_FIRST:
        r = GENUINE_FIRST[pid]
        return "genuine", f"{r}: {ROOT[r][0]}"
    if pid.startswith("3.bo."):
        return "expected limitation", "fixed tool build-output location, ignored by design"
    if pid in EXPECTED:
        return "expected limitation", EXPECTED[pid]
    family = RULE_FAMILY.get(pid[:4])
    if family and verdict == "BROKEN":
        return "duplicate", f"spelling variant; root cause {family}"
    return "UNCLASSIFIED", ""


def main() -> int:
    source, target = Path(sys.argv[1]), Path(sys.argv[2])
    rows = []
    for line in source.read_text(encoding="utf-8").splitlines():
        if not re.match(r"^\| [0-9]", line):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        pid, verdict = cells[0], cells[-1]
        probe = re.sub(r"\s+", " ", cells[2])[:110].replace("|", "/")
        kind, note = classify(pid, verdict)
        rows.append((pid, verdict, kind, probe, note))
    counts: dict[str, int] = {}
    for _, _, kind, _, _ in rows:
        counts[kind] = counts.get(kind, 0) + 1
    out = ["# G1.5 adversarial review: triage of every probe", "",
           f"Source: `.kiro/workflow-output/adversarial/attack.md` (workflow run `wf_19bbf8ec6126f08a`), "
           f"{len(rows)} probes. Generated by `tools/kiro/triage_g15.py`.", "",
           "| Class | Probes |", "|---|---|"]
    out += [f"| {k} | {v} |" for k, v in sorted(counts.items())]
    out += ["", "## Genuine root causes, fixes and regression tests", "", "| Root cause | Fix | Regression test(s) |", "|---|---|---|"]
    out += [f"| {r} | {fix} | {test} |" for r, (fix, test) in ROOT.items()]
    out += ["", "## Every probe", "", "| Probe | Review verdict | Classification | Probe | Note |", "|---|---|---|---|---|"]
    out += [f"| {p} | {v} | {k} | {pr} | {n} |" for p, v, k, pr, n in rows]
    target.write_text("\n".join(out) + "\n", encoding="utf-8", newline="\n")
    print(counts)
    return 1 if counts.get("UNCLASSIFIED") else 0


if __name__ == "__main__":
    sys.exit(main())
