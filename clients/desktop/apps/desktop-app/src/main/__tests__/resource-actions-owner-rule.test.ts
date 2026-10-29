import type * as ProjectOwnerModule from '../lib/project-owner';

type ProjectOwnerTarget = ProjectOwnerModule.ProjectOwnerTarget;
type ResolvedProjectOwner =
  | { kind: 'none' }
  | { kind: 'unknown' }
  | { kind: 'personal' }
  | { kind: 'organization'; organizationId: string };

const mockResolveProjectSavedOwner = jest.fn<
  Promise<ResolvedProjectOwner>,
  [ProjectOwnerTarget]
>();
const mockIsMissingTarget = jest.fn<Promise<boolean>, [ProjectOwnerTarget]>();
const mockScopeAutomations = jest.fn((state: unknown) =>
  Promise.resolve(state),
);

jest.mock('../lib/cowork-migration-map', () => ({
  resolveCoworkWorkspaceId: (id: string): string =>
    id === 'legacy-chat-project' ? 'mapped-cowork-project' : id,
}));

jest.mock('../lib/project-owner', () => {
  const actual = jest.requireActual<typeof ProjectOwnerModule>(
    '../lib/project-owner',
  );
  return {
    ...actual,
    resolveProjectSavedOwner: (
      target: ProjectOwnerTarget,
    ): Promise<ResolvedProjectOwner> => mockResolveProjectSavedOwner(target),
    decideSameOwnerAccess: (
      callerOwner: ResolvedProjectOwner,
      target: ProjectOwnerTarget,
    ): Promise<ProjectOwnerModule.SameOwnerDecision> =>
      actual.decideSameOwnerAccess(callerOwner, target, {
        resolveTargetOwner: mockResolveProjectSavedOwner,
        isMissingTarget: mockIsMissingTarget,
      }),
  };
});

const automationService = {
  list: jest.fn(() => Promise.resolve({ activities: [], recentRuns: [] })),
  listForContext: jest.fn(),
  listRuns: jest.fn(),
  create: jest.fn(() => Promise.resolve({ ok: true })),
  update: jest.fn(),
  delete: jest.fn(),
  runNow: jest.fn(),
};

jest.mock('../automations/service', () => ({
  getAutomationsService: (): typeof automationService => automationService,
}));

jest.mock('../services/background-execution-context', () => ({
  scopeAutomationsToSelectedContext: (state: unknown): Promise<unknown> =>
    mockScopeAutomations(state),
}));

