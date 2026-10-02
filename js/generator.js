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
    /* Drop the whole floor until its shallowest column reaches the bottom.
       Zeroing just that one column instead would cut a cliff into an
       otherwise gentle floor — on a high floor that leaves a one-wide shaft
       several rows deep, hanging below the arena like a hole in it. Shifting
       the lot keeps every step between neighbours at one row. */
    var lowest = heights[0];
    for (var k = 1; k < heights.length; k++) if (heights[k] < lowest) lowest = heights[k];
    if (lowest > 0) for (var j = 0; j < heights.length; j++) heights[j] -= lowest;
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

  /* ── counting the ways a level can be solved ──────────────────────── */

  /* A perfect packing can never contain a buried empty cell, so every board
     the player can still win from is filled contiguously from the floor up.
     That makes the column heights a complete description of the board, which
     is what lets this count whole solutions rather than walk a tree of
     placements. Counting stops at `cap`. */
  function countSolutions(level, cap) {
    var limit = cap || 3;
    var w = level.width;
    var totalRows = SKY + level.height;

    var start = new Array(w);
    for (var c = 0; c < w; c++) start[c] = 0;
    for (var o = 0; o < level.obstacles.length; o++) start[level.obstacles[o].col]++;

    /* Distinct moves per piece. Two rotations that draw the same cells are
       the same move to the player, and a piece carrying a covered gap of its
       own can never belong to a perfect packing. */
    var moves = [];
    for (var p = 0; p < level.pieces.length; p++) {
      var seen = {};
      var options = [];
      for (var rot = 0; rot < 4; rot++) {
        var geom = Shapes.cellsOf(level.pieces[p].shape, rot);
        var ids = [];
        for (var i = 0; i < geom.cells.length; i++) ids.push(geom.cells[i].r + ':' + geom.cells[i].c);
        var key = ids.sort().join('|');
        if (seen[key]) continue;
        seen[key] = true;

        var low = [], count = [];
        for (var j = 0; j < geom.cols; j++) { low[j] = -1; count[j] = 0; }
        for (var k = 0; k < geom.cells.length; k++) {
          var cell = geom.cells[k];
          if (cell.r > low[cell.c]) low[cell.c] = cell.r;
          count[cell.c]++;
        }
        var solid = true;
        for (var m = 0; m < geom.cols; m++) {
          if (!count[m]) continue;
          var top = low[m] - count[m] + 1;
          var filled = 0;
          for (var q = 0; q < geom.cells.length; q++) {
            if (geom.cells[q].c === m && geom.cells[q].r >= top && geom.cells[q].r <= low[m]) filled++;
          }
          if (filled !== count[m]) { solid = false; break; }
        }
        if (solid) options.push({ cols: geom.cols, low: low, count: count });
      }
      moves.push(options);
    }

    var memo = [];
    for (var n = 0; n <= moves.length; n++) memo.push({});

    function walk(index, heights) {
      if (index === moves.length) {
        for (var a = 0; a < w; a++) if (heights[a] !== level.height) return 0;
        return 1;
      }
      var key = heights.join(',');
      var hit = memo[index][key];
      if (hit !== undefined) return hit;

      var found = 0;
      var options = moves[index];
      for (var t = 0; t < options.length && found < limit; t++) {
        var move = options[t];
        for (var col = 0; col + move.cols <= w && found < limit; col++) {
          /* Every column the piece covers has to meet its underside at the
             same row, otherwise the piece bridges a gap and buries a cell. */
          var rest = null;
          var flush = true;
          for (var b = 0; b < move.cols; b++) {
            if (!move.count[b]) continue;
            var landing = totalRows - 1 - heights[col + b] - move.low[b];
            if (rest === null) rest = landing;
            else if (landing !== rest) { flush = false; break; }
          }
          if (!flush || rest === null || rest < SKY) continue;

          var next = heights.slice();
          var fits = true;
          for (var d = 0; d < move.cols; d++) {
            if (!move.count[d]) continue;
            next[col + d] += move.count[d];
            if (next[col + d] > level.height) { fits = false; break; }
          }
          if (!fits) continue;
          found += walk(index + 1, next);
        }
      }
      if (found > limit) found = limit;
      memo[index][key] = found;
      return found;
    }

    return walk(0, start);
  }

  /* ── building a level ─────────────────────────────────────────────── */

  /* A level with a single answer is a memory test: one wrong drop and the
     only way back is Restart. Three gives the player room to think. */
  var MIN_SOLUTIONS = 3;

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
      var level = {
        id: kind + '-' + seed,
        kind: kind,
        seed: seed,
        width: params.w,
        height: params.h,
        obstacles: obstacles,
        pieces: pieces,
        fallSpeed: params.fallSpeed
      };
      if (countSolutions(level, MIN_SOLUTIONS) < MIN_SOLUTIONS) continue;
      return level;
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
    countSolutions: countSolutions,
    rng: rng
  };
})(typeof window !== 'undefined' ? window : globalThis);
