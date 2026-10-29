import { readFileSync } from 'node:fs';
import path from 'node:path';

function declaredNumber(relativePath: string, pattern: RegExp): number {
  const source = readFileSync(path.join(__dirname, relativePath), 'utf8');
  const match = pattern.exec(source);
  if (!match) throw new Error(`No version declaration in ${relativePath}`);
  return Number(match[1]);
}

// Playwright cannot import the service, so the E2E seeders keep their own
// copy of its cache version. A cache with any other version is discarded and
// rebuilt, which silently drops every seeded row (#4631).
test('E2E seeders write the invocable inventory cache version the service accepts', () => {
  expect(
    declaredNumber(
      '../../../tests/electron/seeders/invocableInventoryCache.mjs',
      /^export const INVOCABLE_INVENTORY_CACHE_VERSION = (\d+);$/m,
    ),
  ).toBe(
    declaredNumber(
      '../plugins/invocable-inventory-service.ts',
      /^const CACHE_VERSION = (\d+);$/m,
    ),
  );
});
