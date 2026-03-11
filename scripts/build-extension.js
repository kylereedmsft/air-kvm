#!/usr/bin/env node
// Build extension dist/ folder.
// Copies extension source + shared code into a flat structure
// that Chrome can load directly.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const extSrc = path.join(root, 'extension', 'src');
const shared = path.join(root, 'shared');
const dist = path.join(root, 'extension', 'dist');
const distSrc = path.join(dist, 'src');

// Clean dist/
if (fs.existsSync(dist)) {
  fs.rmSync(dist, { recursive: true });
}
fs.mkdirSync(distSrc, { recursive: true });

// Copy manifest.json
fs.copyFileSync(
  path.join(root, 'extension', 'manifest.json'),
  path.join(dist, 'manifest.json')
);

// Copy extension source files (but skip barrel files for shared code)
const sharedFileNames = new Set(['binary_frame.js', 'halfpipe.js']);
for (const file of fs.readdirSync(extSrc)) {
  const src = path.join(extSrc, file);
  if (fs.statSync(src).isFile()) {
    if (sharedFileNames.has(file)) {
      // Copy canonical shared file instead of barrel
      fs.copyFileSync(path.join(shared, file), path.join(distSrc, file));
    } else {
      fs.copyFileSync(src, path.join(distSrc, file));
    }
  }
}

// Copy any HTML files from extension root src area (ble_bridge.html etc.)
// Also check for icons/, _locales/, or other asset directories
for (const item of fs.readdirSync(path.join(root, 'extension'))) {
  if (item === 'src' || item === 'dist' || item === 'test' || item === 'node_modules') continue;
  const full = path.join(root, 'extension', item);
  if (item === 'manifest.json') continue; // already copied
  if (fs.statSync(full).isDirectory()) {
    // Copy directory recursively (icons/, _locales/, etc.)
    fs.cpSync(full, path.join(dist, item), { recursive: true });
  } else if (fs.statSync(full).isFile()) {
    fs.copyFileSync(full, path.join(dist, item));
  }
}

// Count files
let count = 0;
function countFiles(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) countFiles(p);
    else count++;
  }
}
countFiles(dist);

console.log(`Built extension/dist/ (${count} files)`);
