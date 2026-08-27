#!/usr/bin/env node
/* build.js — bundle the game into one self-contained HTML file.
 *
 *   node build.js [outfile]              artifact fragment (default)
 *   node build.js --standalone [outfile] complete document
 *
 * Produces a page with no external references whatsoever — fonts included —
 * so there is nothing left to fetch wherever it ends up.
 *
 * By default the output omits <!doctype>, <html>, <head> and <body>, because
 * some hosts wrap the page themselves. Pass --standalone for a complete
 * document that opens correctly straight from disk. */

'use strict';
const fs = require('fs');
const path = require('path');

const root = __dirname;
const args = process.argv.slice(2);
const standalone = args.includes('--standalone');
const out = path.resolve(root, args.filter(a => a !== '--standalone')[0] ||
  (standalone ? 'block-puzzle-standalone.html' : 'block-puzzle.html'));
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const html = read('index.html');

/* Take the module list, and its order, straight from the page rather than
   keeping a second copy here — a hand-maintained list silently drops any
   newly added file, and the bundle then breaks in ways the source page does
   not. Order matters: each module attaches to window and the next reads it. */
const MODULES = [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/gi)].map(m => m[1]);
if (!MODULES.length) throw new Error('index.html: no <script src> tags found');

const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
if (!body) throw new Error('index.html: no <body> found');

const markup = body[1].replace(/[ \t]*<script\s+src=[^>]*><\/script>\s*/gi, '').trim();

const title = (html.match(/<title>([\s\S]*?)<\/title>/i) || [, 'Block Puzzle'])[1].trim();

/* A literal </script> or </style> inside the inlined text would close the tag
 * early. Nothing uses them today; guard anyway so a future edit cannot
 * silently produce a broken bundle. */
const safe = s => s.replace(/<\/(script|style)/gi, '<\\/$1');

const js = MODULES.map(f => '/* ── ' + f + ' ── */\n' + safe(read(f)).trim()).join('\n\n');

const page =
  '<title>' + title + '</title>\n\n' +
  '<style>\n' + safe(read('fonts.css')).trim() + '\n\n' +
  safe(read('styles.css')).trim() + '\n</style>\n\n' +
  markup + '\n\n' +
  '<script>\n' + js + '\n</script>\n';

fs.writeFileSync(out, standalone
  ? '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    page.replace(/\n\n(?=<div class="app">)/, '\n</head>\n<body>\n') +
    '</body>\n</html>\n'
  : page);

const kb = (fs.statSync(out).size / 1024).toFixed(1);
console.log('wrote ' + path.relative(root, out) + '  (' + kb + ' KB, ' + MODULES.length + ' modules inlined)');
