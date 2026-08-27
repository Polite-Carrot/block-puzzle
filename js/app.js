/* app.js — screens, progress and every kind of input the player has.
 *
 * The game has four screens — home, levels, game — and modals for win, fail
 * and help. While a level is on screen a requestAnimationFrame loop drops
 * the current piece at the level's own speed. Input:
 *
 *   Tap / space     — rotate
 *   Swipe left/right / arrow keys — shift one column
 *   Swipe down / down arrow       — speed the fall (soft drop) while held
 *   Undo / Restart                — the two toolbar buttons
 *
 * There is no hard drop; the piece is always falling. */
(function () {
  'use strict';

  var Palette = window.Palette;
  var Engine = window.Engine;
  var Shapes = window.Shapes;
  var UI = window.UI;
  var LEVELS = window.LEVELS;
  var Sound = UI.Sound;

  var STORE_KEY = 'blockpuzzle.progress.v1';
  var PREFS_KEY = 'blockpuzzle.prefs.v1';

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    game: null,
    levelIndex: 0,
    prefs: { sound: true, cbAssist: false },
    progress: {},
    rafHandle: null,
    lastTime: 0,
    softDrop: false
  };

  /* Soft-drop rate — twenty rows a second is fast enough to feel like "get on
     with it" and slow enough that a mistake is still catchable. */
  var SOFT_DROP_SPEED = 20;

  /* ── prefs and progress ─────────────────────────────────────────────── */

  function loadPrefs() {
    try {
      var raw = window.Store.read(PREFS_KEY);
      if (raw) state.prefs = Object.assign(state.prefs, JSON.parse(raw));
    } catch (e) { /* keep defaults */ }
    Sound.on = !!state.prefs.sound;
    document.body.classList.toggle('cb-assist', !!state.prefs.cbAssist);
  }
  function savePrefs() { window.Store.write(PREFS_KEY, JSON.stringify(state.prefs)); }

  function loadProgress() {
    try {
      var raw = window.Store.read(STORE_KEY);
      state.progress = raw ? JSON.parse(raw) : {};
    } catch (e) { state.progress = {}; }
    if (!state.progress.completed) state.progress.completed = {};
    if (!state.progress.stars) state.progress.stars = {};
  }
  function saveProgress() { window.Store.write(STORE_KEY, JSON.stringify(state.progress)); }

  function highestUnlocked() {
    var last = 0;
    for (var i = 1; i <= LEVELS.length; i++) {
      if (state.progress.completed[i]) last = i;
      else break;
    }
    return Math.min(LEVELS.length - 1, last) + 1;
  }

  /* ── screens ────────────────────────────────────────────────────────── */

  function showScreen(id) {
    var screens = document.querySelectorAll('.screen');
    for (var i = 0; i < screens.length; i++) screens[i].classList.remove('is-active');
    $(id).classList.add('is-active');
    document.body.classList.toggle('playing', id === 'screen-game');
  }

  function renderHome() {
    var done = 0, total = LEVELS.length;
    for (var k in state.progress.completed) if (state.progress.completed[k]) done++;
    $('home-progress').textContent = done + ' / ' + total;
    $('home-fill').style.height = (100 * done / total) + '%';

    var warn = $('save-warning');
    if (window.Store.kind === 'kept') {
      warn.hidden = true;
    } else if (window.Store.kind === 'this-visit') {
      warn.hidden = false;
      warn.textContent = 'Progress will not survive closing this tab.';
    } else {
      warn.hidden = false;
      warn.textContent = 'The browser is not saving anything — progress will vanish.';
    }
  }

  function renderLevelGrid() {
    var grid = $('level-grid');
    grid.innerHTML = '';
    var unlocked = highestUnlocked();
    for (var i = 0; i < LEVELS.length; i++) {
      var idx = i + 1;
      var level = LEVELS[i];
      var li = UI.el('li', 'level-item', grid);
      var btn = UI.el('button', 'tile', li);
      btn.type = 'button';
      var stars = state.progress.stars[idx] || 0;
      var isDone = !!state.progress.completed[idx];
      var isLocked = idx > unlocked;
      btn.className = 'tile' +
        (isDone ? ' tile--done' : '') +
        (isLocked ? ' tile--locked' : '');
      var num = UI.el('span', 'tile__num', btn);
      num.textContent = idx;
      var name = UI.el('span', 'tile__name', btn);
      name.textContent = level.name || ('Level ' + idx);
      if (isLocked) {
        UI.el('span', 'tile__lock', btn).textContent = '🔒';
      } else {
        var starsN = UI.el('span', 'tile__stars', btn);
        starsN.textContent = '★★★'.slice(0, stars) + '☆☆☆'.slice(0, 3 - stars);
      }
      btn.disabled = isLocked;
      btn.addEventListener('click', function (n) {
        return function () { startLevel(n); };
      }(idx));
    }
  }

  /* ── running a level ────────────────────────────────────────────────── */

  var arena, queue, confetti;

  function startLevel(idx) {
    stopFallLoop();
    $('overlay').hidden = true;
    $('fail-overlay').hidden = true;
    state.levelIndex = idx;
    var level = LEVELS[idx - 1];
    state.game = new Engine.Game(level);
    $('level-name').textContent = level.name || ('Level ' + idx);
    $('level-sub').textContent = 'Level ' + idx + ' of ' + LEVELS.length;
    $('brief').textContent = level.brief || '';
    $('brief').style.display = level.brief ? '' : 'none';
    if (!arena) arena = new UI.ArenaView($('arena'));
    if (!queue) queue = new UI.QueueView($('queue'));
    if (!confetti) confetti = new UI.Confetti($('confetti'));
    showScreen('screen-game');
    /* Wait a frame so the flex layout settles before measuring the board. */
    requestAnimationFrame(function () {
      fitBoard();
      redraw();
      startFallLoop();
    });
  }

  /* Cell size that fits the arena inside the .board container. Reserves
     14px for the frame's border chrome and drop shadow, and can shrink cells
     all the way to 10px on tiny viewports so the pile at the bottom of a
     tall arena is never clipped by the queue below. */
  function fitBoard() {
    if (!state.game || !arena) return;
    var g = state.game;
    var boardEl = document.querySelector('.board');
    var boardW = boardEl.clientWidth - 4;
    var boardH = boardEl.clientHeight - 14;
    if (boardW <= 0 || boardH <= 0) return;
    var byW = Math.floor(boardW / g.width);
    var byH = Math.floor(boardH / (g.height + g.sky));
    var cell = Math.max(10, Math.min(56, Math.min(byH, byW)));
    arena.layout(g, cell);
  }

  window.addEventListener('resize', function () {
    if (state.game) { fitBoard(); redraw(); }
  });

  function redraw() {
    if (!state.game) return;
    arena.renderGrid(state.game);
    arena.showCurrent(state.game);
    queue.render(state.game.level, state.game.currentIdx);
    $('stat-placed').textContent = state.game.placed.length;
    $('stat-total').textContent = state.game.level.pieces.length;
    $('undo').disabled = !state.game.canUndo() || state.game.won;
    updateStatus();
  }

  function updateStatus() {
    var s = $('status');
    if (!state.game) { s.textContent = ''; return; }
    if (state.game.won) { s.textContent = 'Cleared.'; return; }
    if (state.game.lost) { s.textContent = ''; return; }
    s.textContent = state.game.remaining() === 1
      ? 'Last piece.'
      : state.game.remaining() + ' pieces to go.';
  }

  /* ── the fall loop ──────────────────────────────────────────────────── */

  function startFallLoop() {
    stopFallLoop();
    state.lastTime = performance.now();
    state.rafHandle = requestAnimationFrame(tickFall);
  }

  function stopFallLoop() {
    if (state.rafHandle) {
      cancelAnimationFrame(state.rafHandle);
      state.rafHandle = null;
    }
  }

  function tickFall(now) {
    state.rafHandle = null;
    var game = state.game;
    if (!game || game.won || game.lost || !game.currentPiece()) {
      redraw();
      return;
    }
    /* A modal in front of the arena — settings, how-to, fail — freezes the
       fall so opening it does not silently overflow the current piece. */
    if (document.querySelector('.overlay:not([hidden])')) {
      state.lastTime = now;
      state.rafHandle = requestAnimationFrame(tickFall);
      return;
    }
    var dt = Math.min(0.1, (now - state.lastTime) / 1000);
    state.lastTime = now;
    var speed = state.softDrop ? SOFT_DROP_SPEED : game.fallSpeed;
    var landing = game.landingRow(game.currentRot, game.currentCol);

    /* At landing already? Lock straight away — no sub-row accumulation, no
       visual overshoot into the row below. */
    if (landing === null || game.currentRow >= landing) {
      return lockNow();
    }

    game.subrow += dt * speed;
    while (game.subrow >= 1 && game.currentRow < landing) {
      game.subrow -= 1;
      game.tryFall();
      /* Landing can change with each row descended if the pile beneath
         differs by column, so refresh before deciding to lock. */
      landing = game.landingRow(game.currentRot, game.currentCol);
      if (landing === null || game.currentRow >= landing) {
        return lockNow();
      }
    }

    /* Never render past the landing row — otherwise the piece appears to
       poke into the cell below before it locks. */
    var maxSubrow = landing - game.currentRow;
    if (game.subrow > maxSubrow) game.subrow = maxSubrow;

    arena.showCurrent(game);
    state.rafHandle = requestAnimationFrame(tickFall);
  }

  function lockNow() {
    var game = state.game;
    if (!game) return;
    game.subrow = 0;
    var placement = game.lock();
    onLocked(placement);
    redraw();
    if (!game.won && !game.lost && game.currentPiece()) {
      state.rafHandle = requestAnimationFrame(tickFall);
    }
  }

  function onLocked(placement) {
    if (!placement) return;
    if (placement.overflow) {
      Sound.lose();
      onLost();
      return;
    }
    Sound.lock();
    if (arena) arena.thumpPlacement(placement);
    if (state.game.won) onWin();
  }

  /* ── input ──────────────────────────────────────────────────────────── */

  function move(dir) {
    var game = state.game;
    if (!game || game.won || game.lost) return;
    if (game.tryMove(dir)) { Sound.move(); redraw(); }
  }
  function rotate() {
    var game = state.game;
    if (!game || game.won || game.lost) return;
    if (game.tryRotate()) { Sound.rotate(); redraw(); }
  }
  function undo() {
    var game = state.game;
    if (!game || !game.canUndo() || game.won) return;
    game.undo();
    Sound.undo();
    $('fail-overlay').hidden = true;
    redraw();
    state.lastTime = performance.now();
    startFallLoop();
  }
  function restart() {
    var game = state.game;
    if (!game) return;
    $('fail-overlay').hidden = true;
    game.restart();
    redraw();
    state.lastTime = performance.now();
    startFallLoop();
  }

  function onKey(ev) {
    if (!state.game) return;
    if (document.querySelector('.overlay:not([hidden])')) return;
    switch (ev.key) {
      case 'ArrowLeft':  move(-1); ev.preventDefault(); break;
      case 'ArrowRight': move(1);  ev.preventDefault(); break;
      case 'ArrowUp':
      case ' ':
      case 'r':
      case 'R': rotate(); ev.preventDefault(); break;
      case 'ArrowDown': state.softDrop = true; ev.preventDefault(); break;
      case 'u':
      case 'U': undo(); break;
      case 'Escape': backToMenu(); break;
    }
  }
  function onKeyUp(ev) {
    if (ev.key === 'ArrowDown') state.softDrop = false;
  }

  /* Pointer on the arena. One gesture only, tracked by press:
     - a tap (no meaningful drag) rotates
     - a horizontal drag shifts the piece one column per cell of movement
     - a vertical drag past a threshold acts as soft drop while held. */
  var press = null;
  var TAP_MOVE_TOLERANCE = 6;
  var TAP_TIME_MS = 300;

  function onPointerDown(ev) {
    if (!state.game || state.game.won || state.game.lost) return;
    if (document.querySelector('.overlay:not([hidden])')) return;
    ev.preventDefault();
    arena.frame.setPointerCapture(ev.pointerId);
    press = {
      startX: ev.clientX,
      startY: ev.clientY,
      stepsMoved: 0,
      softDrop: false,
      startTime: performance.now(),
      tapCandidate: true
    };
  }

  function onPointerMove(ev) {
    if (!press) return;
    var game = state.game;
    if (!game || game.won || game.lost) return;
    var dx = ev.clientX - press.startX;
    var dy = ev.clientY - press.startY;
    var cell = arena.cellPx || 30;
    if (Math.abs(dx) > TAP_MOVE_TOLERANCE || Math.abs(dy) > TAP_MOVE_TOLERANCE) {
      press.tapCandidate = false;
    }
    /* Round to nearest cell of drag distance. Each full cell of horizontal
       drag is one step; a swipe of 30-40 pixels is naturally one column. */
    var targetSteps = Math.round(dx / cell);
    while (press.stepsMoved < targetSteps) {
      if (!game.tryMove(1)) break;
      press.stepsMoved++;
      Sound.move();
    }
    while (press.stepsMoved > targetSteps) {
      if (!game.tryMove(-1)) break;
      press.stepsMoved--;
      Sound.move();
    }
    var wantSoft = dy > cell * 0.4;
    if (wantSoft !== press.softDrop) {
      press.softDrop = wantSoft;
      state.softDrop = wantSoft;
    }
    redraw();
  }

  function onPointerUp() {
    if (!press) return;
    var elapsed = performance.now() - press.startTime;
    if (press.tapCandidate && elapsed < TAP_TIME_MS) rotate();
    state.softDrop = false;
    press = null;
  }
  function onPointerCancel() {
    if (!press) return;
    state.softDrop = false;
    press = null;
  }

  /* ── win, lose, menu ────────────────────────────────────────────────── */

  function starsFor(game) {
    var u = game.undosUsed || 0;
    if (u === 0) return 3;
    if (u <= 3) return 2;
    return 1;
  }

  function onWin() {
    stopFallLoop();
    Sound.win();
    var idx = state.levelIndex;
    var stars = starsFor(state.game);
    state.progress.completed[idx] = true;
    state.progress.stars[idx] = Math.max(state.progress.stars[idx] || 0, stars);
    saveProgress();
    var used = state.game.level.pieces
      .map(function (p) { return p.colour; })
      .filter(function (v, i, a) { return a.indexOf(v) === i; });
    confetti.fire(used);
    setTimeout(function () { showWin(stars); }, 380);
  }

  function showWin(stars) {
    $('win-stars').textContent = '★★★'.slice(0, stars) + '☆☆☆'.slice(0, 3 - stars);
    $('win-title').textContent = state.levelIndex === LEVELS.length ? 'Every level cleared' : 'Cleared';
    var next = LEVELS[state.levelIndex] ? 'Next' : 'Menu';
    $('win-next').textContent = next;
    $('overlay').hidden = false;
  }

  function onLost() {
    stopFallLoop();
    /* Small delay so the settle animation reads before the modal drops in. */
    setTimeout(function () { $('fail-overlay').hidden = false; }, 260);
  }

  function backToMenu() {
    $('overlay').hidden = true;
    $('fail-overlay').hidden = true;
    stopFallLoop();
    state.game = null;
    renderHome();
    renderLevelGrid();
    showScreen('screen-home');
  }

  function goLevels() {
    $('overlay').hidden = true;
    $('fail-overlay').hidden = true;
    stopFallLoop();
    state.game = null;
    renderLevelGrid();
    showScreen('screen-levels');
  }

  function goNext() {
    var next = state.levelIndex + 1;
    $('overlay').hidden = true;
    if (next > LEVELS.length) { backToMenu(); return; }
    startLevel(next);
  }

  /* ── boot ───────────────────────────────────────────────────────────── */

  function wire() {
    $('play').addEventListener('click', function () {
      renderLevelGrid(); showScreen('screen-levels');
    });
    $('levels-back').addEventListener('click', function () {
      renderHome(); showScreen('screen-home');
    });
    $('back').addEventListener('click', goLevels);
    $('undo').addEventListener('click', undo);
    $('restart').addEventListener('click', restart);
    $('win-next').addEventListener('click', goNext);
    $('win-retry').addEventListener('click', function () {
      $('overlay').hidden = true;
      startLevel(state.levelIndex);
    });
    $('win-menu').addEventListener('click', goLevels);
    $('fail-retry').addEventListener('click', function () {
      $('fail-overlay').hidden = true;
      startLevel(state.levelIndex);
    });
    $('fail-menu').addEventListener('click', goLevels);
    $('how-to').addEventListener('click', function () { $('howto').hidden = false; });
    $('howto-close').addEventListener('click', function () { $('howto').hidden = true; });
    $('settings').addEventListener('click', openSettings);
    $('game-settings').addEventListener('click', openSettings);
    $('settings-close').addEventListener('click', function () { $('settings-modal').hidden = true; });
    $('settings-sound').addEventListener('click', function () {
      state.prefs.sound = !state.prefs.sound;
      Sound.on = state.prefs.sound;
      if (!Sound.on) Sound.hush();
      updateSettingsUI();
      savePrefs();
    });
    $('settings-cb').addEventListener('click', function () {
      state.prefs.cbAssist = !state.prefs.cbAssist;
      document.body.classList.toggle('cb-assist', state.prefs.cbAssist);
      updateSettingsUI();
      savePrefs();
    });
    $('reset-progress').addEventListener('click', function () {
      if (!confirm('Reset every level? All stars will be lost.')) return;
      state.progress = { completed: {}, stars: {} };
      saveProgress();
      renderHome();
      renderLevelGrid();
    });

    var frame = $('arena');
    frame.addEventListener('pointerdown', onPointerDown);
    frame.addEventListener('pointermove', onPointerMove);
    frame.addEventListener('pointerup', onPointerUp);
    frame.addEventListener('pointercancel', onPointerCancel);
    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', onKeyUp);
  }

  function openSettings() {
    updateSettingsUI();
    $('settings-modal').hidden = false;
  }
  function updateSettingsUI() {
    var s = $('settings-sound');
    s.textContent = state.prefs.sound ? 'On' : 'Off';
    s.setAttribute('aria-pressed', state.prefs.sound ? 'true' : 'false');
    var c = $('settings-cb');
    c.textContent = state.prefs.cbAssist ? 'On' : 'Off';
    c.setAttribute('aria-pressed', state.prefs.cbAssist ? 'true' : 'false');
  }

  function boot() {
    loadPrefs();
    loadProgress();
    wire();
    renderHome();
    showScreen('screen-home');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
