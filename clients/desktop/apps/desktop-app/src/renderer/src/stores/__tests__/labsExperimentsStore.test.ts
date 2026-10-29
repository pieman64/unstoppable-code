/**
 * @jest-environment jsdom
 */
import { EXTRACTED_EARLY_ACCESS_EXPERIMENT_IDS } from '@canopy/protocol/experiments';

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  labsOwnedSidebarKeys,
  type LabsExperimentsSnapshot,
} from '@canopy/desktop-shared/lib/labs-experiments';
import {
  createTestExperimentsBridge,
  makeTestLabsSnapshot,
  pageExperimentsOn,
  type TestExperimentsBridge,
} from '@/test-utils/labsExperiments';
import {
  getLabsFeatureEnabled,
  subscribeLabsFeature,
  applyLabsExperimentsSnapshot,
  ensureLabsExperimentsSubscription,
  LABS_EXPERIMENT_SAVE_ERROR,
  resetLabsExperimentsStoreForTest,
  setLabsExperimentChoice,
  useLabsExperimentsStore,
  useLabsOwnedSidebarKeys,
} from '../labsExperimentsStore';

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');

const AUDIT = {
  id: 'audit',
  pages: ['audit' as const],
  sidebarKeys: ['audit'],
  availability: 'offered' as const,
};

function installApi(bridge: TestExperimentsBridge | null): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: bridge ? { experiments: bridge.api } : {},
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

/** Mounts `useLabsOwnedSidebarKeys` and records every value it returns. */
function renderOwnedKeys(): {
  results: (readonly string[])[];
  unmount: () => void;
} {
  const results: (readonly string[])[] = [];
  function Probe(): null {
    results.push(useLabsOwnedSidebarKeys());
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => {
    root.render(createElement(Probe));
  });
  return { results, unmount: () => act(() => root.unmount()) };
}

function latest(results: (readonly string[])[]): readonly string[] {
  return results[results.length - 1] ?? [];
}

function state(): ReturnType<typeof useLabsExperimentsStore.getState> {
  return useLabsExperimentsStore.getState();
}

afterEach(() => {
  resetLabsExperimentsStoreForTest();
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor);
  } else {
    Reflect.deleteProperty(window, 'api');
  }
});

