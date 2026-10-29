import type {
  PlanCommentThread,
  SaveTrackedPlanCommentsRequest,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import {
  planViewKey,
  resetPlanViewStoreForTests,
  usePlanViewStore,
  type PlanViewTarget,
} from '../planViewStore';

const TARGET: PlanViewTarget = {
  projectId: 'proj-1',
  worktreeId: 'wt-1',
  planId: 'plan-1',
};
const KEY = planViewKey(TARGET.projectId, TARGET.worktreeId, TARGET.planId);

let saveCommentsMock: jest.Mock<
  Promise<TrackedPlanData | null>,
  [SaveTrackedPlanCommentsRequest]
>;

function thread(id: string): PlanCommentThread {
  return {
    id,
    status: 'open',
    createdAt: '2026-06-06T00:00:00.000Z',
    anchorState: 'matched',
    anchor: { quote: '', unanchored: true },
    comments: [
      {
        id: `${id}-c1`,
        author: 'user',
        body: 'Note',
        createdAt: '2026-06-06T00:00:00.000Z',
        staged: true,
      },
    ],
  };
}

function state(): ReturnType<typeof usePlanViewStore.getState> {
  return usePlanViewStore.getState();
}

function threadIds(): string[] {
  return (state().entries[KEY]?.threads ?? []).map((entry) => entry.id);
}

/** Let settled save promises run their continuations. */
async function flushSaves(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
  }
}

function persistedPlan(commentThreads: PlanCommentThread[]): TrackedPlanData {
  return {
    id: TARGET.planId,
    projectId: TARGET.projectId,
    worktreeId: TARGET.worktreeId,
    source: 'claude',
    title: 'Plan',
    content: '# Plan',
    reviewStatus: 'pending',
    createdAt: '2026-06-06T00:00:00.000Z',
    updatedAt: '2026-06-06T00:00:00.000Z',
    latestRevisionNumber: 1,
    revisions: [],
    linkedExecutionIds: [],
    commentThreads,
  };
}

interface HeldSave {
  readonly request: SaveTrackedPlanCommentsRequest;
  readonly resolve: (plan: TrackedPlanData | null) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Hold every `saveComments` call until the test settles it. `echo(index)` is
 * what main broadcasts for that save (`trackedPlansUpdated`): a fresh copy of
 * the saved threads, as the IPC boundary delivers it.
 */
function holdSaves(): {
  readonly echo: (index: number) => PlanCommentThread[];
  readonly resolve: (index: number) => Promise<void>;
  readonly reject: (index: number) => Promise<void>;
} {
  const held: HeldSave[] = [];
  saveCommentsMock.mockImplementation(
    (request): Promise<TrackedPlanData | null> =>
      new Promise((resolve, reject) => {
        held.push({ request, resolve, reject });
      }),
  );
  const save = (index: number): HeldSave => {
    const entry = held[index];
    if (!entry) {
      throw new Error(`Expected save ${index} to have started`);
    }
    return entry;
  };
  return {
    echo: (index) => structuredClone(save(index).request.commentThreads),
    resolve: async (index): Promise<void> => {
      const entry = save(index);
      entry.resolve(
        persistedPlan(structuredClone(entry.request.commentThreads)),
      );
      await flushSaves();
    },
    reject: async (index): Promise<void> => {
      save(index).reject(new Error('save failed'));
      await flushSaves();
    },
  };
}

beforeEach(() => {
  resetPlanViewStoreForTests();
  saveCommentsMock = jest
    .fn<Promise<TrackedPlanData | null>, [SaveTrackedPlanCommentsRequest]>()
    .mockResolvedValue(null);
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { api: { activity: { plans: { saveComments: saveCommentsMock } } } },
  });
});

describe('planViewKey', () => {
  it('keeps ids with separators distinct', () => {
    expect(planViewKey('a/b', 'c', 'd')).not.toBe(planViewKey('a', 'b/c', 'd'));
  });
});

describe('planViewStore holds', () => {
  it('drops the entry when the last hold is released', () => {
    state().acquire(KEY);
    state().acquire(KEY);
    expect(state().entries[KEY]?.refs).toBe(2);

    state().release(KEY);
    expect(state().entries[KEY]?.refs).toBe(1);

    state().release(KEY);
    expect(state().entries[KEY]).toBeUndefined();
  });

  it('starts a new entry on the document tab without threads', () => {
    state().acquire(KEY);
    expect(state().entries[KEY]).toEqual({
      refs: 1,
      threadsSynced: false,
      threadsSource: undefined,
      threads: [],
      pendingSaves: 0,
      deferredSource: null,
      saveFailed: false,
      submitting: false,
      innerTab: 'document',
      diagramReveal: null,
    });
  });

  it('keeps the entry until a save started before the last release settles', async () => {
    const saves = holdSaves();
    state().acquire(KEY);
    state().syncPersistedThreads(KEY, [thread('t1')]);
    state().mutateThreads(KEY, TARGET, (current) => [...current, thread('t2')]);

    state().release(KEY);
    expect(state().entries[KEY]?.pendingSaves).toBe(1);

    await saves.resolve(0);
    expect(state().entries[KEY]).toBeUndefined();
  });
});

