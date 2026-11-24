# Studio Foundry: Gate E decision

Status: owner decision recorded. It does not change `.kiro/specs/studio-foundry/tasks.md` and does not mark any task complete. Background: `.kiro/specs/studio-foundry/design.md`, engine extension table (E1 to E3).

| Track | Decision | Meaning |
|---|---|---|
| E1 (sprite atlas and animation in the native apps) | **Approved; implementation authorized now** (owner decision, with an explicit sequencing override: E1 may start before the G6 recording) | One atlas per project, sprite references on kinds, frames driven by simulation ticks, on Android and iOS. Implemented on a separate branch and PR, following the steering 08 order. Anything larger is cut, not scheduled. |
| E2 (developer-owned source roots compiled into the app) | **Approved; implementation authorized 2026-11-24** (explicit owner decision "E2 native extension integration", main verified at `3a69b2c`, E1 merged) | Template-only change on branch `studio/e2-native-extensions`: the generated Gradle project compiles `extensions/android`, the generated SwiftPM project links `extensions/ios/MonsteraExtensions`, with engine-owned no-op defaults when a root is absent. Studio writes the Firebase scaffold, the AdMob placement constants, `AdService`, `MockRewardedAdService`, a labelled MOCK rewarded overlay, native tests and `SETUP.md` once into `extensions/`. No schema, oracle, emitter or runtime-core change; no SDK, id, key or network call. The Task 9.2 allowlist names the E2 template paths (`E2_ALLOWED`). |
| E3 (level table in the spec) | Deferred | Post-submission work. |

- E2 does not change the G6 baseline or any G6/M3 evidence: it touches only the template paths in `E2_ALLOWED` and regenerates the committed generated trees. Android compile and JVM test results and the iOS CI result are recorded in the E2 pull request, not here.
## G6 baseline and sequencing

- The frozen G6 baseline stays `71c77e448972bd5cd997993d518d3cf91adb3328`. The G6 clean-room evidence (`docs/evidence/g6-cleanroom/`) describes that baseline and is not rewritten. The formal freeze sign-off and the final G6 acceptance are not recorded here.
- The Task 9.2 regression result on `7f0292b` (5 pass, 0 pending, 0 fail) is the historical G6 result.
- The owner explicitly allowed E1 to start before G6 item 5(d), the recorded demonstration (a sequencing override). It does not complete that recording or G6 acceptance; both are still outstanding.
- E1 trade-off: the atlas is embedded in the spec (base64) so the spec stays the single source and needs no file paths. Studio keeps these fields read-only; its Asset and Sprite editors are not yet connected to them.
- E1 changes are compared against the pre-E1 main `7f0292ba99ccc1b874bf30047ae175aacd021d9f`. The Task 9.2 proof checks both stages: `71c77e4` to `7f0292b` must still be the original freeze (only the approved Task 4.2 test-only change), and `7f0292b` to the current head may change only the paths E1 is approved for.

## Task 9.2 freeze rule before E1

The only permitted difference under `tools/monstera` or `spec/schema` between `71c77e4` and `7f0292b` is the approved Task 4.2 (#20) test-only change to `tools/monstera/tests/test_studio_glue.py`: baseline blob `47c6b54`, approved blob `cd3dfa6` (a fixed constant, never derived from HEAD), exactly 25 lines added and 0 deleted.
