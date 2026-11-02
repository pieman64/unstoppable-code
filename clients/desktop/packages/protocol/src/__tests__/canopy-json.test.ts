import {
  CANOPY_JSON_ID_PATTERN,
  CANOPY_JSON_REPO_ENTRY_KEYS,
  isCanopyJsonId,
  readCanopyJsonRepoEntries,
} from '../canopy-json';

describe('isCanopyJsonId', () => {
  it.each(['web', 'a', '0', '9lives', 'api-server', 'a--b', 'a-', 'repo-2'])(
    'accepts %j',
    (id) => {
      expect(isCanopyJsonId(id)).toBe(true);
    },
  );

  it.each([
    '',
    '-web',
    'Web',
    'WEB',
    'web_app',
    'web.app',
    '.web',
    '..',
    'a/b',
    '/web',
    'web/',
    'a\\b',
    'web ',
    ' web',
    'web\n',
    'wéb',
  ])('rejects %j', (id) => {
    expect(isCanopyJsonId(id)).toBe(false);
  });

  it.each([undefined, null, 1, true, {}, [], ['web']])(
    'rejects the non-string %j',
    (value) => {
      expect(isCanopyJsonId(value)).toBe(false);
    },
  );

  it('exposes the pattern the id check uses', () => {
    expect(CANOPY_JSON_ID_PATTERN.source).toBe('^[a-z0-9][a-z0-9-]*$');
    expect(CANOPY_JSON_ID_PATTERN.global).toBe(false);
  });
});

describe('readCanopyJsonRepoEntries', () => {
  const entry = {
    id: 'web',
    name: 'Web',
    url: 'https://github.com/acme/web',
  };

  it('names the keys of a repo entry', () => {
    expect(CANOPY_JSON_REPO_ENTRY_KEYS).toEqual([
      'id',
      'name',
      'url',
      'scripts',
      'hooks',
    ]);
  });

  it('reads an empty list as no repos', () => {
    expect(readCanopyJsonRepoEntries([])).toEqual({ ok: true, repos: [] });
  });

  it('reads entries in order', () => {
    expect(
      readCanopyJsonRepoEntries([
        entry,
        { id: 'api', name: 'API', url: 'https://github.com/acme/api' },
      ]),
    ).toEqual({
      ok: true,
      repos: [
        entry,
        { id: 'api', name: 'API', url: 'https://github.com/acme/api' },
      ],
    });
  });

  it('trims the name and the url', () => {
    expect(
      readCanopyJsonRepoEntries([
        { id: 'web', name: '  Web \n', url: '\thttps://github.com/acme/web  ' },
      ]),
    ).toEqual({ ok: true, repos: [entry] });
  });

  it('does not check the url format', () => {
    expect(readCanopyJsonRepoEntries([{ ...entry, url: 'not a url' }])).toEqual(
      { ok: true, repos: [{ ...entry, url: 'not a url' }] },
    );
  });

  it('keeps scripts unvalidated and drops hooks and unknown keys', () => {
    const scripts = { setup: { command: 'pnpm i' }, launch: null, bad: 3 };
    expect(
      readCanopyJsonRepoEntries([
        {
          ...entry,
          scripts,
          hooks: { 'pr:merged': [] },
          path: 'apps/web',
          branch: 'main',
          extra: true,
        },
      ]),
    ).toEqual({ ok: true, repos: [{ ...entry, scripts }] });
  });

  it('keeps an empty scripts object', () => {
    expect(readCanopyJsonRepoEntries([{ ...entry, scripts: {} }])).toEqual({
      ok: true,
      repos: [{ ...entry, scripts: {} }],
    });
  });

  it.each([undefined, null, {}, 'web', 1, true])(
    'rejects %j as not an array',
    (value) => {
      expect(readCanopyJsonRepoEntries(value)).toEqual({
        ok: false,
        reason: 'not-an-array',
      });
    },
  );

  it.each([null, 'web', 1, true, [], [entry]])(
    'rejects the entry %j as not an object',
    (bad) => {
      expect(readCanopyJsonRepoEntries([entry, bad])).toEqual({
        ok: false,
        reason: 'entry-not-an-object',
        index: 1,
      });
    },
  );

  it.each([
    undefined,
    null,
    1,
    '',
    '-web',
    'Web',
    'web.app',
    '..',
    'a/b',
    ['web'],
  ])('rejects the id %j', (id) => {
    expect(readCanopyJsonRepoEntries([{ ...entry, id }])).toEqual({
      ok: false,
      reason: 'invalid-id',
      index: 0,
    });
  });

  it.each([undefined, null, 1, '', '   ', '\n\t'])(
    'rejects the name %j',
    (name) => {
      expect(
        readCanopyJsonRepoEntries([entry, { ...entry, id: 'api', name }]),
      ).toEqual({ ok: false, reason: 'missing-name', index: 1 });
    },
  );

  it.each([undefined, null, 1, '', '   ', '\n\t'])(
    'rejects the url %j',
    (url) => {
      expect(readCanopyJsonRepoEntries([{ ...entry, url }])).toEqual({
        ok: false,
        reason: 'missing-url',
        index: 0,
      });
    },
  );

  it.each([null, 'setup', 1, true, []])(
    'rejects the scripts value %j',
    (scripts) => {
      expect(readCanopyJsonRepoEntries([{ ...entry, scripts }])).toEqual({
        ok: false,
        reason: 'invalid-scripts',
        index: 0,
      });
    },
  );

  it('rejects a duplicate id at the later entry', () => {
    expect(
      readCanopyJsonRepoEntries([
        entry,
        { id: 'api', name: 'API', url: 'https://github.com/acme/api' },
        { ...entry, name: 'Web again' },
      ]),
    ).toEqual({ ok: false, reason: 'duplicate-id', index: 2 });
  });

  it('reports the first failing entry', () => {
    expect(
      readCanopyJsonRepoEntries([entry, { ...entry, id: 'Bad' }, null]),
    ).toEqual({ ok: false, reason: 'invalid-id', index: 1 });
  });
});
