import type * as PreferencesStoreModule from '../lib/preferences-store';

jest.mock('../lib/plan-persistence', () => ({
  getTrackedPlan: jest.fn(),
  removePlanDiagramArtifact: jest.fn(),
  setPlanDiagramArtifact: jest.fn(),
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(() => '/repo'),
}));

jest.mock('../lib/preferences-store', () => {
  const actual = jest.requireActual<typeof PreferencesStoreModule>(
    '../lib/preferences-store',
  );
  return {
    ...actual,
    readPreferencesFile: jest.fn(),
  };
});

jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));

jest.mock('../lib/helper-observed-task', () => ({
  finalizeObservedHelperTask: jest.fn(),
  startObservedHelperTask: jest.fn(),
}));

jest.mock('../lib/helper-transcript-observer', () => ({
  createHelperTranscriptObserver: jest.fn(() => ({
    seed: jest.fn(),
    appendEvent: jest.fn(),
  })),
}));

jest.mock('../lib/plan-diagram-generator', () => ({
  generateDataModelDiffDiagram: jest.fn(),
  generateLogicDiffDiagram: jest.fn(),
  generateSequenceDiagram: jest.fn(),
}));

import {
  IPC_CHANNELS,
  initClaudeModels,
  initCodexModels,
  initModelAliases,
  type DataModelDiffDiagram,
  type TrackedPlansUpdatedEvent,
  type TrackedPlanData,
} from '@canopy/desktop-shared/types';
import {
  getTrackedPlan,
  removePlanDiagramArtifact,
  setPlanDiagramArtifact,
} from '../lib/plan-persistence';
import {
  DEFAULT_PREFERENCES,
  readPreferencesFile,
} from '../lib/preferences-store';
import { sendToWindow } from '../lib/window-send';
import { startObservedHelperTask } from '../lib/helper-observed-task';
import { createHelperTranscriptObserver } from '../lib/helper-transcript-observer';
import {
  generateDataModelDiffDiagram,
  generateLogicDiffDiagram,
  generateSequenceDiagram,
} from '../lib/plan-diagram-generator';
import { schedulePlanDiagramGeneration } from '../lib/plan-diagram-scheduler';

const mockedGetTrackedPlan = jest.mocked(getTrackedPlan);
const mockedRemovePlanDiagramArtifact = jest.mocked(removePlanDiagramArtifact);
const mockedSetPlanDiagramArtifact = jest.mocked(setPlanDiagramArtifact);
const mockedReadPreferencesFile = jest.mocked(readPreferencesFile);
const mockedSendToWindow = jest.mocked(sendToWindow);
const mockedStartObservedHelperTask = jest.mocked(startObservedHelperTask);
const mockedCreateHelperTranscriptObserver = jest.mocked(
  createHelperTranscriptObserver,
);
const mockedGenerateDataModelDiffDiagram = jest.mocked(
  generateDataModelDiffDiagram,
);
const mockedGenerateLogicDiffDiagram = jest.mocked(generateLogicDiffDiagram);
const mockedGenerateSequenceDiagram = jest.mocked(generateSequenceDiagram);

const dataModelDiagram: DataModelDiffDiagram = {
  schemaVersion: 1,
  current: {
    entities: [
      {
        id: 'user',
        name: 'User',
        fields: [{ id: 'id', name: 'id', kind: 'primary' }],
      },
    ],
    relationships: [],
  },
  planned: {
    entities: [
      {
        id: 'user',
        name: 'User',
        fields: [
          { id: 'id', name: 'id', kind: 'primary' },
          { id: 'email', name: 'email', kind: 'unique' },
        ],
      },
    ],
    relationships: [],
  },
  changes: [
    {
      id: 'change-email',
      target: 'field',
      type: 'added',
      entityId: 'user',
      fieldId: 'email',
    },
  ],
};

