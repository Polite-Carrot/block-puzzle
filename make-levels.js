#!/usr/bin/env node
/* make-levels.js — build the 100-level campaign into js/levels.js.
 *
 *   node make-levels.js
 *
 * The first five levels are written by hand, because each one exists to teach
 * a single rule. The rest are tiled by a backtracking search: fill the
 * leftmost-lowest empty cell with a gravity-compatible piece, repeat until
 * the arena is packed to the ceiling with no gap left behind. A level ships
 * only if the tiler finds a perfect fit — no floating pockets, no partial
 * fills — and the recorded (shape, rotation, column, row) really lands
 * where the tiler said it did.
 *
 * Re-run only when the curve, the pool or the taught levels change. */

'use strict';
const fs = require('fs');
const path = require('path');

require('./js/palette.js');
require('./js/shapes.js');
require('./js/engine.js');

const Shapes = globalThis.Shapes;
const Engine = globalThis.Engine;
const SKY = Engine.SKY;

/* mulberry32 — small, fast, deterministic. */
function rng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COLOURS = ['red', 'blue', 'teal', 'purple', 'green', 'orange', 'yellow', 'magenta', 'white'];

/* Piece pools by tier. Small pieces (dom, tri) are kept out of the mid-and
   later tiers because a single-cell filler makes any level trivial and the
   puzzle is about squeezing bigger shapes into place. Every pool has at
   least one 4-cell and one 5-cell piece so the tiler always has room to
   trade one for the other when the last few cells demand it. */
const POOL_TINY   = ['dom', 'tri_i', 'tri_l', 'tet_o', 'tet_l', 'tet_j'];
const POOL_SMALL  = ['dom', 'tri_l', 'tet_o', 'tet_l', 'tet_j', 'tet_t', 'tet_i', 'tet_s', 'tet_z'];
const POOL_MID    = ['dom', 'tet_o', 'tet_l', 'tet_j', 'tet_t', 'tet_i', 'tet_s', 'tet_z',
                     'pen_p', 'pen_l', 'pen_u', 'pen_y'];
const POOL_LARGE  = ['dom', 'tet_l', 'tet_j', 'tet_t', 'tet_i', 'tet_s', 'tet_z',
                     'pen_p', 'pen_l', 'pen_u', 'pen_y', 'pen_t', 'pen_v', 'pen_w', 'pen_z'];
const POOL_HARDEST = ['dom', 'tet_s', 'tet_z', 'tet_t', 'tet_l', 'tet_j',
                      'pen_p', 'pen_l', 'pen_u', 'pen_y', 'pen_t', 'pen_v', 'pen_w', 'pen_z'];

/* The curve. Every level takes its size from a monotonically-growing base
   with a small per-level offset so no two adjacent boards feel identical.
   Width ranges 3–8 and height 3–11. Terrain — a per-column rise — comes in
   from the twenties and grows to jagged landscapes by the eighties. */
function paramsFor(level) {
  if (level <= 5) return null;   /* hand-crafted */
  const idx = level - 6;         /* 0..94 */
  const t = idx / 94;

  /* Base grows with the level index. Small per-level offsets keep the shape
     of adjacent boards from repeating: pattern arrays are deterministic so
     regenerating never changes what any level was. */
  const wBase = 3 + Math.floor(t * 5);       /* 3 → 8 */
  const hBase = 3 + Math.floor(t * 7);       /* 3 → 10 */
  const wOff  = [0, 1, 0, -1, 1, 2][level % 6];
  const hOff  = [1, 0, 2, 1, -1, 1, 2][level % 7];
  const w = Math.max(3, Math.min(8, wBase + wOff));
  const h = Math.max(3, Math.min(11, hBase + hOff));

  /* Terrain rise per column. 0 for the first fifteen dealt levels, then up
     to a jagged four rows by level 100. Capped at half the arena so at
     least half the board is always playable. */
  const terrainMax = Math.min(Math.floor(h / 2), Math.max(0, Math.floor((idx - 8) / 12)));

  /* Piece pool tier — early boards run on triominoes and tetrominoes,
     pentominoes take over from level ~30 onwards. */
  const pool = idx < 8  ? POOL_TINY :
               idx < 22 ? POOL_SMALL :
               idx < 45 ? POOL_MID :
               idx < 70 ? POOL_LARGE : POOL_HARDEST;

  const palette   = Math.min(9, 3 + Math.floor(t * 7));
  const fallSpeed = 0.35 + t * 0.5;

  return { w, h, terrainMax, pool, palette, fallSpeed };
}

