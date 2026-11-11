# G1 Canonical Specification Engine: design

Full architecture document: `architecture/SPECIFICATION-ENGINE.md`. This file records the
decisions the tasks depend on.

## Pipeline

```
monstera.spec.json
  -> strict JSON load (dup keys, NaN, line/col)       tools/monstera/monstera/jsonio.py
  -> schema validation (spec/schema/*.schema.json)    schema.py   (stdlib subset validator)
  -> semantic validation                              semantic.py
  -> canonical bytes + SHA-256                        jsonio.py
  -> type IR from the SAME schema files               typemodel.py
  -> Kotlin models + constant / Swift models + constant   emit_kotlin.py / emit_swift.py
  -> deterministic templates (Android, iOS)           scaffold.py + templates/
  -> generated/<id>/{android,ios} + MONSTERA-MANIFEST.json   generate.py
```

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Generator language | Python 3.10+ standard library only | Present on every dev machine and CI runner; no new dependency; the outputs are native Kotlin/Swift, the generator is never shipped. |
| Schema dialect | JSON Schema 2020-12 keyword **subset**, validated by our own code | Avoids a third-party validator. Schemas using an unsupported keyword are rejected at load, so the subset can't silently drift. |
| Type mapping | Schema `title` names the Kotlin/Swift type | One naming source; no per-platform mapping files. |
| Optional fields | None: every property is required | Canonical form has no hidden defaults; models have no nullability. |
| Templates | Plain files with `@@{name}` placeholders (`string.Template`, custom delimiter) | Deterministic and no template engine. `@@` doesn't clash with Kotlin `$` or Swift/Kotlin `@` annotations. |
| Codegen | String emission from a small type IR | No AST compiler (brief constraint). |
| Output location | `generated/<project.id>/`, committed | Lets CI prove reproducibility with `generate --check` and reviewers see the diff. |
| Determinism | No timestamps, sorted manifest, LF, fixed modes, canonical JSON | Same input bytes produce the same output bytes. |
| Runtime parity | Both apps bundle the canonical JSON and compare its SHA-256 with the generated constant; iOS also decodes it into the generated model and compares | Shows both apps carry the same canonical configuration. |
