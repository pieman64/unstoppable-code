import type { LedgerViewChangedEvent } from '@canopy/protocol/ledger-view';
import { createLedgerChangeBroadcaster } from '../ledger';

describe('Ledger title-resolution change events', () => {
  afterEach((): void => {
    jest.useRealTimers();
  });

  it('preserves titleResolved at the same revision and when coalesced with a later revision', () => {
    jest.useFakeTimers();
    const events: LedgerViewChangedEvent[] = [];
    const broadcaster = createLedgerChangeBroadcaster((event): void => {
      events.push(event);
    }, 25);
    const scope = { projectId: 'workspace-1', worktreeId: 'worktree-1' };

    broadcaster.push({
      scope,
      entryId: 'entry-1',
      revision: 4,
      titleResolved: true,
    });
    broadcaster.push({ scope, entryId: 'entry-1', revision: 4 });
    jest.advanceTimersByTime(25);

    expect(events[0]?.changes).toEqual([
      {
        scope,
        entryId: 'entry-1',
        revision: 4,
        titleResolved: true,
      },
    ]);

    broadcaster.push({
      scope,
      entryId: 'entry-2',
      revision: 5,
      titleResolved: true,
    });
    broadcaster.push({ scope, entryId: 'entry-2', revision: 6 });
    jest.advanceTimersByTime(25);

    expect(events[1]?.changes).toEqual([
      {
        scope,
        entryId: 'entry-2',
        revision: 6,
        titleResolved: true,
      },
    ]);
    broadcaster.dispose();
  });
});