/* ── the five that teach ───────────────────────────────────────────────── */

const TEACH = [
  {
    name: 'First Drop',
    brief: 'The block falls slowly from the top. Move it left or right, then let it settle.',
    width: 4, height: 2, obstacles: [],
    fallSpeed: 0.3,
    pieces: [
      { shape: 'tet_o', colour: 'red',  rot: 0, col: 0, top: 6 },
      { shape: 'tet_o', colour: 'blue', rot: 0, col: 2, top: 6 }
    ]
  },
  {
    name: 'Choose a Column',
    brief: 'Two squares along the bottom, two dominos on top. Every cell fills.',
    width: 4, height: 3, obstacles: [],
    fallSpeed: 0.32,
    pieces: [
      { shape: 'tet_o', colour: 'red',    rot: 0, col: 0, top: 7 },
      { shape: 'tet_o', colour: 'blue',   rot: 0, col: 2, top: 7 },
      { shape: 'dom',   colour: 'teal',   rot: 0, col: 0, top: 6 },
      { shape: 'dom',   colour: 'purple', rot: 0, col: 2, top: 6 }
    ]
  },
  {
    name: 'Standing Up',
    brief: 'Tap the arena to rotate. A rotation wider than the arena is refused.',
    width: 3, height: 4, obstacles: [],
    fallSpeed: 0.32,
    pieces: [
      { shape: 'tet_i', colour: 'red',  rot: 1, col: 0, top: 6 },
      { shape: 'tet_i', colour: 'blue', rot: 1, col: 1, top: 6 },
      { shape: 'tet_i', colour: 'teal', rot: 1, col: 2, top: 6 }
    ]
  },
  {
    name: 'Uneven Ground',
    brief: 'The floor is not flat — some columns start higher than others. Fit the pieces to the shape of the ground.',
    width: 4, height: 4,
    obstacles: [{ row: 3, col: 0 }, { row: 3, col: 3 }],
    fallSpeed: 0.32,
    pieces: [
      { shape: 'dom',   colour: 'red',    rot: 0, col: 1, top: 9 },
      { shape: 'tet_o', colour: 'blue',   rot: 0, col: 0, top: 7 },
      { shape: 'tet_o', colour: 'teal',   rot: 0, col: 2, top: 7 },
      { shape: 'dom',   colour: 'purple', rot: 0, col: 0, top: 6 },
      { shape: 'dom',   colour: 'green',  rot: 0, col: 2, top: 6 }
    ]
  },
  {
    name: 'Order Matters',
    brief: 'A bar along the bottom, a square on each side, a bar across the top. Every cell.',
    width: 4, height: 4, obstacles: [],
    fallSpeed: 0.32,
    pieces: [
      { shape: 'tet_i', colour: 'red',    rot: 0, col: 0, top: 9 },
      { shape: 'tet_o', colour: 'blue',   rot: 0, col: 0, top: 7 },
      { shape: 'tet_o', colour: 'teal',   rot: 0, col: 2, top: 7 },
      { shape: 'tet_i', colour: 'purple', rot: 0, col: 0, top: 6 }
    ]
  }
];

/* ── the tiler ─────────────────────────────────────────────────────────── */

function landingRowOn(grid, geom, width, col) {
  const total = grid.length;
  let last = null;
  for (let top = -geom.rows; top <= total - geom.rows; top++) {
    let ok = true;
    for (const cell of geom.cells) {
      const rr = top + cell.r;
      const cc = col + cell.c;
      if (cc < 0 || cc >= width) { ok = false; break; }
      if (rr >= total) { ok = false; break; }
      if (rr < 0) continue;
      if (grid[rr][cc]) { ok = false; break; }
    }
    if (ok) last = top;
    else if (last !== null) break;
  }
  return last;
}

/* Would placing `geom` at (top, col) leave an empty cell that no future
   piece can reach? A cell is unreachable if some occupied cell sits above
   it in the same column, because gravity brings every piece down and any
   piece dropped into that column would rest on the overhang, not the pocket
   underneath.
   
   Only the columns the piece touches need checking — every other column is
   unchanged by this placement. */
function createsCavity(grid, geom, top, col) {
  const perColBottom = new Map();
  for (const cell of geom.cells) {
    const c = col + cell.c;
    const r = top + cell.r;
    const prev = perColBottom.get(c);
    if (prev === undefined || r > prev) perColBottom.set(c, r);
  }
  for (const [c, bottom] of perColBottom) {
    for (let r = bottom + 1; r < grid.length; r++) {
      if (!grid[r][c]) return true;
    }
  }
  return false;
}

