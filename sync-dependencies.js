'use strict';
const fs = require('fs');
const path = require('path');

// Keep the plain-script entry point derived from the installed, pinned package.
module.exports = function syncDependencies() {
  const target = path.join(__dirname, 'vendor/unity-ads.js');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(require.resolve('@politecarrot/capacitor-unity-ads'), target);
};
