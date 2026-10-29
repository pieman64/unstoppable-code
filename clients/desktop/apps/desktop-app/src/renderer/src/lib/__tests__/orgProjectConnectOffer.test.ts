import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  OrgProjectSetupProgress,
  OrgProjectSetupState,
} from '@canopy/protocol/org-projects';
import { startOrgProjectSetupWithGitHubOffer } from '@/lib/orgProjectConnectOffer';
import { useGitHubConnectOfferStore } from '@/stores/githubConnectOfferStore';

interface TestState {
  accountEpoch: number;
  setupProgress: Record<string, OrgProjectSetupProgress>;
  startSetup: (projectId: string, destinationRoot?: string) => Promise<void>;
}

function progress(
  state: OrgProjectSetupState,
  updatedAt: string,
  errorCode?: string,
): OrgProjectSetupProgress {
  return {
    projectId: 'project-a',
    instanceId: null,
    state,
    message: null,
    percent: null,
    updatedAt,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

const T0 = '2026-10-19T10:00:00.000Z';
const T1 = '2026-10-19T10:00:01.000Z';
const T2 = '2026-10-19T10:00:02.000Z';

interface TestStore {
  api: {
    getState: () => TestState;
    subscribe: (listener: () => void) => () => void;
  };
  store: StoreApi<TestState>;
  startSetup: jest.Mock<Promise<void>, [string, string?]>;
  report: (next: OrgProjectSetupProgress) => void;
  listeners: () => number;
}

function createTestStore(initial: Partial<TestState> = {}): TestStore {
  const startSetup = jest.fn<Promise<void>, [string, string?]>();
  const store = createStore<TestState>(() => ({
    accountEpoch: 1,
    setupProgress: {},
    startSetup,
    ...initial,
  }));
  startSetup.mockImplementation(() => {
    report(progress('claiming', T1));
    return Promise.resolve();
  });
  function report(next: OrgProjectSetupProgress): void {
    store.setState((state) => ({
      setupProgress: { ...state.setupProgress, [next.projectId]: next },
    }));
  }
  // zustand exposes no listener count, so count the watch's own subscriptions.
  let active = 0;
  const subscribe = (listener: () => void): (() => void) => {
    const release = store.subscribe(listener);
    let released = false;
    active += 1;
    return (): void => {
      if (!released) active -= 1;
      released = true;
      release();
    };
  };
  const listeners = (): number => active;
  return {
    api: { getState: store.getState, subscribe },
    store,
    startSetup,
    report,
    listeners,
  };
}

const AUTH = 'github-not-authenticated';

describe('startOrgProjectSetupWithGitHubOffer', () => {
  const requestOffer = jest.fn(
    useGitHubConnectOfferStore.getState().requestOffer,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    useGitHubConnectOfferStore.setState({ offer: null, requestOffer });
  });

  it('offers once for a GitHub credential failure, with the account', async () => {
    const t = createTestStore({ accountEpoch: 7 });
    await startOrgProjectSetupWithGitHubOffer(t.api, 'project-a', '/repos');
    expect(t.startSetup).toHaveBeenCalledWith('project-a', '/repos');
    expect(requestOffer).not.toHaveBeenCalled();
    t.report(progress('failed', T2, AUTH));
    t.report(progress('failed', '2026-10-19T10:00:03.000Z', AUTH));
    expect(requestOffer).toHaveBeenCalledTimes(1);
    const continuation =
      useGitHubConnectOfferStore.getState().offer?.continuation;
    expect(typeof continuation?.operationId).toBe('string');
    expect(continuation).toEqual({
      operationId: continuation?.operationId,
      kind: 'org-project-setup',
      projectId: 'project-a',
      destinationRoot: '/repos',
      accountEpoch: 7,
    });
    expect(t.listeners()).toBe(0);
  });

  it.each([
    ['needs-credentials', 'failed', 'needs-credentials'],
    ['clone-failed', 'failed', 'clone-failed'],
    ['ready', 'ready', undefined],
    ['cancelled', 'cancelled', undefined],
  ] as const)('never offers for %s', async (_label, state, code) => {
    const t = createTestStore();
    await startOrgProjectSetupWithGitHubOffer(t.api, 'project-a', '/repos');
    t.report(progress(state, T2, code));
    expect(requestOffer).not.toHaveBeenCalled();
    expect(t.listeners()).toBe(0);
  });

  it('never offers for a continuation', async () => {
    const t = createTestStore();
    await startOrgProjectSetupWithGitHubOffer(t.api, 'project-a', '/repos', {
      continuation: true,
    });
    t.report(progress('failed', T2, AUTH));
    expect(requestOffer).not.toHaveBeenCalled();
  });

  it('ignores the previous failure it started from', async () => {
    const t = createTestStore({
      setupProgress: { 'project-a': progress('failed', T0, AUTH) },
    });
    t.startSetup.mockResolvedValue(undefined);
    await startOrgProjectSetupWithGitHubOffer(t.api, 'project-a', '/repos');
    t.report(progress('failed', T0, AUTH));
    expect(requestOffer).not.toHaveBeenCalled();
    t.report(progress('failed', T1, AUTH));
    expect(requestOffer).toHaveBeenCalledTimes(1);
  });

  it('sees an outcome that arrives before the start resolves', async () => {
    const t = createTestStore();
    t.startSetup.mockImplementation(() => {
      t.report(progress('failed', T2, AUTH));
      return Promise.resolve();
    });
    await startOrgProjectSetupWithGitHubOffer(t.api, 'project-a', '/repos');
    expect(requestOffer).toHaveBeenCalledTimes(1);
  });

  it('propagates a refused start and stops watching', async () => {
    const t = createTestStore();
    t.startSetup.mockRejectedValue(new Error('claim refused'));
    await expect(
      startOrgProjectSetupWithGitHubOffer(t.api, 'project-a', '/repos'),
    ).rejects.toThrow('claim refused');
    expect(t.listeners()).toBe(0);
    t.report(progress('failed', T2, AUTH));
    expect(requestOffer).not.toHaveBeenCalled();
  });

  it('stops watching when the account changes', async () => {
    const t = createTestStore();
    await startOrgProjectSetupWithGitHubOffer(t.api, 'project-a', '/repos');
    t.store.setState({ accountEpoch: 2, setupProgress: {} });
    expect(t.listeners()).toBe(0);
    t.store.setState({
      setupProgress: { 'project-a': progress('failed', T2, AUTH) },
    });
    expect(requestOffer).not.toHaveBeenCalled();
  });

  it('stops watching when the project’s progress disappears', async () => {
    const t = createTestStore();
    await startOrgProjectSetupWithGitHubOffer(t.api, 'project-a', '/repos');
    t.store.setState({ setupProgress: {} });
    expect(t.listeners()).toBe(0);
  });

  it('leaves the row failed when another offer is pending', async () => {
    useGitHubConnectOfferStore.getState().requestOffer({
      operationId: 'op-push',
      kind: 'push',
      projectId: 'p',
      worktreeId: 'w',
      expectedHeadBranch: 'main',
    });
    const t = createTestStore();
    await startOrgProjectSetupWithGitHubOffer(t.api, 'project-a', '/repos');
    const before = t.store.getState().setupProgress;
    t.report(progress('failed', T2, AUTH));
    expect(requestOffer).toHaveReturnedWith('busy');
    expect(
      useGitHubConnectOfferStore.getState().offer?.continuation.operationId,
    ).toBe('op-push');
    expect(t.store.getState().setupProgress['project-a']?.state).toBe('failed');
    expect(before).not.toBe(t.store.getState().setupProgress);
  });

  it('two concurrent starts for one project offer at most once', async () => {
    const t = createTestStore();
    await Promise.all([
      startOrgProjectSetupWithGitHubOffer(t.api, 'project-a', '/repos'),
      startOrgProjectSetupWithGitHubOffer(t.api, 'project-a', '/repos'),
    ]);
    t.report(progress('failed', T2, AUTH));
    expect(
      requestOffer.mock.results.filter((result) => result.value === 'offered'),
    ).toHaveLength(1);
  });
});
