// Shared PDF.js assets used by the desktop renderer; no hosted app dependency.
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const requireFromUi = createRequire(
  join(root, 'packages/ui-rich/package.json'),
);
export function preparePdfWorker({
  destinationDir,
  packageDir = dirname(requireFromUi.resolve('pdfjs-dist/package.json')),
} = {}) {
  if (!destinationDir) throw new Error('PDF.js destinationDir is required');
  const version = JSON.parse(
    readFileSync(join(packageDir, 'package.json'), 'utf8'),
  ).version;
  const worker = join(packageDir, 'build/pdf.worker.min.mjs');
  const directories = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];
  if (
    typeof version !== 'string' ||
    !existsSync(worker) ||
    directories.some((name) => !existsSync(join(packageDir, name)))
  )
    throw new Error('Incomplete PDF.js package');
  rmSync(destinationDir, { recursive: true, force: true });
  mkdirSync(destinationDir, { recursive: true });
  cpSync(worker, join(destinationDir, 'pdf.worker.min.mjs'));
  for (const name of directories)
    cpSync(join(packageDir, name), join(destinationDir, name), {
      recursive: true,
    });
  return { version, destination: join(destinationDir, 'pdf.worker.min.mjs') };
}
