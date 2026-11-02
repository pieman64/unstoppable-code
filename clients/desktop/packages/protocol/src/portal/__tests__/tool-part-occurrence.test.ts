import {
  mergePortalChatPartLists,
  pairToolResultOccurrences,
  portalToolOccurrenceId,
  readPortalToolOccurrence,
  retainPortalToolPartMetadata,
  type PortalChatPart,
} from '../index';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const legacyKey = (part: unknown): string => {
  const record = isRecord(part) ? part : {};
  const data = isRecord(record.data) ? record.data : {};
  return `${String(record.kind)}:${String(data.toolUseId ?? data.text)}`;
};
const merge = (existing: unknown[], incoming: unknown[]): unknown[] =>
  mergePortalChatPartLists(existing, incoming, {
    legacyKey,
    mergeMatched: (_existing, next) => next,
  });

const locator = (
  messageId: string,
  blockOrdinal = 3,
): { messageId: string; blockOrdinal: number; field: 'output' } => ({
  messageId,
  blockOrdinal,
  field: 'output' as const,
});

function result(
  toolUseId: string,
  output: string,
  extra: Partial<PortalChatPart> = {},
): PortalChatPart {
  return { kind: 'tool_result', data: { toolUseId, output }, ...extra };
}

describe('occurrence identity', () => {
  it('derives the id from the canonical row and block ordinal', () => {
    expect(portalToolOccurrenceId('row-7-result-2', 3)).toBe(
      'row-7-result-2#3',
    );
    expect(portalToolOccurrenceId('row', -1)).toBeUndefined();
    expect(portalToolOccurrenceId('row', 1.5)).toBeUndefined();
    expect(portalToolOccurrenceId('row with space', 0)).toBeUndefined();
    expect(portalToolOccurrenceId('x'.repeat(511), 0)).toBeUndefined();
  });

  it('validates the wire shape strictly', () => {
    expect(readPortalToolOccurrence({ id: 'row#3', revision: 4 })).toEqual({
      id: 'row#3',
      revision: 4,
    });
    for (const invalid of [
      { id: '', revision: 1 },
      { id: 'row\u0000#3', revision: 1 },
      { id: 'row\ud800#3', revision: 1 },
      { id: 'x'.repeat(513), revision: 1 },
      { id: 'row#3', revision: -1 },
      { id: 'row#3', revision: Number.MAX_SAFE_INTEGER + 1 },
      { id: 'row#3', revision: 1, extra: true },
      'row#3',
    ])
      expect(readPortalToolOccurrence(invalid)).toBeUndefined();
  });
});

