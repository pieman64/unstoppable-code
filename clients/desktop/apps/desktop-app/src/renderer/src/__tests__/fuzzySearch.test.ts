import type { FileIndexEntry } from '@canopy/desktop-shared/types';
import { fuzzyMatch, searchFiles } from '../lib/fuzzySearch';

describe('fuzzyMatch', () => {
  it('prefers exact matches over partial matches', () => {
    const exact = fuzzyMatch('chat', 'chat');
    const partial = fuzzyMatch('chat', 'chat-panel');

    expect(exact).not.toBeNull();
    expect(partial).not.toBeNull();
    if (!exact || !partial) {
      throw new Error('Expected fuzzy matches for both inputs');
    }
    expect(exact.score).toBeGreaterThan(partial.score);
  });

  it('returns null when characters cannot be found in order', () => {
    expect(fuzzyMatch('xyz', 'chat-input')).toBeNull();
  });
});

describe('searchFiles', () => {
  const repos = [
    {
      repoId: 'app',
      repoName: 'app',
      absolutePath: '/repo',
      rootKind: 'git-repo' as const,
      files: [
        {
          relativePath: 'src/components/ChatInput.tsx',
          filename: 'ChatInput.tsx',
          absolutePath: '/repo/src/components/ChatInput.tsx',
          isIgnored: false,
        },
        {
          relativePath: 'src/components/ChatPanel.tsx',
          filename: 'ChatPanel.tsx',
          absolutePath: '/repo/src/components/ChatPanel.tsx',
          isIgnored: false,
        },
        {
          relativePath: 'src/lib/input-utils.ts',
          filename: 'input-utils.ts',
          absolutePath: '/repo/src/lib/input-utils.ts',
          isIgnored: false,
        },
      ],
    },
  ];

  it('ranks filename matches ahead of path-only matches', () => {
    const results = searchFiles('chati', repos);

    expect(results[0]?.filename).toBe('ChatInput.tsx');
  });

  it('ranks quick-open matches by relative-path coverage before truncating', () => {
    const paths = [
      ...Array.from(
        { length: 120 },
        (_, i) => `docs/planning/topic-${i}/README.md`,
      ),
      'docs/README.md',
      'README.md',
      'r_e_a_d_m_e.md',
    ];
    const readmes = [
      {
        ...repos[0],
        files: paths.map((relativePath) => ({
          relativePath,
          filename: relativePath.slice(relativePath.lastIndexOf('/') + 1),
          absolutePath: `/repo/${relativePath}`,
          isIgnored: false,
        })),
      },
    ];
    const results = searchFiles(' README.md ', readmes, 50, 'path-coverage');
    expect(results.slice(0, 2).map((result) => result.relativePath)).toEqual([
      'README.md',
      'docs/README.md',
    ]);
    expect(results).toHaveLength(50);
    expect(
      results.some((result) => result.relativePath === 'r_e_a_d_m_e.md'),
    ).toBe(false);
    const all = searchFiles('readme.md', readmes, Infinity, 'path-coverage');
    expect(all).toHaveLength(paths.length);
    expect(all[all.length - 1]?.relativePath).toBe('r_e_a_d_m_e.md');
    expect(
      all[1]?.matchedIndices
        .map((index) => all[1].relativePath[index])
        .join(''),
    ).toBe('README.md');
  });

  it('uses repo-relative coverage across repositories and supports path queries', () => {
    const files = (root: string, paths: string[]): FileIndexEntry[] =>
      paths.map((relativePath) => ({
        relativePath,
        filename: relativePath.slice(relativePath.lastIndexOf('/') + 1),
        absolutePath: `${root}/${relativePath}`,
        isIgnored: false,
      }));
    const indexes = [
      { ...repos[0], files: files('/short', ['docs/planning/README.md']) },
      {
        ...repos[0],
        repoId: 'other',
        files: files('/very/long/checkout/root', [
          'README.md',
          'docs/README.md',
        ]),
      },
    ];
    expect(
      searchFiles('readme.md', indexes, 50, 'path-coverage')[0]?.repoId,
    ).toBe('other');
    expect(
      searchFiles('docs/readme', indexes, 50, 'path-coverage')[0]?.relativePath,
    ).toBe('docs/README.md');
  });

  it('preserves fuzzy match quality for non-substring quick-open queries', () => {
    const acronymFiles = [
      {
        ...repos[0],
        files: [
          {
            relativePath: 'scripts/ci.mjs',
            filename: 'ci.mjs',
            absolutePath: '/repo/scripts/ci.mjs',
            isIgnored: false,
          },
          {
            relativePath:
              'apps/desktop-app/src/renderer/src/components/chat/ChatInput.tsx',
            filename: 'ChatInput.tsx',
            absolutePath:
              '/repo/apps/desktop-app/src/renderer/src/components/chat/ChatInput.tsx',
            isIgnored: false,
          },
        ],
      },
    ];

    expect(
      searchFiles('cip', acronymFiles, 50, 'path-coverage')[0]?.filename,
    ).toBe('ChatInput.tsx');
  });

  it('includes absolute paths in search results', () => {
    const results = searchFiles('panel', repos);

    expect(results[0]).toMatchObject({
      filename: 'ChatPanel.tsx',
      absolutePath: '/repo/src/components/ChatPanel.tsx',
    });
  });

  it('keeps ignored files in the result list and propagates the isIgnored flag', () => {
    // Ignored files must remain searchable — the renderer dims them but
    // never filters them out. This guards against a regression where
    // isIgnored was treated as an exclusion instead of styling metadata.
    const reposWithIgnored = [
      {
        repoId: 'app',
        repoName: 'app',
        absolutePath: '/repo',
        rootKind: 'git-repo' as const,
        files: [
          {
            relativePath: 'src/components/ChatInput.tsx',
            filename: 'ChatInput.tsx',
            absolutePath: '/repo/src/components/ChatInput.tsx',
            isIgnored: false,
          },
          {
            relativePath: '.env.local',
            filename: '.env.local',
            absolutePath: '/repo/.env.local',
            isIgnored: true,
          },
        ],
      },
    ];

    const all = searchFiles('', reposWithIgnored, 50);
    expect(all.map((r) => r.filename)).toContain('.env.local');
    expect(all.find((r) => r.filename === '.env.local')?.isIgnored).toBe(true);
    expect(all.find((r) => r.filename === 'ChatInput.tsx')?.isIgnored).toBe(
      false,
    );

    const filtered = searchFiles('env', reposWithIgnored);
    expect(filtered.find((r) => r.filename === '.env.local')?.isIgnored).toBe(
      true,
    );
  });
});
