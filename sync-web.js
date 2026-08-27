#!/usr/bin/env node
/* sync-web.js — mirror the game's web assets into www/ for Capacitor.
 *
 * Capacitor's `webDir` copies a folder wholesale into the native projects,
 * and the game lives at the repo root next to package.json and node_modules.
 * Rather than moving the game, this pulls only the files the page loads into
 * a clean www/ that Capacitor can copy from. Run before `npx cap sync`, or
 * use `npm run sync`, which does both. */

'use strict';
const fs = require('fs');
const path = require('path');

const root = __dirname;
const out = path.join(root, 'www');

/* The page names every script it needs; take the list from index.html rather
   than keeping a second copy here, so a new module cannot silently miss the
   bundle. */
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/gi)].map(m => m[1]);
const styles  = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/gi)].map(m => m[1]);

const files = new Set(['index.html', ...scripts, ...styles]);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const rel of files) {
  const src = path.join(root, rel);
  const dst = path.join(out, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

console.log('www/ populated with ' + files.size + ' files');
