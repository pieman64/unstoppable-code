/** @jest-environment jsdom */

import {
  isStrongCommandTitleMatch,
  parseQuery,
  rankPaletteItems,
  withChatContentSection,
  type PaletteRanking,
} from '../paletteRanking';
import type { PaletteItem, PaletteItemKind } from '../paletteItems';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function makeItem(
  kind: PaletteItemKind,
  title: string,
  overrides: Partial<PaletteItem> = {},
): PaletteItem {
  return {
    id: `${kind}:${title}`,
    kind,
    title,
    execute: () => ({ closePalette: true }),
    ...overrides,
  };
}

function sectionIds(ranking: PaletteRanking): string[] {
  return ranking.sections.map((section) => section.id);
}

function titlesInSection(ranking: PaletteRanking, id: string): string[] {
  return (
    ranking.sections
      .find((section) => section.id === id)
      ?.items.map((ranked) => ranked.item.title) ?? []
  );
}

describe('parseQuery', () => {
  it.each([
    ['open   settings', false],
    ['>  open   settings', true],
  ])(
    'collapses internal whitespace in "%s"',
    (rawQuery, commandsOnly): void => {
      expect(parseQuery(rawQuery)).toEqual({
        commandsOnly,
        query: 'open settings',
      });
    },
  );

  it('detects the > commands-only prefix and strips it', () => {
    expect(parseQuery('>new tab')).toEqual({
      commandsOnly: true,
      query: 'new tab',
    });
  });

  it('tolerates leading whitespace before the prefix', () => {
    expect(parseQuery('   > split')).toEqual({
      commandsOnly: true,
      query: 'split',
    });
  });

  it('treats a plain query as non-commands-only', () => {
    expect(parseQuery('  hello ')).toEqual({
      commandsOnly: false,
      query: 'hello',
    });
  });
});

