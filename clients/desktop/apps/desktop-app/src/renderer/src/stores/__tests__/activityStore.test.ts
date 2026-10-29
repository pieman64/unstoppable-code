import { shareEnvelope } from '@/test-utils/shareOperation';
import type {
  ShareTrackedPlanRequest,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { useActivityStore } from '../activityStore';

const PROJECT_ID = 'proj-1';
const WORKTREE_ID = 'wt-1';
const KEY = `${PROJECT_ID}/${WORKTREE_ID}`;

let shareMock: jest.Mock;
let runsShareMock: jest.Mock;
let runsCheckShareEligibilityMock: jest.Mock;

function makePlan(overrides: Partial<TrackedPlanData> = {}): TrackedPlanData {
  return {
    id: 'plan-1',
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    source: 'claude',
    title: 'My Plan',
    content: '# My Plan\n\nBody',
    reviewStatus: 'pending',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    latestRevisionNumber: 1,
    revisions: [
      {
        revisionNumber: 1,
        content: '# My Plan\n\nBody',
        source: 'claude',
        reviewStatus: 'pending',
        createdAt: '2026-06-01T00:00:00.000Z',
      },
    ],
    linkedExecutionIds: [],
    ...overrides,
  };
}

function getStoredPlans(): TrackedPlanData[] {
  return useActivityStore.getState().trackedPlans[KEY] ?? [];
}

beforeEach(() => {
  shareMock = jest.fn();
  runsShareMock = jest.fn();
  runsCheckShareEligibilityMock = jest.fn();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        activity: { plans: { share: shareEnvelope(shareMock) } },
        runs: {
          share: shareEnvelope(runsShareMock),
          checkShareEligibility: runsCheckShareEligibilityMock,
        },
      },
    },
  });
  useActivityStore.setState({
    trackedPlans: {},
  });
});

describe('activityStore.shareTrackedPlan', () => {
  it('calls the preload bridge with scope + target id and upserts the returned plan', async () => {
    useActivityStore.setState({ trackedPlans: { [KEY]: [makePlan()] } });

    const shared = makePlan({
      share: {
        serverId: 'server-1',
        remoteId: 'remote-1',
        shareScope: 'team',
        syncStatus: 'synced',
      },
    });
    shareMock.mockResolvedValue(shared);

    const result = await useActivityStore
      .getState()
      .shareTrackedPlan(PROJECT_ID, WORKTREE_ID, 'plan-1', {
        shareScope: 'team',
        teamId: 'team-9',
      });

    const expectedRequest: ShareTrackedPlanRequest = {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      planId: 'plan-1',
      shareScope: 'team',
      teamId: 'team-9',
    };
    expect(shareMock).toHaveBeenCalledWith(expectedRequest);
    expect(result).toEqual(shared);

    const stored = getStoredPlans();
    expect(stored).toHaveLength(1);
    expect(stored[0].share).toEqual(shared.share);
  });

  it('omits absent optional fields from the request', async () => {
    useActivityStore.setState({ trackedPlans: { [KEY]: [makePlan()] } });
    shareMock.mockResolvedValue(makePlan());

    await useActivityStore
      .getState()
      .shareTrackedPlan(PROJECT_ID, WORKTREE_ID, 'plan-1');

    expect(shareMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      planId: 'plan-1',
    });
  });

  it('updates the shared plan in trackedPlans', async () => {
    const plan = makePlan();
    useActivityStore.setState({
      trackedPlans: { [KEY]: [plan] },
    });
    const shared = makePlan({
      share: {
        serverId: 'server-1',
        remoteId: 'remote-1',
        shareScope: 'private',
        syncStatus: 'pending',
      },
    });
    shareMock.mockResolvedValue(shared);

    await useActivityStore
      .getState()
      .shareTrackedPlan(PROJECT_ID, WORKTREE_ID, 'plan-1', {
        shareScope: 'private',
      });

    expect(getStoredPlans()[0].share).toEqual(shared.share);
  });

  it('does not upsert when the bridge returns null', async () => {
    useActivityStore.setState({ trackedPlans: { [KEY]: [makePlan()] } });
    shareMock.mockResolvedValue(null);

    const result = await useActivityStore
      .getState()
      .shareTrackedPlan(PROJECT_ID, WORKTREE_ID, 'plan-1');

    expect(result).toBeNull();
    // The original plan is untouched (still has no share metadata).
    expect(getStoredPlans()[0].share).toBeUndefined();
  });
});