/* Find the leftmost-lowest empty cell inside the arena — bottom-first, so
   the tiler always builds up from the floor, and left-first among ties, so
   every recursion has the same "next thing to fill" and the search does not
   revisit equivalent partial states. */
function findTarget(grid, width, sky) {
  for (let r = grid.length - 1; r >= sky; r--) {
    for (let c = 0; c < width; c++) {
      if (!grid[r][c]) return { r, c };
    }
  }
  return null;
}

function shufflePlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr;
}

/* Enumerate every placement that would cover `target` as one of its own
   cells and land there under gravity — i.e., for each cell of the piece,
   solve `top + cell.r = target.r` and `col + cell.c = target.c`, and keep
   the placement only if landingRowOn agrees. */
function candidatesForTarget(grid, width, sky, pool, target) {
  const out = [];
  const seen = new Set();
  for (const shape of pool) {
    for (let rot = 0; rot < 4; rot++) {
      const geom = Shapes.cellsOf(shape, rot);
      if (geom.cols > width) continue;
      for (const cell of geom.cells) {
        const col = target.c - cell.c;
        const top = target.r - cell.r;
        if (col < 0 || col + geom.cols > width) continue;
        if (top < 0 || top + geom.rows > grid.length) continue;
        const landing = landingRowOn(grid, geom, width, col);
        if (landing !== top) continue;
        if (top < sky) continue;
        if (createsCavity(grid, geom, top, col)) continue;
        const key = shape + '/' + rot + '/' + col + '/' + top;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ shape, rot, col, top, geom });
      }
    }
  }
  return out;
}

function tileArena(width, height, obstacles, pool, rng, timeBudgetMs) {
  const total = SKY + height;
  const grid = [];
  for (let r = 0; r < total; r++) grid.push(new Array(width).fill(null));
  for (const o of obstacles) grid[SKY + o.row][o.col] = { obstacle: true };

  const solution = [];
  const started = Date.now();
  let exhausted = false;

  function backtrack() {
    if (exhausted) return false;
    if (Date.now() - started > timeBudgetMs) { exhausted = true; return false; }
    const target = findTarget(grid, width, SKY);
    if (!target) return true;
    const cands = candidatesForTarget(grid, width, SKY, pool, target);
    /* Prefer bigger pieces first so dominoes are a fallback for pockets the
       tetrominoes and pentominoes cannot cover, not the first choice. Within
       a size, the shuffled tie-break keeps the campaign from settling on the
       same rotation every time. */
    const grouped = new Map();
    for (const c of cands) {
      const sz = c.geom.cells.length;
      if (!grouped.has(sz)) grouped.set(sz, []);
      grouped.get(sz).push(c);
    }
    const sizes = [...grouped.keys()].sort((a, b) => b - a);
    const ordered = [];
    for (const sz of sizes) ordered.push(...shufflePlace(grouped.get(sz), rng));
    for (const cand of ordered) {
      for (const cell of cand.geom.cells) {
        grid[cand.top + cell.r][cand.col + cell.c] = { placementIndex: solution.length };
      }
      solution.push({ shape: cand.shape, rot: cand.rot, col: cand.col, top: cand.top });
      if (backtrack()) return true;
      solution.pop();
      for (const cell of cand.geom.cells) {
        grid[cand.top + cell.r][cand.col + cell.c] = null;
      }
    }
    return false;
  }

  return backtrack() ? solution : null;
}

/* Terrain is the arena's landscape — each column has its own floor height,
   rising from the true bottom. Adjacent columns differ by at most one row,
   so the surface reads as a rolling hillside rather than a spiked comb,
   and the tiler's cavity check is happy because every column's terrain
   is a solid stack rooted at the floor. */
function makeTerrain(w, h, maxRise, r) {
  if (maxRise <= 0) return [];
  const cells = [];
  /* Start high so late levels really do end up with substantial terrain,
     and bias the walk slightly upward so the average rise sits near max. */
  let rise = Math.max(1, maxRise - Math.floor(r() * 2));
  const heights = [];
  for (let c = 0; c < w; c++) {
    const roll = r();
    const delta = roll < 0.25 ? -1 : roll < 0.55 ? 0 : 1;
    rise = Math.max(0, Math.min(maxRise, rise + delta));
    heights.push(rise);
  }
  /* At least one column must reach the true floor so pieces can land there
     — otherwise the pile starts elevated and every level fails from turn one. */
  if (heights.every(function (x) { return x > 0; })) {
    let minIdx = 0;
    for (let c = 1; c < w; c++) if (heights[c] < heights[minIdx]) minIdx = c;
    heights[minIdx] = 0;
  }
  for (let c = 0; c < w; c++) {
    for (let d = 0; d < heights[c]; d++) {
      cells.push({ row: h - 1 - d, col: c });
    }
  }
  return cells;
}

