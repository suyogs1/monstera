# Studio Foundry: Gate E recommendation

Status: recommendation recorded for the current milestone. It does not change `.kiro/specs/studio-foundry/tasks.md` and does not mark any task complete. Background: `.kiro/specs/studio-foundry/design.md`, engine extension table (E1 to E3).

| Track | Recommendation | Meaning |
|---|---|---|
| E1 (sprite atlas and animation in the native apps) | Not approved for this milestone | No engine, schema or template work starts now. Studio keeps asset and animation authoring as Studio-only features. |
| E2 (developer-owned source roots compiled into the app) | Deferred | Revisit only after a later recorded gate. |
| E3 (level table in the spec) | Out of scope | Post-deadline work. |

The canonical engine, schema and template freeze is preserved. The baseline stays `71c77e4`.

The Task 9.2 regression proof (`npm run regression` in `studio/`) enforces the freeze. The only permitted difference under `tools/monstera` or `spec/schema` is the approved Task 4.2 (#20) test-only change to `tools/monstera/tests/test_studio_glue.py`: baseline blob `47c6b54`, approved blob `cd3dfa6` (a fixed constant, never derived from HEAD), exactly 25 lines added and 0 deleted. Any other change fails the check. Exported-spec validation and the G6 evidence comparison remain PENDING.
