# Mission and product boundaries

MONSTERA is an AI-native, specification-driven foundry for native 2D mobile games.
It will generate two games from one reusable foundation:

1. Pumpkin Blaster: landscape arcade shooter.
2. Trick or Treat Rush: portrait endless runner.

## Current phase

Phase 0 (gate G0): repository foundation and native toolchain proof. Do NOT build the game
engine or either game until `docs/G0-TOOLCHAIN-REPORT.md` has been evaluated against the
completion criteria in `docs/PHASE-0.md`.

## Boundaries

- In scope: native Android and iOS apps, shared specifications, build/test tooling, Device Lab.
- Out of scope: web games, desktop games, cross-platform runtimes, hosted game backends.
- Kiro is the sole AI development environment and coding agent. Do not add other AI agent configs.
- Prefer fewer files and fewer dependencies. Every dependency needs a stated reason.
- Never claim a capability that has not been demonstrated. See `04-generation-and-provenance.md`.
