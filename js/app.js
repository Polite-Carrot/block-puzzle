/* app.js — screens, progress, and every input the player has.
 *
 * Three ways into a puzzle:
 *   Campaign     — a fixed hundred-level curve (in js/levels.js).
 *   Daily        — one puzzle a day, seeded from the calendar.
 *   Random       — pick a difficulty, hit Deal — a fresh solvable board.
 *
 * All three run the same engine, the same falling piece, and the same
 * pass/fail rules. There is no hard drop; the piece is always falling.
 * Controls: swipe/arrow keys to shift a column, tap or space to rotate,
 * swipe down or the down arrow to speed the fall. */
(function () {
  'use strict';

  var Palette   = window.Palette;
  var Engine    = window.Engine;
  var Shapes    = window.Shapes;
  var UI        = window.UI;
  var LEVELS    = window.LEVELS;
  var Generator = window.Generator;
  var Sound     = UI.Sound;

  var PROGRESS_KEY = 'blockpuzzle.progress.v2';
  var DAILY_KEY    = 'blockpuzzle.daily.v1';
  var RANDOM_KEY   = 'blockpuzzle.random.v1';
  var PREFS_KEY    = 'blockpuzzle.prefs.v1';

  /* The consent dialog links here, and the same URL goes on both store
     listings. */
  var PRIVACY_POLICY_URL = 'https://politecarrot.com/privacy';

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    game: null,
    /* Which mode we are playing — 'campaign', 'daily' or 'random'. */
    mode: 'campaign',
    /* Campaign 1..100. Random and daily use `seed` instead. */
    levelIndex: 0,
    /* Random difficulty 0..4; Daily uses a fixed tier below. */
    difficulty: 1,
    seed: 0,
    calMonth: null,
    dailyDate: null,
    /* null means never asked — that is what brings up the consent dialog on
       the first run. Once answered it is true or false for good. */
    prefs: { sound: true, cbAssist: false, analytics: null, personalizedAds: false },
    progress: {},
    dailyState: {},
    randomState: {},
    rafHandle: null,
    lastTime: 0,
    softDrop: false
  };

  /* Soft-drop rate — fast enough to feel like "get on with it" and slow
     enough that a mistake is still catchable. */
  var SOFT_DROP_SPEED = 20;

  var DAILY_TIER = 2;   /* Every daily plays at Hard, for a consistent challenge. */

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

  function loadJSON(key, fallback) {
    try {
      var raw = window.Store.read(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function saveJSON(key, value) { window.Store.write(key, JSON.stringify(value)); }

  function loadAll() {
    state.progress    = loadJSON(PROGRESS_KEY, { completed: {} });
    if (!state.progress.completed) state.progress.completed = {};
    state.dailyState  = loadJSON(DAILY_KEY, {});
    state.randomState = loadJSON(RANDOM_KEY, { difficulty: 1 });
    state.difficulty  = state.randomState.difficulty | 0;
  }

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

    var today = new Date();
    $('home-daily-day').textContent = today.getDate();
    var todayId = Generator.dailyToday();
    var solvedToday = state.dailyState[todayId] === 'won';
    $('home-daily-sub').textContent = solvedToday
      ? 'Today\u2019s puzzle: solved'
      : 'A fresh board every day';

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

  var PAGE_SIZE = 100;
  var pagerPage = 0;
  function pageCount() { return Math.ceil(LEVELS.length / PAGE_SIZE); }
  function clampPagerToUnlocked() {
    /* Open on the page containing the furthest unlocked level so a returning
       player is not made to page forward a dozen times. */
    var u = highestUnlocked();
    pagerPage = Math.max(0, Math.min(pageCount() - 1, Math.floor((u - 1) / PAGE_SIZE)));
  }
  function renderLevelGrid() {
    var grid = $('level-grid');
    grid.innerHTML = '';
    var unlocked = highestUnlocked();
    var pages = pageCount();
    if (pagerPage >= pages) pagerPage = pages - 1;
    if (pagerPage < 0) pagerPage = 0;
    var start = pagerPage * PAGE_SIZE;
    var end   = Math.min(start + PAGE_SIZE, LEVELS.length);
    for (var i = start; i < end; i++) {
      var idx = i + 1;
      var li = UI.el('li', 'level-item', grid);
      var btn = UI.el('button', 'tile', li);
      btn.type = 'button';
      var isDone = !!state.progress.completed[idx];
      var isLocked = idx > unlocked;
      btn.className = 'tile' +
        (isDone ? ' tile--done' : '') +
        (isLocked ? ' tile--locked' : '');
      UI.el('span', 'tile__num', btn).textContent = idx;
      if (isLocked) UI.el('span', 'tile__lock', btn).textContent = '🔒';
      btn.disabled = isLocked;
      btn.addEventListener('click', (function (n) {
        return function () { startCampaignLevel(n); };
      })(idx));
    }
    var label = $('pager-label');
    if (label) label.textContent = 'Levels ' + (start + 1) + '\u2013' + end;
    var prev = $('pager-prev');
    var next = $('pager-next');
    if (prev) prev.disabled = pagerPage <= 0;
    if (next) next.disabled = pagerPage >= pages - 1;
    /* Scroll back to the top of the grid on page change so the layout looks
       like a fresh screen rather than jumping the player mid-list. */
    var scroller = grid.parentElement;
    if (scroller && scroller.scrollTo) scroller.scrollTo(0, 0);
  }

  function renderDaily() {
    var D = window.Daily;
    if (!state.calMonth) {
      var t = D.today();
      state.calMonth = new Date(t.getFullYear(), t.getMonth(), 1);
    }

    $('cal-month').textContent = D.monthTitle(state.calMonth);

    /* Months before the first daily, or after this one, are not worth
       offering — there is nothing in them either way. */
    var first = D.first(), now = D.today();
    $('cal-prev').disabled = state.calMonth <= new Date(first.getFullYear(), first.getMonth(), 1);
    $('cal-next').disabled = state.calMonth >= new Date(now.getFullYear(), now.getMonth(), 1);

    var grid = $('cal-grid');
    grid.innerHTML = '';
    D.monthGrid(state.calMonth).forEach(function (date) {
      var li = UI.el('li', null, grid);
      if (!date) { li.className = 'cal--blank'; return; }

      var open = D.playable(date);
      var done = state.dailyState[D.seedFor(date)] === 'won';

      var btn = UI.el('button', 'cal__day', li);
      btn.type = 'button';
      btn.disabled = !open;
      if (done) btn.classList.add('is-done');
      if (D.seedFor(date) === D.seedFor(now)) btn.classList.add('is-today');
      btn.textContent = date.getDate();
      btn.setAttribute('aria-label', D.title(date) + ', ' +
        (done ? 'solved' : open ? 'not played yet' : 'not open yet'));
      btn.title = D.title(date);
      if (open) btn.addEventListener('click', function () { startDailyLevel(date); });
    });

    var streak = D.streak(state.dailyState);
    var solved = Object.keys(state.dailyState).length;
    $('daily-note').textContent = D.monthTitle(now);
    $('daily-status').textContent = streak
      ? streak + ' day streak · ' + solved + ' solved'
      : solved ? solved + ' solved' : 'Play today to start a streak';
  }

  function stepMonth(by) {
    state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + by, 1);
    renderDaily();
  }

  var DIFFICULTY_NAMES = Generator.RANDOM_TIERS.map(function (t) { return t.name; });
  var DIFFICULTY_BLURBS = Generator.RANDOM_TIERS.map(function (t) { return t.blurb; });

  function renderRandom() {
    var d = state.difficulty;
    $('difficulty').value = String(d);
    $('difficulty-name').textContent = DIFFICULTY_NAMES[d];
    $('difficulty-blurb').textContent = DIFFICULTY_BLURBS[d];
    var ticks = $('difficulty-ticks');
    ticks.innerHTML = '';
    for (var i = 0; i < DIFFICULTY_NAMES.length; i++) {
      var s = UI.el('span', i === d ? 'is-on' : '', ticks);
      s.textContent = DIFFICULTY_NAMES[i];
    }
    $('difficulty').setAttribute('aria-valuetext', DIFFICULTY_NAMES[d]);
    $('random-record').textContent = state.randomState.lastSeed
      ? 'Last: ' + DIFFICULTY_NAMES[state.randomState.lastDifficulty || 0] +
        ' \u00b7 seed ' + state.randomState.lastSeed
      : '';
  }

  /* ── running a level ────────────────────────────────────────────────── */

  var arena, queue, confetti;

  function startCampaignLevel(idx) {
    state.mode = 'campaign';
    state.levelIndex = idx;
    startLevel(LEVELS[idx - 1]);
  }

  function startDailyLevel(date) {
    state.mode = 'daily';
    var day = date || window.Daily.today();
    state.dailyDate = day;
    var seed = window.Daily.seedFor(day);
    state.seed = seed;
    var level = Generator.buildRandomLevel(DAILY_TIER, seed);
    if (!level) { alert('Could not deal today\u2019s puzzle. Please try again later.'); return; }
    startLevel(level);
  }

  function startRandomLevel(seed) {
    state.mode = 'random';
    if (seed == null || isNaN(seed)) seed = Math.floor(Math.random() * 2147483647);
    state.seed = seed;
    state.randomState.lastSeed = seed;
    state.randomState.lastDifficulty = state.difficulty;
    saveJSON(RANDOM_KEY, state.randomState);
    var level = Generator.buildRandomLevel(state.difficulty, seed);
    if (!level) { alert('Could not deal a puzzle for that seed. Try another.'); return; }
    startLevel(level);
  }

  function startLevel(level) {
    stopFallLoop();
    state.softDrop = false;
    $('overlay').hidden = true;
    $('fail-overlay').hidden = true;
    state.game = new Engine.Game(level);
    track('level_start', {
      mode: state.mode,
      level: state.mode === 'campaign' ? state.levelIndex : undefined,
      difficulty: state.mode === 'random' ? state.difficulty : undefined
    });
    var title = state.mode === 'campaign'
      ? 'Level ' + state.levelIndex
      : (state.mode === 'daily' ? 'Daily Puzzle' : 'Random Puzzle');
    $('level-name').textContent = title;
    if (state.mode === 'campaign') {
      $('level-sub').textContent = 'Level ' + state.levelIndex + ' of ' + LEVELS.length;
    } else if (state.mode === 'daily') {
      $('level-sub').textContent = window.Daily.title(state.dailyDate || window.Daily.today());
    } else {
      $('level-sub').textContent = DIFFICULTY_NAMES[state.difficulty] +
        ' \u00b7 seed ' + state.seed;
    }
    $('brief').textContent = level.brief || '';
    $('brief').style.display = level.brief ? '' : 'none';
    if (!arena) arena = new UI.ArenaView($('arena'));
    if (!queue) queue = new UI.QueueView($('queue'));
    if (!confetti) confetti = new UI.Confetti($('confetti'));
    showScreen('screen-game');
    /* The queue shares the column with the board, so it has to be filled
       before the board is measured — otherwise fitBoard sizes the cells
       against a box that is about to shrink. */
    queue.render(state.game.level, state.game.currentIdx);
    requestAnimationFrame(function () {
      fitBoard();
      redraw();
      startFallLoop();
    });
  }

  /* Cell size that fits the arena inside the .board container. Reserves
     18px for the frame's drop shadow and a touch of breathing room, and
     shrinks cells down to 10px on tiny viewports so both the top runway
     and the pile at the bottom stay visible. */
  var COMFORT_CELL = 22;

  function measureCell(g) {
    var boardEl = document.querySelector('.board');
    var boardW = boardEl.clientWidth - 4;
    var boardH = boardEl.clientHeight - 18;
    if (boardW <= 0 || boardH <= 0) return 0;
    var byW = Math.floor(boardW / g.width);
    var byH = Math.floor(boardH / (g.height + g.sky));
    return Math.max(10, Math.min(56, Math.min(byH, byW)));
  }

  function setTight(on) {
    document.querySelector('.shelf-wrap').classList.toggle('shelf-wrap--compact', on);
    document.body.classList.toggle('is-tight', on);
  }

  function fitBoard() {
    if (!state.game || !arena) return false;
    var g = state.game;
    /* Always judged from the roomy layout, so the outcome depends only on
       the viewport and never on the state left by the previous fit. */
    setTight(false);
    var cell = measureCell(g);
    if (!cell) return false;
    if (cell < COMFORT_CELL) {
      setTight(true);
      var tighter = measureCell(g);
      if (tighter > cell) cell = tighter;
      else setTight(false);
    }
    if (cell === arena.cellPx && g.width === arena.width &&
        g.height === arena.height && g.sky === arena.sky) return false;
    arena.layout(g, cell);
    return true;
  }

  window.addEventListener('resize', function () {
    if (state.game) { fitBoard(); redraw(); }
  });

  /* The board also changes height without a window resize — web fonts
     landing, the brief rewrapping, the queue filling out. Refit on those
     too, or a tall arena keeps the cell size it was given while the box
     underneath it shrinks. */
  if (window.ResizeObserver) {
    new ResizeObserver(function () {
      if (state.game && fitBoard()) redraw();
    }).observe(document.querySelector('.board'));
  }

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
    if (document.querySelector('.overlay:not([hidden])')) {
      state.lastTime = now;
      state.rafHandle = requestAnimationFrame(tickFall);
      return;
    }
    var dt = Math.min(0.1, (now - state.lastTime) / 1000);
    state.lastTime = now;
    var speed = state.softDrop ? SOFT_DROP_SPEED : game.fallSpeed;
    var landing = game.landingRow(game.currentRot, game.currentCol);

    if (landing === null || game.currentRow >= landing) {
      return lockNow();
    }
    game.subrow += dt * speed;
    while (game.subrow >= 1 && game.currentRow < landing) {
      game.subrow -= 1;
      game.tryFall();
      landing = game.landingRow(game.currentRot, game.currentCol);
      if (landing === null || game.currentRow >= landing) return lockNow();
    }
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
    /* The current gesture — if any — ends the moment a piece locks. This
       stops a drag-down held for the last piece carrying over into the
       next one and slamming it home before the player even sees it. */
    state.softDrop = false;
    if (press) press.consumed = true;

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
    track('undo');
    Sound.undo();
    $('fail-overlay').hidden = true;
    redraw();
    state.lastTime = performance.now();
    startFallLoop();
  }
  function restart() {
    var game = state.game;
    if (!game) return;
    state.softDrop = false;
    $('fail-overlay').hidden = true;
    game.restart();
    track('level_restart', { mode: state.mode });
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

  /* Pointer on the arena. `press.consumed` is set the moment a piece locks,
     so continuing to hold the finger after a piece lands cannot soft-drop
     or move the next one until the pointer lifts and comes down again. */
  var press = null;
  var TAP_MOVE_TOLERANCE = 6;
  var TAP_TIME_MS = 300;
  /* A drag commits to one axis and stays there, so the wobble in a downward
     swipe cannot walk the piece across columns. */
  var AXIS_LOCK_PX = 10;
  var AXIS_DOMINANCE = 1.3;
  var STEP_FRACTION = 0.9;   /* of a cell of travel per column step */
  var DROP_FRACTION = 0.5;   /* of a cell downwards to commit the drop */

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
      axis: null,
      startTime: performance.now(),
      tapCandidate: true,
      consumed: false
    };
  }

  function onPointerMove(ev) {
    if (!press || press.consumed) return;
    var game = state.game;
    if (!game || game.won || game.lost) return;
    var dx = ev.clientX - press.startX;
    var dy = ev.clientY - press.startY;
    var cell = arena.cellPx || 30;
    if (Math.abs(dx) > TAP_MOVE_TOLERANCE || Math.abs(dy) > TAP_MOVE_TOLERANCE) {
      press.tapCandidate = false;
    }
    if (!press.axis) {
      var ax = Math.abs(dx), ay = Math.abs(dy);
      if (ax > AXIS_LOCK_PX && ax > ay * AXIS_DOMINANCE) press.axis = 'x';
      else if (ay > AXIS_LOCK_PX && ay > ax * AXIS_DOMINANCE) press.axis = 'y';
      else return;
    }
    if (press.axis === 'y') {
      /* The drop is latched rather than held: it runs until the piece locks,
         so seeing it home takes one swipe instead of a dozen. */
      if (!press.softDrop && dy > cell * DROP_FRACTION) {
        press.softDrop = true;
        state.softDrop = true;
      }
      return;
    }
    var targetSteps = Math.trunc(dx / (cell * STEP_FRACTION));
    var moved = false;
    while (press.stepsMoved < targetSteps) {
      if (!game.tryMove(1)) break;
      press.stepsMoved++;
      moved = true;
    }
    while (press.stepsMoved > targetSteps) {
      if (!game.tryMove(-1)) break;
      press.stepsMoved--;
      moved = true;
    }
    /* Only the piece layer moves here — repainting the grid and the queue on
       every pointer event is what made the drag stutter. */
    if (moved) { Sound.move(); arena.showCurrent(game); }
  }

  function onPointerUp() {
    if (!press) return;
    var elapsed = performance.now() - press.startTime;
    if (!press.consumed && press.tapCandidate && elapsed < TAP_TIME_MS) rotate();
    if (!press.softDrop) state.softDrop = false;
    press = null;
  }
  function onPointerCancel() {
    if (!press) return;
    state.softDrop = false;
    press = null;
  }

  /* ── win, lose, menu ────────────────────────────────────────────────── */

  /* A grab-bag of things to say when the board is beaten. Randomly picked so
     the same line does not appear every clear — mostly short, always warm. */
  var WIN_LINES = [
    'Every piece under the line.',
    'Every cell claimed.',
    'Perfect fit — not a millimetre spare.',
    'Snug as anything.',
    'Slotted home. Every one of them.',
    'That is the shape of it.',
    'Neat work. Every corner counted.',
    'Right down to the last cell.',
    'Fit like a puzzle.',
    'A packed house.',
    'Sharp playing.',
    'Not a gap to be found.',
    'Every last block, in place.',
    'Every stone laid.',
    'That will do nicely.'
  ];
  var FAIL_LINES = [
    'A piece went above the line.',
    'That last one poked through.',
    'Ran out of room at the top.',
    'The pile crossed the line.',
    'One too many for the space.',
    'The stack outgrew the arena.'
  ];

  function pickLine(pool) {
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function onWin() {
    stopFallLoop();
    Sound.win();
    track('level_complete', {
      mode: state.mode,
      level: state.mode === 'campaign' ? state.levelIndex : undefined,
      difficulty: state.mode === 'random' ? state.difficulty : undefined
    });
    if (state.mode === 'campaign') {
      state.progress.completed[state.levelIndex] = true;
      saveJSON(PROGRESS_KEY, state.progress);
    } else if (state.mode === 'daily') {
      state.dailyState[state.seed] = 'won';
      saveJSON(DAILY_KEY, state.dailyState);
    }
    if (window.Ads) window.Ads.noteLevelComplete();
    var used = state.game.level.pieces
      .map(function (p) { return p.colour; })
      .filter(function (v, i, a) { return a.indexOf(v) === i; });
    confetti.fire(used);
    setTimeout(showWin, 380);
  }

  function showWin() {
    var atEnd = state.mode === 'campaign' && state.levelIndex === LEVELS.length;
    $('win-title').textContent = atEnd ? 'Campaign complete!' : 'Cleared!';
    $('win-line').textContent = atEnd
      ? 'Every level, cleared. Every board, packed.'
      : pickLine(WIN_LINES);
    var nextBtn = $('win-next');
    if (state.mode === 'campaign') {
      nextBtn.textContent = state.levelIndex < LEVELS.length ? 'Next' : 'Menu';
      nextBtn.hidden = false;
    } else if (state.mode === 'random') {
      nextBtn.textContent = 'Deal another';
      nextBtn.hidden = false;
    } else {
      nextBtn.hidden = true;
    }
    /* Retriggering the animations by cloning the badge keeps them fresh on
       consecutive clears without needing to unmount the whole modal. */
    var overlay = $('overlay');
    overlay.hidden = false;
    var modal = overlay.querySelector('.modal');
    if (modal) { modal.style.animation = 'none'; void modal.offsetWidth; modal.style.animation = ''; }
  }

  function onLost() {
    stopFallLoop();
    track('level_fail', {
      mode: state.mode,
      level: state.mode === 'campaign' ? state.levelIndex : undefined,
      difficulty: state.mode === 'random' ? state.difficulty : undefined
    });
    setTimeout(function () {
      $('fail-line').textContent = pickLine(FAIL_LINES);
      var overlay = $('fail-overlay');
      overlay.hidden = false;
      var modal = overlay.querySelector('.modal');
      if (modal) { modal.style.animation = 'none'; void modal.offsetWidth; modal.style.animation = ''; }
    }, 260);
  }

  function backToMenu() {
    $('overlay').hidden = true;
    $('fail-overlay').hidden = true;
    stopFallLoop();
    state.game = null;
    renderHome();
    showScreen('screen-home');
  }

  function goCampaign() {
    $('overlay').hidden = true;
    $('fail-overlay').hidden = true;
    stopFallLoop();
    state.game = null;
    if (state.mode === 'campaign') {
      /* Jump to the page containing the level we just came from so the same
         tile is right there — the pager stays "sticky" to context. */
      if (state.levelIndex >= 1) {
        pagerPage = Math.floor((state.levelIndex - 1) / PAGE_SIZE);
      } else {
        clampPagerToUnlocked();
      }
      renderLevelGrid();
      showScreen('screen-levels');
    } else if (state.mode === 'daily') {
      renderDaily();
      showScreen('screen-daily');
    } else {
      renderRandom();
      showScreen('screen-random');
    }
  }

  function goNext() {
    $('overlay').hidden = true;
    /* Interstitial cadence is gated inside Ads — this call is safe to fire
       from every screen transition after a win; it no-ops until both two
       minutes and three levels have passed since the last one. */
    var afterAd = window.Ads ? window.Ads.maybeShowInterstitial() : Promise.resolve();
    afterAd.then(function () {
      if (state.mode === 'campaign') {
        var next = state.levelIndex + 1;
        if (next > LEVELS.length) { backToMenu(); return; }
        startCampaignLevel(next);
      } else if (state.mode === 'random') {
        startRandomLevel(Math.floor(Math.random() * 2147483647));
      } else {
        backToMenu();
      }
    });
  }

  /* ── boot ───────────────────────────────────────────────────────────── */

  function wire() {
    $('go-campaign').addEventListener('click', function () {
      state.mode = 'campaign';
      track('mode_selected', { mode: 'campaign' });
      clampPagerToUnlocked();
      renderLevelGrid();
      showScreen('screen-levels');
    });
    $('go-daily').addEventListener('click', function () {
      state.mode = 'daily';
      track('mode_selected', { mode: 'daily' });
      state.calMonth = null;                 /* always open on this month */
      renderDaily();
      showScreen('screen-daily');
    });
    $('go-random').addEventListener('click', function () {
      state.mode = 'random';
      track('mode_selected', { mode: 'random' });
      renderRandom();
      showScreen('screen-random');
    });
    $('levels-back').addEventListener('click', function () { renderHome(); showScreen('screen-home'); });
    $('daily-back').addEventListener('click', function () { renderHome(); showScreen('screen-home'); });
    $('random-back').addEventListener('click', function () { renderHome(); showScreen('screen-home'); });

    $('pager-prev').addEventListener('click', function () {
      if (pagerPage > 0) { pagerPage--; renderLevelGrid(); }
    });
    $('pager-next').addEventListener('click', function () {
      if (pagerPage < pageCount() - 1) { pagerPage++; renderLevelGrid(); }
    });

    $('cal-prev').addEventListener('click', function () { stepMonth(-1); });
    $('cal-next').addEventListener('click', function () { stepMonth(1); });
    $('play-random').addEventListener('click', function () {
      var raw = $('seed-input').value.trim();
      var seed = raw === '' ? Math.floor(Math.random() * 2147483647) : (parseInt(raw, 10) >>> 0);
      startRandomLevel(seed);
    });

    var slider = $('difficulty');
    slider.addEventListener('input', function () {
      state.difficulty = slider.value | 0;
      state.randomState.difficulty = state.difficulty;
      saveJSON(RANDOM_KEY, state.randomState);
      renderRandom();
    });

    $('back').addEventListener('click', goCampaign);
    $('undo').addEventListener('click', undo);
    $('restart').addEventListener('click', restart);
    $('win-next').addEventListener('click', goNext);
    $('win-retry').addEventListener('click', function () {
      $('overlay').hidden = true;
      var afterAd = window.Ads ? window.Ads.maybeShowInterstitial() : Promise.resolve();
      afterAd.then(function () {
        if (state.mode === 'campaign') startCampaignLevel(state.levelIndex);
        else if (state.mode === 'daily') startDailyLevel(state.dailyDate);
        else startRandomLevel(state.seed);
      });
    });
    $('win-menu').addEventListener('click', function () {
      var afterAd = window.Ads ? window.Ads.maybeShowInterstitial() : Promise.resolve();
      afterAd.then(goCampaign);
    });
    $('fail-retry').addEventListener('click', function () {
      $('fail-overlay').hidden = true;
      if (state.mode === 'campaign') startCampaignLevel(state.levelIndex);
      else if (state.mode === 'daily') startDailyLevel(state.dailyDate);
      else startRandomLevel(state.seed);
    });
    $('fail-menu').addEventListener('click', goCampaign);

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
    $('settings-privacy').addEventListener('click', function () {
      $('settings-modal').hidden = true;
      openPrivacyDataModal();
    });
    $('privacy-analytics').addEventListener('click', function () {
      setToggleBtn(this, this.getAttribute('aria-pressed') !== 'true');
    });
    $('privacy-continue').addEventListener('click', function () {
      state.prefs.analytics = $('privacy-analytics').getAttribute('aria-pressed') === 'true';
      savePrefs();
      applyConsent();
      $('privacy').hidden = true;
      if (state.prefs.analytics) track('analytics_consent_granted');
      primeConsent();
    });
    $('privacy-data-analytics').addEventListener('click', function () {
      state.prefs.analytics = this.getAttribute('aria-pressed') !== 'true';
      setToggleBtn(this, state.prefs.analytics);
      savePrefs();
      applyConsent();
      if (state.prefs.analytics) track('analytics_consent_granted');
    });
    $('privacy-data-ads').addEventListener('click', function () {
      setAdsPersonalized(this.getAttribute('aria-pressed') !== 'true');
    });
    $('privacy-data-close').addEventListener('click', function () {
      $('privacy-data').hidden = true;
    });
    /* Erasing progress asks twice and then asks for six seconds of intent.
       It used to be a home-screen button behind a confirm(), which sat one
       slip away from wiping a thousand levels. */
    function openReset() {
      $('settings-modal').hidden = true;
      $('reset-ask').hidden = false;
      $('reset-hold-step').hidden = true;
      $('reset-modal').hidden = false;
    }

    function closeReset(back) {
      releaseHold();
      $('reset-modal').hidden = true;
      if (back) $('settings-modal').hidden = false;
    }

    $('settings-reset').addEventListener('click', openReset);
    $('reset-cancel').addEventListener('click', function () { closeReset(true); });
    $('reset-back').addEventListener('click', function () { closeReset(true); });
    $('reset-yes').addEventListener('click', function () {
      $('reset-ask').hidden = true;
      $('reset-hold-step').hidden = false;
      $('reset-hold').focus();
    });

    var HOLD_MS = 6000;
    var holdFrom = 0, holdRaf = null;

    function paintHold(fraction, label) {
      $('reset-hold').style.setProperty('--held', fraction);
      $('reset-hold-label').textContent = label;
    }

    function releaseHold() {
      if (holdRaf) cancelAnimationFrame(holdRaf);
      holdRaf = null;
      holdFrom = 0;
      $('reset-hold').classList.remove('is-done');
      paintHold(0, 'Press and hold');
    }

    function tickHold() {
      var held = Date.now() - holdFrom;
      if (held >= HOLD_MS) {
        holdRaf = null;
        $('reset-hold').classList.add('is-done');
        paintHold(1, 'Erased');
        eraseProgress();
        return;
      }
      var left = Math.ceil((HOLD_MS - held) / 1000);
      paintHold(held / HOLD_MS, 'Keep holding\u2026 ' + left);
      holdRaf = requestAnimationFrame(tickHold);
    }

    function startHold() {
      if (holdRaf) return;
      holdFrom = Date.now();
      Sound.undo();
      holdRaf = requestAnimationFrame(tickHold);
    }

    function eraseProgress() {
      state.progress = { completed: {} };
      state.dailyState = {};
      state.randomState = { difficulty: 1 };
      saveJSON(PROGRESS_KEY, state.progress);
      saveJSON(DAILY_KEY, state.dailyState);
      saveJSON(RANDOM_KEY, state.randomState);
      Sound.lose();
      renderHome();
      setTimeout(function () {
        closeReset(false);
        showScreen('screen-home');
      }, 700);
    }

    var hold = $('reset-hold');
    hold.addEventListener('pointerdown', function (e) {
      /* Capture, so a finger sliding off the button still counts as holding. */
      hold.setPointerCapture(e.pointerId);
      startHold();
    });
    ['pointerup', 'pointercancel'].forEach(function (type) {
      hold.addEventListener(type, function () {
        if (!hold.classList.contains('is-done')) releaseHold();
      });
    });
    hold.addEventListener('keydown', function (e) {
      if (e.repeat) return;                   /* auto-repeat is not holding */
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); startHold(); }
    });
    hold.addEventListener('keyup', function (e) {
      if (e.key === ' ' || e.key === 'Enter') {
        if (!hold.classList.contains('is-done')) releaseHold();
      }
    });

    var frame = $('arena');
    frame.addEventListener('pointerdown', onPointerDown);
    frame.addEventListener('pointermove', onPointerMove);
    frame.addEventListener('pointerup', onPointerUp);
    frame.addEventListener('pointercancel', onPointerCancel);
    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', onKeyUp);

    /* Belt-and-braces zoom prevention for iOS Safari where the viewport meta
       does not stop the double-tap gesture on its own. */
    var touchTs = 0;
    document.addEventListener('touchend', function (ev) {
      var now = Date.now();
      if (now - touchTs < 350) ev.preventDefault();
      touchTs = now;
    }, { passive: false });
    document.addEventListener('gesturestart', function (ev) { ev.preventDefault(); });
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
    var a = $('privacy-data-analytics');
    if (a) setToggleBtn(a, state.prefs.analytics === true);
    var ads = $('privacy-data-ads');
    if (ads) setToggleBtn(ads, state.prefs.personalizedAds === true);
  }

  /* Publishes the current consent state to Track (and could to Ads too if a
     personalised-ads toggle existed here). AdMob's own UMP flow governs the
     ads flag independently — we assume "not personalised" unless the user
     goes through UMP. */
  function applyConsent() {
    window.__consentState = {
      analytics: state.prefs.analytics === true,
      ads: !!(window.Ads && window.Ads.adsPersonalisedGranted &&
              window.Ads.adsPersonalisedGranted())
    };
    if (window.Track && window.Track.sync) window.Track.sync();
    if (window.Ads && window.Ads.setPersonalized) {
      window.Ads.setPersonalized(state.prefs.personalizedAds === true);
    }
  }

  /* Turning personalised ads on has to walk the same gates the SDK does:
     ATT first on iOS, then UMP, then Google's own privacy options form. */
  async function setAdsPersonalized(on) {
    state.prefs.personalizedAds = on === true;
    savePrefs();
    applyConsent();
    updateSettingsUI();
    if (!on) return;
    var Ads = window.Ads;
    if (!Ads || !Ads.isNative || !Ads.isNative()) return;
    var attPromise = Ads.getPlatform() === 'ios' ? Ads.ensureAtt(true) : Promise.resolve();
    try { await Ads.init(); } catch (e) {}
    try { await Ads.runUmp(true); } catch (e) {}
    try { await attPromise; } catch (e) {}
    if (Ads.showPrivacyOptionsForm) {
      try { await Ads.showPrivacyOptionsForm(); } catch (e) {}
    }
    applyConsent();
    updateSettingsUI();
  }

  /* Runs once the player has answered our own dialog. Apple's prompt has to
     be reachable for every iOS player whatever the toggles say — a reviewer
     who never sees it fails the build under Guideline 2.1. */
  async function primeConsent() {
    var Ads = window.Ads;
    if (!Ads || !Ads.isNative || !Ads.isNative()) return;
    var attPromise = Ads.getPlatform() === 'ios' ? Ads.ensureAtt(true) : Promise.resolve();
    try { await Ads.init(); } catch (e) {}
    try { await Ads.runUmp(); } catch (e) {}
    var attStatus = null;
    try { attStatus = await attPromise; } catch (e) {}
    if (attStatus === 'authorized') {
      state.prefs.personalizedAds = true;
      savePrefs();
    }
    applyConsent();
    updateSettingsUI();
    Ads.warm();
  }

  function setToggleBtn(btn, on) {
    if (!btn) return;
    btn.textContent = on ? 'On' : 'Off';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function openPrivacyModal() {
    setToggleBtn($('privacy-analytics'), state.prefs.analytics === true);
    var link = $('privacy-policy');
    if (link) {
      link.hidden = !PRIVACY_POLICY_URL;
      if (PRIVACY_POLICY_URL) link.href = PRIVACY_POLICY_URL;
    }
    $('privacy').hidden = false;
  }

  function openPrivacyDataModal() {
    setToggleBtn($('privacy-data-analytics'), state.prefs.analytics === true);
    setToggleBtn($('privacy-data-ads'), state.prefs.personalizedAds === true);
    $('privacy-data').hidden = false;
  }

  /* Asked once, on the first run. Anything already answered is simply
     applied — nothing is collected before the player has said yes. */
  function maybeAskConsent() {
    if (state.prefs.analytics === true || state.prefs.analytics === false) {
      applyConsent();
      var Ads = window.Ads;
      if (Ads && Ads.isNative && Ads.isNative()) {
        Ads.init().then(function () { return Ads.runUmp(); })
          .then(function () { return Ads.ensureAtt(false); })
          .then(function () { applyConsent(); updateSettingsUI(); Ads.warm(); })
          .catch(function () {});
      }
      return;
    }
    /* A boot splash would sit over the dialog, so wait for it to clear. */
    (function waitForBoot(tries) {
      if (!document.getElementById('boot') || tries > 40) { openPrivacyModal(); return; }
      setTimeout(function () { waitForBoot(tries + 1); }, 150);
    })(0);
  }

  /* Every call site is one line and none of them can fail: Track.event is
     itself a no-op without consent. */
  function track(name, params) {
    if (window.Track) window.Track.event(name, params);
  }

  function boot() {
    loadPrefs();
    loadAll();
    applyConsent();
    wire();
    renderHome();
    showScreen('screen-home');
    /* Every ad gate now hangs off this: the player answers our dialog first,
       then UMP, ATT and the SDK warm-up follow in order. */
    maybeAskConsent();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
