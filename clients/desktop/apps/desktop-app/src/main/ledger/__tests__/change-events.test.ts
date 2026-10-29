import {
  notifyLedgerEntryChanged,
  notifyLedgerSyncChanged,
  onLedgerEntryChanged,
  onLedgerSyncChanged,
  withLedgerChangesWithheldForE2e,
  type LedgerEntryChange,
  type LedgerSyncChange,
} from '../change-events';

const CHANGE: LedgerEntryChange = {
  container: {
    kind: 'code_worktree',
    workspaceId: 'workspace-1',
    worktreeId: 'worktree-1',
  },
  entryId: '00000000-0000-4000-8000-000000000101',
  revision: 2,
};

describe('Ledger change events', () => {
  it('tells every listener, past one that throws, until it unsubscribes', () => {
    const heard: LedgerEntryChange[] = [];
    const stopThrowing = onLedgerEntryChanged(() => {
      throw new Error('listener failed');
    });
    const stop = onLedgerEntryChanged((change) => heard.push(change));

    notifyLedgerEntryChanged(CHANGE);
    stop();
    stopThrowing();
    notifyLedgerEntryChanged(CHANGE);

    expect(heard).toEqual([CHANGE]);
  });

  it('withholds the changes an E2E commit makes, and only those', async () => {
    const heard: LedgerEntryChange[] = [];
    const stop = onLedgerEntryChanged((change) => heard.push(change));

    await withLedgerChangesWithheldForE2e(() => {
      notifyLedgerEntryChanged(CHANGE);
      return Promise.resolve();
    });
    await expect(
      withLedgerChangesWithheldForE2e(() =>
        Promise.reject(new Error('commit failed')),
      ),
    ).rejects.toThrow('commit failed');
    notifyLedgerEntryChanged({ ...CHANGE, revision: 3 });
    stop();

    expect(heard).toEqual([{ ...CHANGE, revision: 3 }]);
  });

  it('tells sync listeners apart from entry listeners', () => {
    const entries: LedgerEntryChange[] = [];
    const syncs: LedgerSyncChange[] = [];
    const stopEntries = onLedgerEntryChanged((change) => entries.push(change));
    const stopThrowing = onLedgerSyncChanged(() => {
      throw new Error('listener failed');
    });
    const stopSyncs = onLedgerSyncChanged((change) => syncs.push(change));

    notifyLedgerSyncChanged({ kind: 'scope', container: CHANGE.container });
    notifyLedgerSyncChanged({ kind: 'all' });
    stopSyncs();
    stopThrowing();
    stopEntries();
    notifyLedgerSyncChanged({ kind: 'accounts_rebound' });

    expect(syncs).toEqual([
      { kind: 'scope', container: CHANGE.container },
      { kind: 'all' },
    ]);
    expect(entries).toEqual([]);
  });
});
