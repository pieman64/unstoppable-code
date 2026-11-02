import * as lineSuffix from '@canopy/ui-shared/lib/file-link-line-suffix';
import type { RepoFileIndex } from '@canopy/desktop-shared/types';
import {
  buildFilePathMentionIndex,
  getFilePathMentionIndex,
  splitTextByFilePathMentions,
} from '../filePathMentionIndex';

const repos: RepoFileIndex[] = [
  {
    repoId: 'repo',
    repoName: 'repo',
    absolutePath: '/workspace/repo',
    rootKind: 'git-repo',
    files: [
      {
        relativePath: 'src/App.tsx',
        filename: 'App.tsx',
        absolutePath: '/workspace/repo/src/App.tsx',
        isIgnored: false,
      },
      {
        relativePath: 'package.json',
        filename: 'package.json',
        absolutePath: '/workspace/repo/package.json',
        isIgnored: false,
      },
      {
        relativePath: 'Dockerfile',
        filename: 'Dockerfile',
        absolutePath: '/workspace/repo/Dockerfile',
        isIgnored: false,
      },
      {
        relativePath: '.env',
        filename: '.env',
        absolutePath: '/workspace/repo/.env',
        isIgnored: false,
      },
      {
        relativePath: '.gitignore',
        filename: '.gitignore',
        absolutePath: '/workspace/repo/.gitignore',
        isIgnored: false,
      },
      {
        relativePath: 'nested/test-file.ts',
        filename: 'test-file.ts',
        absolutePath: '/workspace/repo/nested/test-file.ts',
        isIgnored: false,
      },
    ],
  },
  {
    repoId: 'sibling',
    repoName: 'sibling',
    absolutePath: '/workspace/sibling',
    rootKind: 'git-repo',
    files: [
      {
        relativePath: 'outside.ts',
        filename: 'outside.ts',
        absolutePath: '/workspace/sibling/outside.ts',
        isIgnored: false,
      },
    ],
  },
];

function filePieces(text: string): string[] {
  const index = buildFilePathMentionIndex(repos, '/workspace/repo');
  return splitTextByFilePathMentions(text, index)
    .filter((piece) => piece.type === 'file')
    .map((piece) => piece.text);
}

