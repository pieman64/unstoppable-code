import {
  DelegationLaunchJournal,
  type DelegationLaunchRecord,
  type DelegationNativeReconciliation,
} from '../launch-journal';

describe('durable launch ordering and restart reconciliation', () => {
  let writes: DelegationLaunchRecord[];
  const persist = (record: DelegationLaunchRecord): Promise<void> => {
    writes.push(structuredClone(record));
    return Promise.resolve();
  };
  beforeEach(() => {
    writes = [];
  });
  const identity = {
    delegationId: 'child',
    launchKey: 'trusted-call-hash',
    runGeneration: 1,
  };

  it('persists reservation and dispatch exactly once before recording a native identity', async () => {
    const journal = await DelegationLaunchJournal.reserve(identity, {
      commit: persist,
    });
    expect(writes.map((record) => record.phase)).toEqual(['reserved']);
    expect(
      await Promise.all([journal.beforeStart(), journal.beforeStart()]),
    ).toEqual([true, false]);
    await journal.identify('native-child');
    await journal.identify('native-child');
    expect(writes.map((record) => record.phase)).toEqual([
      'reserved',
      'starting',
      'identified',
    ]);
    await expect(journal.identify('foreign-child')).rejects.toThrow(
      'Invalid native',
    );
  });

  it('rebinds an identified run to a new native session for later reconciliation', async () => {
    const journal = await DelegationLaunchJournal.reserve(identity, {
      commit: persist,
    });
    await expect(journal.rebind('native-reloaded')).rejects.toThrow(
      'Invalid native',
    );
    await journal.beforeStart();
    await journal.identify('native-child');
    await journal.rebind('native-reloaded');
    expect(journal.snapshot()).toMatchObject({
      phase: 'identified',
      nativeSessionId: 'native-reloaded',
    });
    const probe = jest.fn(
      (): Promise<DelegationNativeReconciliation> =>
        Promise.resolve({
          status: 'active',
          nativeSessionId: 'native-reloaded',
        }),
    );
    expect(await journal.reconcile(probe)).toEqual({
      status: 'active',
      nativeSessionId: 'native-reloaded',
    });
  });

  it.each(['unknown', 'active', 'terminal'] as const)(
    'reconciles %s native state without permitting another paid launch',
    async (status) => {
      const journal = await DelegationLaunchJournal.reserve(identity, {
        commit: persist,
      });
      await journal.beforeStart();
      const restarted = DelegationLaunchJournal.restore(journal.snapshot(), {
        commit: persist,
      });
      const probe = jest.fn(
        (): Promise<DelegationNativeReconciliation> =>
          Promise.resolve(
            status === 'unknown'
              ? { status }
              : status === 'active'
                ? { status, nativeSessionId: 'native-child' }
                : {
                    status,
                    nativeSessionId: 'native-child',
                    terminalStatus: 'completed',
                  },
          ),
      );
      expect((await restarted.reconcile(probe)).status).toBe(status);
      expect(await restarted.beforeStart()).toBe(false);
      expect(restarted.snapshot().phase).toBe(
        status === 'terminal' ? 'settled' : 'interrupted',
      );
      expect(probe).toHaveBeenCalledTimes(1);
    },
  );

  it('does not probe or resume explicitly cancelled work after restart', async () => {
    const journal = await DelegationLaunchJournal.reserve(identity, {
      commit: persist,
    });
    await journal.settle('cancelled');
    const restarted = DelegationLaunchJournal.restore(journal.snapshot(), {
      commit: persist,
    });
    const probe = jest.fn();
    await restarted.reconcile(probe);
    expect(probe).not.toHaveBeenCalled();
    expect(await restarted.beforeStart()).toBe(false);
    expect(restarted.snapshot().terminalStatus).toBe('cancelled');
  });

  it('leaves a failed durable dispatch write reserved so no provider call can follow', async () => {
    const journal = await DelegationLaunchJournal.reserve(identity, {
      commit: (record) =>
        record.phase === 'starting'
          ? Promise.reject(new Error('disk unavailable'))
          : persist(record),
    });
    await expect(journal.beforeStart()).rejects.toThrow('disk unavailable');
    expect(journal.snapshot().phase).toBe('reserved');
  });

  it('fails closed on an unknown format and ignores a probe for a foreign native identity', async () => {
    const journal = await DelegationLaunchJournal.reserve(identity, {
      commit: persist,
    });
    await journal.beforeStart();
    await journal.identify('native-child');
    const restored = DelegationLaunchJournal.restore(journal.snapshot(), {
      commit: persist,
    });
    expect(
      await restored.reconcile(() =>
        Promise.resolve({ status: 'active', nativeSessionId: 'foreign-child' }),
      ),
    ).toEqual({ status: 'unknown' });
    expect(restored.snapshot().nativeSessionId).toBe('native-child');
    expect(() =>
      DelegationLaunchJournal.restore(
        { ...journal.snapshot(), runGeneration: 0 },
        { commit: persist },
      ),
    ).toThrow('Invalid delegation launch record');
  });
});
