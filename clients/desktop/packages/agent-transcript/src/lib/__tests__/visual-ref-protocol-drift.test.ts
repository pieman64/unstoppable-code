import { CoreChatVisualReadParamsSchema } from '@canopy/protocol/canopy-core';
import type { PersistedVisualReference } from '../../types';
import {
  VISUAL_HEIGHTS_MAX_ENTRIES,
  VISUAL_MAX_HEIGHT,
  VISUAL_MIN_HEIGHT,
  VISUAL_PREPARED_MAX_BYTES,
  VISUAL_TITLE_MAX_LENGTH,
  isVisualId,
} from '../visual-ref';

const digest = 'a'.repeat(64);
const visualId = 'vis_123e4567-e89b-42d3-a456-426614174000';

function reference(
  overrides: Partial<PersistedVisualReference> = {},
): PersistedVisualReference {
  return {
    version: 1,
    visualId,
    artifactId: `sha256-v1-${digest}`,
    byteLength: 10,
    sha256: digest,
    mediaType: 'text/html',
    title: 'Chart',
    maxHeight: 400,
    ...overrides,
  };
}

function accepts(ref: PersistedVisualReference): boolean {
  return CoreChatVisualReadParamsSchema.safeParse({
    scope: { workspaceId: 'workspace', worktreeId: 'worktree', chatId: 'chat' },
    messageId: 'message',
    toolUseId: 'tool',
    reference: ref,
    offset: 0,
    limit: 1,
  }).success;
}

describe('core.chat.visual.read reference limits match stored visuals', () => {
  it('accepts every reference storage can hold and rejects just past each limit', () => {
    expect(accepts(reference({ byteLength: 0 }))).toBe(true);
    expect(accepts(reference({ byteLength: VISUAL_PREPARED_MAX_BYTES }))).toBe(
      true,
    );
    expect(
      accepts(reference({ byteLength: VISUAL_PREPARED_MAX_BYTES + 1 })),
    ).toBe(false);
    expect(
      accepts(reference({ title: 'x'.repeat(VISUAL_TITLE_MAX_LENGTH) })),
    ).toBe(true);
    expect(
      accepts(reference({ title: 'x'.repeat(VISUAL_TITLE_MAX_LENGTH + 1) })),
    ).toBe(false);
    expect(accepts(reference({ maxHeight: VISUAL_MIN_HEIGHT }))).toBe(true);
    expect(accepts(reference({ maxHeight: VISUAL_MIN_HEIGHT - 1 }))).toBe(
      false,
    );
    expect(accepts(reference({ maxHeight: VISUAL_MAX_HEIGHT }))).toBe(true);
    expect(accepts(reference({ maxHeight: VISUAL_MAX_HEIGHT + 1 }))).toBe(
      false,
    );
    const heights = (count: number): Array<[number, number]> =>
      Array.from({ length: count }, (_, index): [number, number] => [
        320 + index,
        240.5,
      ]);
    expect(
      accepts(reference({ heights: heights(VISUAL_HEIGHTS_MAX_ENTRIES) })),
    ).toBe(true);
    expect(
      accepts(reference({ heights: heights(VISUAL_HEIGHTS_MAX_ENTRIES + 1) })),
    ).toBe(false);
  });

  it('accepts exactly the visual ids storage accepts', () => {
    for (const candidate of [
      visualId,
      'vis_123E4567-e89b-42d3-a456-426614174000',
      'vis_123e4567e89b42d3a456426614174000',
      `${visualId}0`,
      'img_123e4567-e89b-42d3-a456-426614174000',
    ])
      expect(accepts(reference({ visualId: candidate }))).toBe(
        isVisualId(candidate),
      );
  });
});
