/* engine.js — arena state and the current piece falling under gravity.
 * Pure logic, no DOM.
 *
 * The board is a grid of `sky + height` rows by `width` columns. Rows
 * sky..sky+height-1 are the arena play area; rows 0..sky-1 are the strip
 * above the ceiling the piece falls through. A piece that comes to rest
 * with any cell above the ceiling has poked through — the level cannot be
 * finished from that position, and the player must undo.
 *
 * Play is Tetris-like: the current piece is always at some (row, col, rot)
 * and always falling. Every tick advances it down; the player can shift
 * left or right, rotate, or soft-drop into an overhang. The piece locks
 * the moment it can no longer fall by one row; there is no "place" button
 * apart from the hard drop, which just snaps it to its landing row and
 * locks. Everything else — win, lose, undo — reads off this one grid. */
(function (global) {
  'use strict';

  var Shapes = global.Shapes;

  /* Enough sky above the arena for the tallest piece to enter without
     clipping the top, plus a couple of extra rows so the player has real
     time to move and rotate before the piece reaches the pile. */
  var SKY = 6;

  function Game(level) {
    this.level = level;
    this.width = level.width;
    this.height = level.height;
    this.sky = SKY;
    /* Speed comes from the level so the first few boards run slower than the
       hundredth. Falls back to a gentle default for hand-crafted levels
       that forgot to set one. */
    this.fallSpeed = level.fallSpeed || 0.6;
    this.restart();
  }

  Game.prototype.restart = function () {
    var total = this.sky + this.height;
    this.grid = [];
    for (var r = 0; r < total; r++) {
      var row = new Array(this.width);
      for (var c = 0; c < this.width; c++) row[c] = null;
      this.grid.push(row);
    }
    var obs = this.level.obstacles || [];
    for (var i = 0; i < obs.length; i++) {
      var o = obs[i];
      this.grid[this.sky + o.row][o.col] = { obstacle: true };
    }
    this.currentIdx = 0;
    this.placed = [];
    this.won = false;
    this.lost = false;
    this.undosUsed = 0;
    /* subrow is the fractional row the current piece has descended past its
       integer row — display-only, so movement snaps to whole grid cells and
       the pile stays aligned. */
    this.subrow = 0;
    this._spawnCurrent();
  };

  Game.prototype.currentPiece = function () {
    if (this.currentIdx >= this.level.pieces.length) return null;
    return this.level.pieces[this.currentIdx];
  };

  Game.prototype.remaining = function () {
    return Math.max(0, this.level.pieces.length - this.currentIdx);
  };

  Game.prototype._spawnCurrent = function () {
    var pc = this.currentPiece();
    if (!pc) { this.currentRow = 0; this.currentCol = 0; this.currentRot = 0; return; }
    /* Pick the first rotation that fits the arena's width — otherwise a
       narrow board would spawn the piece already off the right edge. */
    var rot = 0;
    for (var i = 0; i < 4; i++) {
      var g = Shapes.cellsOf(pc.shape, i);
      if (g.cols <= this.width) { rot = i; break; }
    }
    this.currentRot = rot;
    var geom = Shapes.cellsOf(pc.shape, this.currentRot);
    var mid = Math.floor((this.width - geom.cols) / 2);
    this.currentCol = clamp(mid, 0, this.width - geom.cols);
    this.currentRow = 0;
    this.subrow = 0;
  };

  /* Would the current piece with rotation `rot` at (row, col) collide with
     the grid or the walls? Cells above the grid top are always fine — a
     piece entering from above is expected to have some cells at negative
     rows. */
  Game.prototype._collides = function (rot, col, row) {
    var pc = this.currentPiece();
    if (!pc) return false;
    var geom = Shapes.cellsOf(pc.shape, rot);
    var total = this.grid.length;
    for (var i = 0; i < geom.cells.length; i++) {
      var r = row + geom.cells[i].r;
      var c = col + geom.cells[i].c;
      if (c < 0 || c >= this.width) return true;
      if (r >= total) return true;
      if (r < 0) continue;
      if (this.grid[r][c]) return true;
    }
    return false;
  };

  /* Nudge the piece one column left or right, if the new position is legal.
     Called by keyboard, drag and swipe — anything that wants to slide the
     piece into a sideways gap while it is still falling. */
  Game.prototype.tryMove = function (dir) {
    if (this.won || this.lost) return false;
    if (!this.currentPiece()) return false;
    var newCol = this.currentCol + dir;
    if (this._collides(this.currentRot, newCol, this.currentRow)) return false;
    this.currentCol = newCol;
    return true;
  };

  /* Snap the piece straight to column `col`, moving one step at a time so
     the walls and any pile in between still stop it. Useful for a tap on a
     column: the piece slides across, but only as far as the row it is on
     will let it. */
  Game.prototype.tryMoveTo = function (col) {
    if (this.won || this.lost) return false;
    if (!this.currentPiece()) return false;
    var dir = col > this.currentCol ? 1 : -1;
    var moved = false;
    while (this.currentCol !== col) {
      if (!this.tryMove(dir)) break;
      moved = true;
    }
    return moved;
  };

  /* Rotate clockwise. Standard Tetris wall-kicks: if the next rotation
     collides, try shifting it one and two cells left or right so a piece up
     against a wall can still turn. */
  Game.prototype.tryRotate = function () {
    if (this.won || this.lost) return false;
    var pc = this.currentPiece();
    if (!pc) return false;
    var next = (this.currentRot + 1) % 4;
    var geom = Shapes.cellsOf(pc.shape, next);
    if (geom.cols > this.width) return false;
    var kicks = [0, -1, 1, -2, 2];
    for (var i = 0; i < kicks.length; i++) {
      var col = this.currentCol + kicks[i];
      if (col < 0 || col + geom.cols > this.width) continue;
      if (!this._collides(next, col, this.currentRow)) {
        this.currentRot = next;
        this.currentCol = col;
        return true;
      }
    }
    return false;
  };

  /* Try to move the piece down by one row. Returns true if it moved, false
     if it is now resting on the pile — the caller then knows to lock it. */
  Game.prototype.tryFall = function () {
    if (this.won || this.lost) return false;
    if (!this.currentPiece()) return false;
    if (this._collides(this.currentRot, this.currentCol, this.currentRow + 1)) return false;
    this.currentRow++;
    this.subrow = 0;
    return true;
  };

  /* Where the piece would land if left alone — for the ghost and the hard
     drop shortcut. Walks the piece down until it collides. */
  Game.prototype.landingRow = function (rot, col) {
    var pc = this.currentPiece();
    if (!pc) return null;
    var geom = Shapes.cellsOf(pc.shape, rot);
    var total = this.sky + this.height;
    if (col < 0 || col + geom.cols > this.width) return null;
    /* Start from the current piece's row (or above) and step down. */
    var start = Math.min(this.currentRow, 0);
    var last = null;
    for (var r = start; r <= total - geom.rows; r++) {
      var ok = true;
      for (var i = 0; i < geom.cells.length; i++) {
        var rr = r + geom.cells[i].r;
        var cc = col + geom.cells[i].c;
        if (cc < 0 || cc >= this.width) { ok = false; break; }
        if (rr >= total) { ok = false; break; }
        if (rr < 0) continue;
        if (this.grid[rr][cc]) { ok = false; break; }
      }
      if (ok) last = r; else if (last !== null) break;
    }
    return last;
  };

  /* Commit the current piece to the grid at its current (row, rot, col).
     Advances the queue, marks win or loss, spawns the next piece. */
  Game.prototype.lock = function () {
    var pc = this.currentPiece();
    if (!pc) return null;
    var geom = Shapes.cellsOf(pc.shape, this.currentRot);
    var placementIndex = this.placed.length;
    for (var i = 0; i < geom.cells.length; i++) {
      var r = this.currentRow + geom.cells[i].r;
      var c = this.currentCol + geom.cells[i].c;
      if (r < 0) continue;
      this.grid[r][c] = { placementIndex: placementIndex, colour: pc.colour };
    }
    var placement = {
      idx: this.currentIdx,
      shape: pc.shape,
      colour: pc.colour,
      rot: this.currentRot,
      col: this.currentCol,
      top: this.currentRow,
      overflow: this.currentRow < this.sky
    };
    this.placed.push(placement);
    this.currentIdx++;
    if (placement.overflow) this.lost = true;
    else if (this.currentIdx >= this.level.pieces.length) this.won = true;
    else this._spawnCurrent();
    return placement;
  };

  /* Jump the piece to its landing row and lock. The keyboard's space bar
     and the on-screen Drop button use this. */
  Game.prototype.hardDrop = function () {
    if (this.won || this.lost) return null;
    if (!this.currentPiece()) return null;
    var landing = this.landingRow(this.currentRot, this.currentCol);
    if (landing === null) return null;
    this.currentRow = landing;
    this.subrow = 0;
    return this.lock();
  };

  Game.prototype.canUndo = function () { return this.placed.length > 0; };

  /* Peel the last placement back off the grid and reset the piece to a
     fresh spawn at the top. Progress lost, but no state left over. */
  Game.prototype.undo = function () {
    if (!this.placed.length) return null;
    var last = this.placed.pop();
    var geom = Shapes.cellsOf(last.shape, last.rot);
    for (var i = 0; i < geom.cells.length; i++) {
      var r = last.top + geom.cells[i].r;
      var c = last.col + geom.cells[i].c;
      if (r < 0 || r >= this.grid.length) continue;
      var cell = this.grid[r][c];
      if (cell && cell.placementIndex === this.placed.length) {
        this.grid[r][c] = null;
      }
    }
    this.currentIdx = last.idx;
    this.won = false;
    this.lost = false;
    this.undosUsed++;
    this._spawnCurrent();
    return last;
  };

  function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }

  global.Engine = {
    SKY: SKY,
    Game: Game
  };
})(typeof window !== 'undefined' ? window : globalThis);
