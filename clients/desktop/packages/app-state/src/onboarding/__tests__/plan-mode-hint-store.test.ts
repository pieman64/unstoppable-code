import {
  mergePlanModeHintRecords,
  type PlanModeHintRecord,
} from '@canopy/protocol/onboarding';
import {
  createPlanModeHintStore,
  isPlanModeHintAvailable,
  isPlanModeHintRetired,
  type PlanModeHintLoadResult,
  type PlanModeHintPersistence,
} from '../plan-mode-hint-store';

const NOW = new Date('2026-10-13T12:00:00.000Z');

/** A storage owner that merges like the desktop preference writer. */
function memoryPersistence(
  initial: PlanModeHintLoadResult | Error = {
    record: { version: 1, generation: 0 },
    persisted: true,
  },
): {
  saves: PlanModeHintRecord[];
  errors: string[];
  stored: PlanModeHintRecord | null;
  failNextSaves: (count: number) => void;
  holdLoad: (gate: Promise<void>) => void;
  persistence: PlanModeHintPersistence;
} {
  let stored: PlanModeHintRecord | null =
    initial instanceof Error || !initial.persisted ? null : initial.record;
  let failSaves = 0;
  let loadGate: Promise<void> = Promise.resolve();
  const saves: PlanModeHintRecord[] = [];
  const errors: string[] = [];
  return {
    saves,
    errors,
    get stored(): PlanModeHintRecord | null {
      return stored;
    },
    set stored(record: PlanModeHintRecord | null) {
      stored = record;
    },
    failNextSaves(count: number): void {
      failSaves = count;
    },
    holdLoad(gate: Promise<void>): void {
      loadGate = gate;
    },
    persistence: {
      now: (): Date => NOW,
      onError: (_error: unknown, operation: string): void => {
        errors.push(operation);
      },
      load: async (): Promise<PlanModeHintLoadResult> => {
        await loadGate;
        if (initial instanceof Error) throw initial;
        return stored === null ? initial : { record: stored, persisted: true };
      },
      save: (record: PlanModeHintRecord): Promise<PlanModeHintRecord> => {
        saves.push(record);
        if (failSaves > 0) {
          failSaves -= 1;
          return Promise.reject(new Error('disk full'));
        }
        stored =
          stored === null ? record : mergePlanModeHintRecords(stored, record);
        return Promise.resolve(stored);
      },
    },
  };
}

