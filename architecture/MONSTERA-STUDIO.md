# MONSTERA Studio architecture

Status: **PROPOSED (G1.5).** Implementation: shell from G4, started in parallel with G2/G3.

MONSTERA Studio is the user-facing product: a browser-based native mobile game foundry. Users
configure a game in a visual **Project Brain**, and Studio turns it into a canonical
`monstera.spec.json`. The existing Python engine generates native Kotlin and Swift projects
from it, cloud build workers compile and test them, and users download the source and the
artifacts.

## Non-negotiable rules

1. The canonical `monstera.spec.json` is the single source of truth. Studio state *produces* it;
   nothing else describes the generated app.
2. All generation and validation logic lives in `tools/monstera/`. Studio calls it and never
   reimplements it.
3. Generated apps are independent native Kotlin/Swift projects. They don't depend on Studio,
   Kiro, a web view or any cross-platform runtime.
4. The browser never compiles native code. Builds run only on CI build workers.
5. Credentials (GitHub token, any future signing material) stay server-side. The frontend
   bundle and API responses never contain them.
6. Studio's own stack may be any modern web stack. That freedom stops at `apps/*` and
   `generated/*` (enforced by `monstera check-architecture`).

## System overview

```
  Browser                         Vercel                 Railway                      GitHub Actions
┌───────────────────────┐      ┌──────────────┐      ┌────────────────────────┐     ┌──────────────────────────┐
│ Studio SPA            │ GET  │ static SPA   │      │ Studio API (Python)    │     │ studio-build.yml         │
│  Project Brain UI     │◄─────│ (CDN)        │      │  imports tools/monstera│     │  ubuntu: generate,       │
│  forms + live preview │      └──────────────┘      │  /validate /generate   │     │   gradle, emulator,      │
│  asset manager        │  HTTPS (JSON, multipart)   │  /builds  /artifacts   │ API │   Device Lab, conformance│
│  build + report views │──────────────────────────►│  project store         │────►│  macos: xtool build,     │
│  downloads            │◄──────────────────────────│  job state machine     │◄────│   simulator, Device Lab  │
└───────────────────────┘   status / reports / zips │  GitHub token (secret) │ runs│  uploads artifacts       │
                                                     └────────────────────────┘ +art.└──────────────────────────┘
```

| Component | Technology (proposed) | Responsibility |
|---|---|---|
| Studio web | TypeScript, Vite, React; JSON-Schema-driven forms | Project Brain UI, preview, uploads, build monitor, downloads. Static on **Vercel** |
| Studio API | Python 3.12, ASGI service (e.g. Starlette or FastAPI, pinned), on **Railway** | Imports `tools/monstera` directly; project persistence; build dispatch; artifact proxy |
| Project store | Railway Postgres (projects, versions, builds) + Railway volume for assets | Durable Project Brain state |
| Build workers | **GitHub Actions**: Linux (Android build + emulator, conformance, xtool experiments), hosted **macOS** (iOS Simulator) | Reuses the G0/G1 pipelines and the Device Lab adapters |

## Project Brain

The Project Brain is the **structured project workspace and configuration state**, not a
chatbot. A project is:

```
Project
  id, name, owner (session/access code)
  versions[]                 each version = one canonical spec + its SHA-256
    spec                     canonical monstera.spec.json (validated by the engine)
    validation               issues[] from the engine (path, rule, message)
  assets[]                   uploaded files: sha256, role, licence/provenance record
  builds[]                   one per (version, platform): state, run id, artifacts, Device Lab report
  conformance[]              per version: cross-platform behavioural result (G2+)
```

The workspace sections map one-to-one onto parts of the canonical spec, so the UI never holds
configuration the spec can't express:

| Studio section | Canonical spec section | Phase |
|---|---|---|
| Create project | `project.id`, `displayName`, `identifier`, `version`, `targets` | G4 shell |
| Application characteristics | `project.platforms.*`, `game.orientation`, `game.targetFps`, `game.palette` | G4 shell |
| Gameplay and mechanics | `game` mechanics vocabulary (defined in G2/G3) | G4 after G3 schema |
| Input methods | `game.input` (extended by the G2 input contract) | G4 |
| Native capabilities | `capabilities` (new: haptics, motion, … defined in G5) | G5 |
| Assets | `assets` manifest (new in G3) + uploaded files | G4/G3 |

**Forms come from the schema.** The UI renders fields from `spec/schema/*.schema.json`
(type, enum, min/max, pattern, description), so a schema change is reflected in Studio without
hand-written form logic for each field. Cross-field (semantic) rules stay in the engine.

**Live validation**: every edit is validated by the engine. Two options, decided in G4:

| Option | How | Trade-off |
|---|---|---|
| A (default) | API `POST /validate` (debounced) | Simple, authoritative; one round trip per edit |
| B | Same stdlib engine running in the browser via Pyodide; the server re-validates before generate/build | Instant and offline; ~10 MB first load. Not duplication: it is the same Python files |

## Request flows

### Configure → validate → save

1. The UI edits the draft spec. Debounced `POST /api/validate {spec}` → engine `validate_value` → issues.
2. `POST /api/projects/{id}/versions {spec}` stores a version only if it is valid; the response includes the canonical SHA-256.

### Generate and download source

`POST /api/projects/{id}/versions/{sha}/source`:
1. The API calls the engine `plan()` in memory. Nothing is written to the repository.
2. The plan's files are streamed as `<project-id>-<sha12>-source.zip`, including
   `MONSTERA-MANIFEST.json`.
3. The zip is deterministic (sorted entries, fixed timestamps), so the same spec gives the same bytes.

### Build (never in the browser, never on the API host)