describe('filePathMentionIndex', () => {
  it('detects valid relative files under the cwd', () => {
    expect(
      filePieces('Open src/App.tsx, package.json, and Dockerfile'),
    ).toEqual(['src/App.tsx', 'package.json', 'Dockerfile']);
  });

  it('detects cwd-scoped absolute files', () => {
    expect(filePieces('Open /workspace/repo/src/App.tsx')).toEqual([
      '/workspace/repo/src/App.tsx',
    ]);
  });

  it('trims surrounding sentence punctuation from matches', () => {
    expect(filePieces('Check nested/test-file.ts, then continue.')).toEqual([
      'nested/test-file.ts',
    ]);
  });

  it('detects top-level dotfiles', () => {
    expect(filePieces('Open .env and .gitignore.')).toEqual([
      '.env',
      '.gitignore',
    ]);
  });

  it('rejects files outside the cwd', () => {
    expect(filePieces('Skip /workspace/sibling/outside.ts')).toEqual([]);
  });

  it('preserves prose and markdown punctuation around file mentions', () => {
    const index = buildFilePathMentionIndex(repos, '/workspace/repo');
    const pieces = splitTextByFilePathMentions(
      '**Open `src/App.tsx`**, then [check](package.json).',
      index,
    );

    expect(
      pieces
        .filter((piece) => piece.type === 'file')
        .map((piece) => piece.text),
    ).toEqual(['src/App.tsx', 'package.json']);
    expect(pieces.map((piece) => piece.text).join('')).toBe(
      '**Open `src/App.tsx`**, then [check](package.json).',
    );
  });

  it('returns the cached split result for repeated historical text', () => {
    const index = buildFilePathMentionIndex(repos, '/workspace/repo');
    const text = 'Repeated history references nested/test-file.ts.';

    expect(splitTextByFilePathMentions(text, index)).toBe(
      splitTextByFilePathMentions(text, index),
    );
  });

  it('does not emit ordinary prose words as alias lookup candidates', () => {
    const index = buildFilePathMentionIndex(repos, '/workspace/repo');
    expect(index).not.toBeNull();
    if (!index) return;
    const lookup = jest.spyOn(index.aliases, 'get');

    expect(
      splitTextByFilePathMentions(
        'ordinary prose contains many alphabetic tokens without markers',
        index,
      ),
    ).toEqual([
      {
        type: 'text',
        text: 'ordinary prose contains many alphabetic tokens without markers',
      },
    ]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('retains exact bare top-level filename aliases', () => {
    expect(filePieces('Open Dockerfile before building')).toEqual([
      'Dockerfile',
    ]);
  });

  it('keeps one alias per file and resolves the other spellings at lookup', () => {
    const index = buildFilePathMentionIndex(repos, '/workspace/repo');
    // Six files under the cwd; the sibling repo's file is outside it.
    expect(index?.aliases.size).toBe(6);
    expect(
      filePieces(
        'See ./src/App.tsx, src\\App.tsx, .\\nested\\test-file.ts and /workspace/repo/nested/test-file.ts:3.',
      ),
    ).toEqual([
      './src/App.tsx',
      'src\\App.tsx',
      '.\\nested\\test-file.ts',
      '/workspace/repo/nested/test-file.ts:3',
    ]);
    const pieces = splitTextByFilePathMentions('Open ./.env.', index);
    expect(pieces).toEqual([
      { type: 'text', text: 'Open ' },
      {
        type: 'file',
        text: './.env',
        target: {
          absolutePath: '/workspace/repo/.env',
          displayPath: '.env',
          filename: '.env',
        },
      },
      { type: 'text', text: '.' },
    ]);
  });

  it('resolves Windows paths with either separator', () => {
    const windowsRepos: RepoFileIndex[] = [
      {
        repoId: 'repo',
        repoName: 'repo',
        absolutePath: 'C:\\work\\repo',
        rootKind: 'git-repo',
        files: [
          {
            relativePath: 'src\\App.tsx',
            filename: 'App.tsx',
            absolutePath: 'C:\\work\\repo\\src\\App.tsx',
            isIgnored: false,
          },
        ],
      },
    ];
    const index = buildFilePathMentionIndex(windowsRepos, 'C:\\work\\repo');
    expect(index?.aliases.size).toBe(1);
    expect(
      splitTextByFilePathMentions(
        'Edit src\\App.tsx, src/App.tsx, C:\\work\\repo\\src\\App.tsx and C:/work/repo/src/App.tsx',
        index,
      )
        .filter((piece) => piece.type === 'file')
        .map((piece) => piece.text),
    ).toEqual([
      'src\\App.tsx',
      'src/App.tsx',
      'C:\\work\\repo\\src\\App.tsx',
      'C:/work/repo/src/App.tsx',
    ]);
  });

  it('resolves UNC absolute paths', () => {
    const uncRepos: RepoFileIndex[] = [
      {
        repoId: 'repo',
        repoName: 'repo',
        absolutePath: '\\\\server\\share\\repo',
        rootKind: 'git-repo',
        files: [
          {
            relativePath: 'src\\App.tsx',
            filename: 'App.tsx',
            absolutePath: '\\\\server\\share\\repo\\src\\App.tsx',
            isIgnored: false,
          },
        ],
      },
    ];
    const index = buildFilePathMentionIndex(
      uncRepos,
      '\\\\server\\share\\repo',
    );
    expect(
      splitTextByFilePathMentions(
        'Edit \\\\server\\share\\repo\\src\\App.tsx now',
        index,
      )
        .filter((piece) => piece.type === 'file')
        .map((piece) => piece.text),
    ).toEqual(['\\\\server\\share\\repo\\src\\App.tsx']);
  });

  it('memoizes an index for the same repos array and cwd', () => {
    expect(getFilePathMentionIndex(repos, '/workspace/repo')).toBe(
      getFilePathMentionIndex(repos, '/workspace/repo'),
    );
  });

  it('builds a different index for a different cwd', () => {
    expect(getFilePathMentionIndex(repos, '/workspace/repo')).not.toBe(
      getFilePathMentionIndex(repos, '/workspace/repo/src'),
    );
  });

  it('builds a new index for a new repos array with the same contents', () => {
    const copiedRepos: RepoFileIndex[] = [...repos];

    expect(getFilePathMentionIndex(copiedRepos, '/workspace/repo')).not.toBe(
      getFilePathMentionIndex(repos, '/workspace/repo'),
    );
  });

  it('memoizes null results when cwd or repos are missing', () => {
    const noRepos: RepoFileIndex[] = [];

    expect(getFilePathMentionIndex(repos, undefined)).toBeNull();
    expect(getFilePathMentionIndex(repos, undefined)).toBeNull();
    expect(getFilePathMentionIndex(noRepos, '/workspace/repo')).toBeNull();
    expect(getFilePathMentionIndex(noRepos, '/workspace/repo')).toBeNull();
  });

  it('matches files the same way as the builder for the same inputs', () => {
    const text = 'Open src/App.tsx and package.json.';

    expect(
      splitTextByFilePathMentions(
        text,
        getFilePathMentionIndex(repos, '/workspace/repo'),
      ),
    ).toEqual(
      splitTextByFilePathMentions(
        text,
        buildFilePathMentionIndex(repos, '/workspace/repo'),
      ),
    );
  });
});

describe('file mention line suffixes', () => {
  const index = buildFilePathMentionIndex(repos, '/workspace/repo');
  it.each([
    [':12', { line: 12 }],
    ['#L12', { line: 12 }],
    [':012-020', { line: 12, lineEnd: 20 }],
    ['#L12-L20', { line: 12, lineEnd: 20 }],
    ['#L12-20', { line: 12, lineEnd: 20 }],
    [':12:4', { line: 12 }],
    ['#L12C4', { line: 12 }],
    [':12:4-20:9', { line: 12, lineEnd: 20 }],
    [':20-12', { line: 20 }],
    [':12-12', { line: 12 }],
  ])(
    'absorbs %s into one mention, preserving prose and spelling',
    (suffix, location) => {
      const text = `Read \`src/App.tsx${suffix}\`, then continue.`;
      const pieces = splitTextByFilePathMentions(text, index);
      expect(pieces.filter((piece) => piece.type === 'file')).toEqual([
        expect.objectContaining({ text: `src/App.tsx${suffix}`, location }),
      ]);
      expect(pieces.map((piece) => piece.text).join('')).toBe(text);
      expect(splitTextByFilePathMentions(text, index)).toBe(pieces);
    },
  );

  it.each(['.', ',', ';', '!', '?', ')', ']', '}', '>', ' ', '\n', ''])(
    'keeps boundary %j adjacent',
    (boundary) => {
      const pieces = splitTextByFilePathMentions(
        `src/App.tsx:12-20${boundary}`,
        index,
      );
      expect(pieces[0]).toMatchObject({
        type: 'file',
        text: 'src/App.tsx:12-20',
        location: { line: 12, lineEnd: 20 },
      });
      expect(
        pieces
          .slice(1)
          .map((piece) => piece.text)
          .join(''),
      ).toBe(boundary);
    },
  );

  it.each([
    ':0',
    ':12-',
    ':12:',
    ':12abc',
    ':12_foo',
    ':12/path',
    ':12\\path',
    ':12#L20',
    ':12-20:4',
    ':9007199254740992',
    '#L12-',
    '#L12C0',
  ])('leaves invalid suffix %s adjacent', (suffix) => {
    const pieces = splitTextByFilePathMentions(`src/App.tsx${suffix}`, index);
    expect(pieces[0]).toMatchObject({ type: 'file', text: 'src/App.tsx' });
    expect(pieces[0]).not.toHaveProperty('location');
    expect(
      pieces
        .slice(1)
        .map((piece) => piece.text)
        .join(''),
    ).toBe(suffix);
  });

  it.each(['src/App.tsx:12', 'src/App.tsx#L12', 'notes:12', 'notes#L12'])(
    'prefers an exact indexed delimiter filename %s',
    (alias) => {
      const target = {
        absolutePath: `/workspace/repo/${alias}`,
        displayPath: alias,
        filename: alias,
      };
      const exactIndex = {
        aliases: new Map([...(index?.aliases ?? []), [alias, target]]),
        bareAliasLengthsByFirstCode: new Map([
          [alias.charCodeAt(0), new Set([alias.length])],
        ]),
      };
      expect(splitTextByFilePathMentions(`${alias}.`, exactIndex)).toEqual([
        { type: 'file', text: alias, target },
        { type: 'text', text: '.' },
      ]);
    },
  );
  it('prefers a delimiter filename before parsing its own following suffix', () => {
    const exact = buildFilePathMentionIndex(
      [
        {
          ...repos[0],
          files: [
            ...repos[0].files,
            {
              relativePath: 'src/App.tsx:12',
              filename: 'App.tsx:12',
              absolutePath: '/workspace/repo/src/App.tsx:12',
              isIgnored: false,
            },
          ],
        },
      ],
      '/workspace/repo',
    );
    expect(
      splitTextByFilePathMentions('src/App.tsx:12:20-22', exact)[0],
    ).toMatchObject({
      text: 'src/App.tsx:12:20-22',
      target: { filename: 'App.tsx:12' },
      location: { line: 20, lineEnd: 22 },
    });
  });
  it('bounds suffix work per resolved mention and reuses historical results', () => {
    const match = jest.spyOn(lineSuffix, 'matchLeadingLineSuffix');
    try {
      const text = `${'src/App.tsx:12-20 '.repeat(512)}missing.ts:12-20`;
      const pieces = splitTextByFilePathMentions(text, index);
      expect(pieces.filter((piece) => piece.type === 'file')).toHaveLength(512);
      expect(match).toHaveBeenCalledTimes(512);
      expect(match.mock.calls.every(([suffix]) => suffix.length <= 10)).toBe(
        true,
      );
      expect(splitTextByFilePathMentions(text, index)).toBe(pieces);
      expect(match).toHaveBeenCalledTimes(512);
    } finally {
      match.mockRestore();
    }
  });
});
