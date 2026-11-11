# Kiroween 2026 alignment report (Skeleton Crew)

> **Submission deadline: December 4, 2026, 2:00 pm Pacific Time. No extensions, no late submissions.**
> Internal target: submit by **December 3, 2026** (one day of buffer).

Source of every rule below: the official rules, <https://kiroween.devpost.com/rules>, read in
full on 2026-11-11. Rules are paraphrased here; the rules page wins in case of doubt.
Status values: ✅ met (with evidence) · ⚠️ partial · ❌ missing. No item is marked met without the
evidence named in its row.

## Key dates

| Event | Date (Pacific Time) |
|---|---|
| Submission Period | Oct 30, 2026, 9:00 am – **Dec 4, 2026, 2:00 pm** |
| Judging | Dec 16, 2026 – Jan 29, 2027 |
| Winners announced | around Feb 3, 2027 |

## Category

**Skeleton Crew**: a skeleton code template lean enough to be clear but flexible enough to support
various use cases, demonstrated by **two distinct applications** built from it.

MONSTERA's skeleton is the Kiro-first native game foundation: canonical spec + engine + native
runtime templates + Kiro foundation (`architecture/KIRO-OPERATING-MODEL.md`). The two
applications are:
- **Pumpkin Blaster**, a landscape 2D arcade shooter.
- **Trick or Treat Rush**, a portrait 2D endless runner.

## Compliance checklist

| # | Requirement (rules) | Status | Evidence / gap | Closed in |
|---|---|---|---|---|
| 1 | Two separate repo folders for the two applications | ❌ | Planned `apps/pumpkin-blaster/`, `apps/trick-or-treat-rush/`; `apps/` currently holds the G0 reference apps (migration plan: `docs/REPO-MIGRATION-PLAN.md`) | G1.5 (move), G3 (apps) |
| 2 | Public GitHub repository | ✅ | `github.com/suyogs1/monstera`, visibility PUBLIC (GitHub API, 2026-11-11) | - |
| 3 | Open source licence, detectable and visible in the About section | ⚠️ | GitHub detects **MIT** from `LICENSE` (API `/license`). The About **description and website are empty**: add a description and, later, the Studio URL | G1.5 (description), G6 (URL) |
| 4 | `/.kiro` at the repository root, not git-ignored | ✅ | `.kiro/` tracked on `main` (steering, specs, agents, hooks); `.gitignore` documents it must not be ignored | Kept current every phase |
| 5 | Working URL to the functional application(s) | ❌ | MONSTERA Studio not built or deployed (plan: `architecture/MONSTERA-STUDIO.md`, Vercel + Railway) | G4-shell (first URL), G6 (validated) |
| 6 | Project installs and runs consistently on its intended platform, as shown in the video | ⚠️ | Only the G1 sample app is SIMULATOR-TESTED (Android emulator, iOS Simulator). Neither game exists | G3, G5 |
| 7 | Two **distinct** working native apps from the same foundation | ❌ | Not started. Distinctness criteria below | G3 |
| 8 | Demo video **< 3 minutes**, public on **YouTube**, link in the submission | ❌ | Not recorded | G6 |
| 9 | Video shows the project **functioning on the device it was built for** | ❌ | Emulator and simulator footage is possible today. **Physical-device footage needs an Android phone (and, for iPhone, an Apple ID + iPhone) from the owner** | G5/G6 |
| 10 | No third-party trademarks or copyrighted music in the video without permission | ⚠️ plan | Royalty-free or original audio only; no Apple/Google/Halloween-brand logos | G6 |
| 11 | Text description of features and functionality | ❌ | Drafted from `docs/KIRO-USAGE.md` + reports | G6 |
| 12 | Built with Kiro; "insufficient use of Kiro" disqualifies | ⚠️ | Steering, Kiro Specs, agents and hooks are used and committed. Workflows, prompts, MCP and a power are proposed. `docs/KIRO-USAGE.md` (feature → artifact → recorded use) doesn't exist yet | G1.5 onward |
| 13 | Project newly created during the Submission Period | ✅ | Repository created 2026-11-11T04:52:58Z; first commit `176362c` 2026-11-11 (after Oct 30) | - |
| 14 | Disclose pre-existing code or work incorporated | ❌ | Needs a README "Provenance and third-party tools" section (list below) | G1.5 |
| 15 | Repository contains all source, assets and instructions needed to run | ⚠️ | Engine, sample and G0 apps have instructions; the games' assets and instructions don't exist yet | G3, G6 |
| 16 | Category (and bonus category) identified in the submission | ❌ | Skeleton Crew; bonus categories to be decided by the owner | G6 |
| 17 | Third-party SDKs/APIs used under their terms | ⚠️ | Android SDK, Xcode (hosted macOS runners only), xtool, GitHub Actions, Vercel, Railway. The Apple SDK CI transfer is disabled pending licensing review (G0) | Ongoing |

## Distinctness and reuse (G3 acceptance, so "two skins" can't pass)

