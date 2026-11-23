# Sprite atlases: provenance

| File | Source | Tool | License | Date |
|---|---|---|---|---|
| `pumpkin-blaster-atlas.png` | Original pixel art drawn as text grids in `make_atlases.py` for this repository (saucer, pumpkin, two bat frames, ember) | `make_atlases.py` (Python standard library only, deterministic PNG writer) | Same as the repository (MIT, `LICENSE`) | 2026-11-23 |
| `trick-or-treat-rush-atlas.png` | Original pixel art drawn as text grids in `make_atlases.py` for this repository (two runner frames, tombstone, candy, two ghost frames) | same | same | 2026-11-23 |

No third-party image, sprite sheet or font was used, traced or adapted. The PNG bytes are embedded, base64, in `game.atlas.png` of each game's
`monstera.spec.json`, which is the source of truth for the generated apps; the files here are the same bytes for viewing. Regenerate both with
`python3 assets/sprites/make_atlases.py` from the repository root.