describe('planViewStore.syncPersistedThreads', () => {
  it('adopts a new persisted array and ignores a repeat of the same one', async () => {
    const persisted = [thread('t1')];
    state().acquire(KEY);
    state().syncPersistedThreads(KEY, persisted);
    expect(state().entries[KEY]?.threads).toBe(persisted);

    // A local edit survives a re-sync of the unchanged persisted array.
    state().mutateThreads(KEY, TARGET, (current) => [...current, thread('t2')]);
    state().syncPersistedThreads(KEY, persisted);
    expect(state().entries[KEY]?.threads.map((entry) => entry.id)).toEqual([
      't1',
      't2',
    ]);
    await flushSaves();

    const inbound = [thread('t1'), thread('t2'), thread('t3')];
    state().syncPersistedThreads(KEY, inbound);
    expect(state().entries[KEY]?.threads).toBe(inbound);
  });

  it('applies an inbound update at once when no save is in flight', async () => {
    const saves = holdSaves();
    state().acquire(KEY);
    state().syncPersistedThreads(KEY, [thread('t1')]);
    state().mutateThreads(KEY, TARGET, (current) => [...current, thread('t2')]);
    await saves.resolve(0);

    // A teammate's comment arrives after the save settled.
    const remote = [thread('t1'), thread('t2'), thread('t-remote')];
    state().syncPersistedThreads(KEY, remote);

    expect(state().entries[KEY]?.threads).toBe(remote);
  });

  it('keeps an edit staged while an earlier save is echoed back', async () => {
    const saves = holdSaves();
    state().acquire(KEY);
    state().syncPersistedThreads(KEY, [thread('t1')]);
    state().mutateThreads(KEY, TARGET, (current) => [...current, thread('t2')]);
    state().mutateThreads(KEY, TARGET, (current) => [...current, thread('t3')]);

    // Save A's echo lands while save B is still in flight.
    state().syncPersistedThreads(KEY, saves.echo(0));
    expect(threadIds()).toEqual(['t1', 't2', 't3']);
    await saves.resolve(0);
    expect(threadIds()).toEqual(['t1', 't2', 't3']);

    const echoB = saves.echo(1);
    state().syncPersistedThreads(KEY, echoB);
    await saves.resolve(1);
    expect(state().entries[KEY]?.threads).toEqual(echoB);
  });

  it('keeps an edit whose save failed after an earlier save was echoed', async () => {
    const saves = holdSaves();
    state().acquire(KEY);
    state().syncPersistedThreads(KEY, [thread('t1')]);
    state().mutateThreads(KEY, TARGET, (current) => [...current, thread('t2')]);
    state().mutateThreads(KEY, TARGET, (current) => [...current, thread('t3')]);

    const echoA = saves.echo(0);
    state().syncPersistedThreads(KEY, echoA);
    await saves.resolve(0);
    await saves.reject(1);
    expect(threadIds()).toEqual(['t1', 't2', 't3']);

    // A view opened later syncs the same persisted array: the edit stays…
    state().syncPersistedThreads(KEY, echoA);
    expect(threadIds()).toEqual(['t1', 't2', 't3']);

    // …and the next edit saves the full list again.
    state().mutateThreads(KEY, TARGET, (current) => [...current, thread('t4')]);
    expect(
      saveCommentsMock.mock.lastCall?.[0].commentThreads.map(
        (entry) => entry.id,
      ),
    ).toEqual(['t1', 't2', 't3', 't4']);
  });

  it.each(['echo', 'reply'])(
    'converges on the final persisted array when each save’s %s arrives first',
    async (first) => {
      const saves = holdSaves();
      state().acquire(KEY);
      state().syncPersistedThreads(KEY, [thread('t1')]);
      state().mutateThreads(KEY, TARGET, (current) => [
        ...current,
        thread('t2'),
      ]);
      state().mutateThreads(KEY, TARGET, (current) => [
        ...current,
        thread('t3'),
      ]);

      for (const index of [0, 1]) {
        const echo = saves.echo(index);
        if (first === 'echo') {
          state().syncPersistedThreads(KEY, echo);
          expect(threadIds()).toEqual(['t1', 't2', 't3']);
          await saves.resolve(index);
        } else {
          await saves.resolve(index);
          expect(threadIds()).toEqual(['t1', 't2', 't3']);
          state().syncPersistedThreads(KEY, echo);
        }
        expect(threadIds()).toEqual(['t1', 't2', 't3']);
      }

      const entry = state().entries[KEY];
      expect(entry?.threads).toEqual(saves.echo(1));
      expect(entry?.pendingSaves).toBe(0);
      expect(entry?.deferredSource).toBeNull();
    },
  );

  it('treats a plan without threads as an empty list', () => {
    state().acquire(KEY);
    state().syncPersistedThreads(KEY, undefined);
    expect(state().entries[KEY]?.threadsSynced).toBe(true);
    expect(state().entries[KEY]?.threads).toEqual([]);
  });

  it('ignores an unknown key', () => {
    state().syncPersistedThreads(KEY, [thread('t1')]);
    expect(state().entries[KEY]).toBeUndefined();
  });
});

