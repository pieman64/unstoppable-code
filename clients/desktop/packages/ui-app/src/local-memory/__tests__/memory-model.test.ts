import type {
  LocalMemoryFile,
  LocalMemoryFileDocument,
} from '@canopy/app-core/local-memory';
import {
  levelOneHeading,
  dayGroup,
  defaultFilters,
  groupByDay,
  hiddenFilterCount,
  memoryContent,
  memoryEntries,
  rowTime,
  savedTime,
  visibleEntries,
} from '../memory-model';

const NOW = new Date(2026, 9, 23, 15, 0);

function file(
  overrides: Partial<LocalMemoryFile> & { fileKey: string },
): LocalMemoryFile {
  return {
    kind: overrides.fileKey.startsWith('inbox/') ? 'inbox' : 'topic',
    modifiedAt: NOW.toISOString(),
    sizeBytes: 10,
    ...overrides,
  };
}

describe('memoryEntries', () => {
  it("lists every scope's index, topics and notes newest first", () => {
    const entries = memoryEntries([
      [
        file({ fileKey: 'MEMORY.md', kind: 'index' }),
        file({
          fileKey: 'topics/ports.md',
          title: 'Dev server ports',
          modifiedAt: new Date(2026, 9, 20).toISOString(),
        }),
      ],
      [
        file({
          fileKey: 'inbox/20261023-note.md',
          title: 'Verify in the app pane',
          modifiedAt: new Date(2026, 9, 23, 9).toISOString(),
        }),
        file({
          fileKey: 'topics/untitled-topic.md',
          modifiedAt: new Date(2026, 9, 1).toISOString(),
        }),
      ],
    ]);
    expect(entries.map((entry) => [entry.id, entry.title])).toEqual([
      ['0:MEMORY.md', 'MEMORY.md'],
      ['1:inbox/20261023-note.md', 'Verify in the app pane'],
      ['0:topics/ports.md', 'Dev server ports'],
      ['1:topics/untitled-topic.md', 'untitled-topic.md'],
    ]);
  });
});

describe('visibleEntries', () => {
  const entries = memoryEntries([
    [
      file({
        fileKey: 'topics/a.md',
        title: 'No em dashes',
        excerpt: 'Never use them.',
      }),
    ],
    [
      file({
        fileKey: 'inbox/b.md',
        title: 'Ports',
        excerpt: 'Use 3008 when 3007 is taken.',
      }),
    ],
  ]);

  it('searches titles and the line under them', () => {
    expect(
      visibleEntries(entries, defaultFilters(2), 'PORT', new Set()).map(
        (e) => e.id,
      ),
    ).toEqual(['1:inbox/b.md']);
    expect(
      visibleEntries(entries, defaultFilters(2), 'never', new Set()).map(
        (e) => e.id,
      ),
    ).toEqual(['0:topics/a.md']);
  });

  it('applies kind and scope filters and hides memories waiting for Undo', () => {
    const filters = defaultFilters(2);
    expect(
      visibleEntries(
        entries,
        { ...filters, kinds: new Set(['topic']) },
        '',
        new Set(),
      ).map((e) => e.id),
    ).toEqual(['0:topics/a.md']);
    expect(
      visibleEntries(
        entries,
        { ...filters, scopes: new Set([1]) },
        '',
        new Set(),
      ).map((e) => e.id),
    ).toEqual(['1:inbox/b.md']);
    expect(
      visibleEntries(entries, filters, '', new Set(['0:topics/a.md'])).map(
        (e) => e.id,
      ),
    ).toEqual(['1:inbox/b.md']);
  });

  it('counts the filter choices turned off', () => {
    const filters = defaultFilters(2);
    expect(hiddenFilterCount(filters, 2)).toBe(0);
    expect(
      hiddenFilterCount({ kinds: new Set(['topic']), scopes: new Set([1]) }, 2),
    ).toBe(3);
    expect(
      hiddenFilterCount({ ...defaultFilters(1), kinds: new Set() }, 1),
    ).toBe(3);
  });
});

describe('times and day groups', () => {
  it('groups by Today, This week and Earlier', () => {
    expect(dayGroup(new Date(2026, 9, 23, 1).toISOString(), NOW)).toBe('Today');
    expect(dayGroup(new Date(2026, 9, 17, 12).toISOString(), NOW)).toBe(
      'This week',
    );
    expect(dayGroup(new Date(2026, 9, 16, 12).toISOString(), NOW)).toBe(
      'Earlier',
    );
    const groups = groupByDay(
      memoryEntries([
        [
          file({
            fileKey: 'topics/a.md',
            modifiedAt: new Date(2026, 9, 23, 10).toISOString(),
          }),
          file({
            fileKey: 'topics/b.md',
            modifiedAt: new Date(2026, 9, 21).toISOString(),
          }),
          file({
            fileKey: 'topics/c.md',
            modifiedAt: new Date(2026, 8, 1).toISOString(),
          }),
        ],
      ]),
      NOW,
    );
    expect(groups.map(({ group, entries }) => [group, entries.length])).toEqual(
      [
        ['Today', 1],
        ['This week', 1],
        ['Earlier', 1],
      ],
    );
  });

  it('shows the clock time today, then Yesterday, then the date', () => {
    const today = new Date(2026, 9, 23, 10, 42);
    expect(rowTime(today.toISOString(), NOW)).toMatch(/10:42/);
    expect(rowTime(new Date(2026, 9, 22, 16).toISOString(), NOW)).toBe(
      'Yesterday',
    );
    expect(rowTime(new Date(2026, 9, 20).toISOString(), NOW)).toMatch(/Oct 20/);
    expect(rowTime(new Date(2025, 9, 20).toISOString(), NOW)).toMatch(/2025/);
    expect(savedTime(today.toISOString(), NOW)).toMatch(/^Today at 10:42/);
    expect(savedTime(new Date(2026, 9, 22, 16, 2).toISOString(), NOW)).toMatch(
      /^Yesterday at 4:02/,
    );
  });
});

describe('memoryContent', () => {
  function document(markdown: string): LocalMemoryFileDocument {
    return { fileKey: 'topics/a.md', revision: 'r', items: [], markdown };
  }

  it('splits a titled file into its heading and the Markdown after it, as written', () => {
    expect(
      memoryContent(
        document(
          '\n# Dev server ports ##\r\n\r\n    const x = 1;\r\nFirst line  \r\n- API 8081\r\n\r\n',
        ),
      ),
    ).toEqual({
      title: 'Dev server ports',
      body: '    const x = 1;\nFirst line  \n- API 8081',
    });
  });

  it('keeps a file without a level-1 heading as one body', () => {
    expect(memoryContent(document('\n\n## Writing\n\nUse pnpm.\n'))).toEqual({
      body: '## Writing\n\nUse pnpm.',
    });
  });

  it('reads level-1 headings the way CommonMark does', () => {
    expect(levelOneHeading('# C# and issue #3005')).toBe('C# and issue #3005');
    expect(levelOneHeading('# Title ##')).toBe('Title');
    expect(levelOneHeading('# Title##')).toBe('Title##');
    expect(levelOneHeading('# Title ##\u00a0')).toBe('Title ##\u00a0');
    expect(levelOneHeading('# #')).toBe('');
    expect(levelOneHeading('    # Code')).toBeUndefined();
    expect(levelOneHeading('## Second level')).toBeUndefined();
  });
});
