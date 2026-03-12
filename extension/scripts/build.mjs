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

// Copy all JS and HTML source files into dist/
for (const file of readdirSync(srcDir)) {
  const ext = extname(file);
  if (ext === '.js' || ext === '.html') {
    copyFileSync(join(srcDir, file), join(distDir, file));
  }
}

// Overwrite shim stubs with the real shared implementations
copyFileSync(join(sharedDir, 'binary_frame.js'), join(distDir, 'binary_frame.js'));
copyFileSync(join(sharedDir, 'halfpipe.js'),     join(distDir, 'halfpipe.js'));

// Write manifest.json with "src/" prefix stripped from all script paths
const manifest = readFileSync(join(extensionDir, 'manifest.json'), 'utf8');
writeFileSync(join(distDir, 'manifest.json'), manifest.replaceAll('src/', ''));

console.log(`Extension built → ${distDir}`);