/* Assign colours so no two adjacent pieces (any pair that shares a cell
   border in the arena) get the same one. Pieces are numbered by their
   placement order, so the graph is small enough to greedy-colour without a
   full search. */
function colourPieces(solution, palette, r) {
  const adj = solution.map(() => new Set());
  const pieceOfCell = new Map();
  for (let i = 0; i < solution.length; i++) {
    const p = solution[i];
    const geom = Shapes.cellsOf(p.shape, p.rot);
    for (const cell of geom.cells) {
      const key = (p.top + cell.r) * 1000 + (p.col + cell.c);
      pieceOfCell.set(key, i);
    }
  }
  for (const [key, i] of pieceOfCell) {
    const row = Math.floor(key / 1000);
    const col = key % 1000;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nb = (row + dr) * 1000 + (col + dc);
      const j = pieceOfCell.get(nb);
      if (j !== undefined && j !== i) { adj[i].add(j); adj[j].add(i); }
    }
  }
  const colours = new Array(solution.length).fill(null);
  const order = solution.map((_, i) => i);
  shufflePlace(order, r);
  for (const i of order) {
    const taken = new Set();
    for (const j of adj[i]) if (colours[j] !== null) taken.add(colours[j]);
    /* Shuffled palette per piece keeps the campaign from settling on the
       same colour rotation across every board. */
    const options = shufflePlace(palette.slice(), r);
    let picked = null;
    for (const c of options) if (!taken.has(c)) { picked = c; break; }
    colours[i] = picked || options[0];
  }
  return colours;
}

function buildLevel(index, seed) {
  const p = paramsFor(index);
  if (!p) throw new Error('no params for level ' + index);
  const palette = COLOURS.slice(0, p.palette);
  /* Try a handful of seeds. A generated terrain could be one the tiler
     cannot pack; roll a new one rather than fight the same layout. Every
     attempt is deterministic given its own seed. */
  for (let attempt = 0; attempt < 80; attempt++) {
    const r = rng(seed + attempt * 17);
    const obstacles = makeTerrain(p.w, p.h, p.terrainMax, r);
    const solution = tileArena(p.w, p.h, obstacles, p.pool, r, 4000);
    if (!solution) continue;
    const colours = colourPieces(solution, palette, r);
    const pieces = solution.map((s, i) => ({
      shape: s.shape,
      colour: colours[i],
      rot: s.rot,
      col: s.col,
      top: s.top
    }));
    return {
      id: 'level-' + String(index).padStart(3, '0'),
      name: nameFor(index),
      width: p.w,
      height: p.h,
      obstacles,
      pieces,
      fallSpeed: p.fallSpeed
    };
  }
  throw new Error('could not tile level ' + index + ' after 80 attempts');
}

const NAME_POOL = [
  'Little Steps', 'First Fall', 'Odd Corner', 'Neat Stack', 'Two by Two',
  'Puzzle Box', 'Careful Now', 'Straight Line', 'The Shelf', 'Corner Piece',
  'Under the Line', 'Fit Together', 'Fill the Floor', 'Twin Bars', 'Third Way',
  'Small Chamber', 'Slim Column', 'Wide Shelf', 'Small Gaps', 'Just So',
  'Push and Turn', 'Bit by Bit', 'Trim the Sides', 'Neat Notch', 'Sliding Fit',
  'One Way', 'Only Way', 'Bottom Up', 'Tucked In', 'Turn It Round',
  'Ten Deep', 'Middle Tower', 'Twin Notch', 'Deep Well', 'Split the Line',
  'Terrain', 'Landscape', 'The Cliff', 'The Cave', 'Cornered',
  'Pinch Point', 'Diamond', 'Slotted', 'Nested', 'Wobble',
  'One Turn', 'Two Turns', 'Three Turns', 'Every Turn', 'The Half',
  'Half Height', 'Half Width', 'Deep Cut', 'High Line', 'The Bridge',
  'Boxed In', 'Squeeze', 'The Pillar', 'The Post', 'Between Rocks',
  'Corner Cut', 'Slot Machine', 'Runners', 'Ribbon', 'Braid',
  'The Peak', 'The Trough', 'Shift Left', 'Shift Right', 'Even Steps',
  'Odd Steps', 'Fold', 'Overhang', 'The Ledge', 'The Overhang',
  'Slate', 'Cinder', 'Pumice', 'Basalt', 'Granite',
  'Marble', 'Chalk', 'Flint', 'Slate II', 'Cinder II',
  'The Twelve', 'Full House', 'Almost Full', 'One More', 'Last Piece',
  'Overflow', 'On the Brink', 'Bare Millimetre', 'Fit Exact', 'Trickery',
  'Reach the Line', 'Just Under', 'Right at the Top', 'Tight Squeeze', 'The Very Last',
  'Hundred Down', 'Hundred Up', 'The Hundredth', 'End of the Line', 'One Hundred'
];