describe('mergePortalChatPartLists', () => {
  it('keeps a locator when a later preview of the same occurrence has none', () => {
    const admitted = result('tool-1', 'preview', {
      occurrence: { id: 'row#3', revision: 5 },
      outputLocator: locator('row-result'),
    });
    const preview = result('tool-1', 'preview, newer', {
      occurrence: { id: 'row#3', revision: 9 },
    });
    expect(merge([admitted], [preview])).toEqual([
      result('tool-1', 'preview, newer', {
        occurrence: { id: 'row#3', revision: 5 },
        outputLocator: locator('row-result'),
      }),
    ]);
  });

  it('never lends a locator to another occurrence of the same tool id', () => {
    const first = result('tool-1', 'first', {
      occurrence: { id: 'row-a#1', revision: 2 },
      outputLocator: locator('row-a'),
    });
    const second = result('tool-1', 'second', {
      occurrence: { id: 'row-b#1', revision: 3 },
    });
    expect(merge([first], [second])).toEqual([first, second]);
  });

  it('replaces a conflicting locator only at a newer revision', () => {
    const held = result('tool-1', 'out', {
      occurrence: { id: 'row#3', revision: 5 },
      outputLocator: locator('row-old'),
    });
    const stale = result('tool-1', 'out', {
      occurrence: { id: 'row#3', revision: 5 },
      outputLocator: locator('row-new'),
    });
    const newer = result('tool-1', 'out', {
      occurrence: { id: 'row#3', revision: 6 },
      outputLocator: locator('row-new'),
    });
    expect(merge([held], [stale])).toEqual([held]);
    expect(merge([held], [newer])).toEqual([newer]);
  });

  it('never moves the same target revision backwards', () => {
    const held = result('tool-1', 'out', {
      occurrence: { id: 'row#3', revision: 5 },
      outputLocator: locator('row'),
    });
    const replay = result('tool-1', 'out', {
      occurrence: { id: 'row#3', revision: 2 },
      outputLocator: locator('row'),
    });
    const conflicting = result('tool-1', 'out', {
      occurrence: { id: 'row#3', revision: 4 },
      outputLocator: locator('row-other'),
    });
    expect(merge(merge([held], [replay]), [conflicting])).toEqual([held]);
  });

  it('upgrades the one keyed part of an unkeyed frame in place', () => {
    const keyed = result('tool-1', 'keyed', {
      occurrence: { id: 'row#3', revision: 5 },
      outputLocator: locator('row'),
    });
    expect(merge([keyed], [result('tool-1', 'legacy frame')])).toEqual([
      result('tool-1', 'legacy frame', {
        occurrence: { id: 'row#3', revision: 5 },
        outputLocator: locator('row'),
      }),
    ]);
  });

  it('drops an unkeyed frame it cannot attribute to one occurrence', () => {
    const first = result('tool-1', 'a', {
      occurrence: { id: 'row-a#1', revision: 1 },
      outputLocator: locator('row-a'),
    });
    const second = result('tool-1', 'b', {
      occurrence: { id: 'row-b#1', revision: 2 },
    });
    expect(merge([first, second], [result('tool-1', 'which?')])).toEqual([
      first,
      second,
    ]);
  });

  it('replaces the unkeyed part with its first keyed frame in place', () => {
    const keyed = result('tool-1', 'admitted', {
      occurrence: { id: 'row#3', revision: 5 },
      outputLocator: locator('row'),
    });
    const upgraded = merge([result('tool-1', 'preview')], [keyed]);
    expect(upgraded).toEqual([keyed]);
    expect(merge(upgraded, [result('tool-1', 'later preview')])).toEqual([
      result('tool-1', 'later preview', {
        occurrence: { id: 'row#3', revision: 5 },
        outputLocator: locator('row'),
      }),
    ]);
  });

  it('keeps a second occurrence beside an upgraded one', () => {
    const first = result('tool-1', 'a', {
      occurrence: { id: 'row-a#1', revision: 1 },
    });
    const second = result('tool-1', 'b', {
      occurrence: { id: 'row-b#1', revision: 2 },
    });
    expect(merge([result('tool-1', 'legacy')], [first, second])).toEqual([
      first,
      second,
    ]);
  });

  it('appends an unkeyed part whose frame also carries its keyed sibling', () => {
    const a = result('tool-1', 'a', {
      occurrence: { id: 'row-a#1', revision: 1 },
      outputLocator: locator('row-a'),
    });
    const b = result('tool-1', 'b');
    expect(merge([a], [a, b])).toEqual([a, b]);
  });

  it('keeps the earlier behavior for unkeyed parts', () => {
    const text: PortalChatPart = { kind: 'text', data: { text: 'hi' } };
    expect(
      merge(
        [result('tool-1', 'old'), text],
        [result('tool-1', 'new'), result('tool-2', 'other')],
      ),
    ).toEqual([result('tool-1', 'new'), text, result('tool-2', 'other')]);
  });

  it('matches a keyed frame onto its keyed part in either order', () => {
    const keyedFirst = merge(
      [result('tool-1', 'a', { occurrence: { id: 'row#1', revision: 1 } })],
      [
        result('tool-1', 'b', {
          occurrence: { id: 'row#1', revision: 2 },
          outputLocator: locator('row'),
        }),
      ],
    );
    expect(keyedFirst).toEqual([
      result('tool-1', 'b', {
        occurrence: { id: 'row#1', revision: 2 },
        outputLocator: locator('row'),
      }),
    ]);
  });
});

