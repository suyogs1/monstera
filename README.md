# MONSTERA

An AI-native, specification-driven foundry for native 2D mobile games. Kiro is the development
environment and coding agent.

Two game prototypes are generated from canonical specifications (`apps/`). They are implemented, working native
prototypes, not finished commercial games:

1. Pumpkin Blaster (`apps/pumpkin-blaster/`): landscape arcade shooter.
2. Trick or Treat Rush (`apps/trick-or-treat-rush/`): portrait endless runner.

A third game, Lantern Run (`generated/lantern-run/`), was authored by Kiro through the MONSTERA tools without changing the engine.

**MONSTERA Studio Foundry** is a static web app that runs the unmodified Python engine in the browser (Pyodide) to edit, validate,
preview and export a game specification and its generated native source: https://monstera-phi.vercel.app/ (source in `studio/`).
See [MONSTERA Studio Foundry](#monstera-studio-foundry) below for what works today and what does not.

All games are genuine native apps: Kotlin + Jetpack Compose on Android, Swift + SwiftUI + SpriteKit on
iOS. No React Native, Expo, Flutter or other cross-platform rendering framework.

## Status: G6 clean-room verification is the remaining milestone

| Path | Verification |
|---|---|
| Phase 0 apps: Android on emulator (Windows and Linux CI) | SIMULATOR-TESTED |
| Phase 0 apps: iOS on Simulator (hosted macOS CI) | SIMULATOR-TESTED |
| Phase 0 app: iOS built on Linux with xtool (unsigned) | COMPILED |
| G1 generated Android project (`generated/monstera-sample/android`) | SIMULATOR-TESTED (local emulator); COMPILED in Linux CI |
| G1 generated iOS project (`generated/monstera-sample/ios`) | SIMULATOR-TESTED (hosted macOS CI) |
| Pumpkin Blaster and Trick or Treat Rush, Android | COMPILED (local and CI); SIMULATOR-TESTED on an Android emulator, launch only |
| Pumpkin Blaster and Trick or Treat Rush, iOS | COMPILED with xtool; SIMULATOR-TESTED in hosted macOS CI, launch only |
| Simulation conformance of both games (oracle, Kotlin, Swift) | PASS on the current spec hashes (Kotlin as JVM unit tests, Swift as `swift test` on Linux) |
| Studio (`studio/`) | Deployed at https://monstera-phi.vercel.app/ (the M3-B deployment, 17/17 smoke checks recorded then). Foundry modules on `main` are listed in [the capability matrix](docs/STUDIO-CAPABILITIES.md); the Content-Security-Policy is not deployed |
| Any physical Android or iOS device | **Not tested** |

Completed: G0 toolchain, G1 specification engine, G2 deterministic runtime and conformance, G3 two games, G4 Studio (M0 to M3),
and the Studio Foundry tasks merged to `main` (see below; Foundry acceptance is not complete).
Remaining: **G6**, clean-room regeneration of both games from their committed specs into empty directories, with build
verification and a recorded demonstration (`.kiro/specs/g4-studio/tasks.md`, item 5). The framework and specification
freeze is its first step. G6 is **not accepted**: its pull request (#15, branch `g6/clean-room-regeneration`) is open and
unmerged, and its owner acceptance is pending.

Also pending: the live Vercel report-only deployment of the security headers and the owner's review of its violations (Foundry
Task 1.6; the Root Directory is confirmed as the repository root, and enforcement on production is not approved), the G6
evidence comparison of the regression proof (Task 9.2, whose 18 evidence files are not on `main`), the ChatGPT LLM adversarial
implementation review against the specification and the Git diff (Task 9.4, with an optional Claude LLM architectural critique;
these are LLM reviews, not independent human reviews, and final acceptance belongs to the repository owner), and the demo
script and recording (Task 9.6).

Not shown: gameplay or touch input on an emulator or simulator for the current spec version (the native launch evidence
covers install, launch and the first 60 runtime ticks), performance, haptics, and any physical device.

Evidence: [native build and launch](docs/evidence/m3-native-apps/SUMMARY.md),
[conformance](docs/evidence/m3-native-conformance/SUMMARY.md), [Studio M3-B](docs/evidence/studio-m3b/README.md).
Reports: [G0](docs/G0-TOOLCHAIN-REPORT.md), [G1](docs/G1-SPECIFICATION-REPORT.md), [G2](docs/G2-RUNTIME-REPORT.md),
[G3](docs/G3-GAMES-REPORT.md). Criteria: [docs/PHASE-0.md](docs/PHASE-0.md).

## MONSTERA Studio Foundry

Studio is a static web app in `studio/` (Vite, React, TypeScript). The repository's Python engine runs in the page through Pyodide.
It validates a game, previews it, checks determinism and generates the native Android (Kotlin) and iOS (Swift) **source** as a
ZIP. There is no backend, no account, no live Kiro connection and no AI call. **The browser compiles nothing.** Native builds
and emulator or simulator runs come from CI and Device Lab, and Studio only displays their committed evidence.

### The 11 modules

| Module | Role |
|---|---|
| Project Dashboard | Create, open, rename, duplicate and delete projects kept in this browser; export and import a project bundle |
| Game Designer | Edit the canonical spec with engine validation, view, import and export it |
| Asset Studio | Import images and audio with provenance, assign an asset to a kind |
| Sprite and Animation Editor | Slice sheets, edit frames and animation sequences, preview them by tick |
| Level Studio | Author levels; apply the active level to the spec; export other levels as standalone variants |
| Gameplay Systems | Lives, win score, collectibles and enemies, applied to the spec after review |
| Backend and Services | Firebase scaffold text (not a live backend) |
| Monetization | AdMob mock and test placements (never production ids) |
| Kiro Development | Developer Integration inventory, handoff prompts, pack drift view, proposal inbox |
| Preview and Device Lab | Browser preview, determinism badge, environments table, committed native evidence |
| Build and Release | Source ZIP with the Studio pack, completeness check, readiness checklist |

### How the pieces relate

The canonical `monstera.spec.json` (schema v4) is the only contract with the engine and the generated apps. Studio keeps what
v5 cannot express (levels, Studio assets, animations, gameplay inputs, integration choices, project identity) in versioned
**sidecar manifests** that Studio validates itself. The engine generates native source from the spec alone. Level and gameplay
data reach the native apps only when you apply them to the spec. The export ZIP carries the generated source and a **Studio
pack** with the manifests, asset files, scaffold files and a drift-check script.

### What is usable today

- Editing, validating and exporting a v5 spec, with undo, redo and project persistence in IndexedDB.
- Applying the active level and the gameplay settings to the spec (they compile to native). Other levels export as separate
  specs and are not selectable in the generated app.
- Browser preview, a determinism check against the recorded goldens, and the generated native source ZIP.
- Project bundles, and the Studio pack with its ownership manifest and drift check.

These are working prototypes. Statuses and limits per capability are in [the capability matrix](docs/STUDIO-CAPABILITIES.md).

### Studio-only, scaffold or mock

- **Native sprites (spec v5, Gate E1):** both official games draw original pixel-art sprites, and two kinds per game animate
  from the simulation tick. Each spec embeds one PNG atlas, and at most two kinds animate. The atlas is written by
  `assets/sprites/make_atlases.py`, not by Studio. Evidence: [E1 native evidence](docs/evidence/e1-native-apps/SUMMARY.md) (Android emulator, iOS simulator, launch and
  attract mode only); the M3 evidence stays as the historical v4 record.
- **Studio-only:** the Studio asset library, sprite sheets and animations. Studio's Asset and Sprite editors are not yet wired to the
  spec's atlas fields, which are read-only in Studio. Projects, imports, bundles and drafts written for spec v4 are upgraded to v5 when opened
  (neutral sprite fields, no sprites assigned).
- **Scaffold:** Firebase and AdMob interfaces and stubs written once into `extensions/` of the exported project and compiled by the generated Android and iOS projects. No SDK, no backend connection.
- **Mock:** AdMob placements and a labelled MOCK rewarded overlay in the exported app. No ad is requested and no production ad id is stored.

### Not implemented or not supported

A live Firebase connection, production AdMob ids, calls to AI providers from the browser, a live Kiro connection, running tests on
a device from Studio, level selection or per-level win rules inside the native app, health, power-ups and progression, signing,
store upload and any store-ready claim.

### Run Studio locally

Node 22 and npm are required (CI uses 22.18.0).

```bash
cd studio
npm ci
npm run dev          # development server
npm test             # unit tests
npm run build        # type check and production build into studio/dist
npm run smoke        # browser smoke test against a local production preview (needs Chromium via playwright-core)
```

`npm run capabilities:render` regenerates the capability matrix from `studio/capabilities.json` and `npm run capabilities:check`
fails if it is stale. Do not edit `docs/STUDIO-CAPABILITIES.md` by hand.

Architecture: [architecture/MONSTERA-STUDIO.md](architecture/MONSTERA-STUDIO.md). Generated capability matrix:
[docs/STUDIO-CAPABILITIES.md](docs/STUDIO-CAPABILITIES.md). Specification and design: `.kiro/specs/studio-foundry/`.

## Layout

| Path | Purpose |
|---|---|
| `.kiro/steering/` | Project rules for Kiro and humans (mission, architecture, quality, provenance, Device Lab) |
| `.kiro/agents/` | Project agent and bounded specialist agents |
| `.kiro/specs/`, `.kiro/hooks/`, `.kiro/prompts/` | Kiro development specs, hooks, reusable prompts |
| `spec/` | Canonical spec schemas, sample `monstera.spec.json`, invalid fixtures |
| `tools/monstera/` | Specification engine and `monstera` CLI (Python 3.10+, stdlib only) |
| `generated/` | Generator-owned native projects. Do not edit; run `monstera generate` |
| `studio/` | MONSTERA Studio Foundry: static Vite + React + TypeScript app; the engine runs in the browser with Pyodide |
| `apps/` | The two Skeleton Crew apps (G3): `pumpkin-blaster/`, `trick-or-treat-rush/` |
| `reference/g0/android/` | Phase 0 reference Android app (Gradle, Kotlin, Compose) |
| `reference/g0/ios/` | Phase 0 reference iOS app (SwiftPM package + `xtool.yml`, SwiftUI + SpriteKit) |
| `tools/xtool/` | xtool setup notes and Linux build scripts |
| `tools/scripts/` | Developer and CI scripts |
| `device-lab/` | Device Lab contract (`contract/`), per-platform adapters, run reports |
| `architecture/` | Architecture documents, including [MONSTERA-STUDIO.md](architecture/MONSTERA-STUDIO.md) |
| `docs/` | Reports, decisions, curated evidence (`docs/evidence/`) |
| `assets/` | Game assets with provenance records |
| `.github/workflows/` | CI: `monstera` (spec engine + generated builds), `android` (Linux emulator), `ios-simulator` (hosted macOS), `studio-ci` (Studio tests, build, secret scan, Playwright smoke), `xtool-linux` (experimental, manual trigger only) |

## Quick start

```bash
# Specification engine (Windows without python3: py -3 tools/monstera/monstera.py ...)
tools/monstera/bin/monstera validate --all
tools/monstera/bin/monstera generate spec/samples/monstera-sample/monstera.spec.json

# Android
cd reference/g0/android && ./gradlew assembleDebug

# Android emulator smoke test (emulator already booted)
tools/scripts/android-emulator-smoke.sh
```

iOS: see [reference/g0/ios/README.md](reference/g0/ios/README.md).
