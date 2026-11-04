// Shapes of the desktop main-process entry files written by the main build.
import { resolve } from 'node:path';
import { build } from 'esbuild';

const LINUX_SAFE_STORAGE_HELPER_FILE = 'linux-safe-storage-helper.cjs';

/** Select the helper before loading bytecode, its loader, or any app bootstrap. */
export function isolatedMainEntrySource(normalSource) {
  return [
    '"use strict";',
    'if (process.env.CANOPY_LINUX_SAFE_STORAGE_HELPER_MODE === "1") {',
    `  require("./${LINUX_SAFE_STORAGE_HELPER_FILE}");`,
    '} else {',
    normalSource,
    '}',
    '',
  ].join('\n');
}

/** A separate build keeps the helper out of main's inline/bytecode graph. */
export function linuxSafeStorageHelperPlugin({
  entryFile,
  alias,
  define,
  onInputs,
}) {
  let outputDir = '';
  return {
    name: 'canopy:linux-safe-storage-helper',
    apply: 'build',
    configResolved(config) {
      outputDir = config.build.outDir;
    },
    buildStart() {
      this.addWatchFile(entryFile);
    },
    async writeBundle() {
      const result = await build({
        entryPoints: [entryFile],
        outfile: resolve(outputDir, LINUX_SAFE_STORAGE_HELPER_FILE),
        bundle: true,
        platform: 'node',
        target: 'node24',
        format: 'cjs',
        external: ['electron', 'node:*'],
        alias,
        define,
        minify: true,
        logLevel: 'warning',
        metafile: true,
      });
      const inputs = Object.keys(result.metafile.inputs).map((input) =>
        resolve(input),
      );
      for (const input of inputs) this.addWatchFile(input);
      onInputs?.(inputs);
    },
  };
}

/**
 * Source of a small main entry that loads the bundle with `require()`.
 *
 * Electron imports its main entry through Node's ESM loader, which keeps the
 * entry's whole source on its CommonJS module object for the life of the
 * process. When the entry is the bundle itself, main holds the bundle's
 * source twice. Bytecode builds already use a small entry; this gives
 * non-bytecode (dev) builds the same shape.
 */
export function mainEntrySource(bundleFile) {
  return isolatedMainEntrySource(`require("./${bundleFile}");`);
}

const TWO_BYTE_PLACEHOLDER = '"\\u200b".repeat(length - 2)';
const ONE_BYTE_PLACEHOLDER = '" ".repeat(length - 2)';

/**
 * Rewrites electron-vite's `bytecode-loader.cjs` to build its placeholder
 * source from spaces instead of U+200B.
 *
 * The loader compiles bytecode against a placeholder string of the original
 * source's length, and V8 keeps that string for the life of the script. V8
 * checks only the length, so a Latin-1 placeholder is accepted, and V8 stores
 * it at one byte per character instead of two.
 */
export function withOneBytePlaceholder(loaderSource) {
  if (loaderSource.includes(ONE_BYTE_PLACEHOLDER)) {
    return loaderSource;
  }
  if (!loaderSource.includes(TWO_BYTE_PLACEHOLDER)) {
    throw new Error(
      'bytecode-loader.cjs no longer builds its placeholder with ' +
        `${TWO_BYTE_PLACEHOLDER}; update scripts/lib/desktop-main-entry.mjs.`,
    );
  }
  return loaderSource.replace(TWO_BYTE_PLACEHOLDER, ONE_BYTE_PLACEHOLDER);
}
