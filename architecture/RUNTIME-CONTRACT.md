# MONSTERA runtime contract (G2)

Normative. The Python oracle (`tools/monstera/monstera/oracle/`), the Kotlin core and the Swift core
are three independent implementations of this document. Where code and this document disagree, the
document is right and the code has a bug. Kiro Spec: `.kiro/specs/g2-deterministic-runtime/`.

The core is platform-free: no Android, UIKit, SpriteKit or Compose imports, no floating-point types,
no clock, no system randomness, no locale, no hash-ordered iteration. The shell renders and feeds input.

## 1. Time and the frame loop

One tick is one step of the core, `game.simulation.tickRate` ticks per second. Velocities are world units **per tick**.
The shell measures wall-clock time and nothing else; how many ticks run is decided by the core's `FrameClock`
in exact integer arithmetic, so the number of ticks for a given sequence of frame durations is identical on every
platform.

`FrameClock(tickRate, maxTicksPerFrame)` keeps `acc`, an integer in units of `1/(10^9 * tickRate)` seconds, starting at 0.
`advance(elapsedNanos)`:

```
e = clamp(elapsedNanos, 0, 1_000_000_000)      # negative counts as 0; a longer frame counts as one second
acc += e * tickRate
ticks = acc / 1_000_000_000 ; acc = acc mod 1_000_000_000
return min(ticks, maxTicksPerFrame)             # ticks beyond the cap are DROPPED (the backlog is discarded)
alpha = (acc << 16) / 1_000_000_000             # Q16.16 in [0, 65535], for render interpolation only
```

`GameLoop(world, ...)` queues input events (`submit`), and each frame runs `advance` ticks. The queued events are
applied at the start of the **first** tick of the frame, in submission order; if no tick runs, they stay queued.
Rendering may interpolate with `alpha` using floating point in the shell; nothing flows back into the core.
A frame that runs zero ticks changes no simulation state.

| Frames (ns) at tickRate 60, max 5 | Ticks per frame | Final `acc` | `alpha` |
|---|---|---|---|
| 16666667 x4 | 1 1 1 1 | 80 | 0 |
| 16666666 x4 | 0 1 1 1 | 999999840 | 65535 |
| 8333333 x6 (120 Hz) | 0 0 1 0 1 0 | 999999880 | 65535 |
| 500000000, 16666667 | 5 1 | 20 | 0 |
| -5, 0, 2000000000 | 0 0 5 | 0 | 0 |
| 8333333 (single) | 0 | 499999980 | 32767 |
| tickRate 60, max 100: 2000000000 (clamped to one second) | 60 | 0 | 0 |
| tickRate 120: 8333334, 8333333, 8333333 | 1 1 1 | 0 | 0 |
| tickRate 60, 1000 frames, `x = x*1103515245+12345 & 0x7FFFFFFF` from 12345, `frame = 4000000 + (x >> 8) % 36000000` | 490 ticks total | 103339700 | - |
## 2. Fixed point (Q16.16)

A quantity is a signed integer `raw`; the real value is `raw / 65536`. Storage is a 64-bit signed
integer; every result is **saturated** to `[RAW_MIN, RAW_MAX] = [-2^31, 2^31 - 1]` (about +-32768 units),
so any product fits in 64 bits (|a*b| <= 2^62). No operation may trap or wrap. **Every operand is first
saturated to the same range** (input from a shell is not trusted to be in range), so `add`, `sub`, `neg`, `mul` and
`div` are total over all signed 64-bit inputs.

| Op | Definition |
|---|---|
| `add`, `sub` | exact sum or difference, then saturate |
| `neg` | `sat(-a)`; `neg(RAW_MIN) = RAW_MAX` |
| `mul(a, b)` | `sat((a * b) >> 16)`, arithmetic shift: rounds toward **negative** infinity |
| `div(a, b)` | `sat(trunc((a << 16) / b))`, rounds toward **zero**; `b = 0` gives `RAW_MAX` if `a > 0`, `RAW_MIN` if `a < 0`, else `0` |
| `clamp(v, lo, hi)` | `lo` if `v < lo`, `hi` if `v > hi`, else `v` (callers guarantee `lo <= hi`) |

Counters (`score`, `lives`) are int32. A tick sums every delta exactly (64-bit) and saturates **once**
to `[-2^31, 2^31 - 1]`, so the result does not depend on the order of the hits.

Forbidden in the core: logical right shift of signed values, floating point, implicit integer widening
that changes results. The spec stores quantities as Q16.16 **raw integers**; `1.5` units is `98304`.
`world.width` and `world.height` must be integers (units) and are converted with `<< 16`.

## 3. Randomness

