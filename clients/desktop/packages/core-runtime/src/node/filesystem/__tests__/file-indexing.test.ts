import {
  buildFileGlobMatcher,
  buildFileExplorerGlobMatcher,
  normalizeFileIndexingPreferences,
  type FileIndexingMatchPolicy,
  type FileGlobMatcher,
} from '../../index';
import {
  BUILTIN_INDEX_GLOB_IDS,
  createDefaultFileIndexingPreferences,
  getBuiltinIndexGlob,
  type FileIndexingPreferences,
} from '@canopy/protocol/file-indexing';

it('creates isolated portable defaults and exact builtin lookups', () => {
  const first = createDefaultFileIndexingPreferences();
  const second = createDefaultFileIndexingPreferences();
  expect(first).not.toBe(second);
  first.disabledBuiltinGlobIds.push('gradle');
  first.customGlobs.push({ id: 'x', pattern: 'x', enabled: true });
  expect(second).toEqual({ disabledBuiltinGlobIds: [], customGlobs: [] });
  expect(getBuiltinIndexGlob('node-modules')).toEqual({
    id: 'node-modules',
    label: 'Node dependencies',
    pattern: '**/node_modules/**',
  });
  expect(getBuiltinIndexGlob(' node-modules')).toBeUndefined();
  expect(getBuiltinIndexGlob('NODE-MODULES')).toBeUndefined();
  expect(BUILTIN_INDEX_GLOB_IDS.size).toBe(12);
});

it.each([
  undefined,
  null,
  false,
  0,
  '',
  [],
  'invalid',
  { customGlobs: {}, disabledBuiltinGlobIds: 'gradle' },
])('normalizes malformed portable input %p to fresh defaults', (value) => {
  const first = normalizeFileIndexingPreferences(value);
  const second = normalizeFileIndexingPreferences(value);
  first.disabledBuiltinGlobIds.push('gradle');
  first.customGlobs.push({ id: 'x', pattern: 'x', enabled: true });
  expect(second).toEqual({ disabledBuiltinGlobIds: [], customGlobs: [] });
});

it('normalizes literal malformed records without id deduplication or glob validation', () => {
  expect(
    normalizeFileIndexingPreferences({
      disabledBuiltinGlobIds: [
        'node-modules',
        ' node-modules',
        'NODE-MODULES',
        'node-modules ',
        'unknown',
        null,
        1,
        'gradle',
        'node-modules',
      ],
      customGlobs: [
        null,
        [],
        'bad',
        {},
        { pattern: 1 },
        { pattern: ' ' },
        { id: ' same ', pattern: ' café/** ', enabled: false },
        { id: 'discarded', pattern: 'café/**', enabled: true },
        { id: 'same', pattern: 'CAFÉ/**', enabled: 0 },
        { pattern: 'café/**' },
        { id: ' ', pattern: 'logs/**' },
        { pattern: 'cafe\u0301/**', enabled: 'yes' },
        { id: 5, pattern: '[' },
        { pattern: ' café/** ', enabled: true },
        { pattern: ' ! ' },
      ],
    }),
  ).toEqual({
    disabledBuiltinGlobIds: ['node-modules', 'gradle'],
    customGlobs: [
      { id: 'same', pattern: 'café/**', enabled: false },
      { id: 'same', pattern: 'CAFÉ/**', enabled: true },
      { id: 'custom-b616456d7375', pattern: 'logs/**', enabled: true },
      { id: 'custom-2207e03a1c83', pattern: 'cafe\u0301/**', enabled: true },
      { id: 'custom-245843abef9e', pattern: '[', enabled: true },
      { id: 'custom-bb7208bc9b5d', pattern: '!', enabled: true },
    ],
  });
  expect(
    normalizeFileIndexingPreferences({
      customGlobs: [{ pattern: ' café/** ' }, { pattern: 'CAFÉ/**' }],
    }).customGlobs,
  ).toEqual([
    { id: 'custom-cadf99727580', pattern: 'café/**', enabled: true },
    { id: 'custom-ea4cc135ba0e', pattern: 'CAFÉ/**', enabled: true },
  ]);
});