describe('activityStore.shareRun', () => {
  it('forwards the org-scoped share request to the runs bridge', async () => {
    runsShareMock.mockResolvedValue({ externalId: 'run-ext-1' });

    const result = await useActivityStore
      .getState()
      .shareRun(PROJECT_ID, WORKTREE_ID, 'chat-1', {
        shareScope: 'organization',
        organizationId: 'org-9',
      });

    expect(runsShareMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      chatId: 'chat-1',
      shareScope: 'organization',
      organizationId: 'org-9',
    });
    expect(result).toEqual({ externalId: 'run-ext-1' });
  });

  it('forwards a share-eligibility probe and returns the blocked reason', async () => {
    runsCheckShareEligibilityMock.mockResolvedValue({
      shareable: false,
      reason: 'no-activity',
      auditRetentionDays: 7,
    });

    const result = await useActivityStore
      .getState()
      .checkShareEligibility(PROJECT_ID, WORKTREE_ID, 'chat-1');

    expect(runsCheckShareEligibilityMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      chatId: 'chat-1',
    });
    expect(result).toEqual({
      shareable: false,
      reason: 'no-activity',
      auditRetentionDays: 7,
    });
  });

  it('forwards a team-scoped share request', async () => {
    runsShareMock.mockResolvedValue({ externalId: null });

    const result = await useActivityStore
      .getState()
      .shareRun(PROJECT_ID, WORKTREE_ID, 'chat-1', {
        shareScope: 'team',
        teamId: 'team-9',
      });

    expect(runsShareMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      chatId: 'chat-1',
      shareScope: 'team',
      teamId: 'team-9',
    });
    expect(result).toEqual({ externalId: null });
  });

  it('forwards a private redacted shared-run request', async () => {
    runsShareMock.mockResolvedValue({ externalId: 'run-private' });

    const result = await useActivityStore
      .getState()
      .shareRun(PROJECT_ID, WORKTREE_ID, 'chat-1', {
        shareScope: 'private',
      });

    expect(runsShareMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      chatId: 'chat-1',
      shareScope: 'private',
    });
    expect(result).toEqual({ externalId: 'run-private' });
  });
});

describe('activityStore.upsertTrackedPlan share equality', () => {
  it('re-renders a share-only update (content/updatedAt unchanged)', () => {
    const original = makePlan();
    useActivityStore.setState({ trackedPlans: { [KEY]: [original] } });

    // Same content/updatedAt — only `share` changes, as a background
    // `trackedPlansUpdated` event would deliver. `trackedPlanDataEqual` must
    // treat this as NOT equal so the updated plan replaces the stored one.
    const syncing = makePlan({
      share: {
        serverId: 'server-1',
        remoteId: 'remote-1',
        shareScope: 'private',
        syncStatus: 'syncing',
      },
    });
    useActivityStore.getState().upsertTrackedPlan(syncing);
    expect(getStoredPlans()[0].share?.syncStatus).toBe('syncing');

    // A subsequent share-only transition (syncing -> synced) also lands.
    const synced = makePlan({
      share: {
        serverId: 'server-1',
        remoteId: 'remote-1',
        shareScope: 'private',
        syncStatus: 'synced',
      },
    });
    useActivityStore.getState().upsertTrackedPlan(synced);
    expect(getStoredPlans()[0].share?.syncStatus).toBe('synced');
  });

  it('keeps the same state reference when nothing (including share) changed', () => {
    const original = makePlan({
      share: {
        serverId: 'server-1',
        remoteId: 'remote-1',
        shareScope: 'private',
        syncStatus: 'synced',
      },
    });
    useActivityStore.setState({ trackedPlans: { [KEY]: [original] } });
    const before = useActivityStore.getState().trackedPlans;

    // An identical plan (deep-equal share) must short-circuit.
    useActivityStore.getState().upsertTrackedPlan(
      makePlan({
        share: {
          serverId: 'server-1',
          remoteId: 'remote-1',
          shareScope: 'private',
          syncStatus: 'synced',
        },
      }),
    );

    expect(useActivityStore.getState().trackedPlans).toBe(before);
  });
});

describe('activityStore.removeTrackedPlan (CAN-1305)', () => {
  it('drops the named plan and leaves its siblings in place', () => {
    const removed = makePlan({ id: 'plan-1' });
    const kept = makePlan({ id: 'plan-2' });
    useActivityStore.setState({ trackedPlans: { [KEY]: [removed, kept] } });

    useActivityStore
      .getState()
      .removeTrackedPlan(PROJECT_ID, WORKTREE_ID, 'plan-1');

    expect(getStoredPlans().map((plan) => plan.id)).toEqual(['plan-2']);
  });

  it('keeps the same state reference for an unknown plan id', () => {
    useActivityStore.setState({ trackedPlans: { [KEY]: [makePlan()] } });
    const before = useActivityStore.getState().trackedPlans;

    useActivityStore
      .getState()
      .removeTrackedPlan(PROJECT_ID, WORKTREE_ID, 'plan-missing');

    expect(useActivityStore.getState().trackedPlans).toBe(before);
  });
});

