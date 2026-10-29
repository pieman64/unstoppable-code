/**
 * Labs page experiment helpers (CAN-3678). Overview, Kanban, Agents,
 * Statistics and Audit Trail are Labs experiments that production offers off.
 * The E2E launcher pins them `on`, so specs that drive those pages reach them
 * without seeding. While on, each page is a main-nav row, which makes the
 * sidebar five rows taller than a production default install.
 *
 * Specs that measure the rail, its menus, or what the More menu holds were
 * written for the production main nav. They launch through
 * `launchCanopyWithLabsPagesOffered` (or pass `withLabsPagesOffered(env)`) so
 * the layout they assert does not depend on the suite-wide pin.
 */

import { launchCanopy } from '../launchCanopy.mjs';

const E2E_CLIENT_FEATURE_FLAGS_ENV = 'CANOPY_E2E_CLIENT_FEATURE_FLAGS';

/**
 * Client flags that keep every Labs page at its production default. Covers
 * every page flag `DEFAULT_E2E_CLIENT_FEATURE_FLAGS` in `launchCanopy.mjs`
 * pins; `node/labs-pages-helper.test.mjs` fails when the two drift apart.
 */
export const LABS_PAGES_OFFERED_FLAGS = Object.freeze({
  'canopy-desktop-labs-overview-page': 'offered',
  'canopy-desktop-labs-kanban-page': 'offered',
  'canopy-desktop-labs-statistics-page': 'offered',
  'canopy-desktop-labs-audit-trail-page': 'offered',
});

/**
 * Returns `env` with the Labs page flags set to `offered`. Flags the caller
 * already passes in `CANOPY_E2E_CLIENT_FEATURE_FLAGS` win, so a spec can still
 * switch one page on explicitly. A value that is not a JSON object is left
 * untouched, as the launcher does, so the flag service still reports it.
 *
 * @param {Record<string, string>} [env]
 * @returns {Record<string, string>}
 */
export function withLabsPagesOffered(env = {}) {
  const raw = env[E2E_CLIENT_FEATURE_FLAGS_ENV];
  let flags = {};
  if (typeof raw === 'string' && raw.trim()) {
    try {
      flags = JSON.parse(raw);
    } catch {
      return env;
    }
    if (!flags || typeof flags !== 'object' || Array.isArray(flags)) {
      return env;
    }
  }
  return {
    ...env,
    [E2E_CLIENT_FEATURE_FLAGS_ENV]: JSON.stringify({
      ...LABS_PAGES_OFFERED_FLAGS,
      ...flags,
    }),
  };
}

/**
 * `launchCanopy` with every Labs page at its production default.
 *
 * @param {Parameters<typeof launchCanopy>[0]} [options]
 * @returns {ReturnType<typeof launchCanopy>}
 */
export function launchCanopyWithLabsPagesOffered(options = {}) {
  return launchCanopy({ ...options, env: withLabsPagesOffered(options.env) });
}