describe('createPlanModeHintStore', () => {
  it('stays unavailable until trustworthy hydration', async () => {
    const memory = memoryPersistence();
    const store = createPlanModeHintStore(memory.persistence);
    expect(store.getState().status).toBe('loading');
    expect(isPlanModeHintAvailable(store.getState())).toBe(false);
    await store.getState().hydrate();
    expect(isPlanModeHintAvailable(store.getState())).toBe(true);
    expect(memory.saves).toEqual([]);
  });

  it('never writes defaults over a degraded read', async () => {
    const memory = memoryPersistence(new Error('corrupt'));
    const store = createPlanModeHintStore(memory.persistence);
    await store.getState().hydrate();
    expect(store.getState().status).toBe('error');
    expect(isPlanModeHintAvailable(store.getState())).toBe(false);
    await store.getState().markShown();
    expect(memory.saves).toEqual([]);
    expect(memory.errors).toEqual(['hydrate']);
  });

  it('saves a migrated record before treating it as durable', async () => {
    const memory = memoryPersistence({
      record: {
        version: 1,
        generation: 0,
        dismissedAt: '2026-01-01T00:00:00.000Z',
      },
      persisted: false,
    });
    const store = createPlanModeHintStore(memory.persistence);
    await store.getState().hydrate();
    expect(memory.stored?.dismissedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(isPlanModeHintRetired(store.getState())).toBe(true);
  });

  it('does not let hydration overwrite an action taken while loading', async () => {
    const memory = memoryPersistence();
    let release!: () => void;
    memory.holdLoad(new Promise((resolve) => (release = resolve)));
    const store = createPlanModeHintStore(memory.persistence);
    const hydrated = store.getState().hydrate();
    const tried = store.getState().markTried();
    expect(isPlanModeHintRetired(store.getState())).toBe(true);
    release();
    await hydrated;
    await expect(tried).resolves.toBe(true);
    expect(store.getState().record?.triedAt).toBe(NOW.toISOString());
    expect(memory.stored?.triedAt).toBe(NOW.toISOString());
  });

  it('suppresses locally on a failed save and retries with the original generation', async () => {
    const memory = memoryPersistence();
    const store = createPlanModeHintStore(memory.persistence);
    await store.getState().hydrate();
    memory.failNextSaves(1);
    await expect(store.getState().markDismissed()).resolves.toBe(false);
    expect(isPlanModeHintRetired(store.getState())).toBe(true);
    expect(store.getState().record?.dismissedAt).toBeUndefined();
    expect(memory.errors).toEqual(['dismissed']);

    await store.getState().markShown();
    expect(memory.stored).toEqual({
      version: 1,
      generation: 0,
      dismissedAt: NOW.toISOString(),
      shownAt: NOW.toISOString(),
    });
    expect(memory.saves.every((save) => save.generation === 0)).toBe(true);
  });

  it('keeps retirement when a stale impression lands later', async () => {
    const memory = memoryPersistence();
    const store = createPlanModeHintStore(memory.persistence);
    await store.getState().hydrate();
    await Promise.all([
      store.getState().markDismissed(),
      store.getState().markShown(),
    ]);
    expect(store.getState().record?.dismissedAt).toBe(NOW.toISOString());
    expect(isPlanModeHintRetired(store.getState())).toBe(true);
  });

  it('resets to a new generation that older pending writes cannot resurrect', async () => {
    const memory = memoryPersistence();
    const store = createPlanModeHintStore(memory.persistence);
    await store.getState().hydrate();
    memory.failNextSaves(1);
    await store.getState().markTried();
    await expect(store.getState().reset()).resolves.toBe(true);
    expect(store.getState().record).toEqual({ version: 1, generation: 1 });
    expect(isPlanModeHintAvailable(store.getState())).toBe(true);

    await store.getState().markShown();
    expect(memory.stored).toEqual({
      version: 1,
      generation: 1,
      shownAt: NOW.toISOString(),
    });

    // Reload: the stored marker wins; legacy progress is not remigrated.
    const reloaded = createPlanModeHintStore(memory.persistence);
    await reloaded.getState().hydrate();
    expect(isPlanModeHintAvailable(reloaded.getState())).toBe(true);
  });

  it('does not reset before hydration or on a failed save', async () => {
    const memory = memoryPersistence();
    const store = createPlanModeHintStore(memory.persistence);
    await expect(store.getState().reset()).resolves.toBe(false);
    await store.getState().hydrate();
    await store.getState().markDismissed();
    memory.failNextSaves(1);
    await expect(store.getState().reset()).resolves.toBe(false);
    expect(isPlanModeHintRetired(store.getState())).toBe(true);
    expect(memory.errors).toEqual(['reset']);
  });

  it('reconciles external retirement and resets', async () => {
    const memory = memoryPersistence();
    const store = createPlanModeHintStore(memory.persistence);
    store.getState().reconcile({
      version: 1,
      generation: 0,
      triedAt: NOW.toISOString(),
    });
    expect(store.getState().status).toBe('loading');
    await store.getState().hydrate();

    store.getState().reconcile({
      version: 1,
      generation: 0,
      triedAt: NOW.toISOString(),
    });
    expect(isPlanModeHintRetired(store.getState())).toBe(true);
    // A stale external snapshot cannot un-retire.
    store.getState().reconcile({ version: 1, generation: 0 });
    expect(isPlanModeHintRetired(store.getState())).toBe(true);

    store.getState().reconcile({ version: 1, generation: 2 });
    expect(store.getState().record).toEqual({ version: 1, generation: 2 });
    expect(isPlanModeHintAvailable(store.getState())).toBe(true);
  });
  it('keeps a newer external reset when an older local reset save finishes', async () => {
    const memory = memoryPersistence();
    let finish!: (record: PlanModeHintRecord) => void;
    const store = createPlanModeHintStore({
      ...memory.persistence,
      save: () =>
        new Promise((done) => {
          finish = done;
        }),
    });
    await store.getState().hydrate();
    const resetting = store.getState().reset();
    await Promise.resolve();
    store.getState().reconcile({ version: 1, generation: 2 });
    finish({ version: 1, generation: 1 });
    await resetting;
    expect(store.getState().record?.generation).toBe(2);
  });
  it('keeps an external retirement received during a delayed hydration', async () => {
    const memory = memoryPersistence();
    let release!: () => void;
    memory.holdLoad(
      new Promise((done) => {
        release = done;
      }),
    );
    const store = createPlanModeHintStore(memory.persistence);
    const loading = store.getState().hydrate();
    store
      .getState()
      .reconcile({ version: 1, generation: 0, dismissedAt: NOW.toISOString() });
    release();
    await loading;
    expect(isPlanModeHintRetired(store.getState())).toBe(true);
  });

  it('does not let a queued pre-reset retirement adopt the external reset generation', async () => {
    const memory = memoryPersistence();
    const store = createPlanModeHintStore(memory.persistence);
    await store.getState().hydrate();
    const retiring = store.getState().markTried();
    store.getState().reconcile({ version: 1, generation: 1 });
    await retiring;
    expect(store.getState().record).toEqual({ version: 1, generation: 1 });
  });
  it('clears old local suppression when a stale write reply reveals a reset first', async () => {
    const memory = memoryPersistence();
    const store = createPlanModeHintStore(memory.persistence);
    await store.getState().hydrate();
    memory.stored = { version: 1, generation: 1 };
    expect(await store.getState().markTried()).toBe(false);
    store.getState().reconcile({ version: 1, generation: 1 });
    expect(isPlanModeHintAvailable(store.getState())).toBe(true);
    expect(store.getState().record).toEqual({ version: 1, generation: 1 });
  });

  it('clears failed-action suppression when trustworthy hydration discovers a reset', async () => {
    const memory = memoryPersistence();
    const store = createPlanModeHintStore(memory.persistence);
    await store.getState().hydrate();
    memory.failNextSaves(1);
    await store.getState().markDismissed();
    memory.stored = { version: 1, generation: 1 };
    await store.getState().hydrate();
    expect(isPlanModeHintAvailable(store.getState())).toBe(true);
    expect(store.getState().record).toEqual({ version: 1, generation: 1 });
  });
});
