/**
 * Which working-tree files each E2E build unit can read.
 *
 * `pnpm run build:e2e` builds and caches three units independently: the Electron
 * `main` bundle (with its utility workers), the `preload` scripts, and the
 * `renderer`. A unit's cache key hashes only the files inside its scope, so an
 * edit outside the scope leaves that unit's cached output valid.
 *
 * A scope must be a superset of everything the unit's build reads. Scopes are
 * therefore written as exclusions (anything not listed stays an input), and
 * the exclusions are enforced rather than assumed: E2E builds fail when a
 * unit's Rollup module graph, its Rollup watch files (which include every file
 * Tailwind scans), or a utility worker's esbuild inputs reach an excluded path
 * (`canopy:e2e-build-input-guard` in apps/desktop-app/electron.vite.config.ts).
 * When that guard fails, remove the exclusion here; never work around it.
 *
 * Paths are repository-relative with forward slashes.
 */

import path from 'node:path';

export const E2E_BUILD_UNITS = Object.freeze(['main', 'preload', 'renderer']);

// Trees no desktop bundle reads: nothing in them is imported by the main,
// preload, or renderer builds, and the renderer's Tailwind sources
// (apps/desktop-app/src/renderer/src/styles/globals.css) do not include them.
const NON_DESKTOP_TREES = Object.freeze([
  '.github/',
  'apps/canopy-dictate/',
  'apps/desktop-app/tests/',
  'apps/email-worker/',
  'apps/mobile/',
  'apps/web/',
  'docs/',
  'helm/',
  'ui-mocks/',
]);

// Mirrors the desktop dev watcher's test-only ignore patterns
// (`devWatchIgnorePatterns` in apps/desktop-app/electron.vite.config.ts).
const TEST_ONLY_PATH =
  /(?:^|\/)(?:__tests__|__mocks__|test-utils|tests)\/|\.(?:test|spec)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;

// The Vite config imports its build plugins from here, so every unit reads it.
const BUILD_TOOLING_TREE = 'apps/desktop-app/src/main/build/';

const MAIN_TREE = 'apps/desktop-app/src/main/';
const PRELOAD_TREE = 'apps/desktop-app/src/preload/';
const RENDERER_TREE = 'apps/desktop-app/src/renderer/';

const UNIT_EXCLUDED_TREES = Object.freeze({
  main: Object.freeze([...NON_DESKTOP_TREES, PRELOAD_TREE, RENDERER_TREE]),
  preload: Object.freeze([...NON_DESKTOP_TREES, MAIN_TREE, RENDERER_TREE]),
  renderer: Object.freeze([...NON_DESKTOP_TREES, MAIN_TREE, PRELOAD_TREE]),
});

// Tailwind scans these trees, tests included, for the class names in the
// renderer's stylesheet (the `source()` and `@source` entries in
// apps/desktop-app/src/renderer/src/styles/globals.css).
const TAILWIND_SOURCE_TREES = Object.freeze([RENDERER_TREE, 'packages/']);

function assertUnit(unit) {
  if (!E2E_BUILD_UNITS.includes(unit)) {
    throw new Error(`Unknown E2E build unit: ${unit}`);
  }
}

function isUnderTree(relativePath, tree) {
  // A tree's own directory entry (reported without the trailing slash by
  // directory watchers) counts as part of the tree.
  return relativePath.startsWith(tree) || `${relativePath}/` === tree;
}

/**
 * Test files are never imported by a bundle, so they are inputs only where
 * Tailwind reads them: the renderer's stylesheet can change with a test file
 * under one of Tailwind's source trees.
 */
function isTestOnlyInput(unit, relativePath) {
  return (
    unit === 'renderer' &&
    TAILWIND_SOURCE_TREES.some((tree) => isUnderTree(relativePath, tree))
  );
}

/** Whether a repository-relative path is inside the unit's input scope. */
export function isE2eBuildInput(unit, relativePath) {
  assertUnit(unit);
  if (
    TEST_ONLY_PATH.test(relativePath) &&
    !isTestOnlyInput(unit, relativePath)
  ) {
    return false;
  }
  if (isUnderTree(relativePath, BUILD_TOOLING_TREE)) {
    return true;
  }
  return !UNIT_EXCLUDED_TREES[unit].some((tree) =>
    isUnderTree(relativePath, tree),
  );
}

/**
 * Turns a bundler module id or watched path into a repository-relative path,
 * or null when it is not a file inside the repository (virtual modules, bare
 * specifiers, files elsewhere on disk).
 */
export function toRepoRelativeInputPath(repoRoot, id) {
  if (typeof id !== 'string') {
    return null;
  }
  let filePath = id.replace(/^\0+/, '');
  const queryStart = filePath.search(/[?#]/);
  if (queryStart >= 0) {
    filePath = filePath.slice(0, queryStart);
  }
  if (filePath.length === 0 || !path.isAbsolute(filePath)) {
    return null;
  }
  const relativePath = path.relative(repoRoot, filePath);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith('..') ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }
  return relativePath.split(path.sep).join('/');
}

/**
 * The files a build read that lie outside the unit's declared scope, as sorted
 * repository-relative paths. Empty when the scope held.
 */
export function findE2eBuildInputViolations(unit, repoRoot, ids) {
  assertUnit(unit);
  const violations = new Set();
  for (const id of ids) {
    const relativePath = toRepoRelativeInputPath(repoRoot, id);
    if (relativePath !== null && !isE2eBuildInput(unit, relativePath)) {
      violations.add(relativePath);
    }
  }
  return [...violations].sort();
}

export function formatE2eBuildInputViolations(unit, violations) {
  const shown = violations.slice(0, 10);
  const remainder = violations.length - shown.length;
  return [
    `The E2E ${unit} build read ${violations.length} file(s) outside its declared input scope:`,
    ...shown.map((violation) => `  ${violation}`),
    ...(remainder > 0 ? [`  ...and ${remainder} more`] : []),
    'Its cached output could be reused after these files change. Remove the matching exclusion in scripts/lib/e2e-build-inputs.mjs.',
  ].join('\n');
}