function makePlan(overrides: Partial<TrackedPlanData> = {}): TrackedPlanData {
  return {
    id: 'plan-1',
    projectId: 'project-a',
    worktreeId: 'wt-1',
    source: 'claude',
    title: 'Plan 1',
    content: '# Plan\n\nAdd a Prisma migration for User.email.',
    reviewStatus: 'pending',
    createdAt: '2026-03-31T00:01:00.000Z',
    updatedAt: '2026-03-31T00:01:00.000Z',
    latestRevisionNumber: 1,
    revisions: [
      {
        revisionNumber: 1,
        content: '# Plan\n\nAdd a Prisma migration for User.email.',
        source: 'claude',
        reviewStatus: 'pending',
        createdAt: '2026-03-31T00:01:00.000Z',
      },
    ],
    linkedExecutionIds: [],
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function isTrackedPlansUpdatedEvent(
  value: unknown,
): value is TrackedPlansUpdatedEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'plan' in value &&
    'projectId' in value &&
    'worktreeId' in value
  );
}

function trackedPlanUpdateEvents(): TrackedPlansUpdatedEvent[] {
  return mockedSendToWindow.mock.calls.flatMap((call) => {
    const [, channel, event] = call;
    return channel === IPC_CHANNELS.trackedPlansUpdated &&
      isTrackedPlansUpdatedEvent(event)
      ? [event]
      : [];
  });
}

