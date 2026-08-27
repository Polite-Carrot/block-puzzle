#!/usr/bin/env node
/* verify-levels.js — replay every level through the engine using the
 * (rot, col, top) each piece was recorded with, confirm nothing overflows,
 * and confirm the arena ends fully packed with no gaps. */

'use strict';
require('./js/palette.js');
require('./js/shapes.js');
require('./js/engine.js');
require('./js/levels.js');

const Engine = globalThis.Engine;
const LEVELS = globalThis.LEVELS;

let ok = 0, bad = 0;
for (const level of LEVELS) {
  const game = new Engine.Game(level);
  let broke = null;
  for (let i = 0; i < level.pieces.length; i++) {
    const p = level.pieces[i];
    game.currentRot = p.solRot | 0;
    game.currentCol = p.solCol | 0;
    const placement = game.hardDrop();
    if (!placement) { broke = 'no drop for piece ' + i; break; }
    if (placement.overflow) { broke = 'overflow at piece ' + i; break; }
    if (placement.top !== p.solTop) {
      broke = 'piece ' + i + ' landed at ' + placement.top + ' but was recorded as ' + p.solTop;
      break;
    }
  }
  if (broke || !game.won) {
    bad++;
    console.error('BAD  ' + level.id + '  ' + level.name + '  — ' + (broke || 'not won'));
    continue;
  }
  /* Every non-obstacle cell in the arena must be covered. Anything left
     empty is a gap the tiler let through. */
  let gaps = 0;
  for (let r = game.sky; r < game.grid.length; r++) {
    for (let c = 0; c < game.width; c++) {
      if (!game.grid[r][c]) gaps++;
    }
  }
  if (gaps > 0) {
    bad++;
    console.error('BAD  ' + level.id + '  ' + level.name + '  — ' + gaps + ' gaps left');
  } else {
    ok++;
  }
}

console.log('verified ' + ok + '/' + LEVELS.length + ' levels perfectly tiled' +
  (bad ? ', ' + bad + ' failed' : ''));
process.exit(bad ? 1 : 0);
