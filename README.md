# Color Block Fall

A browser puzzle game about dropping four-block shapes under a line. One
thousand levels, tuned to a rising curve; each is solvable and the
generator only keeps a deal that survives replay.

**To play:** open `index.html` in a browser. No install, no build step, no
server. Or run `node build.js --standalone` for the whole game as one
shareable HTML file. It also runs on iOS and Android through Capacitor — see
below.

## What's in it

The home screen has three ways in: **Campaign**, a **Daily Puzzle**, and a
**Random Puzzle** at five difficulties. The Campaign card fills with a bar
that shows how far through the thousand you are.

Pieces come in a queue, one at a time. For each piece the player picks a
column and (if it helps) a rotation, then drops it. Gravity carries the
piece to the lowest cell it can reach. Terrain — the grey blocks — cannot
move; pieces stack on top of them just as they stack on each other.

A level is cleared when every piece has been dropped and none pokes above the
dashed line. If a drop leaves a piece above the line the arena beneath it is
too full; **undo** and try a different order.

### The curve

| Levels | Arena | What's new |
| --- | --- | --- |
| 1–5 | 4×2 up to 4×4 | Taught: dropping, choosing a column, rotation, terrain, order |
| 6–8 | 4×4 to 5×5 | Four to six pieces, O, I, L and J only, mostly flat floor |
| 9–35 | 5×5 | A shaped floor on every level from here, T joins |
| 36–100 | 5×5 to 6×6 | All seven shapes, floors up to two rows deep |
| 101–300 | Up to 8×9 | Wider boards, up to 16 pieces |
| 301–1000 | Up to 8×10 | Deeper floors, up to 19 pieces |

### Stars

Every level packs perfectly up to the dashed line. Three stars for keeping
everything under it; each row the pile rises above it costs a star, and
passing the red line two rows up fails the level.

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

```bash
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

```bash
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

```text
block-puzzle/
├── index.html          the page; lists every script it needs
├── fonts.css           Baloo 2 + Nunito, inlined as data URIs
├── styles.css          the one visual world
├── js/
│   ├── store.js        localStorage with a probe and fallbacks
│   ├── palette.js      block colours and ink weights
│   ├── shapes.js       piece catalogue and rotation
│   ├── engine.js       arena state, gravity, drop, undo, win check
│   ├── levels.js       GENERATED — the thousand levels
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
0s and 1s. Add the id to a difficulty pool in `js/generator.js`
(`POOL_TINY`, `POOL_SMALL` or `POOL_FULL`) and re-run
`node make-levels.js && node verify-levels.js`. Nothing else needs
touching — the engine and the UI both take a shape by id. Every shape must
be four cells: the generator pads each arena to a multiple of four.

## Adding a level by hand

A hand-crafted level is a plain object in `TEACH` inside
`make-levels.js`. It has a width, a height, a list of obstacles as
`{ row, col }`, and a list of pieces as
`{ shape, colour, rot, col }`. The generator emits the hand-crafted levels
first, and re-running the generator preserves their exact contents.