describe('rankPaletteItems', () => {
  describe('CAN-2828 strong command section ranking', (): void => {
    it('ranks and highlights a strong command with repeated query spaces', (): void => {
      const ranking = rankPaletteItems(
        [
          makeItem('command', 'Open settings'),
          makeItem('chat', 'Open settings notes'),
        ],
        'open   settings',
        NOW,
      );
      expect(sectionIds(ranking)).toEqual(['commands', 'chats']);
      expect(ranking.sections[0]?.items[0]?.titleIndices).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      ]);
    });

    it.each(['open settings', 'open sett', 'ope'])(
      'lets a stronger command title match lead for "%s"',
      (query): void => {
        const ranking = rankPaletteItems(
          [
            makeItem('command', 'Open settings'),
            makeItem('chat', 'Open settings notes'),
          ],
          query,
          NOW,
        );
        expect(sectionIds(ranking)).toEqual(['commands', 'chats']);
        expect(titlesInSection(ranking, 'commands')).toEqual(['Open settings']);
      },
    );

    it('keeps a higher-scoring chat ahead of a weak command title match', (): void => {
      const ranking = rankPaletteItems(
        [
          makeItem('command', 'Open Settings notes'),
          makeItem('chat', 'Settings notes'),
        ],
        'settings n',
        NOW,
      );
      expect(sectionIds(ranking)).toEqual(['chats', 'commands']);
      expect(ranking.sections[0]?.items[0]?.score).toBeGreaterThan(
        ranking.sections[1]?.items[0]?.score ?? Infinity,
      );
    });

    it('lets a higher-scoring chat lead even when the command title match is strong', (): void => {
      const ranking = rankPaletteItems(
        [makeItem('command', 'Open settings'), makeItem('chat', 'Open')],
        'open',
        NOW,
      );
      expect(sectionIds(ranking)).toEqual(['chats', 'commands']);
      expect(ranking.sections[0]?.items[0]?.score).toBeGreaterThan(
        ranking.sections[1]?.items[0]?.score ?? Infinity,
      );
    });

    it('keeps equal-score command sections last in canonical order', (): void => {
      const ranking = rankPaletteItems(
        [
          makeItem('command', 'Open settings'),
          makeItem('chat', 'Open settings'),
        ],
        'open settings',
        NOW,
      );
      expect(sectionIds(ranking)).toEqual(['chats', 'commands']);
      expect(ranking.sections[0]?.items[0]?.score).toBe(
        ranking.sections[1]?.items[0]?.score,
      );
    });

    it('uses only the top command to decide strength, never a subtitle or a lower title hit', (): void => {
      const ranking = rankPaletteItems(
        [
          makeItem('command', 'Support', { subtitle: 'help' }),
          makeItem('command', 'Help menu'),
          makeItem('chat', 'Help with notes'),
        ],
        'help',
        NOW,
      );
      expect(sectionIds(ranking)).toEqual(['chats', 'commands']);
      expect(titlesInSection(ranking, 'commands')).toEqual([
        'Support',
        'Help menu',
      ]);
      expect(ranking.sections[1]?.items[0]?.score).toBeGreaterThan(
        ranking.sections[0]?.items[0]?.score ?? Infinity,
      );
    });

    it('preserves >open commands-only filtering', (): void => {
      const ranking = rankPaletteItems(
        [
          makeItem('command', 'Open settings'),
          makeItem('chat', 'Open settings notes'),
        ],
        '>open',
        NOW,
      );
      expect(sectionIds(ranking)).toEqual(['commands']);
      expect(titlesInSection(ranking, 'commands')).toEqual(['Open settings']);
    });
  });

  it('floats a shortcut-bearing item above an equal-score peer', () => {
    const plain = makeItem('command', 'Alpha', {
      id: 'plain',
      shortcut: '',
      timestamp: NOW,
    });
    const shortcut = makeItem('command', 'Alpha', {
      id: 'shortcut',
      shortcut: '⌘A',
      timestamp: NOW - 30 * DAY,
    });
    for (const items of [
      [plain, shortcut],
      [shortcut, plain],
    ]) {
      const ranked = rankPaletteItems(items, 'alpha', NOW).sections[0].items;
      expect(ranked[0].score).toBe(ranked[1].score);
      expect(ranked.map(({ item }) => item.id)).toEqual(['shortcut', 'plain']);
    }
  });

  it('does not let a shortcut outrank a stronger match', () => {
    const items = [
      makeItem('command', 'Alpha command', { shortcut: '⌘A' }),
      makeItem('command', 'Alpha'),
    ];
    const ranking = rankPaletteItems(items, 'alpha', NOW);
    expect(titlesInSection(ranking, 'commands')).toEqual([
      'Alpha',
      'Alpha command',
    ]);
    expect(ranking.sections[0].items[0].score).toBeGreaterThan(
      ranking.sections[0].items[1].score,
    );
  });

  it('groups strong matches into sections ordered by score', () => {
    const items = [
      makeItem('command', 'Alpha command'),
      makeItem('chat', 'Alpha chat'),
      makeItem('worktree', 'Alpha worktree'),
    ];
    const ranking = rankPaletteItems(items, 'alpha', NOW);
    expect(sectionIds(ranking)).toEqual(['chats', 'commands', 'worktrees']);
  });

  it('rejects scattered subsequence matches across long unrelated text', () => {
    const items = [
      // "burrow" is an in-order subsequence here (bug → b,u; tracker → r,r;
      // slow → o,w) but never as a coherent run or word-start acronym.
      makeItem('chat', 'bug tracker with slow triage workflow'),
      makeItem('skill', 'burrow'),
    ];
    const ranking = rankPaletteItems(items, 'burrow', NOW);
    expect(
      ranking.flat.map((entry) =>
        entry.type === 'item' ? entry.ranked.item.title : entry.id,
      ),
    ).toEqual(['burrow']);
  });

  it('accepts acronym-style matches on word starts', () => {
    const items = [makeItem('plugin', 'build-web-apps')];
    const ranking = rankPaletteItems(items, 'bwa', NOW);
    expect(ranking.flat).toHaveLength(1);
    expect(ranking.flat[0]).toMatchObject({
      type: 'item',
      ranked: { item: { title: 'build-web-apps' } },
    });
  });

  it('accepts mid-word consecutive substring runs', () => {
    const items = [makeItem('skill', 'burrow')];
    expect(rankPaletteItems(items, 'rrow', NOW).flat).toHaveLength(1);
  });

  it('reorders sections so the strongest match leads, including strong commands', () => {
    const items = [
      makeItem('chat', 'burrow planning session'),
      makeItem('skill', 'burrow'),
      makeItem('command', 'burrow everything'),
    ];
    const ranking = rankPaletteItems(items, 'burrow', NOW);
    // The exact skill leads; the shorter command prefix outranks the chat.
    expect(sectionIds(ranking)).toEqual(['skills', 'commands', 'chats']);
  });

  it('filters out items that do not match the query', () => {
    const items = [
      makeItem('chat', 'Payments refactor'),
      makeItem('worktree', 'zzz unrelated'),
    ];
    const ranking = rankPaletteItems(items, 'payments', NOW);
    expect(ranking.flat).toHaveLength(1);
    expect(ranking.flat[0]).toMatchObject({
      type: 'item',
      ranked: { item: { title: 'Payments refactor' } },
    });
  });

  it('caps each section at six and reports the truncated count', () => {
    const items = Array.from({ length: 9 }, (_, i) =>
      makeItem('worktree', `alpha ${i}`),
    );
    const ranking = rankPaletteItems(items, 'alpha', NOW);
    const worktrees = ranking.sections.find((s) => s.id === 'worktrees');
    expect(worktrees?.items).toHaveLength(6);
    expect(worktrees?.truncated).toBe(3);
  });

  it('returns every item for an explicitly expanded section', () => {
    const items = Array.from({ length: 9 }, (_, i) =>
      makeItem('worktree', `alpha ${i}`),
    );

    const ranking = rankPaletteItems(
      items,
      'alpha',
      NOW,
      new Set(['worktrees']),
    );
    const worktrees = ranking.sections.find((s) => s.id === 'worktrees');

    expect(worktrees?.items).toHaveLength(9);
    expect(worktrees?.truncated).toBe(0);
  });

  it('blends a recency boost so recent items rank first at equal fuzzy score', () => {
    const items = [
      makeItem('worktree', 'alpha', {
        id: 'worktree:old',
        timestamp: NOW - 30 * DAY,
      }),
      makeItem('worktree', 'alpha', {
        id: 'worktree:new',
        timestamp: NOW - 1_000,
      }),
    ];
    const ranking = rankPaletteItems(items, 'alpha', NOW);
    const ordered = ranking.sections[0].items.map((ranked) => ranked.item.id);
    expect(ordered).toEqual(['worktree:new', 'worktree:old']);
  });

  it('does not let recency outrank a stronger fuzzy match', () => {
    const items = [
      makeItem('worktree', 'alpha', {
        id: 'worktree:strong-old',
        timestamp: NOW - 30 * DAY,
      }),
      makeItem('worktree', 'recent item', {
        id: 'worktree:weak-new',
        keywords: ['alpha'],
        timestamp: NOW - 1_000,
      }),
    ];
    const ranking = rankPaletteItems(items, 'alpha', NOW);
    expect(ranking.sections[0].items.map((ranked) => ranked.item.id)).toEqual([
      'worktree:strong-old',
      'worktree:weak-new',
    ]);
  });

  it('penalizes reduced-weight fields when fuzzy scores are negative', () => {
    const longMatch = `${'z'.repeat(60)}x`;
    const items = [
      makeItem('worktree', longMatch, { id: 'worktree:title-match' }),
      makeItem('worktree', 'No title match', {
        id: 'worktree:keyword-match',
        keywords: [longMatch],
      }),
    ];

    const ranking = rankPaletteItems(items, 'x', NOW);

    expect(ranking.sections[0].items.map((ranked) => ranked.item.id)).toEqual([
      'worktree:title-match',
      'worktree:keyword-match',
    ]);
  });

  it('keeps title highlight indices for matched rows', () => {
    const ranking = rankPaletteItems([makeItem('chat', 'alpha')], 'al', NOW);
    expect(ranking.sections[0].items[0].titleIndices).toEqual([0, 1]);
  });

  describe('> commands-only prefix', () => {
    it('restricts results to commands and strips the prefix before matching', () => {
      const items = [
        makeItem('command', 'New chat tab'),
        makeItem('chat', 'New chat about tabs'),
        makeItem('worktree', 'new-branch'),
      ];
      const ranking = rankPaletteItems(items, '>new', NOW);
      expect(sectionIds(ranking)).toEqual(['commands']);
      expect(titlesInSection(ranking, 'commands')).toEqual(['New chat tab']);
    });

    it('lists every command when the query is just >', () => {
      const items = [
        makeItem('command', 'Bravo'),
        makeItem('command', 'Alpha'),
        makeItem('chat', 'Alpha chat'),
      ];
      const ranking = rankPaletteItems(items, '>', NOW);
      expect(sectionIds(ranking)).toEqual(['commands']);
      expect(titlesInSection(ranking, 'commands')).toEqual(['Alpha', 'Bravo']);
    });
  });

  describe('empty query', () => {
    it('lists shortcut-bearing commands first, then alphabetical', () => {
      const items = [
        makeItem('command', 'Zulu', { shortcut: '⌘Z' }),
        makeItem('command', 'Beta'),
        makeItem('command', 'Alpha', { shortcut: '' }),
        makeItem('command', 'Delta', { shortcut: '⌘D' }),
      ];
      for (const query of ['', '>']) {
        expect(
          titlesInSection(rankPaletteItems(items, query, NOW), 'commands'),
        ).toEqual(['Delta', 'Zulu', 'Alpha', 'Beta']);
      }
    });

    it('shows Recent (chats + worktrees by recency) then top commands', () => {
      const items = [
        makeItem('chat', 'Older chat', {
          id: 'chat:old',
          timestamp: NOW - 10 * DAY,
        }),
        makeItem('chat', 'Newer chat', {
          id: 'chat:new',
          timestamp: NOW - 1_000,
        }),
        makeItem('worktree', 'a worktree', {
          id: 'wt',
          timestamp: NOW - 5 * DAY,
        }),
        makeItem('pipeline', 'a pipeline', { id: 'pl', timestamp: NOW }),
        makeItem('command', 'Zeta command'),
      ];
      const ranking = rankPaletteItems(items, '', NOW);
      expect(sectionIds(ranking)).toEqual(['recent', 'commands']);
      expect(titlesInSection(ranking, 'recent')).toEqual([
        'Newer chat',
        'a worktree',
        'Older chat',
      ]);
      // Pipelines are not part of the empty-query Recent view.
      expect(titlesInSection(ranking, 'recent')).not.toContain('a pipeline');
    });

    it('expands the otherwise capped Recent section', () => {
      const items = Array.from({ length: 10 }, (_, index) =>
        makeItem('chat', `Recent chat ${index}`, { timestamp: NOW - index }),
      );

      const ranking = rankPaletteItems(items, '', NOW, new Set(['recent']));

      expect(ranking.sections[0].items).toHaveLength(10);
      expect(ranking.sections[0].truncated).toBe(0);
    });
  });
});