describe('retainPortalToolPartMetadata', () => {
  it('carries the locator into a replacement frame without one', () => {
    const existing = [
      result('tool-1', 'out', {
        occurrence: { id: 'row#3', revision: 5 },
        outputLocator: locator('row'),
      }),
    ];
    const text: PortalChatPart = { kind: 'text', data: { text: 'later' } };
    expect(
      retainPortalToolPartMetadata(existing, [result('tool-1', 'out'), text]),
    ).toEqual([
      result('tool-1', 'out', {
        occurrence: { id: 'row#3', revision: 5 },
        outputLocator: locator('row'),
      }),
      text,
    ]);
  });

  it('gives ambiguous unkeyed frames nothing', () => {
    const existing = [
      result('tool-1', 'a', {
        occurrence: { id: 'row-a#1', revision: 1 },
        outputLocator: locator('row-a'),
      }),
      result('tool-1', 'b', {
        occurrence: { id: 'row-b#1', revision: 1 },
        outputLocator: locator('row-b'),
      }),
    ];
    expect(
      retainPortalToolPartMetadata(existing, [
        result('tool-1', 'a2'),
        result('tool-1', 'b2'),
      ]),
    ).toEqual([result('tool-1', 'a2'), result('tool-1', 'b2')]);
    expect(
      retainPortalToolPartMetadata(existing.slice(0, 1), [
        result('tool-1', 'a2'),
        result('tool-1', 'a3'),
      ]),
    ).toEqual([result('tool-1', 'a2'), result('tool-1', 'a3')]);
  });

  it("never lends a keyed sibling's metadata to an unkeyed part", () => {
    const a = result('tool-1', 'a', {
      occurrence: { id: 'row-a#1', revision: 1 },
      outputLocator: locator('row-a'),
    });
    const b = result('tool-1', 'b');
    expect(retainPortalToolPartMetadata([a], [a, b])).toEqual([a, b]);
  });

  it('never lends metadata past an unkeyed existing sibling', () => {
    const a = result('tool-1', 'a', {
      occurrence: { id: 'row-a#1', revision: 1 },
      outputLocator: locator('row-a'),
    });
    const b = result('tool-1', 'b');
    expect(retainPortalToolPartMetadata([a, b], [b])).toEqual([b]);
  });

  it('keeps parts the replacement frame dropped dropped', () => {
    const existing = [
      result('tool-1', 'a', {
        occurrence: { id: 'row#1', revision: 1 },
        outputLocator: locator('row'),
      }),
    ];
    expect(retainPortalToolPartMetadata(existing, [])).toEqual([]);
  });
});

describe('pairToolResultOccurrences', () => {
  type Item = {
    kind: 'tool_use' | 'tool_result';
    toolUseId: string;
    occurrenceId?: string;
  };
  const pair = (items: Item[]): Record<string, number> =>
    Object.fromEntries(pairToolResultOccurrences(items, (item) => item));

  it('pairs each result with the nearest preceding unmatched call', () => {
    expect(
      pair([
        { kind: 'tool_use', toolUseId: 't' },
        { kind: 'tool_use', toolUseId: 't' },
        { kind: 'tool_result', toolUseId: 't' },
        { kind: 'tool_result', toolUseId: 't' },
      ]),
    ).toEqual({ 1: 2, 0: 3 });
  });

  it('pairs a keyed result with its own occurrence, not the nearest call', () => {
    expect(
      pair([
        { kind: 'tool_use', toolUseId: 't', occurrenceId: 'a#1' },
        { kind: 'tool_use', toolUseId: 't', occurrenceId: 'b#1' },
        { kind: 'tool_result', toolUseId: 't', occurrenceId: 'a#1' },
      ]),
    ).toEqual({ 0: 2 });
  });

  it('never pairs a keyed result with a call of another occurrence', () => {
    expect(
      pair([
        { kind: 'tool_use', toolUseId: 't', occurrenceId: 'b#1' },
        { kind: 'tool_result', toolUseId: 't', occurrenceId: 'a#1' },
      ]),
    ).toEqual({});
  });

  it('falls back to the nearest unkeyed call for a keyed result', () => {
    expect(
      pair([
        { kind: 'tool_use', toolUseId: 't' },
        { kind: 'tool_use', toolUseId: 't', occurrenceId: 'b#1' },
        { kind: 'tool_result', toolUseId: 't', occurrenceId: 'a#1' },
      ]),
    ).toEqual({ 0: 2 });
  });
});
