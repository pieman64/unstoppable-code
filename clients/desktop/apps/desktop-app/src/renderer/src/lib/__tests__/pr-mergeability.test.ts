import { isPrReadyToMerge } from '../pr-mergeability';

const baseStatus = {
  state: 'open' as const,
  checkStatus: 'passing' as const,
  reviewStatus: 'approved' as const,
  hasConflicts: false,
};

describe('isPrReadyToMerge', () => {
  it.each(['clean', 'has_hooks'])(
    'treats GitHub mergeable_state %s as ready',
    (mergeableState) => {
      expect(isPrReadyToMerge({ ...baseStatus, mergeableState })).toBe(true);
    },
  );

  it.each(['blocked', 'dirty', 'draft', 'behind', 'unstable', 'unknown'])(
    'treats GitHub mergeable_state %s as not ready',
    (mergeableState) => {
      expect(isPrReadyToMerge({ ...baseStatus, mergeableState })).toBe(false);
    },
  );

  it('falls back to mergeable plus local approval/check status when mergeable_state is absent', () => {
    expect(isPrReadyToMerge({ ...baseStatus, mergeable: true })).toBe(true);
    expect(
      isPrReadyToMerge({
        ...baseStatus,
        checkStatus: 'failing',
        mergeable: true,
      }),
    ).toBe(false);
  });

  it('treats explicit unknown mergeability as not ready', () => {
    expect(
      isPrReadyToMerge({
        ...baseStatus,
        mergeable: null,
        mergeableState: null,
      }),
    ).toBe(false);
  });

  it('falls back to local status only for older statuses with no mergeability fields', () => {
    expect(isPrReadyToMerge(baseStatus)).toBe(true);
  });
});
