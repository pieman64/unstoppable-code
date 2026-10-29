import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Brand-agnostic but still meaningful: read the app name from the same
// materialized brand cache the renderer build injects as
// `__CANOPY_BRAND_DISPLAY_NAME__` (see electron.vite.config.ts), so an
// assertion tracks whichever brand was built instead of hard-coding one.
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
);
const BRAND_CACHE_FILE = path.join(
  REPO_ROOT,
  '.cache/brand',
  process.env.CANOPY_BRAND || 'canopy',
  'current-brand.json',
);

/**
 * The built brand's display name (`brandText.appName` in the renderer).
 * Call it inside a test, not at module scope: a missing brand cache would
 * otherwise throw during Playwright's collection phase and take down the
 * whole file with an opaque ENOENT.
 */
export function readBrandAppName() {
  try {
    return JSON.parse(readFileSync(BRAND_CACHE_FILE, 'utf-8')).displayName;
  } catch (error) {
    throw new Error(
      `Could not read the brand cache at ${BRAND_CACHE_FILE}. ` +
        `Run "pnpm run build:e2e" (or "pnpm run brand:prepare --all") first. ` +
        `Cause: ${error.message}`,
    );
  }
}
