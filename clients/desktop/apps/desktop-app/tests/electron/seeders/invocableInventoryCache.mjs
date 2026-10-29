/**
 * The only cache version the desktop accepts: `CACHE_VERSION` in
 * `apps/desktop-app/src/main/plugins/invocable-inventory-service.ts`, which
 * Playwright cannot import (`@canopy/desktop-shared` and the app load as
 * CommonJS). Any other version is discarded and rebuilt from disk, dropping
 * seeded rows that have no source there. Bump the two together;
 * `invocable-inventory-e2e-seed-version.test.ts` fails until they match.
 */
export const INVOCABLE_INVENTORY_CACHE_VERSION = 5;