**PCG32 XSH-RR** (O'Neill), 64-bit state, odd 64-bit increment, multiplier `6364136223846793005`.

```
srandom(initstate, initseq):  state = 0; inc = (initseq << 1) | 1; next(); state += initstate; next()
next():  old = state; state = old * MULT + inc
         xorshifted = u32(((old >> 18) ^ old) >> 27); rot = old >> 59
         return u32((xorshifted >> rot) | (xorshifted << ((-rot) & 31)))
```

`nextBelow(bound)` for `1 <= bound < 2^32` (unbiased, rejection):
`threshold = (2^32 - bound) mod 2^32 mod bound`; loop `r = next()` until `r >= threshold`; return `r mod bound`.

**Streams.** A scenario/session `seed` (0..2^53-1) derives one independent generator per stream name:
`sm = seed XOR fnv1a64(utf8(name))`; `initstate = splitmix64(sm)`, `initseq = splitmix64(sm)` (the
second call continues the state). SplitMix64: `sm += 0x9E3779B97F4A7C15; z = sm; z = (z ^ (z >> 30)) *
0xBF58476D1CE4E5B9; z = (z ^ (z >> 27)) * 0x94D049BB133111EB; return z ^ (z >> 31)` (all mod 2^64).
Streams are the sorted (by UTF-8 bytes) distinct `stream` names of the spawners.

### Known-answer vectors

| Check | Result |
|---|---|
| `Pcg32(42, 54)` first six `next()` | `a15c02b7 7b47f409 ba1d3330 83d2f293 bfa4784b cbed606e` (reference pcg32-demo) |
| `splitmix64` from state 0, outputs 1, 2 | `e220a8397b1dcdaf`, `6e789e6aa1b965f4` |
| `fnv1a64("")`, `("a")`, `("foobar")` | `cbf29ce484222325`, `af63dc4c8601ec8c`, `85944171f73967e8` |
| stream `("spawn", seed 12345)` first four `next()` | `3836204951 2901556457 1288830458 20171900`; final `state=be81daf6f5b5d3bb inc=6f4a8582f6e4629f` |
| stream `("fx", seed 12345)` first four `next()` | `3544770967 1588508108 78643710 1025764217` |
| stream `("spawn", seed 1)` `nextBelow(10)` x8, then `nextBelow(1)` x2, then `nextBelow(2^31)` | `6 0 2 2 1 0 3 7`, `0 0`, `1771058001` |

### Fixed-point vectors

| Expression | Result |
|---|---|
| `mul(-1, 1)` | `-1` (floor) |
| `mul(RAW_MAX, RAW_MAX)`, `mul(RAW_MIN, RAW_MIN)` | `RAW_MAX` (saturated) |
| `mul(-3, 32768)`, `mul(3, -32768)` | `-2`, `-2` (floor of -1.5) |
| `div(65536, 196608)`, `div(-65536, 196608)`, `div(65536, -196608)` | `21845`, `-21845`, `-21845` (toward zero) |
| `div(5, 0)`, `div(-5, 0)`, `div(0, 0)` | `RAW_MAX`, `RAW_MIN`, `0` |
| `div(RAW_MIN, -1)` | `RAW_MAX` |
| `neg(RAW_MIN)`, `add(RAW_MAX, 1)`, `sub(RAW_MIN, 1)` | `RAW_MAX`, `RAW_MAX`, `RAW_MIN` |
| `add(I64_MAX, 1)`, `sub(I64_MIN, I64_MAX)`, `neg(I64_MIN)` | `RAW_MAX`, `RAW_MIN`, `RAW_MAX` |
| `mul(I64_MAX, I64_MAX)`, `mul(I64_MIN, 65536)`, `div(I64_MAX, 1)`, `div(1, I64_MIN)` | `RAW_MAX`, `RAW_MIN`, `RAW_MAX`, `0` |

## 4. World and tick order

The world is the half-open rectangle `[0, W) x [0, H)`, W and H in raw units. An entity has
`id` (starts at 1, never reused), `kind` (index into `runtime.kinds`), `controlled`, position `x, y`
(top-left), velocity `vx, vy`, and `age` (ticks lived). Its box is `[x, x + w) x [y, y + h)` with the
width and height of its kind. Entities are kept sorted by id; iteration is always in that order.

`step(events)` runs these phases in order and is a **no-op once `ended`** (the tick does not advance):

1. **input**: apply `events` in the given order.
   `press`/`release` set `pressed`. `tap` spawns `input.tapKind` (unless it is `""`) at the first
   controlled entity's position with velocity `(tapVx, tapVy)`, only if a controlled entity exists
   and `entityCount < maxEntities`. `drag(dx, dy)` moves every controlled entity by
   `mul(dx, dragGain), mul(dy, dragGain)` then clamps it into the world. `swipe(dir)` sets every
   controlled entity's velocity to `dir * swipeSpeed` (`up` is -y; `none` stops it).
2. **spawn**: for each spawner in order, when `tick mod intervalTicks == 0` (tick 0 included), draw
   `x = xMin + nextBelow(xMax - xMin + 1)` then `y = yMin + nextBelow(yMax - yMin + 1)` from its
   stream; **both draws always happen**; the entity is created with velocity `(vx, vy)` only if
   `entityCount < maxEntities` (so a full world still consumes the stream identically).
3. **move**: for each entity, `x = add(x, vx)`, `y = add(y, vy)`, `age += 1`, then its `exitPolicy`:
   `despawn` does nothing here; `clamp` clamps the box into the world; `bounce` reflects per axis
   (`x < 0`: `x = neg(x)`, `vx = neg(vx)`; `x > maxX`: `x = sub(add(maxX, maxX), x)`, `vx = neg(vx)`;
   same for y, `maxX = W - w`) then clamps. Velocity is not otherwise modified.
4. **collide + resolve**: for each collision rule in order, for each entity `a` of kind `rule.a` and
   each entity `b` of kind `rule.b` (ids ascending; `a != b`; when both kinds are the same only pairs
   with `a.id < b.id`) that overlap: mark `a` and/or `b` doomed per `despawnA`/`despawnB` and add
   `score`/`lives` to the tick's deltas. The doomed set is a set and the deltas are exact sums, so the
   result does not depend on pair order. Deltas are applied and saturated once.
5. **despawn**: remove an entity if it is doomed, or its kind has `exitPolicy = despawn` and its box
   is entirely outside the world (`x + w <= 0 || x >= W || y + h <= 0 || y >= H`), or its kind has
   `lifetimeTicks > 0` and `age >= lifetimeTicks`.
6. **advance**: `tick += 1`; `ended = lives <= 0 || (winScore > 0 && score >= winScore)`.

**Overlap** is strict on half-open boxes: `ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah`.
Touching edges do not collide. A zero-size box is a point: it overlaps another box only when strictly inside it (never on its top, left, bottom or right edge).

## 5. Input events

`{type, dx, dy, dir}` with `type` in `press release tap drag swipe`, `dx`/`dy` Q16.16 raw (ignored
unless `drag`), `dir` in `none up down left right` (ignored unless `swipe`). Events for tick `t` are
applied at the start of the step that begins with `tick = t`. A trace is replayable with no shell.

## 6. Canonical state serialization and hash

Little-endian, fixed order, no padding:

```
u32 formatVersion(=1)  u32 tick  u32 nextId  i32 score  i32 lives  u8 ended  u8 pressed
u32 streamCount   { u64 state  u64 inc }  per stream, sorted by name
u32 entityCount   { u32 id  u32 kind  u8 controlled  i32 x  i32 y  i32 vx  i32 vy  u32 age }  per entity, by id
```

The hash is **FNV-1a 64** (`offset 0xcbf29ce484222325`, `prime 0x100000001b3`) over those bytes. RNG
state is part of the hash, so a different number of draws is detected at the first tick it happens.

Observables recorded with every checkpoint: `tick score lives entityCount ended nextId`.

## 7. Scenarios and conformance criteria

A scenario (`spec/scenarios/<project>/<name>.scenario.json`, `scenario.schema.json`) names a spec by
path and SHA-256, a `seed`, a tick count, an input trace and **checkpoints** `{tick, hash, observe}`.
Checkpoint `t` is the state after `t` steps (`0` = initial state).

A scenario with `frames.count` above 0 is **frame-driven**: it exercises section 1 instead of stepping directly. A `GameLoop`
is driven by `count` frame durations from an LCG (`x = x*1103515245 + 12345 & 0x7FFFFFFF` from `frames.seed`;
`duration = minNanos + ((x * (maxNanos - minNanos + 1)) >> 31)`, which spreads the full 31-bit output over the span; the product stays below 2^63). `inputs[].tick` and `checkpoints[].tick` then count
**frames**: events are submitted just before that frame, and a checkpoint is the state after that many frames. Its
`observe.tick` is still the world tick, so a different number of ticks per frame shows up as a divergent `tick`
observable at the first frame where it happens. Expected checkpoints are produced
only by `monstera scenarios record` (the oracle) and committed; a test never regenerates them.

A platform **conforms** when, for every scenario applicable to the spec, every checkpoint's hash **and**
every observable equal the expected values, and its report names no divergence. A divergence report
names the scenario, the first differing checkpoint tick, the platform and the differing fields. The
oracle itself is validated by section 3 vectors, its unit tests, and by agreeing with both native cores.
The verdict is `pass` only when the oracle, Kotlin and Swift all ran against generated sources that equal their manifest and
every checkpoint matched; `fail` for any divergence or platform error; `incomplete` when a platform was skipped or not
requested (an oracle-only run compares the oracle with its own recording and proves nothing about the native cores).
Embedded scenarios are accepted for generation only if their checkpoints equal a fresh oracle run, and a scenario is
rejected when its last checkpoint is not at its last tick or its worst-case oracle work exceeds a fixed bound.
Conformance runs Kotlin on the JVM (`testDebugUnitTest`, no emulator) and Swift via `swift test`.
