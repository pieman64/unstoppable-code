import { CoreChatVisualReferenceSchema } from '../../canopy-core/core';
import {
  PORTAL_CAPABILITY_CHAT_VISUALS,
  PORTAL_CHAT_VISUAL_PAGE_BYTES,
  PORTAL_COMMAND_TYPES_SET,
  PORTAL_SERVER_ONLY_COMMAND_TYPES,
  readPortalChatPartVisual,
  type PortalChatPart,
  type PortalChatVisualReadPayload,
  type PortalChatVisualReadResult,
} from '../index';

const reference = {
  version: 1,
  visualId: 'vis_123e4567-e89b-42d3-a456-426614174000',
  artifactId: `sha256-v1-${'a'.repeat(64)}`,
  byteLength: 4_194_304,
  sha256: 'a'.repeat(64),
  mediaType: 'text/html',
  title: 'Revenue chart',
  maxHeight: 720,
  heights: [[800, 400]],
} as const;

function part(data: unknown): PortalChatPart {
  return { kind: 'tool_result', data };
}

describe('portal chat visual read contract', () => {
  it('registers a server-only read command and its capability', () => {
    expect(PORTAL_COMMAND_TYPES_SET.has('portal.chat.visual.read')).toBe(true);
    expect(PORTAL_CAPABILITY_CHAT_VISUALS).toBe('chat_visuals');
    // Browsers reach visual pages only through the inert byte route.
    expect([...PORTAL_SERVER_ONLY_COMMAND_TYPES].sort()).toEqual([
      'portal.auth.validate_code',
      'portal.chat.visual.read',
    ]);
  });

  it('keeps a full page and its envelope under the per-event budget', () => {
    expect(PORTAL_CHAT_VISUAL_PAGE_BYTES).toBe(384_000);
    // A multiple of 3 encodes to base64 with no padding.
    expect(PORTAL_CHAT_VISUAL_PAGE_BYTES % 3).toBe(0);
    const data = Buffer.alloc(PORTAL_CHAT_VISUAL_PAGE_BYTES, 0xff).toString(
      'base64',
    );
    expect(data).toHaveLength(512_000);
    expect(data.endsWith('=')).toBe(false);
    const result: PortalChatVisualReadResult = {
      kind: 'inline-page',
      data,
      offset: 3_840_000,
      length: PORTAL_CHAT_VISUAL_PAGE_BYTES,
      byteLength: reference.byteLength,
      sha256: reference.sha256,
    };
    const envelope = JSON.stringify({
      type: 'portal.command.completed',
      clientEventId: `evt_${'x'.repeat(64)}`,
      correlationId: `cmd_${'y'.repeat(64)}`,
      sequenceNumber: Number.MAX_SAFE_INTEGER,
      generatedAt: new Date().toISOString(),
      payload: { commandId: `cmd_${'y'.repeat(64)}`, result },
    });
    expect(Buffer.byteLength(envelope)).toBeLessThan(524_288);
    // A 4 MiB visual is 11 pages.
    expect(
      Math.ceil(reference.byteLength / PORTAL_CHAT_VISUAL_PAGE_BYTES),
    ).toBe(11);
  });

  it('types worktree and standalone payloads with a server-issued read', () => {
    const worktree: PortalChatVisualReadPayload = {
      scope: 'worktree',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      messageId: 'message',
      toolUseId: 'tool',
      reference,
      offset: 0,
      limit: PORTAL_CHAT_VISUAL_PAGE_BYTES,
      read: { id: 'read-1', pageCount: 11 },
    };
    const standalone: PortalChatVisualReadPayload = {
      ...worktree,
      scope: 'standalone',
      projectLocalId: 'cowork-project',
    };
    expect(worktree.scope).toBe('worktree');
    expect(standalone.scope).toBe('standalone');
  });

  it('reads a complete visual reference from a tool result part', () => {
    expect(
      readPortalChatPartVisual(part({ toolUseId: 'tool', visual: reference })),
    ).toEqual(reference);
    const { heights, ...withoutHeights } = reference;
    expect(heights).toHaveLength(1);
    expect(readPortalChatPartVisual(part({ visual: withoutHeights }))).toEqual(
      withoutHeights,
    );
  });

  it.each([
    ['a text part', { kind: 'text', data: { visual: reference } }],
    ['missing data', part(undefined)],
    ['a string visual', part({ visual: JSON.stringify(reference) })],
    [
      'a partial reference',
      part({
        visual: { visualId: reference.visualId, sha256: reference.sha256 },
      }),
    ],
    [
      'a bad visual id',
      part({ visual: { ...reference, visualId: 'vis_bad' } }),
    ],
    [
      'a bad digest',
      part({ visual: { ...reference, sha256: 'A'.repeat(64) } }),
    ],
    [
      'another media type',
      part({ visual: { ...reference, mediaType: 'image/svg+xml' } }),
    ],
    [
      'a fractional length',
      part({ visual: { ...reference, byteLength: 1.5 } }),
    ],
    [
      'an oversized length',
      part({ visual: { ...reference, byteLength: 4 * 1024 * 1024 + 1 } }),
    ],
    ['a short frame', part({ visual: { ...reference, maxHeight: 79 } })],
    ['an empty title', part({ visual: { ...reference, title: '' } })],
    ['malformed heights', part({ visual: { ...reference, heights: [[800]] } })],
    [
      'too many heights',
      part({
        visual: {
          ...reference,
          heights: Array.from({ length: 33 }, () => [1, 1]),
        },
      }),
    ],
    ['an extra field', part({ visual: { ...reference, html: '<p>raw</p>' } })],
  ] satisfies Array<[string, PortalChatPart]>)('rejects %s', (_name, value) => {
    expect(readPortalChatPartVisual(value)).toBeNull();
  });

  it('agrees with the core reference schema on the same samples', () => {
    const samples: unknown[] = [
      reference,
      { ...reference, heights: undefined },
      { ...reference, title: 'x'.repeat(120) },
      { ...reference, title: 'x'.repeat(121) },
      { ...reference, maxHeight: 2000 },
      { ...reference, maxHeight: 2001 },
      { ...reference, byteLength: 0 },
      { ...reference, heights: [[0, 1]] },
      { ...reference, version: 2 },
      { ...reference, artifactId: '' },
    ];
    for (const sample of samples) {
      const portal =
        readPortalChatPartVisual(part({ visual: sample })) !== null;
      const core = CoreChatVisualReferenceSchema.safeParse(sample).success;
      expect({ sample, portal }).toEqual({ sample, portal: core });
    }
  });
});
