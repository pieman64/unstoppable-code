jest.mock('node:fs/promises');

jest.mock('../lib/paths', () => ({
  getPlanExplorePlanFilePath: jest.fn(() => '/tmp/reviewed-plan/plan.md'),
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveTrackedPlansFilePath: jest.fn(),
}));

const recordUsageMetricEventMock = jest.fn();

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordUsageMetricEvent: recordUsageMetricEventMock,
  })),
}));

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type {
  TrackedPlanData,
  TrackedPlanShareState,
  TrackedPlansFile,
  UsageMetricEvent,
} from '@canopy/desktop-shared/types';
import { resolveTrackedPlansFilePath } from '../lib/resolve-worktree';
import {
  applyRemoteSharedPlanComments,
  createTrackedPlan,
  deleteTrackedPlan,
  deleteTrackedPlansForWorktree,
  addPlanContentChangeListener,
  addPlanDiagramArtifactChangeListener,
  addPlanShareChangeListener,
  installRestoredTrackedPlans,
  listTrackedPlans,
  removePlanContentChangeListener,
  removePlanDiagramArtifactChangeListener,
  removePlanDiagramArtifact,
  removePlanShareChangeListener,
  setPlanDiagramArtifact,
  setTrackedPlanShareState,
  updateTrackedPlan,
  withTrackedPlanRevision,
} from '../lib/plan-persistence';

const mockedMkdir = jest.mocked(mkdir);
const mockedReadFile = jest.mocked(readFile);
const mockedRm = jest.mocked(rm);
const mockedWriteFile = jest.mocked(writeFile);
const mockedResolveTrackedPlansFilePath = jest.mocked(
  resolveTrackedPlansFilePath,
);

function makeTrackedPlansFile(planCount: number): TrackedPlansFile {
  return {
    version: 1,
    plans: Array.from({ length: planCount }, (_, index) => {
      const revisionNumber = index + 1;
      const timestamp = `2026-03-31T00:0${revisionNumber}:00.000Z`;
      const content = `Plan ${revisionNumber}`;

      return {
        id: `plan-${revisionNumber}`,
        projectId: 'project-a',
        worktreeId: 'wt-1',
        source: 'claude',
        title: content,
        content,
        reviewStatus: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
        latestRevisionNumber: 1,
        revisions: [
          {
            revisionNumber: 1,
            content,
            source: 'claude',
            reviewStatus: 'pending',
            createdAt: timestamp,
          },
        ],
        linkedExecutionIds: [],
      };
    }),
  };
}

function isTrackedPlansFileForTest(value: unknown): value is TrackedPlansFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    value.version === 1 &&
    'plans' in value &&
    Array.isArray(value.plans)
  );
}