describe('plan diagram scheduler data model artifact lifecycle', () => {
  beforeEach(() => {
    initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
    initClaudeModels([{ id: 'sonnet', label: 'Sonnet 5' }]);
    initModelAliases({
      'claude-sonnet-4-6': 'sonnet',
      'gpt-6-sol': 'gpt-5.5',
    });
    jest.clearAllMocks();
    mockedReadPreferencesFile.mockResolvedValue({
      ...DEFAULT_PREFERENCES,
      planDiagramModel: 'claude-sonnet-4-6',
      planDiagramThinkingLevel: 'medium',
    });
    mockedGenerateSequenceDiagram.mockResolvedValue({ value: null, usage: {} });
    mockedGenerateLogicDiffDiagram.mockResolvedValue({
      value: null,
      usage: {},
    });
    mockedGenerateDataModelDiffDiagram.mockResolvedValue({
      value: { schemaVersion: 1, applicable: false },
      usage: {},
    });
    mockedSetPlanDiagramArtifact.mockImplementation(
      (projectId, worktreeId, planId, key, artifact) =>
        Promise.resolve(
          makePlan({
            id: planId,
            projectId,
            worktreeId,
            diagrams: { [key]: artifact },
          }),
        ),
    );
    mockedRemovePlanDiagramArtifact.mockImplementation(
      (projectId, worktreeId, planId) =>
        Promise.resolve(
          makePlan({
            id: planId,
            projectId,
            worktreeId,
            diagrams: {},
          }),
        ),
    );
  });

  it('persists applicable data model results and emits a plan update', async () => {
    const plan = makePlan();
    mockedGetTrackedPlan.mockResolvedValue(plan);
    mockedGenerateDataModelDiffDiagram.mockResolvedValue({
      value: {
        schemaVersion: 1,
        applicable: true,
        diagram: dataModelDiagram,
      },
      usage: {},
    });

    schedulePlanDiagramGeneration(plan, () => null, { immediate: true });
    await flushMicrotasks();

    expect(mockedSetPlanDiagramArtifact).toHaveBeenCalledWith(
      'project-a',
      'wt-1',
      'plan-1',
      'dataModelDiff',
      expect.objectContaining({
        data: dataModelDiagram,
        derivedFromRevision: 1,
        status: 'ready',
      }),
    );
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.trackedPlansUpdated,
      expect.objectContaining({
        projectId: 'project-a',
        worktreeId: 'wt-1',
      }),
    );
  });
  it('removes dataModelDiff on a non-applicable result and emits a plan update', async () => {
    const plan = makePlan({
      diagrams: {
        dataModelDiff: {
          data: dataModelDiagram,
          derivedFromRevision: 1,
          status: 'ready',
        },
      },
    });
    mockedGetTrackedPlan.mockResolvedValue(plan);

    schedulePlanDiagramGeneration(plan, () => null, { immediate: true });
    await flushMicrotasks();

    expect(mockedRemovePlanDiagramArtifact).toHaveBeenCalledWith(
      'project-a',
      'wt-1',
      'plan-1',
      'dataModelDiff',
      1,
    );
    expect(
      trackedPlanUpdateEvents().some(
        (event) => event.plan?.diagrams !== undefined,
      ),
    ).toBe(true);
    expect(
      trackedPlanUpdateEvents().some(
        (event) => event.plan !== undefined && !event.plan.diagrams,
      ),
    ).toBe(false);
    expect(
      trackedPlanUpdateEvents().some((event) => {
        const plan = event.plan;
        return (
          plan !== undefined &&
          plan.diagrams !== undefined &&
          Object.keys(plan.diagrams).length === 0
        );
      }),
    ).toBe(true);
  });

  it('skips data model generation when the plan has no data model hints', async () => {
    const plan = makePlan({
      content: '# Plan\n\nPolish the command palette empty state.',
      revisions: [
        {
          revisionNumber: 1,
          content: '# Plan\n\nPolish the command palette empty state.',
          source: 'claude',
          reviewStatus: 'pending',
          createdAt: '2026-03-31T00:01:00.000Z',
        },
      ],
    });
    mockedGetTrackedPlan.mockResolvedValue(plan);

    schedulePlanDiagramGeneration(plan, () => null, { immediate: true });
    await flushMicrotasks();

    expect(mockedGenerateSequenceDiagram).toHaveBeenCalledTimes(1);
    expect(mockedGenerateLogicDiffDiagram).toHaveBeenCalledTimes(1);
    expect(mockedGenerateDataModelDiffDiagram).not.toHaveBeenCalled();
    expect(mockedStartObservedHelperTask).not.toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Plan Data Model Diagram' }),
    );
  });

  it('passes the start revision to stale non-applicable removals', async () => {
    const staleRunPlan = makePlan({
      latestRevisionNumber: 1,
      diagrams: {
        dataModelDiff: {
          data: dataModelDiagram,
          derivedFromRevision: 1,
          status: 'ready',
        },
      },
    });
    const newerPlan = makePlan({
      latestRevisionNumber: 2,
      diagrams: {
        dataModelDiff: {
          data: dataModelDiagram,
          derivedFromRevision: 2,
          status: 'ready',
        },
      },
    });
    mockedGetTrackedPlan.mockResolvedValue(staleRunPlan);
    mockedRemovePlanDiagramArtifact.mockResolvedValue(newerPlan);

    schedulePlanDiagramGeneration(staleRunPlan, () => null, {
      immediate: true,
    });
    await flushMicrotasks();

    expect(mockedRemovePlanDiagramArtifact).toHaveBeenCalledWith(
      'project-a',
      'wt-1',
      'plan-1',
      'dataModelDiff',
      1,
    );
    expect(
      trackedPlanUpdateEvents().some((event) => event.plan === newerPlan),
    ).toBe(true);
  });

  it('does not persist a first-time dataModelDiff placeholder for non-applicable generation', async () => {
    const plan = makePlan();
    mockedGetTrackedPlan.mockResolvedValue(plan);

    schedulePlanDiagramGeneration(plan, () => null, { immediate: true });
    await flushMicrotasks();

    const dataModelWrites = mockedSetPlanDiagramArtifact.mock.calls.filter(
      (call) => call[3] === 'dataModelDiff',
    );
    expect(dataModelWrites).toHaveLength(0);
    expect(mockedRemovePlanDiagramArtifact).not.toHaveBeenCalled();
  });

  it('links diagram audit entries to the tracked plan and passes transcript observers', async () => {
    const plan = makePlan();
    mockedGetTrackedPlan.mockResolvedValue(plan);
    mockedReadPreferencesFile.mockResolvedValue({
      ...DEFAULT_PREFERENCES,
      planDiagramModel: 'gpt-5.5',
      planDiagramThinkingLevel: 'medium',
      providerModelConfigDefaults: { codex: { fastMode: true } },
    });

    schedulePlanDiagramGeneration(plan, () => null, { immediate: true });
    await flushMicrotasks();

    const dataModelStart = mockedStartObservedHelperTask.mock.calls
      .map(([options]) => options)
      .find((options) => options.label === 'Plan Data Model Diagram');
    expect(dataModelStart?.auditContext).toEqual({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
    });
    expect(dataModelStart?.modelConfig).toMatchObject({
      fastMode: true,
      thinkingLevel: 'medium',
    });
    expect(
      mockedCreateHelperTranscriptObserver.mock.calls.some(([taskKey]) =>
        taskKey.includes('helper:plan-data-model-diagram:'),
      ),
    ).toBe(true);
    const dataModelGenerateOptions =
      mockedGenerateDataModelDiffDiagram.mock.calls[0]?.[0];
    expect(dataModelGenerateOptions?.modelConfig).toMatchObject({
      fastMode: true,
      thinkingLevel: 'medium',
    });
    expect(typeof dataModelGenerateOptions?.transcriptObserver?.seed).toBe(
      'function',
    );
    expect(
      typeof dataModelGenerateOptions?.transcriptObserver?.appendEvent,
    ).toBe('function');
  });

  // ECW-9091 review round 10. Port of the `code-review-scheduler.test.ts`
  // interleaving cases — the same sticky-`pendingUserInitiated` fix landed here
  // but shipped without a regression pin. Both directions are reachable in
  // production: `ipc/plans.ts:146` (immediate/user) and `ipc/index.ts:157`
  // (background content-change debounce).
  //
  // The queued rerun must carry the QUEUING call's intent, not the in-flight
  // one's: otherwise a background regeneration inherits permission to spend AI
  // Credits, and in the reverse order an explicit Generate is downgraded into a
  // silent no-op.
  it('replays the queuing background call intent, not the in-flight user run', async () => {
    const plan = makePlan();
    mockedGetTrackedPlan.mockResolvedValue(plan);

    let releaseFirst: (() => void) | undefined;
    mockedGenerateSequenceDiagram.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return { value: null, usage: {} };
    });

    // User-initiated run starts and blocks inside generation.
    schedulePlanDiagramGeneration(plan, () => null, { immediate: true });
    await flushMicrotasks();
    expect(mockedGenerateSequenceDiagram).toHaveBeenCalledTimes(1);
    expect(mockedGenerateSequenceDiagram.mock.calls[0]?.[0]).toMatchObject({
      userInitiated: true,
    });

    // A background (non-immediate) trigger arrives mid-run and is queued.
    schedulePlanDiagramGeneration(plan, () => null, { immediate: true });
    await flushMicrotasks();

    releaseFirst?.();
    await flushMicrotasks();

    expect(mockedGenerateSequenceDiagram).toHaveBeenCalledTimes(2);
  });

  it('does not downgrade a user request queued behind a background run', async () => {
    const plan = makePlan();
    mockedGetTrackedPlan.mockResolvedValue(plan);

    let releaseFirst: (() => void) | undefined;
    mockedGenerateSequenceDiagram.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return { value: null, usage: {} };
    });

    // Background run starts (debounced path) and blocks.
    jest.useFakeTimers();
    schedulePlanDiagramGeneration(plan, () => null, {});
    jest.advanceTimersByTime(60_000);
    jest.useRealTimers();
    await flushMicrotasks();
    expect(mockedGenerateSequenceDiagram).toHaveBeenCalledTimes(1);
    expect(mockedGenerateSequenceDiagram.mock.calls[0]?.[0]).toMatchObject({
      userInitiated: false,
    });

    // User clicks Generate mid-run; it is queued and must NOT be downgraded.
    schedulePlanDiagramGeneration(plan, () => null, { immediate: true });
    await flushMicrotasks();

    releaseFirst?.();
    await flushMicrotasks();

    expect(mockedGenerateSequenceDiagram).toHaveBeenCalledTimes(2);
    expect(mockedGenerateSequenceDiagram.mock.calls[1]?.[0]).toMatchObject({
      userInitiated: true,
    });
  });
});