describe('activityStore tracked-plan inventory flag', () => {
  let listMock: jest.Mock;

  beforeEach(() => {
    listMock = jest.fn();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { api: { activity: { plans: { list: listMock } } } },
    });
    useActivityStore.setState({
      trackedPlans: {},
      trackedPlanInventoryLoaded: {},
    });
  });

  it('marks a worktree loaded after loadTrackedPlans, even when the list is empty', async () => {
    listMock.mockResolvedValue([]);
    await useActivityStore.getState().loadTrackedPlans(PROJECT_ID, WORKTREE_ID);

    expect(useActivityStore.getState().trackedPlanInventoryLoaded[KEY]).toBe(
      true,
    );
  });

  it('marks a worktree loaded when its list is set, but not on a single upsert', () => {
    useActivityStore.getState().upsertTrackedPlan(makePlan());
    expect(
      useActivityStore.getState().trackedPlanInventoryLoaded[KEY],
    ).toBeUndefined();

    // Setting an equal list still records that the inventory is complete.
    useActivityStore.getState().setTrackedPlans(KEY, getStoredPlans());
    expect(useActivityStore.getState().trackedPlanInventoryLoaded[KEY]).toBe(
      true,
    );
  });

  it('clears the flag with the rest of the worktree state', () => {
    useActivityStore.setState({
      bgProcesses: {},
      trackedPlans: { [KEY]: [makePlan()] },
      trackedPlanInventoryLoaded: { [KEY]: true },
    });
    useActivityStore.getState().cleanupWorktree(PROJECT_ID, WORKTREE_ID);

    expect(
      useActivityStore.getState().trackedPlanInventoryLoaded[KEY],
    ).toBeUndefined();
    expect(useActivityStore.getState().trackedPlans[KEY]).toBeUndefined();
  });
});

describe('activityStore.ensureTrackedPlanLoaded', () => {
  let getMock: jest.Mock;

  beforeEach(() => {
    getMock = jest.fn();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { api: { activity: { plans: { get: getMock } } } },
    });
    useActivityStore.setState({
      trackedPlans: {},
      trackedPlanInventoryLoaded: {},
    });
  });

  it('returns a plan already in the store without fetching', async () => {
    const plan = makePlan();
    useActivityStore.setState({ trackedPlans: { [KEY]: [plan] } });

    await expect(
      useActivityStore
        .getState()
        .ensureTrackedPlanLoaded(PROJECT_ID, WORKTREE_ID, 'plan-1'),
    ).resolves.toBe(plan);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('fetches a missing plan into its list', async () => {
    const existing = makePlan({ id: 'plan-0' });
    const fetched = makePlan();
    useActivityStore.setState({
      trackedPlans: { [KEY]: [existing] },
    });
    getMock.mockResolvedValue(fetched);

    const result = await useActivityStore
      .getState()
      .ensureTrackedPlanLoaded(PROJECT_ID, WORKTREE_ID, 'plan-1');

    expect(result).toBe(fetched);
    expect(getMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      planId: 'plan-1',
    });
    expect(getStoredPlans().map((plan) => plan.id)).toEqual([
      'plan-1',
      'plan-0',
    ]);
    // A single fetched plan is not the worktree's full inventory.
    expect(
      useActivityStore.getState().trackedPlanInventoryLoaded[KEY],
    ).toBeUndefined();
  });

  it('shares one request between concurrent callers', async () => {
    let resolveGet: (plan: TrackedPlanData | null) => void = () => {};
    getMock.mockImplementation(
      (): Promise<TrackedPlanData | null> =>
        new Promise((resolve) => {
          resolveGet = resolve;
        }),
    );

    const first = useActivityStore
      .getState()
      .ensureTrackedPlanLoaded(PROJECT_ID, WORKTREE_ID, 'plan-1');
    const second = useActivityStore
      .getState()
      .ensureTrackedPlanLoaded(PROJECT_ID, WORKTREE_ID, 'plan-1');
    resolveGet(makePlan());

    const [firstPlan, secondPlan] = await Promise.all([first, second]);
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(firstPlan?.id).toBe('plan-1');
    expect(secondPlan).toBe(firstPlan);
    expect(getStoredPlans()).toHaveLength(1);
  });

  it('resolves null for a plan that does not exist and fetches again later', async () => {
    getMock.mockResolvedValue(null);

    await expect(
      useActivityStore
        .getState()
        .ensureTrackedPlanLoaded(PROJECT_ID, WORKTREE_ID, 'plan-1'),
    ).resolves.toBeNull();
    await useActivityStore
      .getState()
      .ensureTrackedPlanLoaded(PROJECT_ID, WORKTREE_ID, 'plan-1');

    expect(getMock).toHaveBeenCalledTimes(2);
    expect(useActivityStore.getState().trackedPlans[KEY]).toBeUndefined();
  });
});
