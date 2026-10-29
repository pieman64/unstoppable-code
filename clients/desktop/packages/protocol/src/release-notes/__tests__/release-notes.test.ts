import {
  parseReleaseNotesFeed,
  applyReleaseNotesBrand,
  changelogAnchor,
  changelogPath,
  changelogUrl,
  compareReleaseVersions,
  decideReleaseHighlights,
  parseReleaseVersion,
  isPublishedReleaseNotesEntry,
  publishedReleaseNotesEntries,
  resolveReleaseNotesEntry,
  validateReleaseNotesCatalog,
  type ReleaseHighlightsDecision,
  type ReleaseNotesEntry,
} from '../index';

function entry(version: string, releasedOn?: string): ReleaseNotesEntry {
  return {
    version,
    ...(releasedOn === undefined ? {} : { releasedOn }),
    highlights: [{ title: 'First' }, { title: 'Second' }, { title: 'Third' }],
  };
}

const RELEASED_ON = '2026-09-01';
function published(version: string): ReleaseNotesEntry {
  return entry(version, RELEASED_ON);
}

// Published catalog: stable builds present only published entries.
const entries = [
  published('2.0.0'),
  published('1.10.0'),
  published('1.9.2'),
  published('1.9.0'),
  published('1.8.0'),
];

describe('release versions', () => {
  it.each(['1.9.0', 'v1.9.0', '1.9.0-rc.1', 'v1.9.0-rc.12'])(
    'parses %s with one stable identity',
    (version) => {
      expect(parseReleaseVersion(version)).toMatchObject({
        major: 1,
        minor: 9,
        patch: 0,
        normalized: '1.9.0',
      });
    },
  );
  it('retains the RC number for preview consumers', () => {
    expect(parseReleaseVersion('v1.9.0-rc.12')?.rc).toBe(12);
    expect(parseReleaseVersion('1.9.0')?.rc).toBeNull();
  });
  it.each([
    '',
    'internal-123',
    '9999.0.0-internal.123',
    '1.9',
    '1.9.0.0',
    '1.9.0-beta.1',
    '1.9.0+build',
    '1.9.0-rc',
    '1.9.0-rc.-1',
    '1.9.0-rc.01',
    '01.9.0',
    '1.09.0',
    '1.9.00',
    '-1.9.0',
    ' 1.9.0 ',
    '1.9.0\n',
    '9007199254740992.0.0',
    '1.9007199254740992.0',
    '1.9.9007199254740992',
    '1.9.0-rc.9007199254740992',
  ])('rejects %p', (version) =>
    expect(parseReleaseVersion(version)).toBeNull(),
  );
  it('accepts safe numeric boundaries', () => {
    expect(parseReleaseVersion('9007199254740991.0.0')?.major).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
  it.each([
    ['1.9.0', '1.10.0', -1],
    ['2.0.0', '1.99.99', 1],
    ['1.9.9', '1.9.10', -1],
    ['1.9.0-rc.1', '1.9.0', 0],
  ] as const)('compares %s and %s numerically', (left, right, expected) => {
    const a = parseReleaseVersion(left);
    const b = parseReleaseVersion(right);
    if (!a || !b) throw new Error('Invalid test version');
    expect(compareReleaseVersions(a, b)).toBe(expected);
  });
});

describe('entry resolution', () => {
  it.each([
    ['1.9.0', '1.9.0'],
    ['v1.9.0-rc.2', null],
    ['1.9.1', null],
    ['1.9.2', '1.9.2'],
    ['1.9.99', null],
    ['1.10.0', '1.10.0'],
    ['1.7.9', null],
    ['3.9.0', null],
    ['internal-123', null],
  ])('resolves %s only for the exact stable version', (version, expected) => {
    expect(
      resolveReleaseNotesEntry(version ?? '', entries)?.version ?? null,
    ).toBe(expected);
  });
  it('returns no entry for an empty catalog or a future-only patch', () => {
    expect(resolveReleaseNotesEntry('1.9.0', [])).toBeNull();
    expect(resolveReleaseNotesEntry('1.9.0', [entry('1.9.2')])).toBeNull();
  });
  it('selects an exact patch regardless of input order', () => {
    expect(
      resolveReleaseNotesEntry('1.9.2', [...entries].reverse())?.version,
    ).toBe('1.9.2');
  });
  it('does not use a noncanonical entry as an identity', () => {
    expect(
      resolveReleaseNotesEntry('1.9.9', [entry('v1.9.2'), entry('1.9.0-rc.1')]),
    ).toBeNull();
  });
});

describe('automatic eligibility', () => {
  it.each(['1.8.0', '1.9.0'])(
    'presents exact patch notes published after an unmatched launch with history %s',
    (lastSeenVersion) => {
      const eligibility = {
        currentVersion: '1.9.1',
        lastSeenVersion,
        onboardingCompletedAtInitialSnapshot: true,
      };
      const inherited = decideReleaseHighlights(eligibility, [
        published('1.9.0'),
      ]);
      const recorded =
        inherited.action === 'none' ? lastSeenVersion : inherited.version;
      expect(recorded).toBe(lastSeenVersion);
      const later = decideReleaseHighlights(
        { ...eligibility, lastSeenVersion: recorded },
        [published('1.9.1'), published('1.9.0')],
      );
      expect(later).toEqual({
        action: 'show',
        entry: published('1.9.1'),
        version: '1.9.1',
      });
      expect(
        decideReleaseHighlights({ ...eligibility, lastSeenVersion: '1.9.1' }, [
          published('1.9.1'),
          published('1.9.0'),
        ]),
      ).toEqual({ action: 'none' });
    },
  );

  function decide(
    currentVersion: string,
    lastSeenVersion: string | null,
    onboardingCompletedAtInitialSnapshot = true,
  ): ReleaseHighlightsDecision {
    return decideReleaseHighlights(
      { currentVersion, lastSeenVersion, onboardingCompletedAtInitialSnapshot },
      entries,
    );
  }
  it.each(['internal-123', '1.9.0-beta.1', 'bad'])(
    'preserves history for unsupported %s',
    (version) => {
      expect(decide(version, '1.8.0')).toEqual({ action: 'none' });
    },
  );
  it.each(['1.9.2', 'v1.9.2-rc.1', '1.9.1', '1.8.0'])(
    'never lowers a 1.9.2 watermark for %s',
    (version) => {
      expect(decide(version, '1.9.2')).toEqual({ action: 'none' });
    },
  );
  it('does not silently mark a fresh install or an RC as seen', () => {
    expect(decide('v1.9.0-rc.1', null, false)).toEqual({ action: 'none' });
    expect(decide('1.9.0', 'broken', false)).toEqual({
      action: 'show',
      entry: published('1.9.0'),
      version: '1.9.0',
    });
    expect(decide('1.9.1', null, false)).toEqual({ action: 'none' });
  });
  it.each([null, '', 'broken', 'internal-123'])(
    'shows the current entry for an existing user with history %p',
    (lastSeen) => {
      expect(decide('1.9.0', lastSeen)).toEqual({
        action: 'show',
        entry: published('1.9.0'),
        version: '1.9.0',
      });
    },
  );
  it('queues only the latest applicable entry after skipped releases', () => {
    expect(decide('2.0.0', '1.8.0')).toEqual({
      action: 'show',
      entry: published('2.0.0'),
      version: '2.0.0',
    });
  });
  it('shows explicit patch highlights but preserves history for inherited patches', () => {
    expect(decide('1.9.2', '1.9.1')).toEqual({
      action: 'show',
      entry: published('1.9.2'),
      version: '1.9.2',
    });
    expect(decide('1.9.3', '1.9.2')).toEqual({ action: 'none' });
  });
  it('deduplicates RC-to-stable and RC-to-RC runs', () => {
    expect(decide('1.9.0', 'v1.9.0-rc.1')).toEqual({ action: 'none' });
    expect(decide('1.9.0-rc.2', '1.9.0-rc.1')).toEqual({ action: 'none' });
  });
  it('stays quiet on downgrade, internal runs, and return to the recorded release', () => {
    for (const current of ['1.8.0', 'internal-1', '1.9.2']) {
      expect(decide(current, '1.9.2')).toEqual({ action: 'none' });
    }
  });
  it('leaves the watermark alone for releases with no catalog entry so a later entry still shows', () => {
    expect(decide('1.11.0', '1.9.2')).toEqual({ action: 'none' });
    expect(
      decideReleaseHighlights(
        {
          currentVersion: '1.9.0',
          lastSeenVersion: null,
          onboardingCompletedAtInitialSnapshot: true,
        },
        [],
      ),
    ).toEqual({ action: 'none' });
    // 1.11.0 shipped without an entry; 1.11.1 adds and publishes it.
    expect(decide('1.11.1', '1.9.2')).toEqual({ action: 'none' });
    expect(
      decideReleaseHighlights(
        {
          currentVersion: '1.11.1',
          lastSeenVersion: '1.9.2',
          onboardingCompletedAtInitialSnapshot: true,
        },
        [published('1.11.1'), ...entries],
      ),
    ).toEqual({
      action: 'show',
      entry: published('1.11.1'),
      version: '1.11.1',
    });
  });
  it('uses valid history even when onboarding has no marker', () => {
    expect(decide('1.9.0', '1.8.0', false).action).toBe('show');
  });
  it('stays quiet for drafts and RCs, and presents exact notes once published', () => {
    const withDraft = [entry('1.11.0'), ...entries];
    const eligibility = {
      lastSeenVersion: '1.9.2',
      onboardingCompletedAtInitialSnapshot: true,
    };
    // Stable + draft: no popup and no watermark move.
    expect(
      decideReleaseHighlights(
        { ...eligibility, currentVersion: '1.11.0' },
        withDraft,
      ),
    ).toEqual({ action: 'none' });
    expect(
      decideReleaseHighlights(
        { ...eligibility, currentVersion: 'v1.11.0-rc.1' },
        withDraft,
      ),
    ).toEqual({ action: 'none' });
    // The watermark stayed at 1.9.2, so a later patch that publishes the
    // entry still presents it once.
    expect(
      decideReleaseHighlights({ ...eligibility, currentVersion: '1.11.1' }, [
        published('1.11.1'),
        ...entries,
      ]),
    ).toEqual({
      action: 'show',
      entry: published('1.11.1'),
      version: '1.11.1',
    });
  });
});

describe('catalog and public projections', () => {
  const branded: ReleaseNotesEntry = {
    ...entry('1.9.0', '2026-10-07'),
    headline: 'Welcome to {app}',
    highlights: [
      { title: '{app} title', description: '{app} description' },
      { title: 'Second' },
      { title: 'Third' },
    ],
    details: [
      { heading: '{app} heading', items: ['{app} item', '{app} and {app}'] },
    ],
  };
  it('brands every text field without mutating the source, including literal replacement characters', () => {
    const snapshot = JSON.stringify(branded);
    const result = applyReleaseNotesBrand(branded, { appName: '$& Product' });
    expect(result.headline).toBe('Welcome to $& Product');
    expect(result.highlights[0]).toEqual({
      title: '$& Product title',
      description: '$& Product description',
    });
    expect(result.details).toEqual([
      {
        heading: '$& Product heading',
        items: ['$& Product item', '$& Product and $& Product'],
      },
    ]);
    expect(result).not.toBe(branded);
    expect(result.highlights).not.toBe(branded.highlights);
    expect(JSON.stringify(branded)).toBe(snapshot);
  });
  it('keeps optional fields absent', () => {
    expect(
      applyReleaseNotesBrand(entry('1.9.0'), { appName: 'Product' }),
    ).toEqual(entry('1.9.0'));
  });
  it('decodes only public display data and rejects drafts or malformed feeds', () => {
    const publicEntry = published('1.9.0');
    expect(
      parseReleaseNotesFeed(
        JSON.stringify({
          schemaVersion: 1,
          entries: [
            { ...publicEntry, sourceSha: 'private', review: 'private' },
          ],
        }),
      ),
    ).toEqual({ schemaVersion: 1, entries: [publicEntry] });
    for (const data of [
      null,
      [],
      { schemaVersion: 2, entries: [] },
      { schemaVersion: 1, entries: [entry('1.9.0')] },
      { schemaVersion: 1, entries: [publicEntry, publicEntry] },
      {
        schemaVersion: 1,
        entries: [{ ...publicEntry, highlights: 'invalid' }],
      },
    ]) {
      expect(() => parseReleaseNotesFeed(JSON.stringify(data))).toThrow();
    }
  });
  it.each([
    'v1.9.0',
    '01.9.0',
    '1.9.0-rc.1',
    'internal-1',
    '9007199254740992.0.0',
  ])('rejects noncanonical catalog identity %s', (version) =>
    expect(() => validateReleaseNotesCatalog([entry(version)])).toThrow(),
  );
  it('rejects duplicates and incorrect numeric ordering', () => {
    expect(() =>
      validateReleaseNotesCatalog([entry('1.9.0'), entry('1.9.0')]),
    ).toThrow();
    expect(() =>
      validateReleaseNotesCatalog([entry('1.9.0'), entry('1.10.0')]),
    ).toThrow();
    expect(() => validateReleaseNotesCatalog(entries)).not.toThrow();
    expect(() => validateReleaseNotesCatalog([])).not.toThrow();
  });
  it.each(['2026-02-29', '2026-04-31', '2026-13-01', '2026-1-01', '', 'today'])(
    'rejects invalid publication date %s',
    (date) => {
      expect(() =>
        validateReleaseNotesCatalog([entry('1.9.0', date)]),
      ).toThrow();
      expect(publishedReleaseNotesEntries([entry('1.9.0', date)])).toEqual([]);
      expect(changelogPath(entry('1.9.0', date))).toBe('/changelog');
    },
  );
  it('publishes only canonical stable versions with a valid date', () => {
    expect(isPublishedReleaseNotesEntry(entry('1.9.0', '2026-10-07'))).toBe(
      true,
    );
    expect(isPublishedReleaseNotesEntry(entry('1.9.0'))).toBe(false);
    expect(isPublishedReleaseNotesEntry(entry('v1.9.0', '2026-10-07'))).toBe(
      false,
    );
    expect(
      isPublishedReleaseNotesEntry(entry('1.9.0-rc.1', '2026-10-07')),
    ).toBe(false);
    // A malformed version never reaches `changelogAnchor` through the page.
    expect(
      publishedReleaseNotesEntries([
        entry('v1.9.0', '2026-10-07'),
        entry('1.9.0', '2026-10-07'),
      ]),
    ).toEqual([entry('1.9.0', '2026-10-07')]);
    expect(changelogPath(entry('v1.9.0', '2026-10-07'))).toBe('/changelog');
  });
  it('accepts a leap day and includes only published entries in catalog order', () => {
    const published = [
      entry('1.10.0', '2026-10-07'),
      entry('1.9.0', '2024-02-29'),
    ];
    expect(() => validateReleaseNotesCatalog(published)).not.toThrow();
    expect(
      publishedReleaseNotesEntries([entry('2.0.0'), ...published]),
    ).toEqual(published);
  });
  it('requires 3–5 non-empty highlights and supported tokens in every field', () => {
    for (const highlights of [
      [],
      [{ title: 'First' }],
      Array.from({ length: 6 }, () => ({ title: 'Title' })),
    ]) {
      expect(() =>
        validateReleaseNotesCatalog([{ ...entry('1.9.0'), highlights }]),
      ).toThrow();
    }
    const invalid = [
      { ...branded, headline: ' ' },
      { ...branded, headline: '{other}' },
      { ...branded, headline: 'Try {other' },
      { ...branded, headline: 'Try other}' },
      { ...branded, headline: '{app}}' },
      {
        ...branded,
        highlights: [{ title: '' }, { title: 'Second' }, { title: 'Third' }],
      },
      {
        ...branded,
        highlights: [
          { title: 'First', description: '{other}' },
          { title: 'Second' },
          { title: 'Third' },
        ],
      },
      { ...branded, details: [{ heading: ' ', items: ['Item'] }] },
      { ...branded, details: [{ heading: 'Details', items: ['{other}'] }] },
    ];
    for (const invalidEntry of invalid)
      expect(() => validateReleaseNotesCatalog([invalidEntry])).toThrow();
  });
  it('produces stable published anchors and root paths for drafts and fixtures', () => {
    expect(changelogAnchor('1.9.0')).toBe('v1-9-0');
    expect(changelogPath(branded)).toBe('/changelog?version=1.9.0#v1-9-0');
    expect(changelogPath()).toBe('/changelog');
    expect(changelogPath(entry('99.0.0'))).toBe('/changelog');
    expect(() => changelogAnchor('v1.9.0')).toThrow();
  });
  it.each([
    'https://example.test',
    'https://example.test/',
    'https://example.test/base/path?old=query#old',
  ])('constructs URLs from configured origin %s', (origin) => {
    expect(changelogUrl(origin, branded)).toBe(
      'https://example.test/changelog?version=1.9.0#v1-9-0',
    );
    expect(changelogUrl(origin, entry('99.0.0'))).toBe(
      'https://example.test/changelog',
    );
  });
  it.each(['', 'broken', 'file:///tmp/path', 'javascript:alert(1)'])(
    'hides the destination when origin is unavailable or invalid %p',
    (origin) => expect(changelogUrl(origin, branded)).toBeNull(),
  );
});

describe('database release identity', () => {
  it.each(['1.9.1', '1.9.99', '1.9.0-rc.1'])(
    'never offers 1.9.0 notes to %s',
    (version) => {
      expect(
        resolveReleaseNotesEntry(version, [published('1.9.0')]),
      ).toBeNull();
    },
  );
  it('shows a matching published release on the first launch after startup gates', () => {
    expect(
      decideReleaseHighlights(
        {
          currentVersion: '1.9.0',
          lastSeenVersion: null,
          onboardingCompletedAtInitialSnapshot: false,
        },
        [published('1.9.0')],
      ),
    ).toEqual({ action: 'show', entry: published('1.9.0'), version: '1.9.0' });
  });
});
