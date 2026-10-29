import {
  partitionReviewThreads,
  describeThreadReference,
} from '../reviewCommentList';
import type { ReviewCommentThread } from '@canopy/desktop-shared/types';

function thread(overrides: Partial<ReviewCommentThread>): ReviewCommentThread {
  return {
    id: 't',
    status: 'open',
    createdAt: '2026-04-10T12:00:00.000Z',
    anchorState: 'matched',
    anchor: {
      source: 'code',
      quote: 'x',
      repoId: 'default',
      filePath: 'src/a.ts',
      side: 'new',
      lineStart: 3,
      lineEnd: 3,
    },
    comments: [],
    ...overrides,
  };
}

describe('partitionReviewThreads', () => {
  it('puts open+matched in active, resolved or outdated in archived', () => {
    const open = thread({ id: 'open' });
    const resolved = thread({ id: 'resolved', status: 'resolved' });
    const outdated = thread({ id: 'outdated', anchorState: 'outdated' });
    const { active, archived } = partitionReviewThreads([
      open,
      resolved,
      outdated,
    ]);
    expect(active.map((t) => t.id)).toEqual(['open']);
    expect(archived.map((t) => t.id)).toEqual(['resolved', 'outdated']);
  });
});

describe('describeThreadReference', () => {
  it('formats a code anchor with its location and outdated flag', () => {
    const ref = describeThreadReference(thread({ anchorState: 'outdated' }));
    expect(ref.text).toContain('src/a.ts:3');
    expect(ref.outdated).toBe(true);
    expect(ref.isDiagram).toBe(false);
    expect(ref.isGeneral).toBe(false);
  });

  it('marks an unanchored (general) note', () => {
    const ref = describeThreadReference(
      thread({
        anchor: {
          source: 'code',
          quote: '',
          unanchored: true,
        },
      }),
    );
    expect(ref.isGeneral).toBe(true);
    expect(ref.text).toBe('General note');
    expect(ref.isDiagram).toBe(false);
  });
});
