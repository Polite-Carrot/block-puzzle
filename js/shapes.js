/* shapes.js — the piece catalogue and rotation helpers.
 *
 * A shape is a matrix of 0s and 1s, rows top-first. Every shape is stored in
 * its "canonical" pose; rotate() derives the others on demand. Rotations are
 * counted 0..3 clockwise, and shapes are trimmed to their bounding box so a
 * piece's top-left cell is always at (0, 0).
 *
 * Ids exist so a level can name a shape rather than embedding a matrix. That
 * keeps levels.js short, keeps every piece the same object across the game
 * (so rotation caching pays off), and means any change to a shape is picked
 * up everywhere at once. */
(function (global) {
  'use strict';

  var CATALOGUE = {
    /* mono, domino, triominoes — the small change */
    mono:  [[1]],
    dom:   [[1, 1]],
    tri_i: [[1, 1, 1]],
    tri_l: [[1, 0],
            [1, 1]],

    /* tetrominoes — the seven Tetris pieces */
    tet_i: [[1, 1, 1, 1]],
    tet_o: [[1, 1],
            [1, 1]],
    tet_t: [[1, 1, 1],
            [0, 1, 0]],
    tet_l: [[1, 0],
            [1, 0],
            [1, 1]],
    tet_j: [[0, 1],
            [0, 1],
            [1, 1]],
    tet_s: [[0, 1, 1],
            [1, 1, 0]],
    tet_z: [[1, 1, 0],
            [0, 1, 1]],

    /* pentominoes — a wider vocabulary for the later levels */
    pen_p: [[1, 1],
            [1, 1],
            [1, 0]],
    pen_l: [[1, 0],
            [1, 0],
            [1, 0],
            [1, 1]],
    pen_y: [[0, 1],
            [1, 1],
            [0, 1],
            [0, 1]],
    pen_t: [[1, 1, 1],
            [0, 1, 0],
            [0, 1, 0]],
    pen_u: [[1, 0, 1],
            [1, 1, 1]],
    pen_w: [[1, 0, 0],
            [1, 1, 0],
            [0, 1, 1]],
    pen_z: [[1, 1, 0],
            [0, 1, 0],
            [0, 1, 1]],
    pen_v: [[1, 0, 0],
            [1, 0, 0],
            [1, 1, 1]]
  };

  var IDS = Object.keys(CATALOGUE);

  /* Rotate a matrix clockwise 90°: new[r][c] = old[rows - 1 - c][r]. Then
     trim to the bounding box of 1s, so the top-left of the result sits at
     (0, 0). Every shape here has at least one 1, so the trim is safe. */
  function rotate90(m) {
    var rows = m.length, cols = m[0].length;
    var out = [];
    for (var r = 0; r < cols; r++) {
      var row = [];
      for (var c = 0; c < rows; c++) row.push(m[rows - 1 - c][r]);
      out.push(row);
    }
    return trim(out);
  }

  function trim(m) {
    var top = m.length, bot = -1, left = m[0].length, right = -1;
    for (var r = 0; r < m.length; r++) {
      for (var c = 0; c < m[r].length; c++) {
        if (m[r][c]) {
          if (r < top) top = r;
          if (r > bot) bot = r;
          if (c < left) left = c;
          if (c > right) right = c;
        }
      }
    }
    if (bot < 0) return m;
    var out = [];
    for (var rr = top; rr <= bot; rr++) {
      var row = [];
      for (var cc = left; cc <= right; cc++) row.push(m[rr][cc]);
      out.push(row);
    }
    return out;
  }

  /* Rotations cached per (id, rot) so replaying a level does not recompute
     the same matrices thousands of times. */
  var cache = {};

  function shapeOf(id) {
    var m = CATALOGUE[id];
    if (!m) throw new Error('unknown shape ' + id);
    return m;
  }

  function rotate(id, rot) {
    rot = ((rot % 4) + 4) % 4;
    var key = id + '/' + rot;
    if (cache[key]) return cache[key];
    var m = shapeOf(id);
    for (var i = 0; i < rot; i++) m = rotate90(m);
    return cache[key] = m;
  }

  /* Cells of a rotated piece as [r, c] pairs, and the bounding box, so
     drawing and gravity checks share one description of the piece. */
  function cellsOf(id, rot) {
    var m = rotate(id, rot);
    var out = [];
    for (var r = 0; r < m.length; r++) {
      for (var c = 0; c < m[r].length; c++) if (m[r][c]) out.push({ r: r, c: c });
    }
    return { cells: out, rows: m.length, cols: m[0].length };
  }

  /* How many distinct rotations a shape has — 1, 2 or 4. Square O and mono
     are one, the bar and S/Z are two, the rest are four. Used by the level
     generator so it does not deal a rotation that looks identical to another. */
  function distinctRotations(id) {
    var seen = {};
    var count = 0;
    for (var r = 0; r < 4; r++) {
      var m = rotate(id, r);
      var key = m.map(function (row) { return row.join(''); }).join('|');
      if (!seen[key]) { seen[key] = true; count++; }
    }
    return count;
  }

  /* Size (number of filled cells). Constant across rotations. */
  function size(id) {
    var m = shapeOf(id);
    var n = 0;
    for (var r = 0; r < m.length; r++)
      for (var c = 0; c < m[r].length; c++) if (m[r][c]) n++;
    return n;
  }

  global.Shapes = {
    CATALOGUE: CATALOGUE,
    IDS: IDS,
    shapeOf: shapeOf,
    rotate: rotate,
    cellsOf: cellsOf,
    distinctRotations: distinctRotations,
    size: size
  };
})(typeof window !== 'undefined' ? window : globalThis);