The two games must differ in **mechanics**, not just presentation:

| Dimension | Pumpkin Blaster | Trick or Treat Rush |
|---|---|---|
| Orientation | Landscape | Portrait |
| Core loop | Shoot incoming waves; survive and score | Auto-run; dodge obstacles, collect treats |
| Player motion | Free 2D movement (drag) | Lane switching / jump (swipe) |
| Camera | Fixed arena | Continuous vertical or horizontal scroll |
| Spawning | Wave patterns, aimed projectiles | Procedural track segments, PRNG-driven |
| Fail state | Lives depleted by hits | Collision ends the run (or lives) |
| Scoring | Kills × combo multiplier | Distance + collectibles |

Measured and reported in G3 (`docs/G3-GAMES-REPORT.md`):
- **Reuse**: share of generated lines and files that come from shared templates vs. game-specific
  spec data, per platform. Per-app source is limited to spec, assets and (only if unavoidable)
  `extensions/`, each listed in its manifest.
- **Provenance**: each app's manifest records the spec SHA-256, schema digests, template paths and
  generator version. Asset provenance is recorded in `apps/<id>/assets/PROVENANCE.md`.
- **Behavioural difference**: each game has its own golden scenarios (G2 runtime), and the two games' scenario suites are disjoint.

## Provenance and pre-existing tools to disclose

| Item | Use | Origin |
|---|---|---|
| Gradle wrapper 9.9.1 (`gradle-wrapper.jar`, `gradlew*`) | Android builds | Gradle (checksum verified against gradle.org) |
| Android Gradle Plugin, Kotlin Compose plugin, Jetpack Compose BOM | Android app dependencies | Google / JetBrains, pinned versions |
| xtool 1.24.0 | SwiftPM → iOS app bundle | github.com/xtool-org/xtool |
| Xcode (GitHub-hosted macOS runners) | iOS SDK and Simulator | Apple, used on Apple hardware only |
| GitHub Actions (`actions/checkout`, `actions/upload-artifact`, pinned by SHA) | CI | GitHub |
| MCP Python SDK (planned, pinned) | MCP server | modelcontextprotocol |
| Studio web/API stack (planned, pinned) | Studio | listed when added |

No starter template or pre-existing application code is incorporated. All MONSTERA code was
written in this repository during the Submission Period (history from `176362c`).

## Kiro usage plan (judging: Technological Implementation)

| Kiro feature | Where | Status |
|---|---|---|
| Steering | `.kiro/steering/01–06` (+07 Studio, +08 runtime) | Used since G0 |
| Kiro Specs | `.kiro/specs/g1-specification-engine/` (done), `g2-deterministic-runtime/` (proposed) | Used |
| Custom agents | `.kiro/agents/*.json` (6, +`studio`) | Defined; picker loading to be verified |
| Hooks | `.kiro/hooks/` (3; +2 planned) | Guard verified live |
| Prompts | `.kiro/prompts/` (5) | Proposed |
| Workflows | `.kiro/workflows/` (5) | Proposed |
| Custom MCP server | `tools/monstera-mcp/` (4 tools) | Proposed |
| Power | `powers/monstera/` | Planned (G4) |
| Adversarial review | `monstera-adversarial-review` workflow; G1 review found and fixed 2 real holes | Practiced in G1 |

## Schedule (to meet the deadline)

| Phase | Window (2026) | Exit evidence |
|---|---|---|
| G1.5 alignment + Kiro foundation | Nov 11–12 | Migration done, CI green, workflows/prompts/MCP live, `KIRO-USAGE.md` started |
| G2 deterministic runtime | Nov 12–17 | Conformance green on Kotlin JVM + Swift (Linux/macOS); negative proof |
| G4-shell Studio (parallel) | Nov 13–18 | Public Vercel URL + Railway API: validate + source zip |
| G3 two games | Nov 17–24 | Both apps SIMULATOR-TESTED on both platforms; reuse report |
| G4 Studio complete | Nov 20–27 | Build dispatch + downloads from the hosted URL |
| G5 Device Lab, haptics, motion | Nov 24–28 | Capabilities in the schema; physical-device runs if hardware is available |
| G6 polish, video, submission | Nov 28 – **Dec 3** | Deployment validation, video on YouTube, Devpost form complete |

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Schedule (23 days for runtime, two games, Studio, video) | Incomplete submission | Studio shell in parallel from day 2; cut order: iOS physical device → Studio visual depth → Pyodide |
| No physical device footage | Weaker on "functioning on the device" | Owner provides an Android phone for G5/G6; iPhone needs an Apple ID |
| Hosted Studio availability during judging (Dec 16 – Jan 29) | Broken URL disqualifies the functional-app requirement | Keep Vercel/Railway running through Feb 3; health check; access code in the submission form |
| macOS CI minutes / queueing | Slow iOS builds in Studio | Concurrency cap; cache; queue display in Studio |
| Two games judged as "two skins" | Fails Skeleton Crew intent | Distinctness table above as a G3 acceptance criterion |
