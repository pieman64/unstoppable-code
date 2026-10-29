import type { SplitPrProgressEvent } from '@canopy/desktop-shared/types/github';
import { buildSplitRunningStatusLine } from '../split-progress';

function event(
  partial: Partial<SplitPrProgressEvent> & {
    phase: SplitPrProgressEvent['phase'];
  },
): SplitPrProgressEvent {
  return {
    projectId: 'proj-1',
    worktreeId: 'wt-1',
    ...partial,
  };
}

describe('buildSplitRunningStatusLine', () => {
  it('returns null for an empty feed', () => {
    expect(buildSplitRunningStatusLine([])).toBeNull();
  });

  it('returns the latest non-terminal phase label', () => {
    expect(
      buildSplitRunningStatusLine([
        event({ phase: 'gathering_diff' }),
        event({ phase: 'planning' }),
      ]),
    ).toBe('Planning split');
  });

  it('includes the child progress suffix when present', () => {
    expect(
      buildSplitRunningStatusLine([
        event({ phase: 'carving_child', childIndex: 2, childTotal: 4 }),
      ]),
    ).toBe('Carving child branch (2/4)');
  });

  it('skips a trailing terminal event and reports the last real phase', () => {
    expect(
      buildSplitRunningStatusLine([
        event({ phase: 'verifying_child', childIndex: 1, childTotal: 3 }),
        event({ phase: 'done' }),
      ]),
    ).toBe('Verifying child (1/3)');
  });

  it('returns null when the feed has only terminal events', () => {
    expect(
      buildSplitRunningStatusLine([event({ phase: 'cancelled' })]),
    ).toBeNull();
  });
});