describe('labsExperimentsStore', () => {
  it('allows a valid registry id that matches an inherited object property', async () => {
    const bridge = createTestExperimentsBridge(
      makeTestLabsSnapshot({
        earlyAccess: true,
        experiments: [{ id: 'constructor', choice: false }],
      }),
    );
    installApi(bridge);
    ensureLabsExperimentsSubscription();
    await flush();
    await setLabsExperimentChoice('constructor', true);
    expect(bridge.requests).toEqual([
      { experimentId: 'constructor', enabled: true },
    ]);
  });
  it('subscribes before reading and keeps a newer push over a late read', async () => {
    const bridge = createTestExperimentsBridge();
    const read = deferred<LabsExperimentsSnapshot>();
    let subscribedBeforeRead = false;
    bridge.api.getSnapshot = (): Promise<LabsExperimentsSnapshot> => {
      subscribedBeforeRead = bridge.subscriberCount() === 1;
      return read.promise;
    };
    installApi(bridge);
    ensureLabsExperimentsSubscription();
    await flush();
    expect(subscribedBeforeRead).toBe(true);
    expect(state().hydrated).toBe(false);

    bridge.push(makeTestLabsSnapshot({ earlyAccess: true, revision: 5 }));
    read.resolve(makeTestLabsSnapshot({ earlyAccess: false, revision: 3 }));
    await flush();

    expect(state().snapshot?.revision).toBe(5);
    expect(state().snapshot?.earlyAccessEnabled).toBe(true);
  });

  it('is idempotent', async () => {
    const bridge = createTestExperimentsBridge();
    installApi(bridge);
    ensureLabsExperimentsSubscription();
    ensureLabsExperimentsSubscription();
    await flush();
    expect(bridge.subscriberCount()).toBe(1);
  });

  it('settles hydration fail-closed if subscribing to a partial bridge throws', async () => {
    const bridge = createTestExperimentsBridge(
      makeTestLabsSnapshot({ earlyAccess: true }),
    );
    bridge.api.onSnapshotChanged = (): (() => void) => {
      throw new Error('Bridge closed');
    };
    installApi(bridge);
    expect(() => ensureLabsExperimentsSubscription()).not.toThrow();
    await flush();
    expect(state()).toMatchObject({ hydrated: true, snapshot: null });
  });

  it('ignores a disposed hydration read even if it has a higher generation', async () => {
    const first = createTestExperimentsBridge();
    const read = deferred<LabsExperimentsSnapshot>();
    first.api.getSnapshot = (): Promise<LabsExperimentsSnapshot> =>
      read.promise;
    installApi(first);
    ensureLabsExperimentsSubscription();
    await flush();
    resetLabsExperimentsStoreForTest();
    const replacement = createTestExperimentsBridge(
      makeTestLabsSnapshot({ scope: 'replacement', generation: 1 }),
    );
    installApi(replacement);
    ensureLabsExperimentsSubscription();
    await flush();
    read.resolve(
      makeTestLabsSnapshot({ scope: 'old', earlyAccess: true, generation: 10 }),
    );
    await flush();
    expect(first.subscriberCount()).toBe(0);
    expect(state().snapshot?.scope).toBe('replacement');
  });

  it('settles hydration without a snapshot when the bridge is missing or fails', async () => {
    installApi(null);
    ensureLabsExperimentsSubscription();
    expect(state()).toMatchObject({ hydrated: true, snapshot: null });

    resetLabsExperimentsStoreForTest();
    const bridge = createTestExperimentsBridge();
    bridge.api.getSnapshot = (): Promise<LabsExperimentsSnapshot> =>
      Promise.reject(new Error('boom'));
    installApi(bridge);
    ensureLabsExperimentsSubscription();
    await flush();
    expect(state()).toMatchObject({ hydrated: true, snapshot: null });
  });

  it('shows the requested switch value while pending without changing effective state', async () => {
    const bridge = createTestExperimentsBridge(
      makeTestLabsSnapshot({ earlyAccess: true, experiments: [AUDIT] }),
    );
    const save = deferred<LabsExperimentsSnapshot>();
    bridge.respondWith(() => save.promise);
    installApi(bridge);
    ensureLabsExperimentsSubscription();
    await flush();

    const done = setLabsExperimentChoice('audit', true);
    expect(state().pending).toEqual({ audit: true });
    expect(
      state().snapshot?.experiments.find((entry) => entry.id === 'audit')
        ?.enabled,
    ).toBe(false);

    // A second submission for the same experiment is ignored while pending.
    void setLabsExperimentChoice('audit', false);
    expect(bridge.requests).toEqual([{ experimentId: 'audit', enabled: true }]);

    save.resolve(
      makeTestLabsSnapshot({
        earlyAccess: true,
        experiments: [{ ...AUDIT, choice: true }],
        revision: 2,
      }),
    );
    await done;
    expect(state().pending).toEqual({});
    expect(
      state().snapshot?.experiments.find((entry) => entry.id === 'audit')
        ?.enabled,
    ).toBe(true);
  });

  it('drops only the overlay on failure and keeps a newer pushed snapshot', async () => {
    const bridge = createTestExperimentsBridge(
      makeTestLabsSnapshot({ earlyAccess: true, experiments: [AUDIT] }),
    );
    const save = deferred<LabsExperimentsSnapshot>();
    bridge.respondWith(() => save.promise);
    installApi(bridge);
    ensureLabsExperimentsSubscription();
    await flush();

    const done = setLabsExperimentChoice('audit', true);
    bridge.push(
      makeTestLabsSnapshot({
        earlyAccess: true,
        experiments: [{ ...AUDIT, availability: 'on' }],
        revision: 4,
      }),
    );
    save.reject(new Error('network'));
    await done;

    expect(state().pending).toEqual({});
    expect(state().errors).toEqual({ audit: LABS_EXPERIMENT_SAVE_ERROR });
    expect(state().snapshot?.revision).toBe(4);

    // Retrying clears the stale error.
    bridge.respondWith(() => new Promise(() => undefined));
    void setLabsExperimentChoice('audit', true);
    expect(state().errors).toEqual({});
  });

  it('does not apply an older save result over a newer push', async () => {
    const bridge = createTestExperimentsBridge(
      makeTestLabsSnapshot({ earlyAccess: true, experiments: [AUDIT] }),
    );
    const save = deferred<LabsExperimentsSnapshot>();
    bridge.respondWith(() => save.promise);
    installApi(bridge);
    ensureLabsExperimentsSubscription();
    await flush();

    const done = setLabsExperimentChoice('audit', true);
    bridge.push(
      makeTestLabsSnapshot({
        earlyAccess: true,
        experiments: [{ ...AUDIT, availability: 'hidden', choice: true }],
        revision: 6,
      }),
    );
    save.resolve(
      makeTestLabsSnapshot({
        earlyAccess: true,
        experiments: [{ ...AUDIT, choice: true }],
        revision: 5,
      }),
    );
    await done;

    const audit = state().snapshot?.experiments.find(
      (entry) => entry.id === 'audit',
    );
    expect(audit).toMatchObject({ listed: false, enabled: false });
  });

  it('clears pending saves on an account change and ignores their completion', async () => {
    const bridge = createTestExperimentsBridge(
      makeTestLabsSnapshot({ earlyAccess: true, experiments: [AUDIT] }),
    );
    const save = deferred<LabsExperimentsSnapshot>();
    bridge.respondWith(() => save.promise);
    installApi(bridge);
    ensureLabsExperimentsSubscription();
    await flush();

    const done = setLabsExperimentChoice('audit', true);
    bridge.push(
      makeTestLabsSnapshot({
        generation: 2,
        revision: 7,
        scope: 'account:other',
      }),
    );
    expect(state().pending).toEqual({});

    save.reject(new Error('stale'));
    await done;
    expect(state().errors).toEqual({});
    expect(state().snapshot?.scope).toBe('account:other');
  });

  it('ignores saves before a ready snapshot', async () => {
    const bridge = createTestExperimentsBridge(
      makeTestLabsSnapshot({ ready: false }),
    );
    installApi(bridge);
    ensureLabsExperimentsSubscription();
    await flush();
    await setLabsExperimentChoice('early-access', true);
    expect(bridge.requests).toEqual([]);
  });

  describe('useLabsOwnedSidebarKeys', () => {
    beforeAll(() => {
      Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    });

    it('returns the registry keys before any snapshot arrives', () => {
      installApi(null);
      const { results, unmount } = renderOwnedKeys();
      expect(latest(results)).toEqual(labsOwnedSidebarKeys());
      unmount();
    });

    it('drops a key whose experiment leaves the snapshot registry', () => {
      installApi(null);
      const { results, unmount } = renderOwnedKeys();
      act(() => {
        applyLabsExperimentsSnapshot(
          makeTestLabsSnapshot({
            earlyAccess: true,
            experiments: pageExperimentsOn().filter(
              (entry) => entry.id !== 'kanban-page',
            ),
            revision: 2,
          }),
        );
      });
      expect(latest(results)).toContain('overview');
      expect(latest(results)).not.toContain('kanban');
      unmount();
    });

    it('owns a key a fixture experiment carries', () => {
      installApi(null);
      const { results, unmount } = renderOwnedKeys();
      act(() => {
        applyLabsExperimentsSnapshot(
          makeTestLabsSnapshot({
            experiments: [
              ...pageExperimentsOn(),
              { id: 'feed-preview', sidebarKeys: ['feed'] },
            ],
            revision: 2,
          }),
        );
      });
      expect(latest(results)).toContain('feed');
      unmount();
    });

    it('keeps its identity until the owned set changes', () => {
      installApi(null);
      const { results, unmount } = renderOwnedKeys();
      act(() => {
        applyLabsExperimentsSnapshot(
          makeTestLabsSnapshot({
            experiments: pageExperimentsOn(),
            revision: 2,
          }),
        );
      });
      const first = latest(results);
      act(() => {
        applyLabsExperimentsSnapshot(
          makeTestLabsSnapshot({
            earlyAccess: true,
            experiments: pageExperimentsOn().map((entry) => ({
              ...entry,
              choice: false,
            })),
            revision: 3,
          }),
        );
      });
      expect(latest(results)).toBe(first);
      act(() => {
        applyLabsExperimentsSnapshot(
          makeTestLabsSnapshot({
            experiments: pageExperimentsOn().filter(
              (entry) => entry.id !== 'audit-trail-page',
            ),
            revision: 4,
          }),
        );
      });
      expect(latest(results)).not.toBe(first);
      expect(latest(results)).not.toContain('audit');
      unmount();
    });
  });
});

it('keeps every extracted feature independent of the legacy choice and other features', () => {
  for (const id of EXTRACTED_EARLY_ACCESS_EXPERIMENT_IDS) {
    const experiment = { id, requiresEarlyAccess: false, choice: true };
    useLabsExperimentsStore.setState({
      snapshot: makeTestLabsSnapshot({
        earlyAccess: false,
        experiments: [experiment],
      }),
    });
    expect(getLabsFeatureEnabled(id)).toBe(true);
    expect(getLabsFeatureEnabled('early-access')).toBe(false);
    const listener = jest.fn();
    const stop = subscribeLabsFeature(id, listener);
    useLabsExperimentsStore.setState({
      snapshot: makeTestLabsSnapshot({
        earlyAccess: true,
        experiments: [experiment],
      }),
    });
    expect(getLabsFeatureEnabled(id)).toBe(true);
    expect(listener).not.toHaveBeenCalled();
    useLabsExperimentsStore.setState({
      snapshot: makeTestLabsSnapshot({
        earlyAccess: true,
        experiments: [{ ...experiment, choice: false }],
      }),
    });
    expect(listener).toHaveBeenCalledWith(false, true);
    stop();
  }
});