describe.each([true, false])(
  'portable matcher caseSensitive=%s',
  (caseSensitive) => {
    const policy: FileIndexingMatchPolicy = { caseSensitive };
    it('keeps literal git exclusion when every optional pattern is disabled', () => {
      const matcher = buildFileGlobMatcher(
        {
          disabledBuiltinGlobIds: Array.from(BUILTIN_INDEX_GLOB_IDS),
          customGlobs: [
            { id: 'off', pattern: '**', enabled: false },
            { id: 'blank', pattern: ' ', enabled: true },
          ],
        },
        policy,
      );
      expect(matcher.patterns).toEqual([]);
      for (const kind of ['file', 'directory'] as const) {
        for (const path of [
          '',
          '///',
          '\\\\',
          ' ',
          'node_modules/x',
          '.pnpm-store/x',
          'target/x',
          '.GIT/config',
          '日本語/文書.txt',
        ]) {
          expect(matcher.isIndexExcluded(path, kind)).toBe(false);
        }
        expect(matcher.isIndexExcluded('.git', kind)).toBe(true);
        expect(matcher.isIndexExcluded('///a\\.git\\config', kind)).toBe(true);
      }
    });

    it.each([
      ['[', '[', true, true],
      ['[', 'other', false, false],
      ['!', ' ', true, true],
      ['!', '///', false, false],
      ['!foo', 'foo', false, true],
      ['!foo', 'bar', true, true],
      ['{a,b}', 'a', true, true],
      ['{a,b}', 'c', false, false],
      ['!(foo)', 'a/b', false, false],
      ['*', '.hidden', true, true],
      ['[abc', '[abc', true, true],
    ] as const)(
      'retains permissive pattern %p on path %p',
      (pattern, path, file, directory) => {
        const preferences = normalizeFileIndexingPreferences({
          disabledBuiltinGlobIds: [...BUILTIN_INDEX_GLOB_IDS],
          customGlobs: [{ pattern }],
        });
        const matcher = buildFileGlobMatcher(preferences, policy);
        expect(matcher.patterns).toEqual([pattern]);
        expect(matcher.isIndexExcluded(path, 'file')).toBe(file);
        expect(matcher.isIndexExcluded(path, 'directory')).toBe(directory);
      },
    );

    it('does not reactivate a disabled first duplicate during matcher construction', () => {
      const preferences = normalizeFileIndexingPreferences({
        disabledBuiltinGlobIds: [...BUILTIN_INDEX_GLOB_IDS],
        customGlobs: [
          { id: 'same', pattern: ' logs/** ', enabled: false },
          { id: 'later', pattern: 'logs/**', enabled: true },
          { id: 'same', pattern: 'other/**', enabled: true },
        ],
      });
      const matcher = buildFileGlobMatcher(preferences, policy);
      expect(matcher.patterns).toEqual(['other/**']);
      expect(matcher.isIndexExcluded('logs/x', 'file')).toBe(false);
      expect(matcher.isIndexExcluded('other/x', 'file')).toBe(true);
    });

    it('preserves path, Unicode, git, dot and directory-suffix semantics', () => {
      const preferences: FileIndexingPreferences = {
        disabledBuiltinGlobIds: ['node-modules'],
        customGlobs: [
          { id: 'c', pattern: ' café/** ', enabled: true },
          { id: 'n', pattern: '日本語/**', enabled: true },
          { id: 'h', pattern: '.hidden/**', enabled: true },
          { id: 'd', pattern: 'disabled/**', enabled: false },
          { id: 'blank', pattern: ' ', enabled: true },
          { id: 'suffix', pattern: 'only/child', enabled: true },
          { id: 'slash', pattern: 'slash/', enabled: true },
        ],
      };
      const matcher: FileGlobMatcher = buildFileGlobMatcher(
        preferences,
        policy,
      );
      expect(matcher.patterns).toEqual([
        '**/bower_components/**',
        '**/.pnpm-store/**',
        '**/.yarn/cache/**',
        '**/.yarn/unplugged/**',
        '**/{.venv,venv,env}/**',
        '**/{__pycache__,.pytest_cache,.mypy_cache,.ruff_cache}/**',
        '**/.tox/**',
        '**/.nox/**',
        '**/vendor/bundle/**',
        '**/.gradle/**',
        '**/target/**',
        'café/**',
        '日本語/**',
        '.hidden/**',
        'only/child',
        'slash/',
      ]);
      for (const [path, expected] of [
        ['', false],
        ['///', false],
        ['\\\\', false],
        [' ', false],
        ['/.git/config', true],
        ['a\\.git\\config', true],
        ['.git', true],
        ['.GIT/config', false],
        ['a/.Git/config', false],
        ['.gitignore', false],
        [' .git/config', false],
        ['a/.git /config', false],
        ['node_modules/x', false],
        ['café/x', true],
        ['CAFÉ/x', !caseSensitive],
        ['cafe\u0301/x', false],
        ['日本語/文書.txt', true],
        ['.hidden/x', true],
        ['///.pnpm-store\\x', true],
        ['build/x', false],
        ['dist/x', false],
        ['disabled/x', false],
        ['only', false],
        ['slash', false],
      ] as const)
        expect(matcher.isIndexExcluded(path, 'file')).toBe(expected);
      for (const path of [
        'only',
        'slash',
        '.hidden',
        'café',
        '日本語',
        '.pnpm-store',
      ]) {
        expect(matcher.isIndexExcluded(path, 'directory')).toBe(true);
      }
      expect(matcher.isIndexExcluded('', 'directory')).toBe(false);
      const explorer = buildFileExplorerGlobMatcher(policy);
      expect(explorer.patterns).toEqual([]);
      for (const path of [
        '',
        ' ',
        '///',
        '.GIT/config',
        'node_modules/x',
        '.hidden/x',
        'café/x',
        '日本語/文書.txt',
      ]) {
        expect(explorer.isIndexExcluded(path, 'file')).toBe(false);
      }
      expect(explorer.isIndexExcluded('a\\.git\\config', 'directory')).toBe(
        true,
      );
      expect(explorer.isTraversalDeferred?.('///node_modules')).toBe(true);
      expect(explorer.isTraversalDeferred?.('NODE_MODULES')).toBe(
        !caseSensitive,
      );
      expect(explorer.isTraversalDeferred?.('.pnpm-store')).toBe(true);
      for (const path of [
        '',
        ' ',
        '///',
        '.git',
        '.GIT',
        'build',
        'dist',
        'café',
        '日本語',
      ]) {
        expect(explorer.isTraversalDeferred?.(path)).toBe(false);
      }
    });
  },
);
