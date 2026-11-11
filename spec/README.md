# MONSTERA specifications

| Path | Content |
|---|---|
| `schema/monstera.spec.schema.json` | Canonical `monstera.spec.json` format (composes the two below) |
| `schema/project.schema.json` | Application identity, version, targets, platform-only settings |
| `schema/game.schema.json` | Game presentation contract (no gameplay in G1) |
| `samples/<id>/monstera.spec.json` | Canonical specs; `samples/monstera-sample` is the G1 sample |
| `fixtures/` | Invalid inputs used by tests and CI |

```bash
tools/monstera/bin/monstera validate --all
tools/monstera/bin/monstera format spec/samples/monstera-sample/monstera.spec.json
tools/monstera/bin/monstera generate spec/samples/monstera-sample/monstera.spec.json   # -> generated/monstera-sample/
tools/monstera/bin/monstera generate spec/samples/monstera-sample/monstera.spec.json --check
```

On Windows without a `python3` on PATH, use `py -3 tools/monstera/monstera.py <command>`.
Design: `architecture/SPECIFICATION-ENGINE.md`.
