# Create a game with MONSTERA (parameterized prompt)

Use with the `game-author` agent (or the project agent). Replace the angle-bracket parts.

> Create a **<orientation>** **<genre / core loop>** called **<Display Name>** (id `<id>`).
> Mechanics: **<collectibles, hazards, lives, win condition, how difficulty rises>**. Input: **<drag | swipe | lanes | tap>**.
> Look: **<palette mood, glyphs>**.
>
> Work in `spec/samples/<id>/monstera.spec.json` and follow `.kiro/steering/10-game-authoring.md`:
> check `engine_info` first, validate with `validate_spec` and fix every issue, generate through `generate_project`
> (dry run, then write after my approval), author two or three scenarios and record them with `monstera scenarios record`,
> run `run_conformance` and report exactly which platforms ran, then `inspect_manifest` with `files=true` and explain which
> Kotlin and Swift files were generated and from which spec fields. Do not touch the engine, templates, schemas, `apps/` or `generated/` by hand.
> If something I asked for cannot be expressed, tell me and propose a smaller game.

Example (portrait runner): "Create a portrait three-lane endless runner with collectibles, three lives and progressively harder obstacles."