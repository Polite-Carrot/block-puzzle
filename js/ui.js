/* ui.js — rendering the arena, the queue, and the little animations. All
 * the DOM lives here; the engine never touches it.
 *
 * The board is a CSS grid whose cell size is set by fitBoard() in app.js.
 * The current piece is a lightweight layer floating over that grid whose
 * position updates every frame with the fall — no drop animation, because
 * gravity is doing the animating already. A ghost beneath it shows the
 * row the piece would come to rest at if left alone, so an intentional
 * drop is a decision and not a guess. */
(function (global) {
  'use strict';

  var P = global.Palette;

  function el(tag, cls, parent) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }

  function svg(tag, attrs, parent) {
    var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function ArenaView(mount) {
    this.mount = mount;
    mount.innerHTML = '';
    this.frame = el('div', 'arena__frame', mount);
    /* The SVG that draws the arena's jagged sky-blue interior and its
       ink border — the frame around it is otherwise transparent so the
       shape underneath is genuinely non-rectangular. */
    this.shape = svg('svg', { class: 'arena__shape', preserveAspectRatio: 'none' }, this.frame);
    this.shapePoly = svg('polygon', {
      fill: 'var(--arena-sky)',
      stroke: 'var(--ink)',
      'stroke-width': '3',
      'stroke-linejoin': 'miter',
      'vector-effect': 'non-scaling-stroke'
    }, this.shape);
    this.ceiling = el('div', 'arena__ceiling', this.frame);
    this.grid = el('div', 'arena__grid', this.frame);
    this.ghost = el('div', 'arena__ghost', this.frame);
    this.ghostInner = el('div', 'arena__layer', this.ghost);
    this.piece = el('div', 'arena__piece', this.frame);
    this.pieceInner = el('div', 'arena__layer', this.piece);
    this.wind = el('div', 'arena__wind', this.pieceInner);
    this.width = 0;
    this.height = 0;
    this.cellPx = 0;
    this.sky = 0;
  }

  ArenaView.prototype.layout = function (game, cellPx) {
    this.width = game.width;
    this.height = game.height;
    this.sky = game.sky;
    this.cellPx = cellPx;
    /* Two levels can share a size but not a floor, so callers check this
       before deciding a relayout would be redundant. */
    this.level = game.level;
    var w = game.width * cellPx;
    var h = game.height * cellPx;
    var sky = game.sky * cellPx;
    this.frame.style.width = w + 'px';
    this.frame.style.height = (h + sky) + 'px';
    this.frame.style.setProperty('--cell', cellPx + 'px');
    this.frame.style.setProperty('--sky', sky + 'px');
    this.frame.style.setProperty('--w', game.width);
    this.frame.style.setProperty('--h', game.height);
    this.frame.style.setProperty('--rows', (game.sky + game.height));
    this._reshape(game);
  };

  /* Build the polygon that outlines the arena's actual play area — the
     rectangular sky above and the jagged floor below. The bottom rises
     to meet the top of each column's terrain, so the SVG's fill IS the
     playable region and its stroke IS the arena's frame. */
  ArenaView.prototype._reshape = function (game) {
    var w = game.width;
    var totalRows = game.sky + game.height;
    var rises = new Array(w).fill(0);
    for (var i = 0; i < game.level.obstacles.length; i++) rises[game.level.obstacles[i].col]++;

    var W = w * this.cellPx;
    var H = totalRows * this.cellPx;
    this.shape.setAttribute('viewBox', '0 0 ' + W + ' ' + H);

    var pts = [];
    pts.push('0,0');
    pts.push(W + ',0');
    /* Trace the jagged bottom from right to left — for each column drop
       down to the top of its terrain, then walk left to the next column. */
    for (var c = w - 1; c >= 0; c--) {
      var yTop = (totalRows - rises[c]) * this.cellPx;
      var xRight = (c + 1) * this.cellPx;
      var xLeft = c * this.cellPx;
      pts.push(xRight + ',' + yTop);
      pts.push(xLeft + ',' + yTop);
    }
    this.shapePoly.setAttribute('points', pts.join(' '));
  };

  ArenaView.prototype.renderGrid = function (game) {
    this.grid.innerHTML = '';
    var total = game.sky + game.height;
    for (var r = 0; r < total; r++) {
      for (var c = 0; c < game.width; c++) {
        var cell = game.grid[r][c];
        /* Skip terrain cells — the arena's SVG shape already carves them
           out of the play area, so a grid cell there would draw on top of
           the outline. Also skip empty sky rows to save DOM. */
        if (cell && cell.obstacle) continue;
        var d = el('div', 'cell', this.grid);
        d.style.gridRow = (r + 1);
        d.style.gridColumn = (c + 1);
        if (r < game.sky) d.classList.add('cell--sky');
        else d.classList.add('cell--arena');
        if (cell) this._paintBlock(d, cell.colour);
      }
    }
  };

  ArenaView.prototype._paintBlock = function (node, colour) {
    node.classList.add('cell--block');
    node.style.setProperty('--fill', P.hex(colour));
    node.style.setProperty('--edge', P.edge(colour));
    node.style.setProperty('--ink', P.ink(colour));
    /* The letter mark is only rendered when colour-blind assist is on;
       CSS hides it otherwise. */
    var mark = el('span', 'cell__mark', node);
    mark.textContent = P.mark(colour);
  };

  ArenaView.prototype._clearBlocks = function (container) {
    var old = container.querySelectorAll('.block');
    for (var i = 0; i < old.length; i++) container.removeChild(old[i]);
  };

  ArenaView.prototype._paintPiece = function (container, shape, rot, colour, opts) {
    opts = opts || {};
    /* Only the blocks are replaced. This runs every frame, and clearing the
       whole layer would take the wind with it — restarting its animation on
       each repaint, which leaves the streaks frozen on their first frame. */
    this._clearBlocks(container);
    var geom = global.Shapes.cellsOf(shape, rot);
    container.style.setProperty('--pw', geom.cols);
    container.style.setProperty('--ph', geom.rows);
    for (var i = 0; i < geom.cells.length; i++) {
      var cell = geom.cells[i];
      var d = el('div', 'block' + (opts.ghost ? ' block--ghost' : ''), container);
      d.style.setProperty('--r', cell.r);
      d.style.setProperty('--c', cell.c);
      d.style.setProperty('--fill', P.hex(colour));
      d.style.setProperty('--edge', P.edge(colour));
      d.style.setProperty('--ink', P.ink(colour));
      if (!opts.ghost) {
        var mark = el('span', 'block__mark', d);
        mark.textContent = P.mark(colour);
      }
    }
  };

  ArenaView.prototype._placeLayer = function (outer, inner, row, col) {
    outer.style.transform = 'translateX(' + (col * this.cellPx) + 'px)';
    inner.style.transform = 'translateY(' + (row * this.cellPx) + 'px)';
  };

  /* One streak per column the piece occupies, each sitting on that column's
     highest cell. Built from the shape rather than placed at fixed points,
     so every piece gets wind and none of it lands inside a block. */
  var WIND_LENGTHS = [0.8, 1.0, 0.7, 0.95, 0.85];

  ArenaView.prototype._paintWind = function (geom, key) {
    if (this._windKey === key) return;
    this._windKey = key;
    this.wind.innerHTML = '';
    var tops = [];
    for (var j = 0; j < geom.cols; j++) tops[j] = -1;
    for (var i = 0; i < geom.cells.length; i++) {
      var cell = geom.cells[i];
      if (tops[cell.c] < 0 || cell.r < tops[cell.c]) tops[cell.c] = cell.r;
    }
    for (var c = 0; c < geom.cols; c++) {
      if (tops[c] < 0) continue;
      var streak = el('i', null, this.wind);
      streak.style.setProperty('--c', c);
      streak.style.setProperty('--y', tops[c]);
      streak.style.setProperty('--len', WIND_LENGTHS[c % WIND_LENGTHS.length]);
    }
  };

  /* Paint the current piece at whatever integer + fractional row the engine
     says it has descended to, plus a ghost at the landing row. Called every
     frame while the piece falls, so the piece appears to move continuously
     while the ghost stays pinned to the row it will settle on. */
  ArenaView.prototype.showCurrent = function (game) {
    var pc = game.currentPiece();
    /* Once the level is decided the piece layer should stay empty, otherwise
       the next-piece shape paints into the last piece's slot for a moment
       and it looks like the block gained or lost cells. */
    if (!pc || game.lost || game.won) {
      this.piece.style.opacity = '0';
      this.ghost.style.opacity = '0';
      this._clearBlocks(this.pieceInner);
      this._clearBlocks(this.ghostInner);
      this.wind.innerHTML = '';
      this._windKey = null;
      return;
    }
    this._paintPiece(this.pieceInner, pc.shape, game.currentRot, pc.colour);
    this._paintWind(global.Shapes.cellsOf(pc.shape, game.currentRot),
      pc.shape + ':' + game.currentRot);
    this._paintPiece(this.ghostInner, pc.shape, game.currentRot, pc.colour, { ghost: true });
    var landing = game.landingRow(game.currentRot, game.currentCol);
    this._placeLayer(this.piece, this.pieceInner,
      game.currentRow + (game.subrow || 0), game.currentCol);
    this.piece.style.opacity = '1';
    if (landing === null || landing < game.sky) {
      this.ghost.style.opacity = '0';
    } else {
      this._placeLayer(this.ghost, this.ghostInner, landing, game.currentCol);
      this.ghost.style.opacity = landing === game.currentRow ? '0' : '0.28';
    }
  };

  /* Speed lines while the player is driving the piece down. */
  ArenaView.prototype.setDropping = function (on) {
    this.frame.classList.toggle('is-dropping', !!on);
  };

  ArenaView.prototype.hideCurrent = function () {
    this.piece.style.opacity = '0';
    this.ghost.style.opacity = '0';
  };

  /* Kick the cells of the piece that just locked with a small settle bounce,
     so the impact reads as a physical thud rather than a repaint. */
  ArenaView.prototype.thumpPlacement = function (placement) {
    if (!this.grid.animate) return;
    var geom = global.Shapes.cellsOf(placement.shape, placement.rot);
    var w = this.width;
    var nodes = this.grid.querySelectorAll('.cell');
    for (var j = 0; j < geom.cells.length; j++) {
      var r = placement.top + geom.cells[j].r;
      var c = placement.col + geom.cells[j].c;
      if (r < 0 || c < 0 || c >= w) continue;
      var idx = r * w + c;
      var node = nodes[idx];
      if (!node) continue;
      node.animate([
        { transform: 'scale(1)' },
        { transform: 'scale(1.10)', offset: .35 },
        { transform: 'scale(1)' }
      ], { duration: 220, easing: 'cubic-bezier(.2,.9,.3,1.35)' });
    }
  };

  function QueueView(mount) {
    this.mount = mount;
    mount.innerHTML = '';
  }

  QueueView.prototype.render = function (level, currentIdx) {
    this.mount.innerHTML = '';
    var shown = 0;
    for (var i = currentIdx; i < level.pieces.length && shown < 7; i++, shown++) {
      var pc = level.pieces[i];
      var slot = el('div', 'queue__slot' + (i === currentIdx ? ' is-now' : ''), this.mount);
      if (i === currentIdx) el('span', 'queue__cue', slot).textContent = 'NEXT';
      var thumb = el('div', 'queue__thumb', slot);
      this._paintThumb(thumb, pc.shape, 0, pc.colour);
    }
  };

  QueueView.prototype._paintThumb = function (container, shape, rot, colour) {
    container.innerHTML = '';
    var geom = global.Shapes.cellsOf(shape, rot);
    /* --ox and --oy centre the piece horizontally and pin it to the bottom
       of the fixed 4×4 box, so the queue never jumps when the next piece
       has a different height or width. */
    var slot = 4;
    container.style.setProperty('--pw', geom.cols);
    container.style.setProperty('--ph', geom.rows);
    container.style.setProperty('--ox', (slot - geom.cols) / 2);
    container.style.setProperty('--oy', slot - geom.rows);
    for (var i = 0; i < geom.cells.length; i++) {
      var cell = geom.cells[i];
      var d = el('div', 'block block--thumb', container);
      d.style.setProperty('--r', cell.r);
      d.style.setProperty('--c', cell.c);
      d.style.setProperty('--fill', P.hex(colour));
      d.style.setProperty('--edge', P.edge(colour));
    }
  };

  /* Confetti for a win — cheap falling squares in the level's colours. */
  function Confetti(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pieces = [];
    this.running = false;
  }

  Confetti.prototype.fire = function (colours) {
    var canvas = this.canvas;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.display = 'block';
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    var w = canvas.offsetWidth, h = canvas.offsetHeight;
    this.pieces = [];
    for (var i = 0; i < 100; i++) {
      var col = colours[Math.floor(Math.random() * colours.length)];
      this.pieces.push({
        x: Math.random() * w,
        y: -20 - Math.random() * 200,
        vx: (Math.random() - 0.5) * 3,
        vy: 2 + Math.random() * 4,
        r: 5 + Math.random() * 6,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.4,
        colour: P.hex(col)
      });
    }
    if (!this.running) {
      this.running = true;
      this._tick(dpr, w, h);
    }
  };

  Confetti.prototype._tick = function (dpr, w, h) {
    var self = this, ctx = this.ctx;
    function frame() {
      ctx.clearRect(0, 0, self.canvas.width, self.canvas.height);
      var live = 0;
      for (var i = 0; i < self.pieces.length; i++) {
        var p = self.pieces[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.08;
        p.rot += p.vr;
        if (p.y > h + 20) continue;
        live++;
        ctx.save();
        ctx.translate(p.x * dpr, p.y * dpr);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.colour;
        ctx.fillRect(-p.r * dpr, -p.r * dpr, p.r * 2 * dpr, p.r * 2 * dpr);
        ctx.restore();
      }
      if (live > 0) requestAnimationFrame(frame);
      else {
        self.running = false;
        self.canvas.style.display = 'none';
      }
    }
    requestAnimationFrame(frame);
  };

  /* Blips — same idea as the sibling projects: open the audio device on
     demand, let it idle a second after the last sound, then give it back so
     nothing hums between plays. */
  var IDLE_MS = 1500;

  var Sound = {
    on: true,
    ctx: null,
    broken: false,
    idle: null,
    ensure: function () {
      if (!this.on || this.broken) return null;
      try {
        if (!this.ctx && global.AudioContext) this.ctx = new global.AudioContext();
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      } catch (e) {
        this.broken = true;
        this.ctx = null;
      }
      return this.ctx;
    },
    rest: function () {
      var self = this;
      if (this.idle) clearTimeout(this.idle);
      this.idle = setTimeout(function () {
        self.idle = null;
        self.hush();
      }, IDLE_MS);
    },
    hush: function () {
      if (this.idle) { clearTimeout(this.idle); this.idle = null; }
      try {
        if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
      } catch (e) { /* nothing to give back */ }
    },
    blip: function (freq, dur, type, gain) {
      if (!this.on) return;
      var ctx = this.ensure();
      if (!ctx) return;
      try { this._blip(ctx, freq, dur, type || 'sine', gain || 0.08); }
      catch (e) { this.broken = true; }
      this.rest();
    },
    _blip: function (ctx, freq, dur, type, gain) {
      var osc = ctx.createOscillator();
      var amp = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      amp.gain.setValueAtTime(0.0001, ctx.currentTime);
      amp.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + 0.01);
      amp.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      osc.connect(amp).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + dur + 0.02);
    },
    move:   function () { this.blip(560, 0.04, 'square', 0.04); },
    rotate: function () { this.blip(760, 0.08, 'sine', 0.06); },
    lock:   function () { this.blip(220, 0.10, 'triangle', 0.10); },
    win:    function () {
      var self = this;
      this.blip(520, 0.10, 'sine', 0.09);
      setTimeout(function () { self.blip(740, 0.14, 'sine', 0.09); }, 110);
      setTimeout(function () { self.blip(920, 0.20, 'sine', 0.09); }, 240);
    },
    lose:   function () { this.blip(140, 0.24, 'sawtooth', 0.10); },
    undo:   function () { this.blip(300, 0.07, 'sine', 0.06); }
  };

  global.UI = {
    ArenaView: ArenaView,
    QueueView: QueueView,
    Confetti: Confetti,
    Sound: Sound,
    el: el
  };
})(typeof window !== 'undefined' ? window : globalThis);
