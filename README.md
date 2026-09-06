# Pitch replay

A 2D football match viewer: a **sparse event log** goes in, a **continuous 0–90 replay** comes
out. TypeScript and PixiJS 8, no framework, no backend, mounts into one container element.

Live demo: https://veyr09.github.io/pitch-replay/

## The problem this solves

A match log records **one pitch position per event** — a pass here, a tackle there, a few
seconds apart. A viewer needs twenty-two players and a ball on every frame at 60 fps. Almost
everything on screen has to be invented, and it has to be invented identically every run, or
the same match replays differently each time it is watched.

Two decisions carry the whole result.

**The ball is not lerped across the gap.** A pass that takes 0.9 seconds and is then followed by
four seconds of nothing looks absurd if the ball slides slowly for the whole five: the ball
travels at a plausible speed with an ease-out, arrives, and *dwells*. The gap is absorbed by
waiting, not by slowing down. `PASS_SPEED_M_PER_S`, `CARRY_SPEED_M_PER_S` and
`SHOT_SPEED_M_PER_S` in `src/state.ts` are the whole model.

**Off-ball players are a pure function of time, not a simulation.** Each of the other
twenty-one is computed from the formation slot, the ball, and the clock — no integration, no
state carried between frames:

- the team shape slides toward the ball's end of the pitch, but only partly (`SHAPE_FOLLOW`),
  because a back four does not stand on the halfway line just because the ball is there;
- players within `ATTRACTION_RADIUS_M` close on the ball, proportionally to how near they are;
- the keeper is excluded and tracks the ball laterally near his own line;
- a small seeded drift keeps nobody frozen while play is elsewhere.

Smoothness then comes from **averaging that target across a short time window** rather than
from a spring. That keeps the function pure, which is what makes seeking exact: jumping to
minute 63 draws precisely what playing to minute 63 would have drawn, because it is the same
expression evaluated at the same `t`. Determinism is not a claim here, it is a property of the
shape of the code.

## Run it

    npm install
    npm run build      # esbuild -> docs/bundle.js
    npm run check      # tsc --noEmit, strict, noUncheckedIndexedAccess

Then serve `docs/`:

    python -m http.server 8137 --directory docs

## What is in it

| File | What it does |
|---|---|
| `src/log.ts` | The log format, and a seeded generator so the viewer can be shown without a simulation attached. |
| `src/state.ts` | The interesting part: sparse events to a full picture at any `t`. |
| `src/viewer.ts` | Pitch, 22 players with shirt numbers, ball, easing camera, clock and score, key-moment zoom and overlay, and the strip along the bottom showing the whole pitch. |
| `src/main.ts` | Mount, and the demo page's controls. |

The camera never cuts. It eases toward the ball, and a goal, card, save or offside pulls the
zoom in and back out again on the same easing, so the scene always pans.

## Measured

Built and run in Chrome 152 at 1280×900: **no console errors, and the animation loop is not the
bottleneck** — a 2-second `requestAnimationFrame` count returned 360 frames per second on a
desktop GPU with the frame limiter off, so there is a wide margin under the 60 fps target that a
mobile WebView needs. The bundle is 538 KB minified, PixiJS included.

## Scope

This is a **rendering engine, deliberately**. It does not decide where anybody goes — a real
match log from a real simulation drives it, and swapping the generator in `src/log.ts` for real
data is the only change needed. Artwork is out of scope too: players are drawn as coloured
discs with shirt numbers here, and the sprite hooks are where supplied busts would go.
