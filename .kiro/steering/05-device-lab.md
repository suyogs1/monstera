# Device Lab architecture

Device Lab runs built apps on targets and collects evidence. Full design: `architecture/DEVICE-LAB.md`.

- Targets: `android-emulator`, `android-device`, `ios-simulator`, `ios-device` (via xtool, if proven).
- Every target implements the same operations: build, install, launch, stop, screenshot, logs, test, report.
- Contract lives in `device-lab/contract/`. Adapters live in `device-lab/<platform>/`.
- Adapters are thin scripts over official tools (adb, emulator, xcrun simctl, xtool). No daemon,
  no scheduler, no orchestration until the operations are individually proven.
- Each run writes evidence to `device-lab/reports/runs/<run-id>/` (git-ignored); curated evidence
  that backs a claim in the G0 report is copied to `docs/evidence/`.
- Adapters print one JSON result line per operation matching `device-lab/contract/result.schema.json`.
