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

  /* Only the seven four-block pieces. Early pools hold back T, S and Z, which
     are the hardest to place. */
  var POOL_FULL       = ['tet_i', 'tet_o', 'tet_t', 'tet_s', 'tet_z', 'tet_l', 'tet_j'];
  var POOL_TINY    = ['tet_o', 'tet_i', 'tet_l', 'tet_j'];
  var POOL_SMALL   = ['tet_o', 'tet_i', 'tet_l', 'tet_j', 'tet_t'];
  var POOL_MID     = POOL_FULL;
  var POOL_LARGE   = POOL_FULL;
  var POOL_HARDEST = POOL_FULL;

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
    var used = {};
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
        /* Shuffle, then favour the shapes this board has used least — the
           most compact piece fits the most gaps and would otherwise win
           nearly every time. */
        var group = shufflePlace(grouped.get(sizes[m]), rand);
        group.sort(function (a, b) { return (used[a.shape] || 0) - (used[b.shape] || 0); });
        ordered = ordered.concat(group);
      }
      for (var n = 0; n < ordered.length; n++) {
        var cand = ordered[n];
        for (var j = 0; j < cand.geom.cells.length; j++) {
          grid[cand.top + cand.geom.cells[j].r][cand.col + cand.geom.cells[j].c] =
            { placementIndex: solution.length };
        }
        solution.push({ shape: cand.shape, rot: cand.rot, col: cand.col, top: cand.top });
        used[cand.shape] = (used[cand.shape] || 0) + 1;
        if (backtrack()) return true;
        used[cand.shape]--;
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
    /* A walk clamped at its limits stalls there and often comes out flat, so
       it bounces off them instead, and a floor that is still too even is
       re-rolled. Wide shallow floors want at least one step; deeper ones two. */
    var wantRange = Math.min(maxRise, 2);
    var heights = null;
    for (var attempt = 0; attempt < 12; attempt++) {
      var rise = Math.floor(rand() * (maxRise + 1));
      var walk = [];
      for (var c = 0; c < w; c++) {
        var roll = rand();
        var delta = roll < 0.35 ? -1 : roll < 0.65 ? 0 : 1;
        if (rise + delta > maxRise || rise + delta < 0) delta = -delta;
        rise += delta;
        walk.push(rise);
      }
      heights = walk;
      if (Math.max.apply(null, walk) - Math.min.apply(null, walk) >= wantRange) break;
    }
    /* Drop the whole floor until its shallowest column reaches the bottom.
       Zeroing just that one column instead would cut a cliff into an
       otherwise gentle floor — on a high floor that leaves a one-wide shaft
       several rows deep, hanging below the arena like a hole in it. Shifting
       the lot keeps every step between neighbours at one row. */
    var lowest = Math.min.apply(null, heights);
    for (var j = 0; j < heights.length; j++) heights[j] -= lowest;
    /* Last resort for a floor that never varied: a raised shelf. */
    if (Math.max.apply(null, heights) === 0) {
      var span = 1 + Math.floor(rand() * (w - 1));
      var from = Math.floor(rand() * (w - span + 1));
      for (var s = from; s < from + span; s++) heights[s] = 1;
    }
    var cells = [];
    for (var col = 0; col < w; col++) {
      for (var d = 0; d < heights[col]; d++) {
        cells.push({ row: h - 1 - d, col: col });
      }
    }
    return cells;
  }

  function isFlat(obstacles, w) {
    var heights = new Array(w).fill(0);
    for (var i = 0; i < obstacles.length; i++) heights[obstacles[i].col]++;
    for (var c = 1; c < w; c++) if (heights[c] !== heights[0]) return false;
    return true;
  }

  /* Every piece is four cells, so the open area must be a multiple of four or
     no tiling exists. Raising the lowest columns by one keeps the floor gentle. */
  function padToFours(obstacles, w, h) {
    var need = (w * h - obstacles.length) % 4;
    if (!need) return obstacles;
    var heights = new Array(w).fill(0);
    for (var i = 0; i < obstacles.length; i++) heights[obstacles[i].col]++;
    var order = heights.map(function (v, c) { return c; })
      .sort(function (a, b) { return heights[a] - heights[b] || a - b; });
    var out = obstacles.slice();
    for (var k = 0; k < need; k++) {
      var col = order[k];
      out.push({ row: h - 1 - heights[col], col: col });
    }
    /* Topping up the lowest columns can level the floor off; trimming the
       tallest ones reaches the next multiple of four instead. */
    var trim = 4 - need;
    if (isFlat(out, w) && obstacles.length >= trim) {
      var tallest = order.slice().reverse().slice(0, trim);
      var cut = obstacles.filter(function (o) {
        return !(tallest.indexOf(o.col) >= 0 && o.row === h - heights[o.col]);
      });
      if (!isFlat(cut, w)) return cut;
    }
    return out;
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

  /* Campaign — deterministic curve. `ramp` carries the climb to level ~300,
     where boards are properly tricky; `tail` adds a last notch of size and
     terrain from there to level 1000. */
  var CAMPAIGN_LEVELS = 1000;
  var MAX_HEIGHT = 10;
  function campaignParams(level) {
    var idx = Math.max(0, level - 6);
    var ramp = Math.min(1, idx / 300);
    var tail = Math.max(0, (idx - 300) / (CAMPAIGN_LEVELS - 306));
    var wBase = 4 + Math.round(ramp * 3) + Math.round(tail * 1);   /* 4 → 7 → 8 */
    var hBase = 4 + Math.round(ramp * 4) + Math.round(tail * 2);   /* 4 → 8 → 10 */
    var wOff  = [0, 1, 0, -1, 1, 0][level % 6];
    var hOff  = [1, 0, 1, 0, -1, 0, 1][level % 7];
    /* Once the floor is shaped, 4-wide or 4-tall boards leave too few ways to
       fill them, so they start at 5x5. */
    var minSide = level < 9 ? 4 : 5;
    var w = Math.max(minSide, Math.min(8, wBase + wOff));
    var h = Math.max(minSide, Math.min(MAX_HEIGHT, hBase + hOff));
    var terrainMax = level < 9 ? 0 :
      Math.min(Math.floor(h / 2), Math.max(1, Math.round(ramp * 2) + Math.round(tail * 2)));
    var pool = idx < 6  ? POOL_TINY :
               idx < 30 ? POOL_SMALL : POOL_FULL;
    var palette   = Math.min(9, 3 + Math.round(ramp * 3) + Math.round(tail * 2));
    var fallSpeed = 0.35 + ramp * 0.25 + tail * 0.2;   /* 0.35 → 0.6 → 0.8 */
    return { w: w, h: h, terrainMax: terrainMax, pool: pool, palette: palette, fallSpeed: fallSpeed };
  }

  /* Random — five settings the player picks with a slider. */
  var RANDOM_TIERS = [
    { name: 'Easy',       blurb: 'Small boards, friendly shapes and a gentle floor — a quiet warm-up.',
      w: 5, h: 5, terrainMax: 1, pool: POOL_SMALL, palette: 4, fallSpeed: 0.4 },
    { name: 'Normal',     blurb: 'All seven block shapes and a little uneven ground.',
      w: 5, h: 6, terrainMax: 1, pool: POOL_FULL, palette: 5, fallSpeed: 0.5 },
    { name: 'Hard',       blurb: 'A taller board with every shape and some ground to build around.',
      w: 6, h: 8, terrainMax: 1, pool: POOL_FULL, palette: 6, fallSpeed: 0.55 },
    { name: 'Expert',     blurb: 'A wide board over bumpy ground — plan two moves ahead.',
      w: 7, h: 9, terrainMax: 2, pool: POOL_FULL, palette: 7, fallSpeed: 0.65 },
    { name: 'Extra Hard', blurb: 'Eight columns, deep terrain, and a fall that will not wait.',
      w: 8, h: MAX_HEIGHT, terrainMax: 3, pool: POOL_FULL, palette: 8, fallSpeed: 0.75 }
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

  /* Perfect packings a level must allow, so three stars is a puzzle to work
     out rather than one exact sequence to stumble on. */
  var MIN_SOLUTIONS = 7;

  function buildFromParams(params, seed, kind) {
    var palette = COLOURS.slice(0, params.palette);
    /* A one-row floor on a four-wide board cannot be both uneven and a
       multiple of four cells, so narrow boards get a second row to work with. */
    var rise = params.terrainMax > 0 && params.w <= 4
      ? Math.min(Math.floor(params.h / 2), Math.max(2, params.terrainMax))
      : params.terrainMax;
    var best = null, bestCount = 0;
    for (var attempt = 0; attempt < 80; attempt++) {
      var rand = rng(seed + attempt * 17);
      var obstacles = padToFours(makeTerrain(params.w, params.h, rise, rand), params.w, params.h);
      if (rise > 0 && isFlat(obstacles, params.w)) continue;
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
      var count = countSolutions(level, MIN_SOLUTIONS);
      if (count >= MIN_SOLUTIONS) return level;
      if (count > bestCount) { best = level; bestCount = count; }
    }
    /* A rare board where no deal reaches the bar still ships its roomiest. */
    return best;
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