import { dispatchAgentResourceAction } from '../canopy-tools/resource-actions';
import type {
  AgentResourceAction,
  AgentResourceActionRuntime,
} from '../canopy-tools/resource-actions';
import type {
  AutomationsListResponse,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { resolveAutomationTargetProject } from '../lib/project-owner';
import {
  resetAppAdvisorProjectAgentAccessForTests,
  setAppAdvisorProjectAgentAccess,
} from '../lib/app-advisor-project-agent-access';

function activity(id: string, workspaceId: string): ScheduledActivity {
  return {
    version: 1,
    id,
    name: `Activity ${id}`,
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action: { type: 'worktree_prompt', workspaceId, prompt: `Prompt ${id}` },
    createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-14T00:00:00.000Z',
    failureCount: 0,
  };
}

function activityWithAction(
  id: string,
  action: ScheduledActivity['action'],
): ScheduledActivity {
  return {
    ...activity(id, 'caller-project'),
    action,
  };
}

type OrdinaryTargetKind =
  | 'worktree_prompt'
  | 'worktree_pipeline'
  | 'standalone_prompt';
type OwnerRelation = 'same' | 'other';

function ordinaryTargetProjectId(
  kind: OrdinaryTargetKind,
  relation: OwnerRelation,
): string {
  if (kind === 'standalone_prompt') return 'mapped-cowork-project';
  return relation === 'same' ? 'same-project' : 'target-project';
}

function ordinaryTargetAction(
  kind: OrdinaryTargetKind,
  relation: OwnerRelation,
): ScheduledActivity['action'] {
  const workspaceId = relation === 'same' ? 'same-project' : 'target-project';
  switch (kind) {
    case 'worktree_prompt':
      return { type: kind, workspaceId, prompt: 'Review the project' };
    case 'worktree_pipeline':
      return { type: kind, workspaceId, pipelineId: 'review' };
    case 'standalone_prompt':
      return {
        type: kind,
        chatProjectId: 'legacy-chat-project',
        prompt: 'Review the project',
      };
  }
}

function resolveOrdinaryTargetOwner(
  kind: OrdinaryTargetKind,
  relation: OwnerRelation,
  callerProjectId: string,
): void {
  const ownedTargetId = ordinaryTargetProjectId(kind, relation);
  mockResolveProjectSavedOwner.mockImplementation(
    ({ projectId }): Promise<ResolvedProjectOwner> =>
      Promise.resolve(
        projectId === callerProjectId ||
          projectId === 'same-project' ||
          (relation === 'same' && projectId === ownedTargetId)
          ? { kind: 'personal' }
          : { kind: 'organization', organizationId: 'org-target' },
      ),
  );
}

function resumeAction(
  projectId: string,
  worktreeId: string,
): ScheduledActivity['action'] {
  return {
    type: 'pipeline_execution_resume',
    executionId: `execution-${worktreeId}`,
    statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
    provider: 'claude',
    purpose: 'usage_limit_resume',
    pipelineName: 'Release',
    projectId,
    worktreeId,
  };
}

function callerResolutionCount(
  callerRuntime: AgentResourceActionRuntime,
): number {
  return mockResolveProjectSavedOwner.mock.calls.filter(
    ([target]) =>
      target.projectId === callerRuntime.projectId &&
      target.worktreeId === callerRuntime.worktreeId,
  ).length;
}

function expectCallerResolvedOnce(
  callerRuntime: AgentResourceActionRuntime,
): void {
  expect(callerResolutionCount(callerRuntime)).toBe(1);
}

/** Once for the action, and once more by the guard inside the mutation queue. */
function expectCallerResolvedForQueuedMutation(
  callerRuntime: AgentResourceActionRuntime,
): void {
  expect(callerResolutionCount(callerRuntime)).toBe(2);
}

function isAutomationAuthorization(
  value: unknown,
): value is (freshActivity: ScheduledActivity) => Promise<boolean> {
  return typeof value === 'function';
}

function createAuthorization(
  trusted: unknown,
): (() => Promise<boolean>) | undefined {
  if (trusted === null || typeof trusted !== 'object') return undefined;
  const authorize: unknown = Reflect.get(trusted, 'authorize');
  return typeof authorize === 'function'
    ? (): Promise<boolean> =>
        Promise.resolve(Reflect.apply(authorize, trusted, []))
    : undefined;
}

const anyChat: unknown = expect.anything();
const anyAgentAuthor: unknown = expect.objectContaining({ chat: anyChat });
/** The trusted facts an agent's automation update records. */
const AGENT_AUTHORED: unknown = { agentAuthor: anyAgentAuthor };

describe('agent automation saved-owner boundary', () => {
  const runtime: AgentResourceActionRuntime = {
    projectId: 'caller-project',
    worktreeId: 'caller-worktree',
    chatId: 'caller-chat',
    cwd: '/repo',
    getWindow: () => null,
  };

  beforeEach((): void => {
    jest.clearAllMocks();
    resetAppAdvisorProjectAgentAccessForTests();
    mockIsMissingTarget.mockResolvedValue(false);
    mockResolveProjectSavedOwner.mockImplementation(
      ({ projectId, worktreeId }): Promise<ResolvedProjectOwner> =>
        Promise.resolve(
          projectId === 'target-project' ||
            projectId === 'other-project' ||
            projectId === 'mapped-cowork-project' ||
            (projectId === STANDALONE_CHAT_PROJECT_ID &&
              worktreeId?.includes('other') === true)
            ? { kind: 'organization', organizationId: 'org-target' }
            : { kind: 'personal' },
        ),
    );
    automationService.list.mockReset();
    automationService.list.mockResolvedValue({
      activities: [],
      recentRuns: [],
    });
    automationService.listForContext.mockReset();
    automationService.listForContext.mockResolvedValue({
      activities: [],
      recentRuns: [],
    });
    automationService.listRuns.mockReset();
    automationService.create.mockReset();
    automationService.create.mockResolvedValue({ ok: true });
    automationService.update.mockReset();
    automationService.update.mockResolvedValue({ ok: true });
    automationService.delete.mockReset();
    automationService.delete.mockResolvedValue({ ok: true });
    automationService.runNow.mockReset();
    automationService.runNow.mockResolvedValue({ ok: true });
    automationService.listRuns.mockResolvedValue({
      runs: [],
      nextCursor: null,
      totalCount: 0,
    });
    mockScopeAutomations.mockImplementation((state: unknown) =>
      Promise.resolve(state),
    );
  });

  afterAll((): void => {
    resetAppAdvisorProjectAgentAccessForTests();
  });

  it('reads automation history for get with the caller owner context', async (): Promise<void> => {
    const owned = activity('owned-history', 'caller-project');
    const state: AutomationsListResponse = {
      activities: [owned],
      recentRuns: [],
    };
    automationService.listForContext.mockResolvedValue(state);

    const response = await dispatchAgentResourceAction(
      { type: 'automation.get', id: owned.id },
      runtime,
    );

    expect(response).toMatchObject({ ok: true });
    expect(automationService.listRuns).toHaveBeenCalled();
    for (const call of automationService.listRuns.mock.calls) {
      expect(call).toEqual([
        expect.objectContaining({ activityId: owned.id }),
        { kind: 'personal' },
      ]);
    }
  });

  it('hides other-owner rows and run metadata from list and get', async (): Promise<void> => {
    const visible = activity('visible', 'caller-project');
    const hidden = activity('hidden', 'target-project');
    const visiblePipeline = activityWithAction('visible-pipeline', {
      type: 'worktree_pipeline',
      workspaceId: 'caller-project',
      pipelineId: 'review',
    });
    const hiddenPipeline = activityWithAction('hidden-pipeline', {
      type: 'worktree_pipeline',
      workspaceId: 'target-project',
      pipelineId: 'private-pipeline',
    });
    const hiddenStandalone = activityWithAction('hidden-standalone', {
      type: 'standalone_prompt',
      chatProjectId: 'legacy-chat-project',
      prompt: 'Private cowork prompt',
    });
    const state: AutomationsListResponse = {
      activities: [
        visible,
        hidden,
        visiblePipeline,
        hiddenPipeline,
        hiddenStandalone,
      ],
      recentRuns: [
        {
          id: 'visible-run',
          activityId: visible.id,
          activityName: visible.name,
          scheduledFor: '2026-10-15T13:00:00.000Z',
          manual: false,
          status: 'success',
          startedAt: '2026-10-15T13:00:00.000Z',
          completedAt: '2026-10-15T13:00:01.000Z',
        },
        {
          id: 'visible-pipeline-run',
          activityId: visiblePipeline.id,
          activityName: visiblePipeline.name,
          scheduledFor: '2026-10-15T13:30:00.000Z',
          manual: false,
          status: 'success',
          startedAt: '2026-10-15T13:30:00.000Z',
          completedAt: '2026-10-15T13:30:01.000Z',
        },
        {
          id: 'hidden-run',
          activityId: hidden.id,
          activityName: hidden.name,
          scheduledFor: '2026-10-15T14:00:00.000Z',
          manual: false,
          status: 'success',
          startedAt: '2026-10-15T14:00:00.000Z',
          completedAt: '2026-10-15T14:00:01.000Z',
        },
        {
          id: 'hidden-pipeline-run',
          activityId: hiddenPipeline.id,
          activityName: hiddenPipeline.name,
          scheduledFor: '2026-10-15T14:30:00.000Z',
          manual: false,
          status: 'success',
          startedAt: '2026-10-15T14:30:00.000Z',
          completedAt: '2026-10-15T14:30:01.000Z',
        },
        {
          id: 'hidden-standalone-run',
          activityId: hiddenStandalone.id,
          activityName: hiddenStandalone.name,
          scheduledFor: '2026-10-15T15:00:00.000Z',
          manual: false,
          status: 'success',
          startedAt: '2026-10-15T15:00:00.000Z',
          completedAt: '2026-10-15T15:00:01.000Z',
        },
      ],
    };
    automationService.list.mockResolvedValue(state);
    automationService.listForContext.mockResolvedValue(state);
    automationService.listRuns.mockResolvedValue({
      runs: [],
      nextCursor: null,
      totalCount: 0,
    });

    const listed = await dispatchAgentResourceAction(
      { type: 'automation.list', includeRuns: true },
      runtime,
    );
    expectCallerResolvedOnce(runtime);
    mockResolveProjectSavedOwner.mockClear();
    const fetched = await dispatchAgentResourceAction(
      { type: 'automation.get', id: hidden.id },
      runtime,
    );
    expectCallerResolvedOnce(runtime);

    expect(listed).toMatchObject({
      ok: true,
      result: {
        activities: [{ id: visible.id }, { id: visiblePipeline.id }],
        recentRuns: [
          { id: 'visible-run', activityId: visible.id },
          { id: 'visible-pipeline-run', activityId: visiblePipeline.id },
        ],
      },
    });
    expect(fetched).toMatchObject({
      ok: false,
      error: {
        code: 'not_found',
        message: `Activity ${hidden.id} was not found.`,
      },
    });
    expect(automationService.listRuns).not.toHaveBeenCalled();
  });

  it('hides creation for a project owned by someone else', async (): Promise<void> => {
    const response = await dispatchAgentResourceAction(
      {
        type: 'automation.create',
        input: {
          name: 'Review project',
          schedule: {
            kind: 'one_time',
            runAt: '2026-10-15T13:00:00.000Z',
            timezone: 'local',
          },
          action: {
            type: 'worktree_prompt',
            workspaceId: 'target-project',
            prompt: 'Review this project',
          },
        },
      },
      runtime,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'not_found', message: 'Project not found.' },
    });
    expect(automationService.create).not.toHaveBeenCalled();
    expectCallerResolvedOnce(runtime);
  });

  it.each(
    (
      ['worktree_prompt', 'worktree_pipeline', 'standalone_prompt'] as const
    ).flatMap((kind) =>
      (['same', 'other'] as const).map((relation) => ({ kind, relation })),
    ),
  )(
    'applies the $relation-owner rule to $kind get/list/update/disable/delete/run actions',
    async ({ kind, relation }): Promise<void> => {
      const targetAction = ordinaryTargetAction(kind, relation);
      const existing = activityWithAction(`${kind}-${relation}`, targetAction);
      const run = {
        id: `${existing.id}-run`,
        activityId: existing.id,
        activityName: existing.name,
        scheduledFor: '2026-10-15T13:00:00.000Z',
        manual: false,
        status: 'success' as const,
        startedAt: '2026-10-15T13:00:00.000Z',
        completedAt: '2026-10-15T13:00:01.000Z',
      };
      const state: AutomationsListResponse = {
        activities: [existing],
        recentRuns: [run],
      };
      automationService.list.mockResolvedValue(state);
      automationService.listForContext.mockResolvedValue(state);
      resolveOrdinaryTargetOwner(kind, relation, runtime.projectId);

      const operations: Array<{
        name: string;
        action: AgentResourceAction;
        service: jest.Mock;
      }> = [
        {
          name: 'get',
          action: { type: 'automation.get', id: existing.id },
          service: automationService.listRuns,
        },
        {
          name: 'list',
          action: { type: 'automation.list', includeRuns: true },
          service: automationService.listForContext,
        },
        {
          name: 'update',
          action: {
            type: 'automation.update',
            id: existing.id,
            patch: { name: 'Renamed by owner' },
          },
          service: automationService.update,
        },
        {
          name: 'disable',
          action: { type: 'automation.disable', id: existing.id },
          service: automationService.update,
        },
        {
          name: 'delete',
          action: { type: 'automation.delete', id: existing.id },
          service: automationService.delete,
        },
        {
          name: 'run_now',
          action: { type: 'automation.run_now', id: existing.id },
          service: automationService.runNow,
        },
      ];

      for (const { name, action, service } of operations) {
        mockResolveProjectSavedOwner.mockClear();
        automationService.list.mockClear();
        automationService.listForContext.mockClear();
        automationService.listRuns.mockClear();
        automationService.update.mockClear();
        automationService.delete.mockClear();
        automationService.runNow.mockClear();

        const response = await dispatchAgentResourceAction(action, runtime);

        if (relation === 'same') {
          expect(response).toMatchObject(
            name === 'list'
              ? {
                  ok: true,
                  result: {
                    activities: [{ id: existing.id }],
                    recentRuns: [{ activityId: existing.id }],
                  },
                }
              : name === 'get'
                ? {
                    ok: true,
                    result: {
                      activity: { id: existing.id },
                      recentRuns: [],
                    },
                  }
                : { ok: true },
          );
          expect(service).toHaveBeenCalled();
        } else if (name === 'list') {
          expect(response).toMatchObject({
            ok: true,
            result: { activities: [], recentRuns: [] },
          });
          expect(service).toHaveBeenCalledTimes(1);
        } else {
          expect(response).toMatchObject({
            ok: false,
            error: {
              code: 'not_found',
              message:
                name === 'delete'
                  ? 'Activity not found.'
                  : `Activity ${existing.id} was not found.`,
            },
          });
          expect(service).not.toHaveBeenCalled();
        }

        expectCallerResolvedOnce(runtime);
        if (kind === 'standalone_prompt') {
          expect(mockResolveProjectSavedOwner).toHaveBeenCalledWith({
            projectId: 'mapped-cowork-project',
          });
        }
      }
    },
  );

  it.each(
    (
      ['worktree_prompt', 'worktree_pipeline', 'standalone_prompt'] as const
    ).flatMap((kind) =>
      (['same', 'other'] as const).map((relation) => ({ kind, relation })),
    ),
  )(
    'applies create and action-retarget checks for $relation-owner $kind targets',
    async ({ kind, relation }): Promise<void> => {
      const targetAction = ordinaryTargetAction(kind, relation);
      const existing = activity('retarget-source', 'same-project');
      const state: AutomationsListResponse = {
        activities: [existing],
        recentRuns: [],
      };
      automationService.list.mockResolvedValue(state);
      automationService.listForContext.mockResolvedValue(state);
      resolveOrdinaryTargetOwner(kind, relation, runtime.projectId);

      const created = await dispatchAgentResourceAction(
        {
          type: 'automation.create',
          input: {
            name: `Target ${kind}`,
            schedule: {
              kind: 'one_time',
              runAt: '2026-10-15T13:00:00.000Z',
              timezone: 'local',
            },
            action: targetAction,
          },
        },
        runtime,
      );

      if (relation === 'same') {
        expect(created).toMatchObject({ ok: true });
        expect(automationService.create).toHaveBeenCalledTimes(1);
      } else {
        expect(created).toMatchObject({
          ok: false,
          error: { code: 'not_found', message: 'Project not found.' },
        });
        expect(automationService.create).not.toHaveBeenCalled();
      }
      expectCallerResolvedOnce(runtime);
      if (kind === 'standalone_prompt') {
        expect(mockResolveProjectSavedOwner).toHaveBeenCalledWith({
          projectId: 'mapped-cowork-project',
        });
      }

      mockResolveProjectSavedOwner.mockClear();
      automationService.update.mockClear();
      const updated = await dispatchAgentResourceAction(
        {
          type: 'automation.update',
          id: existing.id,
          patch: { action: targetAction },
        },
        runtime,
      );
      if (relation === 'same') {
        expect(updated).toMatchObject({ ok: true });
        expect(automationService.update).toHaveBeenCalledTimes(1);
      } else {
        expect(updated).toMatchObject({
          ok: false,
          error: { code: 'not_found', message: 'Project not found.' },
        });
        expect(automationService.update).not.toHaveBeenCalled();
      }
      expectCallerResolvedOnce(runtime);
      if (kind === 'standalone_prompt') {
        expect(mockResolveProjectSavedOwner).toHaveBeenCalledWith({
          projectId: 'mapped-cowork-project',
        });
      }
    },
  );

  it('preserves access to each same-owner automation action', async (): Promise<void> => {
    const existing = activity('same-owner-activity', 'same-project');
    const state: AutomationsListResponse = {
      activities: [existing],
      recentRuns: [],
    };
    automationService.list.mockResolvedValue(state);
    automationService.listForContext.mockResolvedValue(state);

    const cases: Array<{
      action: AgentResourceAction;
      verifyService: () => void;
    }> = [
      {
        action: {
          type: 'automation.create',
          input: {
            name: 'Same-owner prompt',
            schedule: {
              kind: 'one_time',
              runAt: '2026-10-15T13:00:00.000Z',
              timezone: 'local',
            },
            action: {
              type: 'worktree_prompt',
              workspaceId: 'same-project',
              prompt: 'Review',
            },
          },
        },
        verifyService: (): void => {
          expect(automationService.create).toHaveBeenCalledTimes(1);
        },
      },
      {
        action: {
          type: 'automation.create',
          input: {
            name: 'Same-owner pipeline',
            schedule: {
              kind: 'one_time',
              runAt: '2026-10-15T13:00:00.000Z',
              timezone: 'local',
            },
            action: {
              type: 'worktree_pipeline',
              workspaceId: 'same-project',
              pipelineId: 'review',
            },
          },
        },
        verifyService: (): void => {
          expect(automationService.create).toHaveBeenCalledTimes(1);
        },
      },
      {
        action: {
          type: 'automation.update',
          id: existing.id,
          patch: { name: 'Renamed by owner' },
        },
        verifyService: (): void => {
          expect(automationService.update).toHaveBeenCalledTimes(1);
          expect(automationService.update).toHaveBeenCalledWith(
            expect.objectContaining({ id: existing.id }),
            expect.any(Function),
            { kind: 'personal' },
            AGENT_AUTHORED,
          );
        },
      },
      {
        action: {
          type: 'automation.update',
          id: existing.id,
          patch: {
            action: {
              type: 'worktree_pipeline',
              workspaceId: 'same-project',
              pipelineId: 'same-owner-pipeline',
            },
          },
        },
        verifyService: (): void => {
          expect(automationService.update).toHaveBeenCalledTimes(1);
          expect(automationService.update).toHaveBeenCalledWith(
            expect.objectContaining({ id: existing.id }),
            expect.any(Function),
            { kind: 'personal' },
            AGENT_AUTHORED,
          );
        },
      },
      {
        action: { type: 'automation.disable', id: existing.id },
        verifyService: (): void => {
          expect(automationService.update).toHaveBeenCalledTimes(1);
          expect(automationService.update).toHaveBeenCalledWith(
            expect.objectContaining({ id: existing.id, enabled: false }),
            expect.any(Function),
            { kind: 'personal' },
          );
        },
      },
      {
        action: { type: 'automation.delete', id: existing.id },
        verifyService: (): void => {
          expect(automationService.delete).toHaveBeenCalledTimes(1);
          expect(automationService.delete).toHaveBeenCalledWith(
            { id: existing.id },
            expect.any(Function),
            { kind: 'personal' },
          );
        },
      },
      {
        action: { type: 'automation.run_now', id: existing.id },
        verifyService: (): void => {
          expect(automationService.runNow).toHaveBeenCalledTimes(1);
          expect(automationService.runNow).toHaveBeenCalledWith(
            { id: existing.id },
            expect.any(Function),
            { kind: 'personal' },
          );
        },
      },
      {
        action: { type: 'automation.get', id: existing.id },
        verifyService: (): void => {
          expect(automationService.listRuns).toHaveBeenCalledTimes(1);
        },
      },
      {
        action: { type: 'automation.list', includeRuns: true },
        verifyService: (): void => {
          expect(automationService.listForContext).toHaveBeenCalledTimes(1);
          expect(automationService.listForContext).toHaveBeenCalledWith({
            kind: 'personal',
          });
        },
      },
    ];

    for (const { action, verifyService } of cases) {
      mockResolveProjectSavedOwner.mockClear();
      automationService.create.mockClear();
      automationService.update.mockClear();
      automationService.delete.mockClear();
      automationService.runNow.mockClear();
      automationService.listRuns.mockClear();
      automationService.listForContext.mockClear();

      const response = await dispatchAgentResourceAction(action, runtime);

      expect(response).toMatchObject({ ok: true });
      verifyService();
      expectCallerResolvedOnce(runtime);
    }
  });

  it('hides every lifecycle operation for an other-owner activity', async (): Promise<void> => {
    const hidden = activity('private-activity', 'other-project');
    const state: AutomationsListResponse = {
      activities: [hidden],
      recentRuns: [],
    };
    automationService.list.mockResolvedValue(state);
    automationService.listForContext.mockResolvedValue(state);

    const cases: Array<{
      action: AgentResourceAction;
      expectedMessage: string;
      verifyNotCalled: () => void;
    }> = [
      {
        action: {
          type: 'automation.update',
          id: hidden.id,
          patch: { name: 'Steal the activity' },
        },
        expectedMessage: `Activity ${hidden.id} was not found.`,
        verifyNotCalled: () =>
          expect(automationService.update).not.toHaveBeenCalled(),
      },
      {
        action: { type: 'automation.disable', id: hidden.id },
        expectedMessage: `Activity ${hidden.id} was not found.`,
        verifyNotCalled: () =>
          expect(automationService.update).not.toHaveBeenCalled(),
      },
      {
        action: { type: 'automation.run_now', id: hidden.id },
        expectedMessage: `Activity ${hidden.id} was not found.`,
        verifyNotCalled: () =>
          expect(automationService.runNow).not.toHaveBeenCalled(),
      },
      {
        action: { type: 'automation.delete', id: hidden.id },
        expectedMessage: 'Activity not found.',
        verifyNotCalled: () =>
          expect(automationService.delete).not.toHaveBeenCalled(),
      },
    ];

    for (const { action, expectedMessage, verifyNotCalled } of cases) {
      mockResolveProjectSavedOwner.mockClear();
      automationService.update.mockClear();
      automationService.runNow.mockClear();
      automationService.delete.mockClear();

      const response = await dispatchAgentResourceAction(action, runtime);

      expect(response).toMatchObject({
        ok: false,
        error: { code: 'not_found', message: expectedMessage },
      });
      verifyNotCalled();
      expectCallerResolvedOnce(runtime);
    }
  });

  it('prevents an owner from retargeting an existing automation to another owner', async (): Promise<void> => {
    const existing = activity('retarget-me', 'same-project');
    const state: AutomationsListResponse = {
      activities: [existing],
      recentRuns: [],
    };
    automationService.list.mockResolvedValue(state);
    automationService.listForContext.mockResolvedValue(state);

    const response = await dispatchAgentResourceAction(
      {
        type: 'automation.update',
        id: existing.id,
        patch: {
          action: {
            type: 'worktree_pipeline',
            workspaceId: 'other-project',
            pipelineId: 'private-pipeline',
          },
        },
      },
      runtime,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'not_found', message: 'Project not found.' },
    });
    expect(automationService.update).not.toHaveBeenCalled();
    expectCallerResolvedOnce(runtime);
  });

  it('rechecks a freshly reread target before a metadata-only mutation', async (): Promise<void> => {
    const initial = activity('reread-target', 'same-project');
    const rereadAtAnotherOwner = activity('reread-target', 'other-project');
    const state: AutomationsListResponse = {
      activities: [initial],
      recentRuns: [],
    };
    automationService.list.mockResolvedValue(state);
    automationService.listForContext.mockResolvedValue(state);
    let rereadAuthorization: boolean | undefined;
    automationService.update.mockImplementation(
      async (_request: unknown, authorize: unknown, callerContext: unknown) => {
        expect(callerContext).toEqual({ kind: 'personal' });
        if (!isAutomationAuthorization(authorize)) {
          throw new Error('Expected a mutation-time authorization guard.');
        }
        rereadAuthorization = await authorize(rereadAtAnotherOwner);
        return { ok: false, error: 'Activity not found.' };
      },
    );

    const response = await dispatchAgentResourceAction(
      {
        type: 'automation.update',
        id: initial.id,
        patch: { name: 'Rename after reread' },
      },
      runtime,
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'not_found',
        message: `Activity ${initial.id} was not found.`,
      },
    });
    expect(rereadAuthorization).toBe(false);
    expect(automationService.update).toHaveBeenCalledWith(
      { id: initial.id, name: 'Rename after reread' },
      expect.any(Function),
      { kind: 'personal' },
      AGENT_AUTHORED,
    );
    expect(mockResolveProjectSavedOwner).toHaveBeenCalledWith({
      projectId: 'other-project',
    });
    expectCallerResolvedForQueuedMutation(runtime);
  });

  it.each(['update', 'disable', 'delete', 'run_now'] as const)(
    'rechecks owners inside the queue when a target changes owner before %s runs',
    async (operation): Promise<void> => {
      const queued = activity('owner-moves-while-queued', 'same-project');
      const state: AutomationsListResponse = {
        activities: [queued],
        recentRuns: [],
      };
      automationService.list.mockResolvedValue(state);
      automationService.listForContext.mockResolvedValue(state);
      let queuedAuthorization: boolean | undefined;
      const runGuardAfterOwnerChange = async (
        _request: unknown,
        authorize: unknown,
      ): Promise<{ ok: false; error: string }> => {
        if (!isAutomationAuthorization(authorize)) {
          throw new Error('Expected a mutation-time authorization guard.');
        }
        // The same project now belongs to another owner.
        mockResolveProjectSavedOwner.mockImplementation(
          ({ projectId }): Promise<ResolvedProjectOwner> =>
            Promise.resolve(
              projectId === 'same-project'
                ? { kind: 'organization', organizationId: 'org-target' }
                : { kind: 'personal' },
            ),
        );
        queuedAuthorization = await authorize(queued);
        return { ok: false, error: 'Activity not found.' };
      };
      automationService.update.mockImplementation(runGuardAfterOwnerChange);
      automationService.delete.mockImplementation(runGuardAfterOwnerChange);
      automationService.runNow.mockImplementation(runGuardAfterOwnerChange);

      const response = await dispatchAgentResourceAction(
        operation === 'update'
          ? {
              type: 'automation.update',
              id: queued.id,
              patch: { name: 'Rename while queued' },
            }
          : operation === 'disable'
            ? { type: 'automation.disable', id: queued.id }
            : operation === 'delete'
              ? { type: 'automation.delete', id: queued.id }
              : { type: 'automation.run_now', id: queued.id },
        runtime,
      );

      expect(queuedAuthorization).toBe(false);
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'not_found' },
      });
    },
  );

  it('rechecks owners inside the queue when a target changes owner before create runs', async (): Promise<void> => {
    let queuedAuthorization: boolean | undefined;
    automationService.create.mockImplementation(
      async (_request: unknown, trusted: unknown) => {
        const authorize = createAuthorization(trusted);
        if (!authorize)
          throw new Error('Expected a mutation-time authorization guard.');
        // The target project now belongs to another owner.
        mockResolveProjectSavedOwner.mockImplementation(
          ({ projectId }): Promise<ResolvedProjectOwner> =>
            Promise.resolve(
              projectId === 'same-project'
                ? { kind: 'organization', organizationId: 'org-target' }
                : { kind: 'personal' },
            ),
        );
        queuedAuthorization = await authorize();
        return { ok: false, error: 'Activity not found.' };
      },
    );

    const response = await dispatchAgentResourceAction(
      {
        type: 'automation.create',
        input: {
          name: 'Create while queued',
          schedule: {
            kind: 'one_time',
            runAt: '2026-10-15T13:00:00.000Z',
            timezone: 'local',
          },
          action: {
            type: 'worktree_prompt',
            workspaceId: 'same-project',
            prompt: 'Review',
          },
        },
      },
      runtime,
    );

    expect(queuedAuthorization).toBe(false);
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('fails closed when the caller owner is unknown', async (): Promise<void> => {
    mockResolveProjectSavedOwner.mockImplementation(
      ({ projectId }): Promise<ResolvedProjectOwner> =>
        Promise.resolve(
          projectId === runtime.projectId
            ? { kind: 'unknown' }
            : { kind: 'personal' },
        ),
    );

    const response = await dispatchAgentResourceAction(
      {
        type: 'automation.create',
        input: {
          name: 'Unknown caller',
          schedule: {
            kind: 'one_time',
            runAt: '2026-10-15T13:00:00.000Z',
            timezone: 'local',
          },
          action: {
            type: 'worktree_prompt',
            workspaceId: 'same-project',
            prompt: 'Review',
          },
        },
      },
      runtime,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'owner_context_unavailable' },
    });
    expect(automationService.create).not.toHaveBeenCalled();
    expectCallerResolvedOnce(runtime);
  });

  it('reports an unreadable existing target as context unavailable', async (): Promise<void> => {
    const unreadable = activity('unreadable-target', 'unknown-project');
    const state: AutomationsListResponse = {
      activities: [unreadable],
      recentRuns: [],
    };
    automationService.list.mockResolvedValue(state);
    automationService.listForContext.mockResolvedValue(state);
    mockResolveProjectSavedOwner.mockImplementation(
      ({ projectId }): Promise<ResolvedProjectOwner> =>
        Promise.resolve(
          projectId === runtime.projectId
            ? { kind: 'personal' }
            : { kind: 'unknown' },
        ),
    );
    mockIsMissingTarget.mockResolvedValue(false);

    const response = await dispatchAgentResourceAction(
      { type: 'automation.get', id: unreadable.id },
      runtime,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'owner_context_unavailable' },
    });
    expect(automationService.listRuns).not.toHaveBeenCalled();
    expectCallerResolvedOnce(runtime);
  });

  it('hides an automation whose target project is missing', async (): Promise<void> => {
    const stale = activity('stale-target', 'missing-project');
    const state: AutomationsListResponse = {
      activities: [stale],
      recentRuns: [],
    };
    automationService.list.mockResolvedValue(state);
    automationService.listForContext.mockResolvedValue(state);
    mockResolveProjectSavedOwner.mockImplementation(
      ({ projectId }): Promise<ResolvedProjectOwner> =>
        Promise.resolve(
          projectId === runtime.projectId
            ? { kind: 'personal' }
            : { kind: 'unknown' },
        ),
    );
    mockIsMissingTarget.mockResolvedValue(true);

    const fetched = await dispatchAgentResourceAction(
      { type: 'automation.get', id: stale.id },
      runtime,
    );

    expect(fetched).toMatchObject({
      ok: false,
      error: {
        code: 'not_found',
        message: `Activity ${stale.id} was not found.`,
      },
    });
    expect(automationService.listRuns).not.toHaveBeenCalled();
    expectCallerResolvedOnce(runtime);
  });

  it('hides targets with an unknown kind when the project ID is blank', async (): Promise<void> => {
    const malformed = activityWithAction('blank-target', {
      type: 'worktree_prompt',
      workspaceId: '   ',
      prompt: 'Review an unspecified project',
    });
    const state: AutomationsListResponse = {
      activities: [malformed],
      recentRuns: [],
    };
    automationService.list.mockResolvedValue(state);
    automationService.listForContext.mockResolvedValue(state);

    const fetched = await dispatchAgentResourceAction(
      { type: 'automation.get', id: malformed.id },
      runtime,
    );

    expect(fetched).toMatchObject({
      ok: false,
      error: {
        code: 'not_found',
        message: `Activity ${malformed.id} was not found.`,
      },
    });
    expect(automationService.listRuns).not.toHaveBeenCalled();
    expect(mockResolveProjectSavedOwner).toHaveBeenCalledTimes(1);
    expectCallerResolvedOnce(runtime);
  });

  it('leaves ownerless App Advisor callers unlimited', async (): Promise<void> => {
    const advisorRuntime: AgentResourceActionRuntime = {
      ...runtime,
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'advisor-worktree',
    };
    const visible = activity('personal-activity', 'same-project');
    const organization = activity('organization-activity', 'target-project');
    const malformed = activityWithAction('malformed-target', {
      type: 'worktree_prompt',
      workspaceId: ' ',
      prompt: 'Target without an ID',
    });
    const state: AutomationsListResponse = {
      activities: [visible, organization, malformed],
      recentRuns: [],
    };
    automationService.list.mockResolvedValue(state);
    automationService.listForContext.mockResolvedValue(state);
    automationService.create.mockResolvedValue({ ok: true });
    mockResolveProjectSavedOwner.mockImplementation(
      ({ projectId }): Promise<ResolvedProjectOwner> =>
        Promise.resolve(
          projectId === APP_ADVISOR_PROJECT_ID
            ? { kind: 'none' }
            : projectId === 'target-project'
              ? { kind: 'organization', organizationId: 'org-target' }
              : { kind: 'personal' },
        ),
    );

    const listed = await dispatchAgentResourceAction(
      { type: 'automation.list', includeRuns: true },
      advisorRuntime,
    );
    expectCallerResolvedOnce(advisorRuntime);
    mockResolveProjectSavedOwner.mockClear();
    const fetched = await dispatchAgentResourceAction(
      { type: 'automation.get', id: organization.id },
      advisorRuntime,
    );
    expectCallerResolvedOnce(advisorRuntime);
    mockResolveProjectSavedOwner.mockClear();
    const malformedFetch = await dispatchAgentResourceAction(
      { type: 'automation.get', id: malformed.id },
      advisorRuntime,
    );
    expect(malformedFetch).toMatchObject({
      ok: true,
      result: { activity: { id: malformed.id } },
    });
    expectCallerResolvedOnce(advisorRuntime);
    mockResolveProjectSavedOwner.mockClear();
    const created = await dispatchAgentResourceAction(
      {
        type: 'automation.create',
        input: {
          name: 'Advisor-created organization automation',
          schedule: {
            kind: 'one_time',
            runAt: '2026-10-15T13:00:00.000Z',
            timezone: 'local',
          },
          action: {
            type: 'worktree_prompt',
            workspaceId: 'target-project',
            prompt: 'Review',
          },
        },
      },
      advisorRuntime,
    );

    expect(listed).toMatchObject({
      ok: true,
      result: {
        activities: [
          { id: visible.id },
          { id: organization.id },
          { id: malformed.id },
        ],
      },
    });
    expect(fetched).toMatchObject({
      ok: true,
      result: { activity: { id: organization.id } },
    });
    expect(created).toMatchObject({ ok: true });
    expect(automationService.create).toHaveBeenCalledTimes(1);
    expectCallerResolvedOnce(advisorRuntime);
  });

  it('keeps the ownerless App Advisor retarget guard unlimited after reread', async (): Promise<void> => {
    const advisorRuntime: AgentResourceActionRuntime = {
      ...runtime,
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'advisor-worktree',
    };
    const existing = activity('advisor-retarget', 'target-project');
    const reread = activity('advisor-retarget', 'other-project');
    automationService.list.mockResolvedValue({
      activities: [existing],
      recentRuns: [],
    });
    mockResolveProjectSavedOwner.mockImplementation(
      ({ projectId }): Promise<ResolvedProjectOwner> =>
        Promise.resolve(
          projectId === APP_ADVISOR_PROJECT_ID
            ? { kind: 'none' }
            : { kind: 'organization', organizationId: 'org-target' },
        ),
    );
    automationService.update.mockImplementation(
      async (_request: unknown, authorize: unknown): Promise<{ ok: true }> => {
        if (!isAutomationAuthorization(authorize)) {
          throw new Error('Expected a mutation-time authorization guard.');
        }
        expect(await authorize(reread)).toBe(true);
        return { ok: true };
      },
    );

    const targetAction: ScheduledActivity['action'] = {
      type: 'worktree_pipeline',
      workspaceId: 'other-project',
      pipelineId: 'advisor-retargeted',
    };
    const response = await dispatchAgentResourceAction(
      {
        type: 'automation.update',
        id: existing.id,
        patch: { action: targetAction },
      },
      advisorRuntime,
    );

    expect(response).toMatchObject({ ok: true });
    expect(automationService.update).toHaveBeenCalledWith(
      { id: existing.id, action: targetAction },
      expect.any(Function),
      undefined,
      AGENT_AUTHORED,
    );
    expect(mockResolveProjectSavedOwner).toHaveBeenCalledTimes(2);
    expectCallerResolvedForQueuedMutation(advisorRuntime);
  });

  it('keeps App Advisor access denial wording when caller ownership is unknown', async (): Promise<void> => {
    const unknownRuntime: AgentResourceActionRuntime = {
      ...runtime,
      projectId: 'unknown-caller',
    };
    setAppAdvisorProjectAgentAccess({ mode: 'disabled', selectedOwners: [] });
    mockResolveProjectSavedOwner.mockResolvedValue({ kind: 'unknown' });

    const response = await dispatchAgentResourceAction(
      {
        type: 'automation.create',
        input: {
          name: 'Advisor review',
          schedule: {
            kind: 'one_time',
            runAt: '2026-10-15T13:00:00.000Z',
            timezone: 'local',
          },
          action: { type: 'app_advisor_prompt', prompt: 'Review changes' },
        },
      },
      unknownRuntime,
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'advisor_access_disabled',
        message:
          'The project owner could not be confirmed, so App Advisor access is unavailable for agents in this project.',
      },
    });
    expect(automationService.create).not.toHaveBeenCalled();
    expectCallerResolvedOnce(unknownRuntime);
  });

  it.each([
    ['owned row first', ['chat-owned', 'chat-other-owner']],
    ['other-owner row first', ['chat-other-owner', 'chat-owned']],
  ] as const)(
    'filters standalone-chat sentinel rows by full target identity (%s)',
    async (_orderName, worktreeIds): Promise<void> => {
      const coworkRuntime: AgentResourceActionRuntime = {
        ...runtime,
        projectId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: 'caller-chat',
      };
      const rows = new Map<string, ScheduledActivity>([
        [
          'chat-owned',
          activityWithAction('chat-owned', {
            type: 'worktree_session_prompt',
            workspaceId: STANDALONE_CHAT_PROJECT_ID,
            worktreeId: 'chat-owned',
            chatId: 'chat-owned-tab',
            purpose: 'scheduled_send',
            prompt: 'Continue owned chat',
          }),
        ],
        [
          'chat-other-owner',
          activityWithAction('chat-other-owner', {
            type: 'worktree_session_prompt',
            workspaceId: STANDALONE_CHAT_PROJECT_ID,
            worktreeId: 'chat-other-owner',
            chatId: 'other-owner-tab',
            purpose: 'scheduled_send',
            prompt: 'Continue private chat',
          }),
        ],
      ]);
      const state: AutomationsListResponse = {
        activities: worktreeIds
          .map((id) => rows.get(id))
          .filter((row): row is ScheduledActivity => row !== undefined),
        recentRuns: worktreeIds.map((id) => ({
          id: `${id}-run`,
          activityId: id,
          activityName: `Activity ${id}`,
          scheduledFor: '2026-10-15T13:00:00.000Z',
          manual: false,
          status: 'success',
          startedAt: '2026-10-15T13:00:00.000Z',
          completedAt: '2026-10-15T13:00:01.000Z',
        })),
      };
      automationService.list.mockResolvedValue(state);
      automationService.listForContext.mockResolvedValue(state);
      mockScopeAutomations.mockClear();
      mockScopeAutomations.mockImplementation((state: unknown) =>
        Promise.resolve({
          activities: [
            {
              ...activity('sidebar-only', 'caller-project'),
              name: `Sidebar row from ${typeof state}`,
            },
          ],
          recentRuns: [],
        }),
      );

      const listed = await dispatchAgentResourceAction(
        { type: 'automation.list', includeRuns: true },
        coworkRuntime,
      );

      expect(listed).toMatchObject({
        ok: true,
        result: {
          activities: [{ id: 'chat-owned' }],
          recentRuns: [{ id: 'chat-owned-run', activityId: 'chat-owned' }],
        },
      });
      expect(automationService.listForContext).toHaveBeenCalledTimes(1);
      expect(automationService.listForContext).toHaveBeenCalledWith({
        kind: 'personal',
      });
      expect(automationService.list).not.toHaveBeenCalled();
      expect(mockScopeAutomations).not.toHaveBeenCalled();
      expectCallerResolvedOnce(coworkRuntime);
      expect(mockResolveProjectSavedOwner).toHaveBeenCalledWith({
        projectId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: 'chat-other-owner',
      });
    },
  );

  it('filters resume visibility by its full workspace target and keeps its mutation policy barred', async (): Promise<void> => {
    const coworkRuntime: AgentResourceActionRuntime = {
      ...runtime,
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'caller-chat',
    };
    const ownedResume = activityWithAction(
      'owned-resume',
      resumeAction(STANDALONE_CHAT_PROJECT_ID, 'resume-owned'),
    );
    const hiddenResume = activityWithAction(
      'hidden-resume',
      resumeAction(STANDALONE_CHAT_PROJECT_ID, 'resume-other'),
    );
    const sessionPrompt = activityWithAction('owned-session', {
      type: 'worktree_session_prompt',
      workspaceId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'session-owned',
      chatId: 'session-chat',
      purpose: 'scheduled_send',
      prompt: 'Continue the session',
    });
    const state: AutomationsListResponse = {
      activities: [ownedResume, hiddenResume, sessionPrompt],
      recentRuns: [],
    };
    automationService.list.mockResolvedValue(state);
    automationService.listForContext.mockResolvedValue(state);

    const listed = await dispatchAgentResourceAction(
      { type: 'automation.list', includeRuns: true },
      coworkRuntime,
    );

    expect(listed).toMatchObject({
      ok: true,
      result: {
        activities: [{ id: ownedResume.id }, { id: sessionPrompt.id }],
      },
    });
    expectCallerResolvedOnce(coworkRuntime);
    expect(mockResolveProjectSavedOwner).toHaveBeenCalledWith({
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'resume-other',
    });
    mockResolveProjectSavedOwner.mockClear();
    const hiddenResumeGet = await dispatchAgentResourceAction(
      { type: 'automation.get', id: hiddenResume.id },
      coworkRuntime,
    );
    expect(hiddenResumeGet).toMatchObject({
      ok: false,
      error: {
        code: 'not_found',
        message: `Activity ${hiddenResume.id} was not found.`,
      },
    });
    expectCallerResolvedOnce(coworkRuntime);
    expect(mockResolveProjectSavedOwner).toHaveBeenCalledWith({
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'resume-other',
    });

    mockResolveProjectSavedOwner.mockClear();
    const createResume = await dispatchAgentResourceAction(
      {
        type: 'automation.create',
        input: {
          name: 'Create resume',
          schedule: {
            kind: 'one_time',
            runAt: '2026-10-15T13:00:00.000Z',
            timezone: 'local',
          },
          action: resumeAction(STANDALONE_CHAT_PROJECT_ID, 'resume-owned'),
        },
      },
      coworkRuntime,
    );
    expect(createResume).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(automationService.create).not.toHaveBeenCalled();
    expectCallerResolvedOnce(coworkRuntime);

    mockResolveProjectSavedOwner.mockClear();
    const renameResume = await dispatchAgentResourceAction(
      {
        type: 'automation.update',
        id: ownedResume.id,
        patch: { name: 'Rename resume' },
      },
      coworkRuntime,
    );
    expect(renameResume).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(automationService.update).not.toHaveBeenCalled();
    expectCallerResolvedOnce(coworkRuntime);

    mockResolveProjectSavedOwner.mockClear();
    const createSession = await dispatchAgentResourceAction(
      {
        type: 'automation.create',
        input: {
          name: 'Create session prompt',
          schedule: {
            kind: 'one_time',
            runAt: '2026-10-15T13:00:00.000Z',
            timezone: 'local',
          },
          action: sessionPrompt.action,
        },
      },
      coworkRuntime,
    );
    expect(createSession).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(automationService.create).not.toHaveBeenCalled();
    expectCallerResolvedOnce(coworkRuntime);

    mockResolveProjectSavedOwner.mockClear();
    const retargetSession = await dispatchAgentResourceAction(
      {
        type: 'automation.update',
        id: sessionPrompt.id,
        patch: {
          action: {
            type: 'worktree_session_prompt',
            workspaceId: STANDALONE_CHAT_PROJECT_ID,
            worktreeId: 'session-owned-copy',
            chatId: 'session-chat',
            purpose: 'scheduled_send',
            prompt: 'Continue the session',
          },
        },
      },
      coworkRuntime,
    );
    expect(retargetSession).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(automationService.update).not.toHaveBeenCalled();
    expectCallerResolvedOnce(coworkRuntime);

    mockResolveProjectSavedOwner.mockClear();
    const runResume = await dispatchAgentResourceAction(
      { type: 'automation.run_now', id: ownedResume.id },
      coworkRuntime,
    );
    expect(runResume).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(automationService.runNow).not.toHaveBeenCalled();
    expectCallerResolvedOnce(coworkRuntime);
  });

  it.each(['caller_unknown', 'target_unknown', 'missing', 'blank'] as const)(
    'fails closed across every automation operation for %s context',
    async (scenario): Promise<void> => {
      const targetAction: ScheduledActivity['action'] = {
        type: 'worktree_prompt',
        workspaceId: scenario === 'blank' ? ' ' : 'unavailable-project',
        prompt: 'Review',
      };
      const existing = activityWithAction('unavailable', targetAction);
      const source = activity('retarget-source', 'same-project');
      const state: AutomationsListResponse = {
        activities: [existing, source],
        recentRuns: [],
      };
      automationService.list.mockResolvedValue(state);
      automationService.listForContext.mockResolvedValue(state);
      mockIsMissingTarget.mockResolvedValue(scenario === 'missing');
      mockResolveProjectSavedOwner.mockImplementation(
        ({ projectId }): Promise<ResolvedProjectOwner> =>
          Promise.resolve(
            (scenario === 'caller_unknown' &&
              projectId === runtime.projectId) ||
              (projectId === 'unavailable-project' &&
                scenario !== 'caller_unknown')
              ? { kind: 'unknown' }
              : { kind: 'personal' },
          ),
      );
      const actions: AgentResourceAction[] = [
        { type: 'automation.get', id: existing.id },
        { type: 'automation.update', id: existing.id, patch: { name: 'Edit' } },
        { type: 'automation.disable', id: existing.id },
        { type: 'automation.delete', id: existing.id },
        { type: 'automation.run_now', id: existing.id },
        {
          type: 'automation.create',
          input: {
            name: 'Create',
            schedule: existing.schedule,
            action: targetAction,
          },
        },
        {
          type: 'automation.update',
          id: source.id,
          patch: { action: targetAction },
        },
      ];
      for (const action of actions) {
        mockResolveProjectSavedOwner.mockClear();
        const response = await dispatchAgentResourceAction(action, runtime);
        if (scenario === 'caller_unknown' || scenario === 'target_unknown') {
          expect(response).toMatchObject({
            ok: false,
            error: { code: 'owner_context_unavailable' },
          });
        } else {
          const projectFailure =
            action.type === 'automation.create' ||
            (action.type === 'automation.update' && action.id === source.id);
          expect(response).toMatchObject({
            ok: false,
            error: {
              code: 'not_found',
              message: projectFailure
                ? 'Project not found.'
                : action.type === 'automation.delete'
                  ? 'Activity not found.'
                  : `Activity ${existing.id} was not found.`,
            },
          });
        }
        expectCallerResolvedOnce(runtime);
      }
      const listed = await dispatchAgentResourceAction(
        { type: 'automation.list' },
        runtime,
      );
      expect(listed).toMatchObject(
        scenario === 'caller_unknown'
          ? {
              ok: false,
              error: { code: 'owner_context_unavailable' },
            }
          : {
              ok: true,
              result: { activities: [{ id: source.id }], recentRuns: [] },
            },
      );
      expect(automationService.create).not.toHaveBeenCalled();
      expect(automationService.update).not.toHaveBeenCalled();
      expect(automationService.delete).not.toHaveBeenCalled();
      expect(automationService.runNow).not.toHaveBeenCalled();
      expect(automationService.listRuns).not.toHaveBeenCalled();
    },
  );

  it.each(['update', 'disable', 'delete', 'run_now'] as const)(
    'rechecks revoked Advisor access inside the %s authorization guard',
    async (operation): Promise<void> => {
      setAppAdvisorProjectAgentAccess({ mode: 'enabled', selectedOwners: [] });
      const existing = activityWithAction('advisor-guard', {
        type: 'app_advisor_prompt',
        prompt: 'Review',
      });
      automationService.listForContext.mockResolvedValue({
        activities: [existing],
        recentRuns: [],
      });
      const service =
        operation === 'delete'
          ? automationService.delete
          : operation === 'run_now'
            ? automationService.runNow
            : automationService.update;
      service.mockImplementation(
        async (
          _request: unknown,
          authorize: unknown,
        ): Promise<{ ok: false; error: string }> => {
          setAppAdvisorProjectAgentAccess({
            mode: 'disabled',
            selectedOwners: [],
          });
          if (!isAutomationAuthorization(authorize))
            throw new Error('Expected authorization guard');
          expect(await authorize(existing)).toBe(false);
          return { ok: false, error: 'Activity not found.' };
        },
      );
      const action: AgentResourceAction =
        operation === 'update'
          ? {
              type: 'automation.update',
              id: existing.id,
              patch: { name: 'Edit' },
            }
          : { type: `automation.${operation}`, id: existing.id };
      const response = await dispatchAgentResourceAction(action, runtime);
      expect(response).toMatchObject({
        ok: false,
        error:
          operation === 'delete'
            ? { code: 'not_found', message: 'Activity not found.' }
            : operation === 'disable'
              ? {
                  code: 'not_found',
                  message: `Activity ${existing.id} was not found.`,
                }
              : { code: 'advisor_access_disabled' },
      });
      expectCallerResolvedForQueuedMutation(runtime);
    },
  );

  it('resolves legacy standalone prompt targets through the cowork mapping', async (): Promise<void> => {
    expect(
      resolveAutomationTargetProject({
        type: 'standalone_prompt',
        chatProjectId: 'legacy-chat-project',
        prompt: 'Review the project',
      }),
    ).toEqual({ kind: 'project', projectId: 'mapped-cowork-project' });

    mockResolveProjectSavedOwner.mockClear();
    mockResolveProjectSavedOwner.mockImplementation(
      ({ projectId }): Promise<ResolvedProjectOwner> =>
        Promise.resolve(
          projectId === 'mapped-cowork-project' ||
            projectId === runtime.projectId
            ? { kind: 'personal' }
            : { kind: 'organization', organizationId: 'org-target' },
        ),
    );
    automationService.create.mockResolvedValue({ ok: true });

    const response = await dispatchAgentResourceAction(
      {
        type: 'automation.create',
        input: {
          name: 'Cowork review',
          schedule: {
            kind: 'one_time',
            runAt: '2026-10-15T13:00:00.000Z',
            timezone: 'local',
          },
          action: {
            type: 'standalone_prompt',
            chatProjectId: 'legacy-chat-project',
            prompt: 'Review the project',
          },
        },
      },
      runtime,
    );

    expect(response).toMatchObject({ ok: true });
    expect(automationService.create).toHaveBeenCalledTimes(1);
    expect(mockResolveProjectSavedOwner).toHaveBeenCalledWith({
      projectId: 'mapped-cowork-project',
    });
    expectCallerResolvedOnce(runtime);
  });
});