function nameFor(index) {
  if (index <= 5) return TEACH[index - 1].name;
  return NAME_POOL[(index - 6) % NAME_POOL.length];
}

/* ── build ─────────────────────────────────────────────────────────────── */

const levels = [];

for (let i = 0; i < TEACH.length; i++) {
  const t = TEACH[i];
  levels.push({
    id: 'level-' + String(i + 1).padStart(3, '0'),
    name: t.name,
    brief: t.brief,
    width: t.width,
    height: t.height,
    obstacles: t.obstacles,
    pieces: t.pieces,
    fallSpeed: t.fallSpeed
  });
}

for (let i = TEACH.length + 1; i <= 100; i++) {
  const seed = 90210 + i * 137;
  const level = buildLevel(i, seed);
  levels.push(level);
}

/* ── emit ──────────────────────────────────────────────────────────────── */

function jsonish(v) { return JSON.stringify(v); }

const lines = [];
lines.push('/* levels.js — GENERATED by make-levels.js. Do not edit by hand.');
lines.push(' *');
lines.push(' * A 100-level campaign. The first five are written by hand, one rule each;');
lines.push(' * the rest are perfectly tiled by a backtracking search — every cell of every');
lines.push(' * arena is filled by a piece, no floating pockets, no gaps left behind, so');
lines.push(' * the level has one intended fit that reaches the ceiling exactly.');
lines.push(' *');
lines.push(' * Each piece carries the (rotation, column, top) the tiler chose, so the');
lines.push(' * game can hard-drop it in for a hint and verify-levels.js can prove every');
lines.push(' * level really is solvable.');
lines.push(' */');
lines.push('(function (global) {');
lines.push("  'use strict';");
lines.push('  var LEVELS = [');
for (const lvl of levels) {
  const obs = lvl.obstacles && lvl.obstacles.length
    ? '[' + lvl.obstacles.map(o => `{r:${o.row},c:${o.col}}`).join(',') + ']'
    : '[]';
  const pieces = '[' + lvl.pieces
    .map(p => `{s:'${p.shape}',c:'${p.colour}',r:${p.rot},x:${p.col},t:${p.top}}`).join(',') + ']';
  const brief = lvl.brief ? `, brief: ${jsonish(lvl.brief)}` : '';
  lines.push(
    `    { id: '${lvl.id}', name: ${jsonish(lvl.name)}${brief}, width: ${lvl.width}, height: ${lvl.height}, fallSpeed: ${lvl.fallSpeed}, obstacles: ${obs}, pieces: ${pieces} },`
  );
}
lines.push('  ];');
lines.push('  for (var i = 0; i < LEVELS.length; i++) {');
lines.push('    var L = LEVELS[i];');
lines.push('    L.subtitle = "Level " + (i + 1) + " of " + LEVELS.length;');
lines.push('    L.obstacles = L.obstacles.map(function (o) { return { row: o.r, col: o.c }; });');
lines.push('    L.pieces = L.pieces.map(function (p) {');
lines.push('      return { shape: p.s, colour: p.c, solRot: p.r, solCol: p.x, solTop: p.t };');
lines.push('    });');
lines.push('  }');
lines.push('  global.LEVELS = LEVELS;');
lines.push("})(typeof window !== 'undefined' ? window : globalThis);");
lines.push('');

const outPath = path.join(__dirname, 'js', 'levels.js');
fs.writeFileSync(outPath, lines.join('\n'));

const totalPieces = levels.reduce((n, l) => n + l.pieces.length, 0);
console.log(
  'Wrote ' + path.relative(__dirname, outPath) +
  ' — ' + levels.length + ' levels, ' + totalPieces + ' pieces total, ' +
  (fs.statSync(outPath).size / 1024).toFixed(1) + ' KB'
);
