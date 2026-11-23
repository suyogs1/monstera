# Studio Foundry: Gate E decision

Status: owner decision recorded. It does not change `.kiro/specs/studio-foundry/tasks.md` and does not mark any task complete. Background: `.kiro/specs/studio-foundry/design.md`, engine extension table (E1 to E3).

| Track | Decision | Meaning |
|---|---|---|
| E1 (sprite atlas and animation in the native apps) | **Approved; implementation authorized now** (owner decision, after the framework freeze sign-off) | One atlas per project, sprite references on kinds, frames driven by simulation ticks, on Android and iOS. Implemented on a separate branch and PR, following the steering 08 order. Anything larger is cut, not scheduled. |
| E2 (developer-owned source roots compiled into the app) | Conditional | Considered only after E1 is complete and verified, and after a review of the remaining time and credits. A separate owner decision. |
| E3 (level table in the spec) | Deferred | Post-submission work. |

## G6 baseline and sequencing

- The frozen G6 baseline stays `71c77e448972bd5cd997993d518d3cf91adb3328`. The owner signed off the framework and specification freeze at that baseline. The G6 clean-room evidence (`docs/evidence/g6-cleanroom/`) describes that baseline and is not rewritten.
- The Task 9.2 regression result on `7f0292b` (5 pass, 0 pending, 0 fail) is the historical G6 result.
- The owner explicitly allowed E1 to start before G6 item 5(d), the recorded demonstration. That recording and the final G6 acceptance are still outstanding and are not claimed here.
- E1 changes are compared against the pre-E1 main `7f0292ba99ccc1b874bf30047ae175aacd021d9f`. The Task 9.2 proof checks both stages: `71c77e4` to `7f0292b` must still be the original freeze (only the approved Task 4.2 test-only change), and `7f0292b` to the current head may change only the paths E1 is approved for.

## Task 9.2 freeze rule before E1

The only permitted difference under `tools/monstera` or `spec/schema` between `71c77e4` and `7f0292b` is the approved Task 4.2 (#20) test-only change to `tools/monstera/tests/test_studio_glue.py`: baseline blob `47c6b54`, approved blob `cd3dfa6` (a fixed constant, never derived from HEAD), exactly 25 lines added and 0 deleted.