describe('withChatContentSection', () => {
  const base = rankPaletteItems([makeItem('chat', 'alpha')], 'alpha', NOW);

  it('is a no-op when there are no content items', () => {
    expect(withChatContentSection(base, [])).toBe(base);
  });

  it('appends the "In transcripts" section at the very end, preserving order', () => {
    const content = [makeItem('chat-content', 'A transcript hit')];
    const merged = withChatContentSection(base, content);
    expect(sectionIds(merged)).toEqual(['chats', 'transcripts']);
    // Existing rows keep their leading indices; content is appended last.
    expect(merged.flat[0]).toMatchObject({
      type: 'item',
      ranked: { item: { title: 'alpha' } },
    });
    expect(merged.flat[merged.flat.length - 1]).toMatchObject({
      type: 'item',
      ranked: { item: { kind: 'chat-content' } },
    });
  });
});

describe('isStrongCommandTitleMatch', (): void => {
  it.each([
    ['open settings', 'Open settings', true],
    ['open', 'Open settings', true],
    ['open sett', 'Open settings', true],
    ['ope', 'Open settings', true],
    ['pen', 'Open settings', false],
    ['settings n', 'Open Settings notes', false],
    ['help', 'Take the tour', false],
    ['  OPEN   sett  ', '  Open \t Settings  ', true],
    ['', 'Open settings', false],
    ['   ', 'Open settings', false],
    ['open settings extra', 'Open settings', false],
  ])(
    'matches query "%s" against title "%s": %s',
    (query, title, expected): void => {
      expect(isStrongCommandTitleMatch(query, title)).toBe(expected);
    },
  );
});
