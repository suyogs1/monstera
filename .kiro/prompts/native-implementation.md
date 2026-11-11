Implement Kiro Spec task: $ARGUMENTS

1. Read the task in `.kiro/specs/<spec>/tasks.md`, the requirement IDs it cites in
   `requirements.md`, and the relevant part of `design.md`. Read `.kiro/steering/02`, `03`, `06`.
2. Change the **canonical spec, schemas or generator templates**, never generated output
   (`generated/**`, `apps/*/android/**`, `apps/*/ios/**`). A hook blocks hand edits there.
3. Regenerate: `tools/monstera/bin/monstera generate <spec>` (Windows: `py -3 tools/monstera/monstera.py ...`).
   Never use `--force` unless the task explicitly says to discard hand edits.
4. Verify:
   - `monstera gates` must pass.
   - Android: `cd <out>/android && ./gradlew assembleDebug` (plus `testDebugUnitTest` when tests exist).
   - iOS: compile via CI (`monstera` workflow, `ios-generated` job) or on macOS with
     `xtool dev build --triple arm64-apple-ios-simulator`.
5. Keep generated apps independent: Kotlin + Compose / Swift + SwiftUI + SpriteKit only; nothing
   that needs Kiro, Python or Studio at build or run time.

Report:
- The diff summary (files changed, why), with requirement IDs.
- The full `monstera gates` output.
- The build command(s) and outcome.
- The highest verification label reached (GENERATED / COMPILED / SIMULATOR-TESTED /
  PHYSICAL-DEVICE-TESTED) and the evidence for it. Never claim a level without evidence.
