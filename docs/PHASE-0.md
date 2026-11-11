# Phase 0 (G0) completion criteria

1. Repository structure exists.
2. Kiro steering and project instructions are present.
3. Android APK successfully builds.
4. Android application launches in an emulator.
5. xtool experiment has a documented, reproducible result.
6. Hosted macOS iOS Simulator build is proven.
7. Device Lab interfaces are documented.
8. `docs/G0-TOOLCHAIN-REPORT.md` accurately records all results.

Phase 1 does not start until these are evaluated. Results: `docs/G0-TOOLCHAIN-REPORT.md`.

## Structure decisions (differences from the proposed layout)

- Added `device-lab/contract/`: the operation contract and result schema, separate from adapters.
- Added `docs/evidence/`: curated screenshots/logs that back claims in the report.
- Added `docs/XTOOL-EXPERIMENT.md`: reproducible record of the xtool investigation.
- `device-lab/reports/runs/` is git-ignored runtime output; curated evidence is copied to `docs/evidence/`.
