import { readCanopyJsonRepoEntries } from '@canopy/protocol/canopy-json';
import { validateCanopyJson } from '../canopy-json';

/**
 * REG-3023: Canopy Web reads canopy.json `repos[]` through the shared reader in
 * `@canopy/protocol/canopy-json`, Canopy Desktop through `validateCanopyJson`.
 * Both must accept and reject the same `repos` values and agree on each
 * accepted repo's `{ id, name, url }`.
 *
 * Out of scope here: the shared reader leaves the values inside `scripts` (and
 * all of `hooks`) to its consumer, so the fixtures keep those valid.
 */
const URL = 'https://github.com/acme/web';
const entry = { id: 'web', name: 'Web', url: URL };

const acceptedRepos: ReadonlyArray<readonly [string, unknown]> = [
  ['an empty list', []],
  ['one repo', [entry]],
  [
    'two repos',
    [entry, { id: 'api-2', name: 'API', url: 'https://github.com/acme/api' }],
  ],
  ['a digit-leading id', [{ ...entry, id: '9lives' }]],
  ['a padded name and url', [{ ...entry, name: '  Web  ', url: ` ${URL}\n` }]],
  ['a non-URL url', [{ ...entry, url: 'git@github.com:acme/web.git' }]],
  ['unknown keys', [{ ...entry, path: 'apps/web', branch: 'main', extra: 1 }]],
  ['empty scripts and hooks', [{ ...entry, scripts: {}, hooks: {} }]],
  [
    'valid scripts',
    [
      {
        ...entry,
        scripts: { setup: 'pnpm install', launch: { command: 'pnpm dev' } },
      },
    ],
  ],
  ['a disabled script', [{ ...entry, scripts: { setup: null } }]],
  ['a disabled hook', [{ ...entry, hooks: { 'pr:merged': null } }]],
];

const rejectedRepos: ReadonlyArray<readonly [string, unknown]> = [
  ['undefined', undefined],
  ['null', null],
  ['an object', {}],
  ['a string', 'web'],
  ['a null entry', [null]],
  ['a string entry', ['web']],
  ['an array entry', [[entry]]],
  ['a missing id', [{ name: 'Web', url: URL }]],
  ['a numeric id', [{ ...entry, id: 1 }]],
  ['an empty id', [{ ...entry, id: '' }]],
  ['a leading-hyphen id', [{ ...entry, id: '-web' }]],
  ['an uppercase id', [{ ...entry, id: 'Web' }]],
  ['a dotted id', [{ ...entry, id: 'web.app' }]],
  ['a slash id', [{ ...entry, id: 'a/b' }]],
  ['a parent-directory id', [{ ...entry, id: '..' }]],
  ['an id with a trailing newline', [{ ...entry, id: 'web\n' }]],
  ['a missing name', [{ id: 'web', url: URL }]],
  ['a blank name', [{ ...entry, name: '  ' }]],
  ['a non-string name', [{ ...entry, name: 7 }]],
  ['a missing url', [{ id: 'web', name: 'Web' }]],
  ['a blank url', [{ ...entry, url: '\t' }]],
  ['a non-string url', [{ ...entry, url: {} }]],
  ['a duplicate id', [entry, { ...entry, name: 'Web again' }]],
  ['null scripts', [{ ...entry, scripts: null }]],
  ['array scripts', [{ ...entry, scripts: [] }]],
  ['string scripts', [{ ...entry, scripts: 'pnpm dev' }]],
];

function desktopRepos(
  repos: unknown,
): ReadonlyArray<{ id: string; name: string; url: string }> | null {
  try {
    const config = validateCanopyJson(
      { version: 1, repos },
      '/tmp/canopy.json',
    );
    return (config.repos ?? []).map(({ id, name, url }) => ({ id, name, url }));
  } catch {
    return null;
  }
}

function sharedRepos(
  repos: unknown,
): ReadonlyArray<{ id: string; name: string; url: string }> | null {
  const result = readCanopyJsonRepoEntries(repos);
  return result.ok
    ? result.repos.map(({ id, name, url }) => ({ id, name, url }))
    : null;
}

describe('canopy.json repos[] desktop parity', () => {
  it.each(acceptedRepos)(
    'both accept %s and read the same repos',
    (_label, repos) => {
      const desktop = desktopRepos(repos);
      expect(desktop).not.toBeNull();
      expect(sharedRepos(repos)).toEqual(desktop);
    },
  );

  it.each(rejectedRepos)('both reject %s', (_label, repos) => {
    expect(desktopRepos(repos)).toBeNull();
    expect(sharedRepos(repos)).toBeNull();
  });
});
