import { computeTranscriptStickySections } from '../transcriptStickySections';
import type { TurnGroup, TurnGroupOrMessage, TurnMessage } from '../types';

const NO_REVERTS: ReadonlySet<string> = new Set();

function userMessage(
  id: string,
  overrides: Partial<TurnMessage> = {},
): TurnMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text: `prompt ${id}` }],
    timestamp: 1,
    ...overrides,
  };
}

function turnGroup(
  id: string,
  overrides: Partial<TurnMessage> = {},
): TurnGroup {
  return {
    kind: 'turn-group',
    userMessage: userMessage(id, overrides),
    assistantMessages: [
      {
        id: `${id}-assistant`,
        role: 'assistant',
        blocks: [{ type: 'text', text: 'reply' }],
        timestamp: 2,
      },
    ],
    timerMessage: {
      id: `${id}-timer`,
      role: 'system',
      blocks: [{ type: 'turn_timer', completedAt: 3 }],
      timestamp: 3,
    },
    isComplete: true,
  };
}

function standalone(
  id: string,
  role: TurnMessage['role'],
  overrides: Partial<TurnMessage> = {},
): TurnGroupOrMessage {
  return {
    kind: 'standalone',
    message: {
      id,
      role,
      blocks: [{ type: 'text', text: `standalone ${id}` }],
      timestamp: 1,
      ...overrides,
    },
  };
}

describe('computeTranscriptStickySections', () => {
  it('gives each typed user turn its own section with a sticky head', () => {
    const items = [turnGroup('user-1'), turnGroup('user-2')];
    const sections = computeTranscriptStickySections(items, NO_REVERTS);

    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({
      key: 'user-1',
      startIndex: 0,
      stickyGroup: items[0],
    });
    expect(sections[1]).toMatchObject({
      key: 'user-2',
      startIndex: 1,
      stickyGroup: items[1],
    });
  });

  it('keeps watcher-fired turns inside the previous section', () => {
    const items = [
      turnGroup('user-1'),
      turnGroup('watcher-1', {
        watcherFired: { kind: 'Pipeline completion (Deploy)' },
      }),
      turnGroup('user-2'),
    ];
    const sections = computeTranscriptStickySections(items, NO_REVERTS);

    expect(sections).toHaveLength(2);
    expect(sections[0].items).toEqual([items[0], items[1]]);
    expect(sections[0].stickyGroup).toBe(items[0]);
    expect(sections[1].items).toEqual([items[2]]);
  });

  it.each([
    'watcher',
    'deferred_tools_reload',
    'immediate_turn_restart',
  ] as const)(
    'keeps %s continuations under the last human prompt',
    (source) => {
      const items = [
        turnGroup('human'),
        turnGroup('resume', { userMessageSource: source }),
        standalone('resume-standalone', 'user', { userMessageSource: source }),
      ];
      const sections = computeTranscriptStickySections(items, NO_REVERTS);
      expect(sections).toHaveLength(1);
      expect(sections[0].stickyGroup).toBe(items[0]);
      expect(sections[0].items).toEqual(items);
    },
  );

  it('bounds virtualized sections during long consecutive watcher runs', () => {
    const items = [
      turnGroup('user-1'),
      ...Array.from({ length: 100 }, (_, index) =>
        turnGroup(`watcher-${index}`, {
          watcherFired: { kind: 'Pipeline completion (Deploy)' },
        }),
      ),
    ];
    const sections = computeTranscriptStickySections(items, NO_REVERTS, 20);

    expect(sections).toHaveLength(6);
    expect(sections.every((section) => section.items.length <= 20)).toBe(true);
    expect(new Set(sections.map((section) => section.key)).size).toBe(
      sections.length,
    );
    expect(sections.every((section) => section.stickyGroup === items[0])).toBe(
      true,
    );
  });

  it('starts a headerless leading section for items before the first user turn', () => {
    const items = [
      standalone('sys-1', 'system'),
      turnGroup('watcher-1', { watcherFired: { kind: 'Hook (CI guard)' } }),
      turnGroup('user-1'),
    ];
    const sections = computeTranscriptStickySections(items, NO_REVERTS);

    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ key: 'sys-1', startIndex: 0 });
    expect(sections[0].stickyGroup).toBeUndefined();
    expect(sections[0].items).toEqual([items[0], items[1]]);
    expect(sections[1].stickyGroup).toBe(items[2]);
  });

  it('bounds sections at reverted user turns without making them sticky', () => {
    const items = [
      turnGroup('user-1'),
      turnGroup('user-reverted'),
      turnGroup('watcher-1', { watcherFired: { kind: 'Chat completion' } }),
    ];
    const sections = computeTranscriptStickySections(
      items,
      new Set(['user-reverted']),
    );

    expect(sections).toHaveLength(2);
    expect(sections[0].stickyGroup).toBe(items[0]);
    // The reverted turn still starts its own section (so the previous sticky
    // does not stick over it), but has no sticky head — and the watcher turn
    // that follows scrolls inside its section.
    expect(sections[1]).toMatchObject({ key: 'user-reverted', startIndex: 1 });
    expect(sections[1].stickyGroup).toBeUndefined();
    expect(sections[1].items).toEqual([items[1], items[2]]);
  });

  it('starts a section at a standalone typed user message without a sticky head', () => {
    const items = [
      turnGroup('user-1'),
      standalone('user-standalone', 'user'),
      standalone('assistant-1', 'assistant'),
    ];
    const sections = computeTranscriptStickySections(items, NO_REVERTS);

    expect(sections).toHaveLength(2);
    expect(sections[1]).toMatchObject({
      key: 'user-standalone',
      startIndex: 1,
    });
    expect(sections[1].stickyGroup).toBeUndefined();
    expect(sections[1].items).toEqual([items[1], items[2]]);
  });

  it('keeps a standalone watcher-fired user message in the previous section', () => {
    const items = [
      turnGroup('user-1'),
      standalone('watcher-standalone', 'user', {
        watcherFired: { kind: 'GitHub workflow run (acme/api)' },
      }),
    ];
    const sections = computeTranscriptStickySections(items, NO_REVERTS);

    expect(sections).toHaveLength(1);
    expect(sections[0].items).toEqual(items);
  });

  it('returns no sections for an empty transcript', () => {
    expect(computeTranscriptStickySections([], NO_REVERTS)).toEqual([]);
  });
});