describe('tracked plan persistence cleanup', () => {
  it('reloads OpenCode plans and every OpenCode revision without dropping them', async () => {
    const file = makeTrackedPlansFile(1);
    const plan = file.plans[0];
    plan.source = 'opencode';
    plan.revisions[0].source = 'opencode';
    mockedReadFile.mockResolvedValueOnce(JSON.stringify(file));
    const restored = await listTrackedPlans('project-a', 'wt-1');
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      source: 'opencode',
      revisions: [expect.objectContaining({ source: 'opencode' })],
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveTrackedPlansFilePath.mockReturnValue(
      '/tmp/project-a/plans/wt-1.json',
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedRm.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
  });

  it('removes the tracked plan artifact when deleting all plans for a worktree', async () => {
    await deleteTrackedPlansForWorktree('project-a', 'wt-1');

    expect(mockedRm).toHaveBeenCalledWith('/tmp/project-a/plans/wt-1.json', {
      force: true,
    });
    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(mockedMkdir).not.toHaveBeenCalled();
  });

  it('re-binds restored plans to the destination worktree before writing', async () => {
    mockedResolveTrackedPlansFilePath.mockReturnValue(
      '/tmp/project-a/plans/wt-restored.json',
    );
    const [plan] = makeTrackedPlansFile(1).plans;

    await installRestoredTrackedPlans('project-a', 'wt-restored', [plan]);

    expect(mockedResolveTrackedPlansFilePath).toHaveBeenCalledWith(
      'project-a',
      'wt-restored',
    );
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    const writtenPayload = mockedWriteFile.mock.calls[0][1];
    if (typeof writtenPayload !== 'string') {
      throw new Error('written payload is not a string');
    }
    const written: unknown = JSON.parse(writtenPayload);
    if (!isTrackedPlansFileForTest(written)) {
      throw new Error('written payload is not a tracked plans file');
    }
    expect(written.plans[0]).toMatchObject({
      id: 'plan-1',
      projectId: 'project-a',
      worktreeId: 'wt-restored',
    });
  });

  it('installing zero restored plans never clears the destination file', async () => {
    await installRestoredTrackedPlans('project-a', 'wt-restored', []);

    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('removes the tracked plan artifact when deleting the last remaining plan', async () => {
    const file = makeTrackedPlansFile(1);
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    await deleteTrackedPlan('project-a', 'wt-1', 'plan-1');

    expect(mockedReadFile).toHaveBeenCalledWith(
      '/tmp/project-a/plans/wt-1.json',
      'utf8',
    );
    expect(mockedRm).toHaveBeenCalledWith('/tmp/project-a/plans/wt-1.json', {
      force: true,
    });
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('rewrites the tracked plan file when plans remain after deletion', async () => {
    const file = makeTrackedPlansFile(2);
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    await deleteTrackedPlan('project-a', 'wt-1', 'plan-1');

    expect(mockedRm).not.toHaveBeenCalled();
    expect(mockedMkdir).toHaveBeenCalledWith('/tmp/project-a/plans', {
      recursive: true,
    });
    expect(mockedWriteFile).toHaveBeenCalledWith(
      '/tmp/project-a/plans/wt-1.json',
      JSON.stringify(
        {
          version: 1,
          plans: [file.plans[1]],
        },
        null,
        2,
      ),
      'utf8',
    );
  });

  it('keeps Cursor proposals when loading validated JSON', async () => {
    const file = makeTrackedPlansFile(1);
    const [plan] = file.plans;
    if (!plan?.revisions[0]) throw new Error('Expected a tracked plan');
    plan.source = 'cursor';
    plan.revisions[0].source = 'cursor';
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const plans = await listTrackedPlans('project-a', 'wt-1');

    expect(plans).toHaveLength(1);
    expect(plans[0]?.source).toBe('cursor');
    expect(plans[0]?.revisions[0]?.source).toBe('cursor');
  });

  it('deduplicates proposal creation and revisions after a lost response and reload', async () => {
    let saved = JSON.stringify({ version: 1, plans: [] });
    mockedReadFile.mockImplementation(() => Promise.resolve(saved));
    mockedWriteFile.mockImplementation((_path, data) => {
      if (typeof data !== 'string') throw new Error('Expected plan JSON');
      saved = data;
      return Promise.resolve();
    });
    const request = {
      projectId: 'project-a',
      worktreeId: 'wt-1',
      source: 'cursor' as const,
      content: 'Original proposal',
      proposalRequestId: 'proposal-one',
    };
    const first = await createTrackedPlan(request);
    const replay = await createTrackedPlan(request);
    expect(replay.id).toBe(first.id);
    expect(await listTrackedPlans('project-a', 'wt-1')).toHaveLength(1);
    const revision = {
      ...request,
      planId: first.id,
      content: 'Revised proposal',
      proposalRequestId: 'proposal-two',
    };
    await updateTrackedPlan(revision);
    const retried = await updateTrackedPlan(revision);
    expect(retried?.latestRevisionNumber).toBe(2);
    expect(retried?.revisions).toHaveLength(2);
    const conflicting = {
      ...revision,
      content: 'Different content with reused ID',
    };
    await expect(updateTrackedPlan(conflicting)).rejects.toThrow('different');
    // A genuine new request is a revision even when its content is identical.
    const next = await updateTrackedPlan({
      ...revision,
      proposalRequestId: 'proposal-three',
    });
    expect(next?.latestRevisionNumber).toBe(3);
  });

  it('recovers a Cursor proposal after a failed overlapping revision and projection reload', async () => {
    let saved = JSON.stringify({ version: 1, plans: [] });
    mockedReadFile.mockImplementation(() => Promise.resolve(saved));
    mockedWriteFile.mockImplementation((_path, data) => {
      if (typeof data !== 'string') throw new Error('Expected plan JSON');
      saved = data;
      return Promise.resolve();
    });
    const initial = {
      projectId: 'project-a',
      worktreeId: 'wt-1',
      source: 'cursor' as const,
      chatId: 'proposal-chat',
      content: 'Original proposal',
      proposalRequestId: 'proposal-a',
    };
    const first = await createTrackedPlan(initial);
    const revision = {
      ...initial,
      content: 'Revised proposal',
      proposalRequestId: 'proposal-b',
    };
    mockedWriteFile.mockRejectedValueOnce(new Error('Disk unavailable'));
    await expect(
      updateTrackedPlan({ ...revision, planId: first.id }),
    ).rejects.toThrow('Disk unavailable');
    // Hydration has the new pending request, but the renderer lost the old
    // in-flight identity before publishing trackedPlanId. Only disk survives.
    expect(await listTrackedPlans('project-a', 'wt-1')).toHaveLength(1);
    const recovered = await createTrackedPlan(revision);
    expect(recovered.id).toBe(first.id);
    expect(recovered.latestRevisionNumber).toBe(2);
    expect(recovered.revisions.map((entry) => entry.proposalRequestId)).toEqual(
      ['proposal-a', 'proposal-b'],
    );
    const plans = await listTrackedPlans('project-a', 'wt-1');
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      id: first.id,
      proposalChatId: 'proposal-chat',
    });
    expect((await createTrackedPlan(revision)).latestRevisionNumber).toBe(2);
  });

  it('serializes concurrent implicit Cursor proposal revisions onto one plan', async () => {
    let saved = JSON.stringify({ version: 1, plans: [] });
    mockedReadFile.mockImplementation(() => Promise.resolve(saved));
    mockedWriteFile.mockImplementation((_path, data) => {
      if (typeof data !== 'string') throw new Error('Expected plan JSON');
      saved = data;
      return Promise.resolve();
    });
    const results = await Promise.all(
      ['proposal-a', 'proposal-b', 'proposal-c'].map((proposalRequestId) =>
        createTrackedPlan({
          projectId: 'project-a',
          worktreeId: 'wt-1',
          source: 'cursor',
          chatId: 'proposal-chat',
          content: proposalRequestId,
          proposalRequestId,
        }),
      ),
    );
    expect(new Set(results.map((plan) => plan.id)).size).toBe(1);
    const plans = await listTrackedPlans('project-a', 'wt-1');
    expect(plans).toHaveLength(1);
    expect(plans[0]?.revisions.map((entry) => entry.proposalRequestId)).toEqual(
      ['proposal-a', 'proposal-b', 'proposal-c'],
    );
  });

  it.each<{
    source: TrackedPlanData['source'];
    chatId: string;
    id?: string;
    dismissFirst?: boolean;
  }>([
    { source: 'cursor', chatId: 'another-chat' },
    { source: 'codex', chatId: 'proposal-chat' },
    { source: 'cursor', chatId: 'proposal-chat', id: 'explicit-plan' },
    { source: 'cursor', chatId: 'proposal-chat', dismissFirst: true },
  ])('keeps independent plan creation distinct: %j', async (next) => {
    let saved = JSON.stringify({ version: 1, plans: [] });
    mockedReadFile.mockImplementation(() => Promise.resolve(saved));
    mockedWriteFile.mockImplementation((_path, data) => {
      if (typeof data !== 'string') throw new Error('Expected plan JSON');
      saved = data;
      return Promise.resolve();
    });
    const first = await createTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      source: next.source,
      chatId: 'proposal-chat',
      content: 'First plan',
      proposalRequestId: 'first-plan',
    });
    if (next.dismissFirst)
      await updateTrackedPlan({
        projectId: 'project-a',
        worktreeId: 'wt-1',
        planId: first.id,
        reviewStatus: 'dismissed',
      });
    const second = await createTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      source: next.source,
      chatId: next.chatId,
      id: next.id,
      content: 'Second plan',
      proposalRequestId: 'second-plan',
    });
    expect(second.id).not.toBe(first.id);
    expect(await listTrackedPlans('project-a', 'wt-1')).toHaveLength(2);
  });

  it.each(['', 'x'.repeat(257)])(
    'rejects an invalid durable proposal chat identity: %p',
    async (chatId) => {
      await expect(
        createTrackedPlan({
          projectId: 'project-a',
          worktreeId: 'wt-1',
          source: 'cursor',
          chatId,
          content: 'Plan',
          proposalRequestId: 'request',
        }),
      ).rejects.toThrow('Invalid proposal chat identity');
      expect(mockedWriteFile).not.toHaveBeenCalled();
    },
  );

  it('keeps ollama-sourced tracked plans when loading validated JSON', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        plans: [
          {
            id: 'plan-ollama',
            projectId: 'project-a',
            worktreeId: 'wt-1',
            source: 'ollama',
            title: 'Ollama plan',
            content: 'Use local inference',
            reviewStatus: 'pending',
            createdAt: '2026-03-31T00:01:00.000Z',
            updatedAt: '2026-03-31T00:01:00.000Z',
            latestRevisionNumber: 1,
            revisions: [
              {
                revisionNumber: 1,
                content: 'Use local inference',
                source: 'ollama',
                reviewStatus: 'pending',
                createdAt: '2026-03-31T00:01:00.000Z',
              },
            ],
            linkedExecutionIds: [],
          },
        ],
      }),
    );

    const plans = await listTrackedPlans('project-a', 'wt-1');

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      id: 'plan-ollama',
      source: 'ollama',
    });
    expect(plans[0]?.revisions[0]?.source).toBe('ollama');
  });

  it('round-trips tracked plan share metadata from validated JSON', async () => {
    const file = makeTrackedPlansFile(1);
    const firstPlan = file.plans[0];
    if (!firstPlan) {
      throw new Error('Expected test plan');
    }
    file.plans[0] = {
      ...firstPlan,
      share: {
        serverId: 'canopy-cloud',
        remoteId: '11111111-1111-4111-8111-111111111111',
        shareScope: 'private',
        syncStatus: 'synced',
        lastSyncedAt: '2026-03-31T01:00:00.000Z',
        lastSyncedLocalRevisionNumber: 1,
        lastSyncedRemoteRevisionNumber: 2,
        lastSyncedSnapshotHash: 'hash-1',
      },
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const plans = await listTrackedPlans('project-a', 'wt-1');

    expect(plans[0]?.share).toEqual(file.plans[0]?.share);
  });

  it('writes share metadata without changing updatedAt or revisions', async () => {
    const file = makeTrackedPlansFile(1);
    const diagramListener = jest.fn<void, [TrackedPlanData]>();
    addPlanDiagramArtifactChangeListener(diagramListener);
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const updated = await setTrackedPlanShareState(
      'project-a',
      'wt-1',
      'plan-1',
      {
        serverId: 'canopy-cloud',
        remoteId: '11111111-1111-4111-8111-111111111111',
        shareScope: 'private',
        syncStatus: 'synced',
        lastSyncedSnapshotHash: 'hash-1',
      },
    );

    expect(updated?.updatedAt).toBe(file.plans[0]?.updatedAt);
    expect(updated?.revisions).toEqual(file.plans[0]?.revisions);
    const writtenContent = mockedWriteFile.mock.calls[0]?.[1];
    if (typeof writtenContent !== 'string') {
      throw new Error('Expected tracked plan file write content');
    }
    const writtenJson: unknown = JSON.parse(writtenContent);
    if (!isTrackedPlansFileForTest(writtenJson)) {
      throw new Error('Expected tracked plan file JSON');
    }
    const written = writtenJson;
    expect(written.plans[0]?.updatedAt).toBe(file.plans[0]?.updatedAt);
    expect(written.plans[0]?.share?.remoteId).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(diagramListener).not.toHaveBeenCalled();
    removePlanDiagramArtifactChangeListener(diagramListener);
  });

  it('updates share metadata from the latest persisted share state', async () => {
    const file = makeTrackedPlansFile(1);
    const firstPlan = file.plans[0];
    if (!firstPlan) {
      throw new Error('Expected test plan');
    }
    const currentShare: TrackedPlanShareState = {
      serverId: 'canopy-cloud',
      remoteId: '11111111-1111-4111-8111-111111111111',
      shareScope: 'private',
      syncStatus: 'synced',
      lastSyncedSnapshotHash: 'new-server-hash',
      lastSyncedRemoteRevisionNumber: 7,
    };
    file.plans[0] = {
      ...firstPlan,
      share: currentShare,
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const updated = await setTrackedPlanShareState(
      'project-a',
      'wt-1',
      'plan-1',
      (share) =>
        share
          ? {
              ...share,
              syncStatus: 'pending',
              lastSyncError: undefined,
            }
          : share,
    );

    expect(updated?.share).toEqual({
      ...currentShare,
      syncStatus: 'pending',
      lastSyncError: undefined,
    });
    const writtenContent = mockedWriteFile.mock.calls[0]?.[1];
    if (typeof writtenContent !== 'string') {
      throw new Error('Expected tracked plan file write content');
    }
    const writtenJson: unknown = JSON.parse(writtenContent);
    if (!isTrackedPlansFileForTest(writtenJson)) {
      throw new Error('Expected tracked plan file JSON');
    }
    expect(writtenJson.plans[0]?.share).toEqual({
      ...currentShare,
      syncStatus: 'pending',
    });
  });

  it('notifies content listeners only for content changes and share listeners for share-relevant changes', async () => {
    const contentListener = jest.fn();
    const shareListener = jest.fn();
    addPlanContentChangeListener(contentListener);
    addPlanShareChangeListener(shareListener);
    const file = makeTrackedPlansFile(1);
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    await updateTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      hidden: true,
    });
    await updateTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      title: 'Renamed plan',
    });
    await updateTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      content: 'Updated content',
    });

    expect(contentListener).toHaveBeenCalledTimes(1);
    expect(contentListener).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Updated content' }),
    );
    expect(shareListener).toHaveBeenCalledTimes(2);
    expect(shareListener).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ title: 'Renamed plan' }),
    );
    expect(shareListener).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ content: 'Updated content' }),
    );
    removePlanContentChangeListener(contentListener);
    removePlanShareChangeListener(shareListener);
  });

  it('notifies share listeners when a same-content edit only bumps the revision number', async () => {
    const shareListener = jest.fn();
    addPlanShareChangeListener(shareListener);
    const file = makeTrackedPlansFile(1);
    const existingContent = file.plans[0]?.content;
    if (!existingContent) {
      throw new Error('Expected test plan content');
    }
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    await updateTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      content: existingContent,
    });

    expect(shareListener).toHaveBeenCalledWith(
      expect.objectContaining({ latestRevisionNumber: 2 }),
    );
    removePlanShareChangeListener(shareListener);
  });

  it('notifies share listeners when an execution is newly linked', async () => {
    const shareListener = jest.fn();
    addPlanShareChangeListener(shareListener);
    const file = makeTrackedPlansFile(1);
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const updated = await updateTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      linkedExecutionId: 'exec-123',
    });

    expect(updated?.linkedExecutionIds).toEqual(['exec-123']);
    expect(shareListener).toHaveBeenCalledWith(
      expect.objectContaining({ linkedExecutionIds: ['exec-123'] }),
    );
    removePlanShareChangeListener(shareListener);
  });

  it('does not re-notify share listeners when linking an already-linked execution', async () => {
    const shareListener = jest.fn();
    const file = makeTrackedPlansFile(1);
    const planWithLink = {
      ...file,
      plans: file.plans.map((plan) => ({
        ...plan,
        linkedExecutionIds: ['exec-123'],
      })),
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(planWithLink));
    addPlanShareChangeListener(shareListener);

    await updateTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      linkedExecutionId: 'exec-123',
    });

    expect(shareListener).not.toHaveBeenCalled();
    removePlanShareChangeListener(shareListener);
  });

  it('stores sourceFilePath/sourceRepoId on detected plans', async () => {
    let capturedWrite: string | undefined;
    mockedReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    mockedWriteFile.mockImplementationOnce((_file, data) => {
      if (typeof data === 'string') {
        capturedWrite = data;
      }
      return Promise.resolve();
    });

    const plan = await createTrackedPlan({
      projectId: 'p1',
      worktreeId: 'w1',
      source: 'detected',
      content: '# Title\nbody',
      sourceFilePath: 'docs/superpowers/specs/a.md',
      sourceRepoId: '__workspace_root__',
    });
    expect(plan.sourceFilePath).toBe('docs/superpowers/specs/a.md');
    expect(plan.sourceRepoId).toBe('__workspace_root__');

    if (!capturedWrite) {
      throw new Error('Expected plan file to be written');
    }
    mockedReadFile.mockResolvedValueOnce(capturedWrite);

    const updated = await updateTrackedPlan({
      projectId: 'p1',
      worktreeId: 'w1',
      planId: plan.id,
      content: '# Title\nchanged',
    });
    expect(updated?.latestRevisionNumber).toBe(2);
    expect(updated?.sourceFilePath).toBe('docs/superpowers/specs/a.md');
  });

  it('emits plan_created after creating a tracked plan', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));

    const plan = await createTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      source: 'claude',
      content: 'Step one\n\nStep two',
      reviewStatus: 'pending',
      chatId: 'chat-1',
      initiationSource: 'user',
    });

    expect(recordUsageMetricEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'plan_created',
        workspaceId: 'project-a',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        provider: 'claude',
        initiationSource: 'user',
        id: `plan-created:project-a/wt-1/chat-1:${plan.id}:1`,
        planId: plan.id,
        planVersion: 1,
        planLineCount: 2,
      }),
    );
  });

  it('uses an explicitly provided id instead of a random uuid', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));

    const plan = await createTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      source: 'claude',
      content: '# Plan body',
      id: 'fixed-id-123',
    });

    expect(plan.id).toBe('fixed-id-123');
    expect(plan.latestRevisionNumber).toBe(1);
  });

  it('returns the existing plan when the provided id already exists', async () => {
    const file = makeTrackedPlansFile(1);
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const plan = await createTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      source: 'claude',
      content: '# A totally different body',
      id: 'plan-1',
    });

    // Idempotent: the existing plan is returned, not duplicated or overwritten.
    expect(plan.id).toBe('plan-1');
    expect(plan.content).toBe('Plan 1');
  });

  it('emits plan_updated for a content-only pending plan update', async () => {
    const file = makeTrackedPlansFile(1);
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const updated = await updateTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      content: 'Updated pending plan',
      chatId: 'chat-1',
      initiationSource: 'user',
    });

    expect(updated?.latestRevisionNumber).toBe(2);
    expect(recordUsageMetricEventMock).toHaveBeenCalledTimes(1);
    expect(recordUsageMetricEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'plan_updated',
        id: 'plan-updated:project-a/wt-1/chat-1:plan-1:2',
        planId: 'plan-1',
        planVersion: 2,
      }),
    );
  });

  it('emits plan_approved for an approval-only status transition', async () => {
    const file = makeTrackedPlansFile(1);
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const updated = await updateTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      reviewStatus: 'approved',
      approvedAt: '2026-03-31T01:00:00.000Z',
      chatId: 'chat-1',
      initiationSource: 'user',
    });

    expect(updated?.latestRevisionNumber).toBe(1);
    expect(recordUsageMetricEventMock).toHaveBeenCalledTimes(1);
    expect(recordUsageMetricEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'plan_approved',
        id: 'plan-approved:project-a/wt-1/chat-1:plan-1:1',
        planId: 'plan-1',
        planVersion: 1,
      }),
    );
  });

  it('preserves approvedAt when re-approving an already approved plan', async () => {
    const file = makeTrackedPlansFile(1);
    file.plans[0] = {
      ...file.plans[0],
      reviewStatus: 'approved',
      approvedAt: '2026-03-31T01:00:00.000Z',
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const updated = await updateTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      reviewStatus: 'approved',
      approvedAt: '2026-04-01T01:00:00.000Z',
      linkedExecutionId: 'exec-rerun',
      chatId: 'chat-1',
      initiationSource: 'user',
    });

    expect(updated?.approvedAt).toBe('2026-03-31T01:00:00.000Z');
    expect(updated?.linkedExecutionIds).toContain('exec-rerun');
    expect(recordUsageMetricEventMock).not.toHaveBeenCalled();
  });

  it('emits plan_updated before plan_approved for combined content and approval changes', async () => {
    const file = makeTrackedPlansFile(1);
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const updated = await updateTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      content: 'Updated plan',
      reviewStatus: 'approved',
      approvedAt: '2026-03-31T01:00:00.000Z',
      chatId: 'chat-1',
      initiationSource: 'user',
    });

    expect(updated?.latestRevisionNumber).toBe(2);
    const recordedTypes = recordUsageMetricEventMock.mock.calls.map(
      ([event]: [UsageMetricEvent]) => event.type,
    );
    expect(recordedTypes).toEqual(['plan_updated', 'plan_approved']);
    expect(recordUsageMetricEventMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'plan_approved',
        id: 'plan-approved:project-a/wt-1/chat-1:plan-1:2',
        planId: 'plan-1',
        planVersion: 2,
      }),
    );
  });

  it('does not emit plan_updated for content changes to already approved plans', async () => {
    const file = makeTrackedPlansFile(1);
    file.plans[0] = {
      ...file.plans[0],
      reviewStatus: 'approved',
      approvedAt: '2026-03-31T01:00:00.000Z',
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const updated = await updateTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      content: 'Approved plan typo fix',
      chatId: 'chat-1',
      initiationSource: 'user',
    });

    expect(updated?.latestRevisionNumber).toBe(2);
    expect(recordUsageMetricEventMock).not.toHaveBeenCalled();
  });

  it('does not emit usage events for combined content and dismissed status changes', async () => {
    const file = makeTrackedPlansFile(1);
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const updated = await updateTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      content: 'Dismissed plan revision',
      reviewStatus: 'dismissed',
      dismissedAt: '2026-03-31T01:00:00.000Z',
      chatId: 'chat-1',
      initiationSource: 'user',
    });

    expect(updated?.latestRevisionNumber).toBe(2);
    expect(updated?.reviewStatus).toBe('dismissed');
    expect(recordUsageMetricEventMock).not.toHaveBeenCalled();
  });
});

