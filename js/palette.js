/* palette.js — the block colours.
 *
 * Picked to look like the screenshot: bright, saturated, and different enough
 * that any two placed next to each other read as two, not one. Each colour
 * carries a letter for a colour-blind assist mode; no two share an initial
 * (cyan uses 'C', magenta uses 'M') so the marks never collide. */
(function (global) {
  'use strict';

  var PALETTE = {
    red:     { hex: '#f5423c', mark: 'R', name: 'red' },
    orange:  { hex: '#ff8700', mark: 'O', name: 'orange' },
    yellow:  { hex: '#ffd028', mark: 'Y', name: 'yellow' },
    green:   { hex: '#2fc15e', mark: 'G', name: 'green' },
    teal:    { hex: '#0ec3c6', mark: 'T', name: 'teal' },
    blue:    { hex: '#3b7bf7', mark: 'B', name: 'blue' },
    purple:  { hex: '#9a53ef', mark: 'P', name: 'purple' },
    magenta: { hex: '#ff5aae', mark: 'M', name: 'magenta' },
    white:   { hex: '#fbfdff', mark: 'W', name: 'white' }
  };

  var KEYS = Object.keys(PALETTE);

  function hex(key) { var c = PALETTE[key]; return c ? c.hex : 'transparent'; }
  function mark(key) { var c = PALETTE[key]; return c ? c.mark : ''; }
  function name(key) { var c = PALETTE[key]; return c ? c.name : 'empty'; }

  function rgb(key) {
    var h = hex(key).replace('#', '');
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    };
  }

  /* Dark or light ink for a mark sitting on a block. Weighted luma so a
     white or yellow block gets dark ink and everything else gets pale ink. */
  function ink(key) {
    var c = rgb(key);
    return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255 > 0.62
      ? 'rgba(28, 20, 48, .62)' : 'rgba(255, 255, 255, .82)';
  }

  /* A slightly darker shade for the outline / drop shadow of a block, so the
     block reads as three-dimensional without needing a real shadow. */
  function edge(key) {
    var c = rgb(key);
    var f = 0.72;
    return 'rgb(' +
      Math.round(c.r * f) + ',' +
      Math.round(c.g * f) + ',' +
      Math.round(c.b * f) + ')';
  }

  global.Palette = {
    PALETTE: PALETTE, KEYS: KEYS,
    hex: hex, mark: mark, name: name, ink: ink, edge: edge
  };
})(typeof window !== 'undefined' ? window : globalThis);
