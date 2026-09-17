/* generator.js — the level tiler, shared between make-levels.js (Node) and
 * the browser. Given a seed, it deals a perfectly-tiled arena the player
 * can beat: every non-terrain cell filled by exactly one piece, arranged
 * so gravity can settle each one where the tiler placed it.
 *
 * Attached to the global as `Generator` with three helpers:
 *
 *   Generator.buildCampaignLevel(index, seed)  — used by make-levels.js
 *   Generator.buildRandomLevel(difficulty, seed)
 *   Generator.dailyToday()  — the seed the daily puzzle is dealt with
 *
 * The tiler is deterministic: same seed, same board. */
(function (global) {
  'use strict';

  var Shapes = global.Shapes;
  var Engine = global.Engine;
  if (!Shapes || !Engine) return;   /* loaded before its dependencies — bail */

  var SKY = Engine.SKY;

  var COLOURS = ['red', 'blue', 'teal', 'purple', 'green', 'orange', 'yellow', 'magenta', 'white'];

  var POOL_TINY    = ['dom', 'tri_i', 'tri_l', 'tet_o', 'tet_l', 'tet_j'];
  var POOL_SMALL   = ['dom', 'tri_l', 'tet_o', 'tet_l', 'tet_j', 'tet_t', 'tet_i', 'tet_s', 'tet_z'];
  var POOL_MID     = ['dom', 'tet_o', 'tet_l', 'tet_j', 'tet_t', 'tet_i', 'tet_s', 'tet_z',
                      'pen_p', 'pen_l', 'pen_u', 'pen_y'];
  var POOL_LARGE   = ['dom', 'tet_l', 'tet_j', 'tet_t', 'tet_i', 'tet_s', 'tet_z',
                      'pen_p', 'pen_l', 'pen_u', 'pen_y', 'pen_t', 'pen_v', 'pen_w', 'pen_z'];
  var POOL_HARDEST = ['dom', 'tet_s', 'tet_z', 'tet_t', 'tet_l', 'tet_j',
                      'pen_p', 'pen_l', 'pen_u', 'pen_y', 'pen_t', 'pen_v', 'pen_w', 'pen_z'];

  /* mulberry32 — small, fast, deterministic. */
  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ── the tiler ─────────────────────────────────────────────────────── */

  function landingRowOn(grid, geom, width, col) {
    var total = grid.length;
    var last = null;
    for (var top = -geom.rows; top <= total - geom.rows; top++) {
      var ok = true;
      for (var i = 0; i < geom.cells.length; i++) {
        var rr = top + geom.cells[i].r;
        var cc = col + geom.cells[i].c;
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

  function createsCavity(grid, geom, top, col) {
    var perCol = new Map();
    for (var i = 0; i < geom.cells.length; i++) {
      var c = col + geom.cells[i].c;
      var r = top + geom.cells[i].r;
      var prev = perCol.get(c);
      if (prev === undefined || r > prev) perCol.set(c, r);
    }
    var iter = perCol.entries();
    var next = iter.next();
    while (!next.done) {
      var col2 = next.value[0], bottom = next.value[1];
      for (var rr = bottom + 1; rr < grid.length; rr++) {
        if (!grid[rr][col2]) return true;
      }
      next = iter.next();
    }
    return false;
  }

  function findTarget(grid, width, sky) {
    for (var r = grid.length - 1; r >= sky; r--) {
      for (var c = 0; c < width; c++) {
        if (!grid[r][c]) return { r: r, c: c };
      }
    }
    return null;
  }

  function shufflePlace(arr, rand) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  function candidatesForTarget(grid, width, sky, pool, target) {
    var out = [];
    var seen = new Set();
    for (var s = 0; s < pool.length; s++) {
      var shape = pool[s];
      for (var rot = 0; rot < 4; rot++) {
        var geom = Shapes.cellsOf(shape, rot);
        if (geom.cols > width) continue;
        for (var i = 0; i < geom.cells.length; i++) {
          var col = target.c - geom.cells[i].c;
          var top = target.r - geom.cells[i].r;
          if (col < 0 || col + geom.cols > width) continue;
          if (top < 0 || top + geom.rows > grid.length) continue;
          var landing = landingRowOn(grid, geom, width, col);
          if (landing !== top) continue;
          if (top < sky) continue;
          if (createsCavity(grid, geom, top, col)) continue;
          var key = shape + '/' + rot + '/' + col + '/' + top;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ shape: shape, rot: rot, col: col, top: top, geom: geom });
        }
      }
    }
    return out;
  }

  function tileArena(width, height, obstacles, pool, rand, timeBudgetMs) {
    var total = SKY + height;
    var grid = [];
    for (var r = 0; r < total; r++) grid.push(new Array(width).fill(null));
    for (var i = 0; i < obstacles.length; i++) {
      grid[SKY + obstacles[i].row][obstacles[i].col] = { obstacle: true };
    }
    var solution = [];
    var started = Date.now();
    var exhausted = false;

    function backtrack() {
      if (exhausted) return false;
      if (Date.now() - started > timeBudgetMs) { exhausted = true; return false; }
      var target = findTarget(grid, width, SKY);
      if (!target) return true;
      var cands = candidatesForTarget(grid, width, SKY, pool, target);
      var grouped = new Map();
      for (var k = 0; k < cands.length; k++) {
        var sz = cands[k].geom.cells.length;
        if (!grouped.has(sz)) grouped.set(sz, []);
        grouped.get(sz).push(cands[k]);
      }
      var sizes = Array.from(grouped.keys()).sort(function (a, b) { return b - a; });
      var ordered = [];
      for (var m = 0; m < sizes.length; m++) {
        ordered = ordered.concat(shufflePlace(grouped.get(sizes[m]), rand));
      }
      for (var n = 0; n < ordered.length; n++) {
        var cand = ordered[n];
        for (var j = 0; j < cand.geom.cells.length; j++) {
          grid[cand.top + cand.geom.cells[j].r][cand.col + cand.geom.cells[j].c] =
            { placementIndex: solution.length };
        }
        solution.push({ shape: cand.shape, rot: cand.rot, col: cand.col, top: cand.top });
        if (backtrack()) return true;
        solution.pop();
        for (var jj = 0; jj < cand.geom.cells.length; jj++) {
          grid[cand.top + cand.geom.cells[jj].r][cand.col + cand.geom.cells[jj].c] = null;
        }
      }
      return false;
    }
    return backtrack() ? solution : null;
  }

  /* ── terrain ───────────────────────────────────────────────────────── */

  function makeTerrain(w, h, maxRise, rand) {
    if (maxRise <= 0) return [];
    var cells = [];
    var rise = Math.max(1, maxRise - Math.floor(rand() * 2));
    var heights = [];
    for (var c = 0; c < w; c++) {
      var roll = rand();
      var delta = roll < 0.25 ? -1 : roll < 0.55 ? 0 : 1;
      rise = Math.max(0, Math.min(maxRise, rise + delta));
      heights.push(rise);
    }
    var allNonZero = true;
    for (var k = 0; k < heights.length; k++) if (heights[k] === 0) allNonZero = false;
    if (allNonZero) {
      var minIdx = 0;
      for (var i = 1; i < w; i++) if (heights[i] < heights[minIdx]) minIdx = i;
      heights[minIdx] = 0;
    }
    for (var col = 0; col < w; col++) {
      for (var d = 0; d < heights[col]; d++) {
        cells.push({ row: h - 1 - d, col: col });
      }
    }
    return cells;
  }

  /* ── colouring ─────────────────────────────────────────────────────── */

  function colourPieces(solution, palette, rand) {
    var adj = solution.map(function () { return new Set(); });
    var pieceOfCell = new Map();
    for (var i = 0; i < solution.length; i++) {
      var p = solution[i];
      var geom = Shapes.cellsOf(p.shape, p.rot);
      for (var j = 0; j < geom.cells.length; j++) {
        var key = (p.top + geom.cells[j].r) * 1000 + (p.col + geom.cells[j].c);
        pieceOfCell.set(key, i);
      }
    }
    var iter = pieceOfCell.entries();
    var e = iter.next();
    while (!e.done) {
      var kk = e.value[0], own = e.value[1];
      var row = Math.floor(kk / 1000), col = kk % 1000;
      var deltas = [[-1, 0], [1, 0], [0, -1], [0, 1]];
      for (var d = 0; d < 4; d++) {
        var nb = (row + deltas[d][0]) * 1000 + (col + deltas[d][1]);
        var other = pieceOfCell.get(nb);
        if (other !== undefined && other !== own) { adj[own].add(other); adj[other].add(own); }
      }
      e = iter.next();
    }
    var colours = new Array(solution.length).fill(null);
    var order = solution.map(function (_, i) { return i; });
    shufflePlace(order, rand);
    for (var m = 0; m < order.length; m++) {
      var idx = order[m];
      var taken = new Set();
      adj[idx].forEach(function (o) { if (colours[o] !== null) taken.add(colours[o]); });
      var options = shufflePlace(palette.slice(), rand);
      var picked = null;
      for (var p2 = 0; p2 < options.length; p2++) if (!taken.has(options[p2])) { picked = options[p2]; break; }
      colours[idx] = picked || options[0];
    }
    return colours;
  }

  /* ── params: campaign and random ──────────────────────────────────── */

  /* Campaign — deterministic curve. One thousand levels, dealt into five
     pool tiers so the vocabulary of shapes grows steadily; width and height
     rise almost linearly with the level number so the arena keeps widening
     into the hundreds; terrain and fall speed climb in parallel. */
  var CAMPAIGN_LEVELS = 1000;
  function campaignParams(level) {
    var idx = Math.max(0, level - 6);
    var t = idx / (CAMPAIGN_LEVELS - 6);   /* 0 at level 6, 1 at level 1000 */
    /* Two ramps rather than one. A single curve stretched over a thousand
       levels leaves the opening fifty barely distinguishable from each other;
       `early` does most of its growing in the first sixty levels, and `late`
       takes over for the long climb after that. */
    var early = Math.min(1, Math.sqrt(idx / 60));
    var late  = Math.max(0, (idx - 60) / (CAMPAIGN_LEVELS - 66));
    var wBase = 4 + Math.round(early * 3) + Math.round(late * 1);   /* 4 → 7 → 8 */
    var hBase = 4 + Math.round(early * 5) + Math.round(late * 3);   /* 4 → 9 → 12 */
    var wOff  = [0, 1, 0, -1, 1, 2][level % 6];
    var hOff  = [1, 0, 2, 1, -1, 1, 2][level % 7];
    var w = Math.max(4, Math.min(8, wBase + wOff));
    var h = Math.max(4, Math.min(12, hBase + hOff));
    /* Terrain from the twenties, jagged by the eighties. */
    var terrainMax = Math.min(5, Math.floor(h / 2), Math.floor(idx / 16));
    /* Five-cell pieces arrive at level 10, once the taught levels are done. */
    var pool = idx < 4   ? POOL_TINY :
               idx < 24  ? POOL_MID :
               idx < 150 ? POOL_LARGE : POOL_HARDEST;
    var palette   = Math.min(9, 3 + Math.round(early * 3) + Math.round(late * 3));
    var fallSpeed = 0.35 + early * 0.25 + late * 0.3;   /* 0.35 → 0.6 → 0.9 */
    return { w: w, h: h, terrainMax: terrainMax, pool: pool, palette: palette, fallSpeed: fallSpeed };
  }

  /* Random — five settings the player picks with a slider. Sizes and pools
     are the same shapes the campaign uses, just quantised into readable
     "easy" through "extra hard" tiers. */
  var RANDOM_TIERS = [
    { name: 'Easy',       blurb: 'Small boards, big pieces, no terrain — a quiet warm-up.',
      w: 4, h: 5, terrainMax: 0, pool: POOL_SMALL, palette: 4, fallSpeed: 0.4 },
    { name: 'Normal',     blurb: 'Every tetromino, a little terrain, and just enough shape variety.',
      w: 5, h: 6, terrainMax: 1, pool: POOL_MID,   palette: 5, fallSpeed: 0.5 },
    { name: 'Hard',       blurb: 'Pentominoes in the mix and a real landscape to fit them around.',
      w: 6, h: 8, terrainMax: 2, pool: POOL_LARGE, palette: 6, fallSpeed: 0.6 },
    { name: 'Expert',     blurb: 'A wide board of pentominoes and a jagged ground — plan two moves ahead.',
      w: 7, h: 9, terrainMax: 3, pool: POOL_LARGE, palette: 7, fallSpeed: 0.7 },
    { name: 'Extra Hard', blurb: 'Eight columns of pentominoes, deep terrain, and a fall that will not wait.',
      w: 8, h: 11, terrainMax: 4, pool: POOL_HARDEST, palette: 8, fallSpeed: 0.8 }
  ];

  /* ── building a level ─────────────────────────────────────────────── */

  function buildFromParams(params, seed, kind) {
    var palette = COLOURS.slice(0, params.palette);
    for (var attempt = 0; attempt < 80; attempt++) {
      var rand = rng(seed + attempt * 17);
      var obstacles = makeTerrain(params.w, params.h, params.terrainMax, rand);
      var solution = tileArena(params.w, params.h, obstacles, params.pool, rand, 3000);
      if (!solution) continue;
      var colours = colourPieces(solution, palette, rand);
      var pieces = solution.map(function (s, i) {
        return { shape: s.shape, colour: colours[i], rot: s.rot, col: s.col, top: s.top };
      });
      return {
        id: kind + '-' + seed,
        kind: kind,
        seed: seed,
        width: params.w,
        height: params.h,
        obstacles: obstacles,
        pieces: pieces,
        fallSpeed: params.fallSpeed
      };
    }
    return null;
  }

  function buildCampaignLevel(index, seed) {
    var params = campaignParams(index);
    var lvl = buildFromParams(params, seed, 'campaign');
    if (!lvl) throw new Error('could not tile level ' + index);
    lvl.id = 'level-' + String(index).padStart(3, '0');
    return lvl;
  }

  function buildRandomLevel(difficulty, seed) {
    var d = Math.max(0, Math.min(RANDOM_TIERS.length - 1, difficulty | 0));
    var tier = RANDOM_TIERS[d];
    /* Try a handful of seeds — the requested seed first, then bumps —
       so the caller almost always gets a puzzle for their specific seed
       even if the first tiling attempt happens to time out. */
    for (var bump = 0; bump < 12; bump++) {
      var lvl = buildFromParams(tier, seed + bump * 91, 'random');
      if (lvl) { lvl.difficulty = d; return lvl; }
    }
    return null;
  }

  function dailyToday() {
    var now = new Date();
    var y = now.getFullYear();
    var m = now.getMonth() + 1;
    var d = now.getDate();
    return y * 10000 + m * 100 + d;
  }

  global.Generator = {
    SKY: SKY,
    COLOURS: COLOURS,
    POOLS: {
      TINY: POOL_TINY, SMALL: POOL_SMALL, MID: POOL_MID,
      LARGE: POOL_LARGE, HARDEST: POOL_HARDEST
    },
    RANDOM_TIERS: RANDOM_TIERS,
    campaignParams: campaignParams,
    buildCampaignLevel: buildCampaignLevel,
    buildRandomLevel: buildRandomLevel,
    dailyToday: dailyToday,
    /* Exposed for verify-levels.js and other bespoke tools. */
    tileArena: tileArena,
    makeTerrain: makeTerrain,
    colourPieces: colourPieces,
    rng: rng
  };
})(typeof window !== 'undefined' ? window : globalThis);
