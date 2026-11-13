# Mission and product boundaries

MONSTERA is a **browser-based native mobile game foundry**, built Kiro-first for Kiroween 2026
(Skeleton Crew). Users work in **MONSTERA Studio** (web app) to configure, validate, generate,
build, test and download genuine native Android (Kotlin) and iOS (Swift, SwiftUI, SpriteKit)
applications. The Python specification engine and CLI (`tools/monstera/`) are the generation backend.

The same foundation generates the two Skeleton Crew applications, which must be genuinely distinct:

1. Pumpkin Blaster (`apps/pumpkin-blaster/`): landscape 2D arcade shooter.
2. Trick or Treat Rush (`apps/trick-or-treat-rush/`): portrait 2D endless runner.

## Phases

G0 toolchain (done) → G1 specification engine (done) → G1.5 Kiro foundation (done) → G2 deterministic runtime and
conformance (done) → G3 two games (done) → **G4 MONSTERA Studio and the Kiro-to-MONSTERA workflow (current)** → G5 Device
Lab, haptics, motion → G6 clean-room regeneration, recording and submission. G4 order: M0 spike (done), visual batch / spec v4
(done), K0 Kiro authoring (a third game, Lantern Run, made by Kiro without touching the engine), then Studio M1 to M3
(`.kiro/specs/g4-studio/`). A phase starts only after the previous one is reviewed. **Submission deadline:
Dec 4, 2026, 2:00 pm PT** (`docs/KIROWEEN-ALIGNMENT-REPORT.md`).

The product has three parts: the **Engine** (skeleton, canonical specs, deterministic runtime, validation, generation,
conformance), **Studio** (static web app, the engine runs unmodified in the browser) and the **Kiro integration**
(steering, agents, hooks, MCP tools that let Kiro create and extend native games). The canonical spec file is the only
contract between them. Studio never pretends to be Kiro and has no Kiro connection.

## Boundaries

- In scope: generated native apps, the canonical specification and engine, MONSTERA Studio
  (web frontend, API, build orchestration), build/test tooling, Device Lab, the Kiro foundation.
- Out of scope: web or desktop *games*, cross-platform game runtimes, signing apps on users' behalf.
- Kiro is the sole AI development environment and coding agent, and a first-class part of the
  foundation (`architecture/KIRO-OPERATING-MODEL.md`). Do not add other AI agent configs.
- Two "spec" concepts are never mixed: Kiro Specs (`.kiro/specs/`, how we develop) vs. MONSTERA
  canonical specifications (`monstera.spec.json`, what we generate).
- Prefer fewer files and fewer dependencies. Every dependency needs a stated reason.
- Never claim a capability that has not been demonstrated. See `04-generation-and-provenance.md`.