`POST /api/projects/{id}/versions/{sha}/builds {platforms: ["android","ios"]}`:
1. The API stores the spec and assets as a **build bundle** and creates a single-use download token.
2. The API calls GitHub `workflow_dispatch` on `studio-build.yml` with inputs `bundle_url`,
   `bundle_sha256`, `platforms`, `build_id`. There's no spec payload in the inputs, which have
   size limits and appear in logs.
3. Workers download the bundle, check its SHA-256, and run `monstera validate` and `monstera generate`.
   Then the Device Lab `build` op runs (Gradle on Linux, xtool on macOS), followed by
   `install`/`launch`/`screenshot`/`logs`/`report` on the emulator/simulator.
4. Workers upload artifacts: APK, iOS Simulator `.app` zip, Device Lab report, screenshots, conformance result.
5. The API polls the run (`GET /repos/.../actions/runs/{id}`) and records state transitions:
   `queued → running → succeeded | failed | cancelled | timed_out`.
6. The UI polls `GET /api/builds/{id}`. `GET /api/builds/{id}/artifacts/{name}` is proxied by the API,
   because GitHub artifact downloads need a token.

### Inspect results

Studio shows, per build:
- Device Lab `report.json` lines (op, status, detail).
- Screenshots.
- Conformance (G2+).
- The manifest summary: files, SHA-256, provenance.

The verification label shown is the highest level with evidence: GENERATED, COMPILED or
SIMULATOR-TESTED. Studio never shows PHYSICAL-DEVICE-TESTED, because workers have no physical
devices.

## Downloadable artifacts

| Artifact | Producer | Notes |
|---|---|---|
| Source zip (Android + iOS + manifest) | API (engine `plan`) | Always available; no build needed |
| Android debug APK | Linux worker | Installable on any Android device with sideloading enabled |
| iOS Simulator `.app` (zip) | macOS worker | Runs in Xcode's Simulator only. **A signed iPhone build needs the user's own Apple ID** (xtool or Xcode locally); Studio documents this and does not sign |
| Device Lab report + screenshots | Workers | Evidence for the result page |

## API surface (initial)

| Method & path | Purpose |
|---|---|
| `GET /api/schema` | Schema files (forms are generated from them) |
| `POST /api/validate` | Engine validation of a draft spec |
| `GET/POST /api/projects`, `GET /api/projects/{id}` | Project Brain CRUD |
| `POST /api/projects/{id}/versions` | Store a validated canonical version |
| `POST /api/projects/{id}/assets` | Upload an asset (type and size checked, hashed) |
| `POST /api/projects/{id}/versions/{sha}/source` | Deterministic source zip |
| `POST /api/projects/{id}/versions/{sha}/builds` | Dispatch build workers |
| `GET /api/builds/{id}`, `GET /api/builds/{id}/artifacts/{name}` | Status, results, proxied downloads |
| `GET /api/health` | Engine version, schema digests, worker reachability |

## Security

| Threat | Control |
|---|---|
| Code injection through spec strings into Kotlin/Swift/XML | Strict schema (patterns, enums, closed objects) plus the engine's escaping in its emitters. It's the same boundary the CLI uses, and adversarial tests already cover it |
| Malicious assets | Allow-listed types (PNG, WAV/OGG, JSON), size caps, re-encode images, store by SHA-256, never execute |
| Abuse of macOS build minutes | Access code (shared with judges in the Devpost form), per-session rate limit, global concurrency cap (proposed: 2 builds), build timeout |
| Token leakage | Fine-grained GitHub token: **Actions read/write on the worker repository only**. Railway secret, never logged or returned |
| Bundle tampering | Single-use, expiring bundle URL + SHA-256 checked by the worker |
| Public logs | Workers on a public repo have public logs. Specs are not secret, but users must be told. Option: a private worker repository (see open decisions) |
| Apple SDK licensing | Workers never transfer Apple SDK material between machines (G0 rule kept); iOS builds run only on macOS |
| CORS / CSRF | API allows only the Vercel origin; state-changing requests need the session token |

## Deployment validation (before the URL goes into the submission)

The hosting plan is preferred **subject to validation**. Each item must be demonstrated, with evidence in `docs/evidence/studio/`:

1. Vercel serves the SPA from a production URL.
2. Railway runs the API; `GET /api/health` reports the engine version and schema digests that match `main`.
3. `POST /api/validate` returns the same issues as the CLI for the fixture cases.
4. The source zip from the API equals the CLI `generate` output, checked via the manifest SHA-256.
5. A build dispatched from the hosted Studio produces an APK and a simulator `.app`, with Device Lab reports.
6. Secrets: the frontend bundle and network responses contain no token (automated grep in CI).
7. Rate limit and concurrency cap rejects are observed.

## Phasing

| Phase | Studio scope |
|---|---|
| G4-shell (parallel with G2) | SPA + API skeleton, schema-driven forms for today's schema, validate, source zip, deploy to Vercel/Railway |
| G4 (after G3 schema) | Gameplay/mechanics sections, asset manager, build dispatch + results, downloads |
| G5 | Native capabilities section, Device Lab report views, conformance views |
| G6 | Polish, access control for judges, final deployment validation |

## Open decisions (G4)

| # | Decision | Proposal |
|---|---|---|
| S1 | Live validation: API (A) or Pyodide (B) | A first; B if time allows |
| S2 | Workers in this public repo or a private worker repo | Public repo for the hackathon (free macOS minutes, auditable), with a visible notice; private repo after |
| S3 | API framework | Starlette or FastAPI, pinned exactly |
| S4 | Access control for judges | Shared access code in the Devpost form |