function isTrackedPlansFileShape(value: unknown): value is TrackedPlansFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'plans' in value &&
    Array.isArray(value.plans)
  );
}

function parseWrittenTrackedPlansFile(raw: unknown): TrackedPlansFile {
  if (typeof raw !== 'string') {
    throw new Error('expected written tracked plans payload to be a string');
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isTrackedPlansFileShape(parsed)) {
    throw new Error('written tracked plans file failed validation');
  }
  return parsed;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('tracked plan diagram and comment thread persistence', () => {
  const dataModelDiagram = {
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
  const diagrams = {
    sequence: {
      data: { schemaVersion: 1, nodes: [], edges: [] },
      derivedFromRevision: 1,
      status: 'ready',
      generatedAt: '2026-03-31T00:05:00.000Z',
    },
    dataModelDiff: {
      data: dataModelDiagram,
      derivedFromRevision: 1,
      status: 'ready',
      generatedAt: '2026-03-31T00:06:00.000Z',
    },
  };
  const commentThreads = [
    {
      id: 'thread-1',
      status: 'open',
      createdAt: '2026-03-31T00:05:00.000Z',
      anchor: { quote: 'Phase 1' },
      anchorState: 'matched',
      comments: [],
    },
  ];

  function makePlanWithExtras(): TrackedPlansFile {
    return {
      version: 1,
      plans: [
        {
          id: 'plan-1',
          projectId: 'project-a',
          worktreeId: 'wt-1',
          source: 'claude',
          title: 'Plan 1',
          content: 'Plan 1',
          reviewStatus: 'pending',
          createdAt: '2026-03-31T00:01:00.000Z',
          updatedAt: '2026-03-31T00:01:00.000Z',
          latestRevisionNumber: 1,
          revisions: [
            {
              revisionNumber: 1,
              content: 'Plan 1',
              source: 'claude',
              reviewStatus: 'pending',
              createdAt: '2026-03-31T00:01:00.000Z',
            },
          ],
          linkedExecutionIds: [],
          diagrams: cloneJson(diagrams),
          commentThreads: cloneJson(commentThreads),
          lastEditSource: 'agent',
        },
      ],
    };
  }

  let capturedWrittenPayload: unknown;

  beforeEach(() => {
    jest.clearAllMocks();
    capturedWrittenPayload = undefined;
    mockedResolveTrackedPlansFilePath.mockReturnValue(
      '/tmp/project-a/plans/wt-1.json',
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedRm.mockResolvedValue(undefined);
    mockedWriteFile.mockImplementation((_file, data) => {
      capturedWrittenPayload = data;
      return Promise.resolve();
    });
  });

  it('retains diagrams, comment threads, and lastEditSource on read', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify(makePlanWithExtras()));

    const plans = await listTrackedPlans('project-a', 'wt-1');

    expect(plans).toHaveLength(1);
    const plan = plans[0];
    expect(plan?.diagrams?.sequence?.status).toBe('ready');
    expect(plan?.diagrams?.sequence?.data).toEqual({
      schemaVersion: 1,
      nodes: [],
      edges: [],
    });
    expect(plan?.diagrams?.dataModelDiff?.status).toBe('ready');
    expect(plan?.diagrams?.dataModelDiff?.data).toEqual(dataModelDiagram);
    expect(plan?.commentThreads?.[0]?.id).toBe('thread-1');
    expect(plan?.lastEditSource).toBe('agent');
  });

  it('marks diagrams stale and preserves comment threads when updating content', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify(makePlanWithExtras()));

    const updated = await updateTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      content: 'Plan 1 revised',
      chatId: 'chat-1',
      initiationSource: 'user',
    });

    expect(updated?.latestRevisionNumber).toBe(2);
    expect(updated?.diagrams?.sequence?.status).toBe('stale');
    expect(updated?.diagrams?.sequence?.data).toEqual({
      schemaVersion: 1,
      nodes: [],
      edges: [],
    });
    expect(updated?.diagrams?.sequence?.derivedFromRevision).toBe(1);
    expect(updated?.diagrams?.dataModelDiff?.status).toBe('stale');
    expect(updated?.diagrams?.dataModelDiff?.data).toEqual(dataModelDiagram);
    expect(updated?.diagrams?.dataModelDiff?.derivedFromRevision).toBe(1);
    expect(updated?.commentThreads?.[0]?.id).toBe('thread-1');
    expect(updated?.lastEditSource).toBe('agent');

    expect(mockedWriteFile).toHaveBeenCalledWith(
      '/tmp/project-a/plans/wt-1.json',
      expect.any(String),
      'utf8',
    );
    const writtenParsed = parseWrittenTrackedPlansFile(capturedWrittenPayload);
    const writtenPlan = writtenParsed.plans[0];
    expect(writtenPlan?.diagrams?.sequence?.status).toBe('stale');
    expect(writtenPlan?.diagrams?.dataModelDiff?.status).toBe('stale');
    expect(writtenPlan?.commentThreads?.[0]?.id).toBe('thread-1');
    expect(writtenPlan?.lastEditSource).toBe('agent');
  });

  it('merges web-authored comments without clobbering staged drafts (CAN-393)', async () => {
    const localThreads = [
      {
        id: 'thread-1',
        status: 'open',
        createdAt: '2026-03-31T00:05:00.000Z',
        anchor: { quote: '', unanchored: true },
        anchorState: 'matched',
        comments: [
          {
            id: 'c-staged',
            author: 'user',
            body: 'unsent draft',
            createdAt: '2026-03-31T00:06:00.000Z',
            staged: true,
          },
          {
            id: 'c1',
            author: 'user',
            body: 'owner note',
            createdAt: '2026-03-31T00:05:30.000Z',
          },
        ],
      },
    ];
    const seeded: TrackedPlansFile = {
      version: 1,
      plans: [
        {
          id: 'plan-1',
          projectId: 'project-a',
          worktreeId: 'wt-1',
          source: 'claude',
          title: 'Plan 1',
          content: 'Plan 1',
          reviewStatus: 'pending',
          createdAt: '2026-03-31T00:01:00.000Z',
          updatedAt: '2026-03-31T00:01:00.000Z',
          latestRevisionNumber: 1,
          revisions: [
            {
              revisionNumber: 1,
              content: 'Plan 1',
              source: 'claude',
              reviewStatus: 'pending',
              createdAt: '2026-03-31T00:01:00.000Z',
            },
          ],
          linkedExecutionIds: [],
          commentThreads: cloneJson(localThreads),
        },
      ],
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(seeded));

    const result = await applyRemoteSharedPlanComments(
      'project-a',
      'wt-1',
      'plan-1',
      [
        {
          id: 'thread-1',
          status: 'open',
          createdAt: '2026-03-31T00:05:00.000Z',
          anchor: { quote: '', unanchored: true },
          anchorState: 'matched',
          comments: [
            {
              id: 'c1',
              author: 'user',
              body: 'owner note',
              createdAt: '2026-03-31T00:05:30.000Z',
            },
            {
              id: 'r1',
              author: 'remote',
              remoteAuthor: { userId: 'u-2', displayName: 'Bob' },
              body: 'teammate reply',
              createdAt: '2026-03-31T00:07:00.000Z',
            },
          ],
        },
        {
          id: 'web-thread',
          status: 'open',
          createdAt: '2026-03-31T00:08:00.000Z',
          anchor: { quote: '', unanchored: true },
          anchorState: 'matched',
          comments: [
            {
              id: 'r2',
              author: 'remote',
              remoteAuthor: { userId: 'u-2', displayName: 'Bob' },
              body: 'new thread from web',
              createdAt: '2026-03-31T00:08:00.000Z',
            },
          ],
        },
      ],
    );

    expect(result?.changed).toBe(true);
    const threads = result?.plan.commentThreads ?? [];
    const thread1 = threads.find((thread) => thread.id === 'thread-1');
    const commentIds = thread1?.comments.map((comment) => comment.id) ?? [];
    // Staged draft preserved; teammate reply added.
    expect(commentIds).toContain('c-staged');
    expect(commentIds).toContain('r1');
    const remoteReply = thread1?.comments.find(
      (comment) => comment.id === 'r1',
    );
    expect(remoteReply?.author).toBe('remote');
    expect(remoteReply?.remoteAuthor).toEqual({
      userId: 'u-2',
      displayName: 'Bob',
    });
    // New web-authored thread merged in.
    expect(threads.some((thread) => thread.id === 'web-thread')).toBe(true);
  });

  it('reports no change when remote comments match the local store (CAN-393)', async () => {
    const unanchoredThreads = [
      {
        id: 'thread-1',
        status: 'open',
        createdAt: '2026-03-31T00:05:00.000Z',
        anchor: { quote: '', unanchored: true },
        anchorState: 'matched',
        comments: [
          {
            id: 'c1',
            author: 'user',
            body: 'owner note',
            createdAt: '2026-03-31T00:05:30.000Z',
          },
        ],
      },
    ];
    const seeded: TrackedPlansFile = {
      ...makeTrackedPlansFile(1),
      plans: [
        {
          ...makeTrackedPlansFile(1).plans[0],
          id: 'plan-1',
          commentThreads: cloneJson(unanchoredThreads),
        },
      ],
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(seeded));

    const result = await applyRemoteSharedPlanComments(
      'project-a',
      'wt-1',
      'plan-1',
      cloneJson(unanchoredThreads),
    );

    expect(result?.changed).toBe(false);
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('SC8: a server echo after an acknowledgment save preserves submittedToChat with no duplicate ids and changed:false', async () => {
    // Simulates the post-acknowledgment state: a remote comment already
    // handed off to the chat agent (submittedToChat: true) plus a local
    // owner comment, both already durably saved.
    const acknowledgedThread = {
      id: 'thread-1',
      status: 'open',
      createdAt: '2026-03-31T00:05:00.000Z',
      anchor: { quote: '', unanchored: true },
      anchorState: 'matched',
      comments: [
        {
          id: 'r1',
          author: 'remote',
          remoteAuthor: { userId: 'u-2', displayName: 'Ada Lovelace' },
          body: 'Ada asked a question',
          createdAt: '2026-03-31T00:05:30.000Z',
          submittedToChat: true,
        },
        {
          id: 'c1',
          author: 'user',
          body: 'owner note',
          createdAt: '2026-03-31T00:06:00.000Z',
          staged: false,
        },
      ],
    };
    const seeded: TrackedPlansFile = {
      ...makeTrackedPlansFile(1),
      plans: [
        {
          ...makeTrackedPlansFile(1).plans[0],
          id: 'plan-1',
          commentThreads: cloneJson([acknowledgedThread]),
        },
      ],
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(seeded));

    // The server echoes back exactly what it already has: the wire shape
    // never carries the renderer-only `submittedToChat`/`staged` fields.
    const result = await applyRemoteSharedPlanComments(
      'project-a',
      'wt-1',
      'plan-1',
      [
        {
          id: 'thread-1',
          status: 'open',
          createdAt: '2026-03-31T00:05:00.000Z',
          anchor: { quote: '', unanchored: true },
          anchorState: 'matched',
          comments: [
            {
              id: 'r1',
              author: 'remote',
              remoteAuthor: { userId: 'u-2', displayName: 'Ada Lovelace' },
              body: 'Ada asked a question',
              createdAt: '2026-03-31T00:05:30.000Z',
            },
            {
              id: 'c1',
              author: 'user',
              body: 'owner note',
              createdAt: '2026-03-31T00:06:00.000Z',
            },
          ],
        },
      ],
    );

    expect(result?.changed).toBe(false);
    expect(mockedWriteFile).not.toHaveBeenCalled();
    const threads = result?.plan.commentThreads ?? [];
    expect(threads).toHaveLength(1);
    const thread = threads[0];
    const commentIds = thread?.comments.map((comment) => comment.id) ?? [];
    expect(commentIds).toEqual(['r1', 'c1']);
    const remoteComment = thread?.comments.find(
      (comment) => comment.id === 'r1',
    );
    expect(remoteComment?.submittedToChat).toBe(true);
  });

  it('records lastEditSource from the request when provided', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify(makePlanWithExtras()));

    const updated = await updateTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      content: 'Plan 1 edited via pipeline',
      lastEditSource: 'pipeline',
      chatId: 'chat-1',
      initiationSource: 'user',
    });

    expect(updated?.lastEditSource).toBe('pipeline');
    expect(updated?.diagrams?.sequence?.status).toBe('stale');
  });

  it('keeps completed diagram artifacts stale when they lag the current revision', async () => {
    const file = makePlanWithExtras();
    file.plans[0].latestRevisionNumber = 2;
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const updated = await setPlanDiagramArtifact(
      'project-a',
      'wt-1',
      'plan-1',
      'sequence',
      {
        data: { schemaVersion: 1, nodes: [], edges: [] },
        derivedFromRevision: 1,
        status: 'ready',
        generatedAt: '2026-03-31T00:06:00.000Z',
      },
    );

    expect(updated?.diagrams?.sequence?.status).toBe('stale');
    expect(updated?.diagrams?.sequence?.derivedFromRevision).toBe(1);

    const writtenParsed = parseWrittenTrackedPlansFile(capturedWrittenPayload);
    expect(writtenParsed.plans[0]?.diagrams?.sequence?.status).toBe('stale');
  });

  it('notifies diagram artifact listeners for diagram-only writes', async () => {
    const listener = jest.fn<void, [TrackedPlanData]>();
    addPlanDiagramArtifactChangeListener(listener);
    mockedReadFile.mockResolvedValue(JSON.stringify(makePlanWithExtras()));

    const updated = await setPlanDiagramArtifact(
      'project-a',
      'wt-1',
      'plan-1',
      'sequence',
      {
        data: { schemaVersion: 1, nodes: [], edges: [] },
        derivedFromRevision: 1,
        status: 'ready',
        generatedAt: '2026-03-31T00:06:00.000Z',
      },
    );

    expect(updated).not.toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    const notifiedPlan = listener.mock.calls[0]?.[0];
    expect(notifiedPlan?.id).toBe('plan-1');
    expect(notifiedPlan?.diagrams?.sequence?.status).toBe('ready');
    removePlanDiagramArtifactChangeListener(listener);
  });

  it('keeps error diagram artifacts stale when they lag the current revision', async () => {
    const file = makePlanWithExtras();
    file.plans[0].latestRevisionNumber = 2;
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const updated = await setPlanDiagramArtifact(
      'project-a',
      'wt-1',
      'plan-1',
      'sequence',
      {
        data: null,
        error: 'Generation failed',
        derivedFromRevision: 1,
        status: 'error',
        generatedAt: '2026-03-31T00:06:00.000Z',
      },
    );

    expect(updated?.diagrams?.sequence?.status).toBe('stale');
    expect(updated?.diagrams?.sequence?.derivedFromRevision).toBe(1);

    const writtenParsed = parseWrittenTrackedPlansFile(capturedWrittenPayload);
    expect(writtenParsed.plans[0]?.diagrams?.sequence?.status).toBe('stale');
  });

  it('persists ready data model diagram artifacts', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify(makePlanWithExtras()));

    const updated = await setPlanDiagramArtifact(
      'project-a',
      'wt-1',
      'plan-1',
      'dataModelDiff',
      {
        data: dataModelDiagram,
        derivedFromRevision: 1,
        status: 'ready',
        generatedAt: '2026-03-31T00:07:00.000Z',
      },
    );

    expect(updated?.diagrams?.dataModelDiff?.status).toBe('ready');
    expect(updated?.diagrams?.dataModelDiff?.data).toEqual(dataModelDiagram);

    const writtenParsed = parseWrittenTrackedPlansFile(capturedWrittenPayload);
    expect(writtenParsed.plans[0]?.diagrams?.dataModelDiff?.status).toBe(
      'ready',
    );
  });

  it('keeps data model diagram artifacts stale when they lag the current revision', async () => {
    const file = makePlanWithExtras();
    file.plans[0].latestRevisionNumber = 2;
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const updated = await setPlanDiagramArtifact(
      'project-a',
      'wt-1',
      'plan-1',
      'dataModelDiff',
      {
        data: dataModelDiagram,
        derivedFromRevision: 1,
        status: 'ready',
        generatedAt: '2026-03-31T00:07:00.000Z',
      },
    );

    expect(updated?.diagrams?.dataModelDiff?.status).toBe('stale');
    expect(updated?.diagrams?.dataModelDiff?.derivedFromRevision).toBe(1);

    const writtenParsed = parseWrittenTrackedPlansFile(capturedWrittenPayload);
    expect(writtenParsed.plans[0]?.diagrams?.dataModelDiff?.status).toBe(
      'stale',
    );
  });

  it('does not overwrite a newer data model artifact with a late stale result', async () => {
    const file = makePlanWithExtras();
    file.plans[0].latestRevisionNumber = 2;
    file.plans[0].diagrams = {
      ...file.plans[0].diagrams,
      dataModelDiff: {
        data: dataModelDiagram,
        derivedFromRevision: 2,
        status: 'ready',
        generatedAt: '2026-03-31T00:08:00.000Z',
      },
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const lateDiagram = {
      ...dataModelDiagram,
      changes: [
        {
          id: 'change-late',
          target: 'entity',
          type: 'changed',
          entityId: 'user',
        },
      ],
    };

    const updated = await setPlanDiagramArtifact(
      'project-a',
      'wt-1',
      'plan-1',
      'dataModelDiff',
      {
        data: lateDiagram,
        derivedFromRevision: 1,
        status: 'ready',
        generatedAt: '2026-03-31T00:07:00.000Z',
      },
    );

    expect(updated?.diagrams?.dataModelDiff?.derivedFromRevision).toBe(2);
    expect(updated?.diagrams?.dataModelDiff?.status).toBe('ready');
    expect(updated?.diagrams?.dataModelDiff?.data).toEqual(dataModelDiagram);
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('does not create dataModelDiff from a first-time late stale result', async () => {
    const file = makePlanWithExtras();
    file.plans[0].latestRevisionNumber = 2;
    delete file.plans[0].diagrams?.dataModelDiff;
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const updated = await setPlanDiagramArtifact(
      'project-a',
      'wt-1',
      'plan-1',
      'dataModelDiff',
      {
        data: dataModelDiagram,
        derivedFromRevision: 1,
        status: 'ready',
        generatedAt: '2026-03-31T00:07:00.000Z',
      },
    );

    expect(updated?.diagrams?.dataModelDiff).toBeUndefined();
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('removes only dataModelDiff when the expected revision is current', async () => {
    const listener = jest.fn<void, [TrackedPlanData]>();
    addPlanDiagramArtifactChangeListener(listener);
    mockedReadFile.mockResolvedValue(JSON.stringify(makePlanWithExtras()));

    const updated = await removePlanDiagramArtifact(
      'project-a',
      'wt-1',
      'plan-1',
      'dataModelDiff',
      1,
    );

    expect(updated?.diagrams?.sequence).toBeDefined();
    expect(updated?.diagrams?.dataModelDiff).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(updated);
    removePlanDiagramArtifactChangeListener(listener);

    const writtenParsed = parseWrittenTrackedPlansFile(capturedWrittenPayload);
    expect(writtenParsed.plans[0]?.diagrams?.sequence).toBeDefined();
    expect(writtenParsed.plans[0]?.diagrams?.dataModelDiff).toBeUndefined();
  });

  it('leaves an absent dataModelDiff artifact unchanged without writing', async () => {
    const file = makePlanWithExtras();
    delete file.plans[0].diagrams?.dataModelDiff;
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const updated = await removePlanDiagramArtifact(
      'project-a',
      'wt-1',
      'plan-1',
      'dataModelDiff',
      1,
    );

    expect(updated?.diagrams?.sequence).toBeDefined();
    expect(updated?.diagrams?.dataModelDiff).toBeUndefined();
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('does not remove dataModelDiff for a stale older-revision result', async () => {
    const file = makePlanWithExtras();
    file.plans[0].latestRevisionNumber = 2;
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const updated = await removePlanDiagramArtifact(
      'project-a',
      'wt-1',
      'plan-1',
      'dataModelDiff',
      1,
    );

    expect(updated?.diagrams?.dataModelDiff?.data).toEqual(dataModelDiagram);
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });
});

describe('guarded plan review writes', () => {
  it.each(['edited', 'missing', 'unreadable'])(
    'rejects an approved revision when its materialized file is %s',
    async (state) => {
      const file = makeTrackedPlansFile(1);
      file.plans[0].source = 'opencode';
      file.plans[0].reviewStatus = 'approved';
      mockedResolveTrackedPlansFilePath.mockReturnValue(
        '/tmp/reviewed-plan/plans.json',
      );
      mockedReadFile.mockImplementation((filePath) => {
        if (typeof filePath === 'string' && filePath.endsWith('plans.json'))
          return Promise.resolve(JSON.stringify(file));
        if (state === 'edited')
          return Promise.resolve('# Unreviewed working-copy edit');
        return Promise.reject(
          Object.assign(new Error(state), {
            code: state === 'missing' ? 'ENOENT' : 'EACCES',
          }),
        );
      });
      const commit = jest.fn(() => Promise.resolve('committed'));
      await expect(
        withTrackedPlanRevision(
          {
            projectId: 'project-a',
            worktreeId: 'wt-1',
            planId: 'plan-1',
            revisionNumber: 1,
            source: 'opencode',
            reviewStatus: 'approved',
          },
          commit,
        ),
      ).resolves.toEqual({ accepted: false });
      expect(commit).not.toHaveBeenCalled();
    },
  );

  it('accepts an approved revision only with the same materialized content', async () => {
    const file = makeTrackedPlansFile(1);
    file.plans[0].source = 'opencode';
    file.plans[0].reviewStatus = 'approved';
    mockedResolveTrackedPlansFilePath.mockReturnValue(
      '/tmp/reviewed-plan/plans.json',
    );
    mockedReadFile.mockImplementation((filePath) =>
      Promise.resolve(
        typeof filePath === 'string' && filePath.endsWith('plans.json')
          ? JSON.stringify(file)
          : file.plans[0].content,
      ),
    );
    const commit = jest.fn(() => Promise.resolve('committed'));
    await expect(
      withTrackedPlanRevision(
        {
          projectId: 'project-a',
          worktreeId: 'wt-1',
          planId: 'plan-1',
          revisionNumber: 1,
          source: 'opencode',
          reviewStatus: 'approved',
        },
        commit,
      ),
    ).resolves.toEqual({ accepted: true, result: 'committed' });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('records the matching OpenCode revision without changing its contents or revision number', async () => {
    const file = makeTrackedPlansFile(1);
    const plan = file.plans[0];
    plan.source = 'opencode';
    plan.revisions[0].source = 'opencode';
    mockedResolveTrackedPlansFilePath.mockReturnValue(
      '/tmp/guarded-plan-match/plans.json',
    );
    mockedReadFile.mockResolvedValue(JSON.stringify(file));
    mockedWriteFile.mockClear();
    const approvedAt = '2026-10-12T11:00:00.000Z';
    await expect(
      updateTrackedPlan(
        {
          projectId: 'project-a',
          worktreeId: 'wt-1',
          planId: 'plan-1',
          reviewStatus: 'approved',
          approvedAt,
        },
        { revisionNumber: 1, source: 'opencode' },
      ),
    ).resolves.toMatchObject({
      content: 'Plan 1',
      latestRevisionNumber: 1,
      reviewStatus: 'approved',
      approvedAt,
    });
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
  });

  it('refuses a changed plan revision under the existing plan-file lock', async () => {
    const file = makeTrackedPlansFile(1);
    mockedResolveTrackedPlansFilePath.mockReturnValue(
      '/tmp/guarded-plan/plans.json',
    );
    mockedReadFile.mockResolvedValue(JSON.stringify(file));
    mockedWriteFile.mockClear();
    await expect(
      updateTrackedPlan(
        {
          projectId: 'project-a',
          worktreeId: 'wt-1',
          planId: 'plan-1',
          reviewStatus: 'approved',
        },
        { revisionNumber: 2, source: 'claude' },
      ),
    ).resolves.toBeNull();
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });
  it('holds the saved revision stable until canonical acceptance completes', async () => {
    const file = makeTrackedPlansFile(1);
    file.plans[0].source = 'opencode';
    mockedResolveTrackedPlansFilePath.mockReturnValue(
      '/tmp/guarded-acceptance/plans.json',
    );
    mockedReadFile.mockResolvedValue(JSON.stringify(file));
    mockedWriteFile.mockClear();
    let enter: (() => void) | undefined;
    let release: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const accepted = withTrackedPlanRevision(
      {
        projectId: 'project-a',
        worktreeId: 'wt-1',
        planId: 'plan-1',
        revisionNumber: 1,
        source: 'opencode',
      },
      async () => {
        enter?.();
        await held;
        return 'committed';
      },
    );
    await entered;
    const edited = updateTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      content: 'Later edit',
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mockedWriteFile).not.toHaveBeenCalled();
    } finally {
      release?.();
    }
    await expect(accepted).resolves.toEqual({
      accepted: true,
      result: 'committed',
    });
    await expect(edited).resolves.toMatchObject({
      latestRevisionNumber: 2,
      content: 'Later edit',
    });
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
  });

  it('releases the plan lock when canonical acceptance fails', async () => {
    const file = makeTrackedPlansFile(1);
    mockedResolveTrackedPlansFilePath.mockReturnValue(
      '/tmp/guarded-acceptance-failed/plans.json',
    );
    mockedReadFile.mockResolvedValue(JSON.stringify(file));
    await expect(
      withTrackedPlanRevision(
        {
          projectId: 'project-a',
          worktreeId: 'wt-1',
          planId: 'plan-1',
          revisionNumber: 1,
          source: 'claude',
        },
        () => Promise.reject(new Error('Commit failed')),
      ),
    ).rejects.toThrow('Commit failed');
    await expect(
      updateTrackedPlan({
        projectId: 'project-a',
        worktreeId: 'wt-1',
        planId: 'plan-1',
        content: 'Recovered edit',
      }),
    ).resolves.toMatchObject({ latestRevisionNumber: 2 });
  });

  it('never enters canonical acceptance for a stale saved revision', async () => {
    const file = makeTrackedPlansFile(1);
    mockedResolveTrackedPlansFilePath.mockReturnValue(
      '/tmp/guarded-acceptance-stale/plans.json',
    );
    mockedReadFile.mockResolvedValue(JSON.stringify(file));
    const commit = jest.fn(() => Promise.resolve('committed'));
    await expect(
      withTrackedPlanRevision(
        {
          projectId: 'project-a',
          worktreeId: 'wt-1',
          planId: 'plan-1',
          revisionNumber: 2,
          source: 'claude',
        },
        commit,
      ),
    ).resolves.toEqual({ accepted: false });
    expect(commit).not.toHaveBeenCalled();
  });
});