describe('planViewStore.mutateThreads', () => {
  it('applies the updater to the current threads and saves the result', () => {
    state().acquire(KEY);
    state().syncPersistedThreads(KEY, [thread('t1')]);

    state().mutateThreads(KEY, TARGET, (current) => [...current, thread('t2')]);
    state().mutateThreads(KEY, TARGET, (current) => [...current, thread('t3')]);

    const ids = ['t1', 't2', 't3'];
    expect(state().entries[KEY]?.threads.map((entry) => entry.id)).toEqual(ids);
    expect(saveCommentsMock).toHaveBeenCalledTimes(2);
    const saved = saveCommentsMock.mock.lastCall?.[0];
    expect(saved).toMatchObject(TARGET);
    expect(saved?.commentThreads.map((entry) => entry.id)).toEqual(ids);
  });

  it('never saves for an unknown or unsynced entry, or an unchanged list', () => {
    state().mutateThreads(KEY, TARGET, () => [thread('t1')]);
    state().acquire(KEY);
    state().mutateThreads(KEY, TARGET, () => [thread('t1')]);
    state().syncPersistedThreads(KEY, [thread('t1')]);
    state().mutateThreads(KEY, TARGET, (current) => current);

    expect(saveCommentsMock).not.toHaveBeenCalled();
    expect(state().entries[KEY]?.threads.map((entry) => entry.id)).toEqual([
      't1',
    ]);
  });
});

describe('planViewStore submit guard', () => {
  it('refuses to begin a submit for an unknown key', () => {
    expect(state().beginSubmit(KEY)).toBe(false);
    expect(state().entries[KEY]).toBeUndefined();
  });

  it('allows one submit at a time until it ends', () => {
    state().acquire(KEY);

    expect(state().beginSubmit(KEY)).toBe(true);
    expect(state().entries[KEY]?.submitting).toBe(true);
    expect(state().beginSubmit(KEY)).toBe(false);

    state().endSubmit(KEY);
    expect(state().entries[KEY]?.submitting).toBe(false);
    expect(state().beginSubmit(KEY)).toBe(true);
  });

  it('keeps holds and threads while a submit begins and ends', () => {
    state().acquire(KEY);
    state().syncPersistedThreads(KEY, [thread('t1')]);
    const before = state().entries[KEY];

    state().beginSubmit(KEY);
    state().endSubmit(KEY);

    expect(state().entries[KEY]).toEqual(before);
  });

  it('ignores ending a submit for an unknown key', () => {
    state().endSubmit(KEY);
    expect(state().entries[KEY]).toBeUndefined();
  });
});

describe('planViewStore view state', () => {
  it('sets the inner tab of a held entry only', () => {
    state().setInnerTab(KEY, 'diagram');
    expect(state().entries[KEY]).toBeUndefined();

    state().acquire(KEY);
    state().setInnerTab(KEY, 'diagram');
    expect(state().entries[KEY]?.innerTab).toBe('diagram');
  });

  it('issues diagram reveal requests with increasing ids', () => {
    state().requestDiagramReveal(KEY, 'sequence', 'node-0');
    expect(state().entries[KEY]).toBeUndefined();

    state().acquire(KEY);
    state().requestDiagramReveal(KEY, 'sequence', 'node-1');
    const first = state().entries[KEY]?.diagramReveal;
    state().requestDiagramReveal(KEY, 'sequence', 'node-1');
    const second = state().entries[KEY]?.diagramReveal;

    expect(first).toMatchObject({ diagramKind: 'sequence', nodeId: 'node-1' });
    expect(second?.nodeId).toBe('node-1');
    expect(second?.requestId ?? 0).toBeGreaterThan(first?.requestId ?? 0);
  });
});
