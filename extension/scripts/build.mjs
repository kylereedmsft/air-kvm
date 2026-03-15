// Builds the loadable extension into dist/.
//
// Chrome cannot resolve imports outside the extension directory, so shared/
// files are copied in. dist/ is the folder to load as an unpacked extension.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionDir = resolve(fileURLToPath(import.meta.url), '..', '..');
const rootDir      = resolve(extensionDir, '..');
const srcDir       = join(extensionDir, 'src');
const sharedDir    = join(rootDir, 'shared');
const distDir      = join(extensionDir, 'dist');

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// Copy all JS and HTML source files into dist/, rewriting shared/ import paths
for (const file of readdirSync(srcDir)) {
  const ext = extname(file);
  if (ext === '.js' || ext === '.html') {
    let content = readFileSync(join(srcDir, file), 'utf8');
    // Rewrite any shared/ relative imports to flat dist/ paths
    content = content.replace(/from '\.\.\/\.\.\/shared\/([\w.]+\.js)'/g, "from './$1'");
    writeFileSync(join(distDir, file), content);
  }
}

// Copy all shared/ JS files into dist/ (flattened)
for (const file of readdirSync(sharedDir)) {
  if (extname(file) === '.js') {
    copyFileSync(join(sharedDir, file), join(distDir, file));
  }
}

// Write manifest.json verbatim — paths are already relative to dist/ root
const manifest = readFileSync(join(extensionDir, 'manifest.json'), 'utf8');
writeFileSync(join(distDir, 'manifest.json'), manifest);

console.log(`Extension built → ${distDir}`);
