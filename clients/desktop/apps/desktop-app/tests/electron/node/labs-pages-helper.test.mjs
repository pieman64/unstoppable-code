import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  LABS_PAGES_OFFERED_FLAGS,
  withLabsPagesOffered,
} from '../helpers/labsPages.mjs';

const FLAGS_ENV = 'CANOPY_E2E_CLIENT_FEATURE_FLAGS';

function launcherLabsPageFlagKeys() {
  const source = readFileSync(
    new URL('../launchCanopy.mjs', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('const DEFAULT_E2E_CLIENT_FEATURE_FLAGS = {');
  assert.notEqual(start, -1, 'launcher flag defaults not found');
  const block = source.slice(start, source.indexOf('\n};', start));
  return [...block.matchAll(/'(canopy-desktop-labs-[a-z-]+-page)'/g)]
    .map((match) => match[1])
    .sort();
}

test('the helper covers every Labs page flag the launcher pins', () => {
  const pinned = launcherLabsPageFlagKeys();
  assert.ok(pinned.length > 0);
  assert.deepEqual(Object.keys(LABS_PAGES_OFFERED_FLAGS).sort(), pinned);
  for (const value of Object.values(LABS_PAGES_OFFERED_FLAGS)) {
    assert.equal(value, 'offered');
  }
});

test('withLabsPagesOffered keeps other env and lets explicit flags win', () => {
  const env = withLabsPagesOffered({
    HOME: '/tmp/home',
    [FLAGS_ENV]: JSON.stringify({
      'canopy-portal-enabled': false,
      'canopy-desktop-labs-kanban-page': 'on',
    }),
  });
  assert.equal(env.HOME, '/tmp/home');
  assert.deepEqual(JSON.parse(env[FLAGS_ENV]), {
    ...LABS_PAGES_OFFERED_FLAGS,
    'canopy-portal-enabled': false,
    'canopy-desktop-labs-kanban-page': 'on',
  });
  assert.deepEqual(
    JSON.parse(withLabsPagesOffered()[FLAGS_ENV]),
    LABS_PAGES_OFFERED_FLAGS,
  );
});

test('withLabsPagesOffered leaves a non-object flags value untouched', () => {
  for (const raw of ['not json', '[]', 'null', '"on"']) {
    const env = { [FLAGS_ENV]: raw };
    assert.equal(withLabsPagesOffered(env), env);
  }
});
