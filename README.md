# Block Puzzle

A browser puzzle game about dropping Tetris-shaped blocks under a line. One
hundred levels, hand-tuned to a rising curve; each is solvable and the
generator only keeps a deal that survives replay.

**To play:** open `index.html` in a browser. No install, no build step, no
server. Or run `node build.js --standalone` for the whole game as one
shareable HTML file. It also runs on iOS and Android through Capacitor — see
below.

## What's in it

The home screen has one way in — **Play** — because the game is one campaign.
The choice card fills with a bar that shows how far through the hundred you
are.

Pieces come in a queue, one at a time. For each piece the player picks a
column and (if it helps) a rotation, then drops it. Gravity carries the
piece to the lowest cell it can reach. Terrain — the grey blocks — cannot
move; pieces stack on top of them just as they stack on each other.

A level is cleared when every piece has been dropped and none pokes above the
dashed line. If a drop leaves a piece above the line the arena beneath it is
too full; **undo** and try a different order.

### The curve

| Levels | Arena | What's new |
|--------|-------|------------|
| 1–5    | 4×2 up to 4×4 | Taught: dropping, choosing a column, rotation, terrain, order |
| 6–15   | 5×6 | Six to eight pieces, dominos to tetrominoes, no obstacles |
| 16–30  | 5×7 | Every tetromino, still no obstacles |
| 31–45  | 6×8 | One rock in the way, first pentominoes (P, U) |
| 46–60  | 6×9 | Two rocks, more pentominoes (L, Y) |
| 61–75  | 7×10 | Three rocks, every pentomino in the pool |
| 76–90  | 7×11 | Four rocks, deeper stacks |
| 91–100 | 8×12 | Five rocks, up to 25 pieces |

### Stars

Three stars for a run finished without pressing undo. Two for a couple of
undos. One for finishing at all.

### Keeping progress

Stars and cleared levels live in `localStorage` under
`blockpuzzle.progress.v1`. The store probes the browser first: if a value
does not survive a round trip through `localStorage`, the game falls back to
`sessionStorage`, and if that is blocked it falls back to holding progress
in memory for the current sitting. The home screen says so plainly rather
than quietly losing anyone's stars.

Sound and colour-blind assist live in `blockpuzzle.prefs.v1`.

## Building the campaign

`js/levels.js` is generated. To rebuild:

```
node make-levels.js
```

The first five levels are written by hand, one rule each, and the rest are
dealt by dropping random pieces into the arena along a widening curve. Each
piece records the (rotation, column) the generator used, so
`node verify-levels.js` can replay every level and confirm nothing overflows
— a guardrail against a shape or engine change silently breaking the deal.

Only re-run these when the curve or the taught levels change. Boards are
baked into the file, so starting a level costs nothing and every player
plays the same campaign.

## Running on iOS and Android

The game is packaged with Capacitor. The Capacitor project's `webDir` is
`www/`, which `sync-web.js` populates from the files `index.html` lists:

```
npm install
npx cap add ios      # once, to create the ios/ project
npx cap add android  # once, to create the android/ project
npm run sync         # node sync-web.js && cap sync
```

`npm run sync` is the everyday command — it rebuilds `www/` and then hands
it to Capacitor, which copies the web assets into the native platform
folders. Open `ios/App/App.xcworkspace` in Xcode or `android/` in Android
Studio to run on device.

## Files

```
block-puzzle/
├── index.html          the page; lists every script it needs
├── fonts.css           Baloo 2 + Nunito, inlined as data URIs
├── styles.css          the one visual world
├── js/
│   ├── store.js        localStorage with a probe and fallbacks
│   ├── palette.js      block colours and ink weights
│   ├── shapes.js       piece catalogue and rotation
│   ├── engine.js       arena state, gravity, drop, undo, win check
│   ├── levels.js       GENERATED — the hundred levels
│   ├── ui.js           rendering, animations, sound
│   └── app.js          screen wiring, input, progress
├── make-levels.js      regenerates js/levels.js
├── verify-levels.js    replays every level to prove solvability
├── sync-web.js         mirrors the web assets into www/
├── build.js            bundles the whole game into one HTML file
├── capacitor.config.json
├── package.json
├── ios/                Capacitor iOS project (created by `npx cap add ios`)
├── android/            Capacitor Android project (`npx cap add android`)
└── www/                built by sync-web.js
```

## Adding a shape

New shapes go in `js/shapes.js` under `CATALOGUE`, top-first as a matrix of
0s and 1s. Add the id to the appropriate difficulty pool in
`make-levels.js` (SMALL, SMALL_MID, MID, MID_LARGE or LARGE) and re-run
`node make-levels.js && node verify-levels.js`. Nothing else needs
touching — the engine and the UI both take a shape by id.

## Adding a level by hand

A hand-crafted level is a plain object in `TEACH` inside
`make-levels.js`. It has a width, a height, a list of obstacles as
`{ row, col }`, and a list of pieces as
`{ shape, colour, rot, col }`. The generator emits the hand-crafted levels
first, and re-running the generator preserves their exact contents.
