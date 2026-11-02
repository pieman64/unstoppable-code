const mockAssertSkillContext = jest.fn<Promise<void>, [string]>(() =>
  Promise.resolve(),
);
jest.mock('../skills/skill-install-context', () => ({
  assertSkillShareOrigin: (): Promise<void> => Promise.resolve(),
  assertStoredSkillContext: (id: string): Promise<void> =>
    mockAssertSkillContext(id),
  filterStoredSkillContexts: (rows: unknown[]): Promise<unknown[]> =>
    Promise.resolve(rows),
}));

jest.mock('../pipelines/pipeline-package-service', () => ({
  copyPackageInstall: jest.fn(() => Promise.resolve()),
  updateSharedPipelinePreservingPackage: jest.fn(),
}));
const mockGetSharedPipelineSaveImpact = jest.fn<
  Promise<{ automations: never[] }>,
  [string]
>(() => Promise.resolve({ automations: [] }));
jest.mock('../pipelines/shared-pipeline-save-impact', () => ({
  getSharedPipelineSaveImpact: (remoteId: string): Promise<unknown> =>
    mockGetSharedPipelineSaveImpact(remoteId),
}));
const mockShareContextEnabled = false;
jest.mock('../pipelines/resource-lanes', () => ({
  pipelineResourceContextEnabled: jest.fn(() => mockShareContextEnabled),
  assertPipelineContext: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: jest.fn(() => ({
    initialize: jest.fn(() => Promise.resolve()),
    whenIdle: jest.fn(() => Promise.resolve()),
    getState: jest.fn(() => ({
      context: { kind: 'personal' },
      // The account is a member of every organization these tests use.
      organizations: [
        'org-selected',
        'org-not-selected',
        'org-stale',
        'org-current',
        'org-input',
      ].map((id) => ({ id, name: id, role: 'MEMBER' })),
    })),
  })),
}));
jest.mock('../pipelines/pipeline-install-context', () => ({
  authorizeProjectPipelineRequest: jest.fn(),
  assertStoredPipelineContext: jest.fn(() => Promise.resolve()),
  copyPipelineInstallOrigin: jest.fn(() => Promise.resolve()),
}));
jest.mock('../skills/skill-service', () => ({
  loadSkills: jest.fn(),
  readSkillContent: jest.fn(),
  readSkillFile: jest.fn(),
  saveCustomSkill: jest.fn(),
  removeSkill: jest.fn(),
  readRawSkill: jest.fn(),
  writeRawSkill: jest.fn(),
}));
jest.mock('../skills/canopy-server-client', () => ({
  listSharedSkills: jest.fn(),
  getSharedSkill: jest.fn(),
  createSharedSkill: jest.fn(),
  updateSharedSkill: jest.fn(),
  deleteSharedSkill: jest.fn(),
}));
jest.mock('../pipelines/curated-pipeline-catalog', () => ({
  getManagedCuratedPipeline: jest.fn(),
}));
jest.mock('../pipelines/pipeline-service', () => ({
  listPipelines: jest.fn(),
  getPipeline: jest.fn(),
  savePipeline: jest.fn(),
  updatePipeline: jest.fn(),
  deletePipeline: jest.fn(),
}));
jest.mock('../pipelines/canopy-server-client', () => ({
  listSharedPipelines: jest.fn(),
  getSharedPipeline: jest.fn(),
  createSharedPipeline: jest.fn(),
  updateSharedPipeline: jest.fn(),
  deleteSharedPipeline: jest.fn(),
}));
jest.mock('../pipelines/project-pipeline-discovery', () => ({
  discoverProjectPipelines: jest.fn(() => Promise.resolve([])),
  loadProjectPipelineFromDisk: jest.fn(),
}));
jest.mock('../pipelines/instrumentation', () => ({
  withPipelineCrudTelemetry: jest.fn(
    (_context: unknown, operation: () => unknown) => operation(),
  ),
}));
jest.mock('../pipelines/plugin-collection-store', () => ({
  deletePipelinePluginCollectionPreferences: jest.fn(),
}));
jest.mock('../plugins/invocable-inventory-service', () => ({
  refreshInvocableInventoryAfterMutation: jest.fn(),
}));
jest.mock('../lib/preferences-store', () => ({
  peekPreferencesLoadError: (): null => null,
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({ disabledPipelineIds: [] }),
  ),
  updatePreferencesFile: jest.fn((updater: (value: unknown) => unknown) =>
    Promise.resolve(updater({ disabledPipelineIds: [] })),
  ),
}));

// CAN-4551: the owner marker a converted automation's pipeline carries.
const mockReadPipelineLocalMetadata = jest.fn<
  { ownerAutomationId?: string },
  [unknown]
>(() => ({}));
jest.mock('../pipelines/pipeline-local-metadata-store', () => ({
  ...jest.requireActual<object>('../pipelines/pipeline-local-metadata-store'),
  readPipelineLocalMetadata: (ref: unknown): unknown =>
    mockReadPipelineLocalMetadata(ref),
}));

const mockListAutomations = jest.fn<Promise<AutomationsListResponse>, []>(() =>
  Promise.resolve({ activities: [], recentRuns: [] }),
);
const automationService = {
  list: mockListAutomations,
  listForContext: jest.fn((context: WorkspaceContext) => {
    void context;
    return mockListAutomations();
  }),
  listRuns: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  runNow: jest.fn(),
};
jest.mock('../automations/service', () => ({
  getAutomationsService: (): typeof automationService => automationService,
}));
// CAN-4551 7c: agent writes go through the conversion save, passed straight
// to the service here unless a test stands in for it.
const mockUpdateAutomationForAgent = jest.fn(
  (
    request: unknown,
    writer: {
      authorize?: unknown;
      callerContext?: unknown;
      agentAuthor: unknown;
    },
    service: typeof automationService,
  ): unknown =>
    service.update(request, writer.authorize, writer.callerContext, {
      agentAuthor: writer.agentAuthor,
    }),
);
jest.mock('../automations/chat-automation-save', () => ({
  createAutomationForAgent: (
    request: unknown,
    trusted: unknown,
    service: typeof automationService,
  ): unknown => service.create(request, trusted),
  updateAutomationForAgent: (
    ...args: Parameters<typeof mockUpdateAutomationForAgent>
  ): unknown => mockUpdateAutomationForAgent(...args),
}));

// CAN-4551: the chat action a converted automation's owned pipeline stands
// for; unconverted activities project to themselves.
const mockProjectOwnedChatAutomation = jest.fn(
  (activity: ScheduledActivity): ScheduledActivity => activity,
);
jest.mock('../automations/owned-chat-projection', () => ({
  projectOwnedChatAutomation: (
    activity: ScheduledActivity,
  ): ScheduledActivity => mockProjectOwnedChatAutomation(activity),
}));

const mockScopeAutomations = jest.fn(
  (list: AutomationsListResponse): Promise<AutomationsListResponse> =>
    Promise.resolve(list),
);
jest.mock('../services/background-execution-context', () => ({
  scopeAutomationsToSelectedContext: (
    list: AutomationsListResponse,
  ): Promise<AutomationsListResponse> => mockScopeAutomations(list),
}));

type ProjectOwnerTarget = { projectId: string; worktreeId?: string };
type ResolvedProjectOwner =
  | { kind: 'none' }
  | { kind: 'unknown' }
  | { kind: 'personal' }
  | { kind: 'organization'; organizationId: string };
type SameOwnerDecision =
  | { kind: 'allowed' }
  | { kind: 'hidden' }
  | { kind: 'caller_owner_unknown' }
  | { kind: 'target_owner_unknown' };
const mockResolveProjectSavedOwner = jest.fn<
  Promise<ResolvedProjectOwner>,
  [ProjectOwnerTarget]
>(() => Promise.resolve({ kind: 'personal' }));
const mockResolveAutomationTargetOwner = jest.fn<
  Promise<ResolvedProjectOwner>,
  [ProjectOwnerTarget]
>(() => Promise.resolve({ kind: 'personal' }));
const mockIsMissingAutomationTarget = jest.fn<
  Promise<boolean>,
  [ProjectOwnerTarget]
>(() => Promise.resolve(false));
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
    ): Promise<SameOwnerDecision> =>
      actual.decideSameOwnerAccess(callerOwner, target, {
        resolveTargetOwner: (targetProject): Promise<ResolvedProjectOwner> =>
          mockResolveAutomationTargetOwner(targetProject),
        isMissingTarget: (targetProject): Promise<boolean> =>
          mockIsMissingAutomationTarget(targetProject),
      }),
  };
});

jest.mock('../canopy-cloud/client', () => {
  class MockCanopyCloudClientError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status?: number,
    ) {
      super(message);
    }
  }
  return {
    assertCanopyCloudCapability: jest.fn(() => Promise.resolve()),
    CanopyCloudClientError: MockCanopyCloudClientError,
  };
});
const mockIsClaudeTuiChatsEnabled = jest.fn(() => true);
jest.mock('../lib/claude-tui-chats', () => ({
  get isClaudeTuiChatsEnabled(): typeof mockIsClaudeTuiChatsEnabled {
    return mockIsClaudeTuiChatsEnabled;
  },
}));

import type {
  AppAdvisorJson,
  AutomationsListResponse,
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import type * as ProjectOwnerModule from '../lib/project-owner';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { WORKTREE_SESSION_PROMPT_ACTION_CHANGE_POLICY_ERROR } from '@canopy/desktop-shared/lib/agent-automation-policy';
import {
  resetAppAdvisorProjectAgentAccessForTests,
  setAppAdvisorProjectAgentAccess,
} from '../lib/app-advisor-project-agent-access';
import {
  dispatchAgentResourceAction,
  loadAgentPipelineById,
  type AgentResourceActionRuntime,
} from '../canopy-tools/resource-actions';
import * as pipelineStore from '../pipelines/pipeline-service';

const ADVISOR_ACCESS_DISABLED_MESSAGE =
  'Orchestrator access is turned off for agents in this project. The user controls this in Settings > Orchestrator.';
const OWNER_UNKNOWN_MESSAGE =
  'The project owner could not be confirmed, so Orchestrator access is unavailable for agents in this project.';
const AUTOMATION_OWNER_UNKNOWN_MESSAGE =
  'The project owner could not be confirmed, so automation access is unavailable for agents in this project.';

function activity(
  id: string,
  action: ScheduledActivity['action'] = {
    type: 'app_advisor_prompt',
    prompt: `prompt for ${id}`,
  },
): ScheduledActivity {
  return {
    version: 1,
    id,
    name: `Activity ${id}`,
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action,
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    nextRunAt: '2026-08-05T13:00:00.000Z',
    failureCount: 0,
  };
}

function ordinaryAction(): ScheduledActivity['action'] {
  return {
    type: 'worktree_prompt',
    workspaceId: 'workspace-1',
    prompt: 'Review the project',
  };
}

function resultObject(
  value: AppAdvisorJson | undefined,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected object result');
  }
  return value;
}

const anyChat: unknown = expect.anything();
const anyAgentAuthor: unknown = expect.objectContaining({ chat: anyChat });
/** The trusted facts an agent's automation update records. */
const AGENT_AUTHORED: unknown = { agentAuthor: anyAgentAuthor };

describe('agent automation App Advisor access', () => {
  const runtime: AgentResourceActionRuntime = {
    projectId: 'trusted-project',
    worktreeId: 'trusted-worktree',
    chatId: 'trusted-chat',
    cwd: '/repo',
    getWindow: () => null,
  };

  beforeEach((): void => {
    jest.clearAllMocks();
    resetAppAdvisorProjectAgentAccessForTests();
    mockResolveProjectSavedOwner.mockResolvedValue({ kind: 'personal' });
    mockResolveAutomationTargetOwner.mockResolvedValue({ kind: 'personal' });
    mockIsMissingAutomationTarget.mockResolvedValue(false);
    automationService.list.mockResolvedValue({
      activities: [],
      recentRuns: [],
    });
    automationService.listRuns.mockResolvedValue({
      runs: [],
      nextCursor: null,
      totalCount: 0,
    });
    automationService.create.mockResolvedValue({ ok: true });
    automationService.update.mockResolvedValue({ ok: true });
    automationService.delete.mockResolvedValue({ ok: true });
    automationService.runNow.mockResolvedValue({ ok: true });
    mockScopeAutomations.mockImplementation((list) => Promise.resolve(list));
    mockProjectOwnedChatAutomation.mockImplementation((activity) => activity);
    mockReadPipelineLocalMetadata.mockReturnValue({});
  });

  afterAll((): void => {
    resetAppAdvisorProjectAgentAccessForTests();
  });

  describe('converted chat automations (CAN-4551)', () => {
    const ownedPipelineAction: ScheduledActivity['action'] = {
      type: 'worktree_pipeline',
      target: { kind: 'global' },
      pipelineId: 'owned-1',
      pipelineSource: 'user',
    };

    function standsFor(
      converted: ScheduledActivity,
      chatAction: ScheduledActivity['action'],
    ): void {
      mockProjectOwnedChatAutomation.mockImplementation((candidate) =>
        candidate.id === converted.id
          ? { ...candidate, action: chatAction }
          : candidate,
      );
    }

    it('keeps a converted Orchestrator automation behind Orchestrator access', async (): Promise<void> => {
      setAppAdvisorProjectAgentAccess({
        mode: 'disabled',
        selectedOwners: [],
      });
      const converted = {
        ...activity('converted-advisor', ownedPipelineAction),
        executionContext: 'personal',
      };
      standsFor(converted, { type: 'app_advisor_prompt', prompt: 'Review' });
      const convertedRun = {
        id: 'converted-run',
        activityId: converted.id,
        activityName: converted.name,
        scheduledFor: '2026-08-05T13:00:00.000Z',
        manual: false,
        status: 'success' as const,
        startedAt: '2026-08-05T13:00:00.000Z',
        completedAt: '2026-08-05T13:00:01.000Z',
      };
      automationService.list.mockResolvedValue({
        activities: [converted],
        recentRuns: [convertedRun],
      });

      const list = await dispatchAgentResourceAction(
        { type: 'automation.list', includeRuns: true },
        runtime,
      );
      const fetched = await dispatchAgentResourceAction(
        { type: 'automation.get', id: converted.id },
        runtime,
      );
      const runNow = await dispatchAgentResourceAction(
        { type: 'automation.run_now', id: converted.id },
        runtime,
      );
      const disabled = await dispatchAgentResourceAction(
        { type: 'automation.disable', id: converted.id },
        runtime,
      );
      const deleted = await dispatchAgentResourceAction(
        { type: 'automation.delete', id: converted.id },
        runtime,
      );

      expect(resultObject(list.result)).toEqual({
        activities: [],
        recentRuns: [],
      });
      expect(runNow).toEqual({
        requestId: '',
        ok: false,
        error: {
          code: 'advisor_access_disabled',
          message: ADVISOR_ACCESS_DISABLED_MESSAGE,
          retryable: false,
        },
      });
      for (const response of [fetched, disabled]) {
        expect(response).toEqual({
          requestId: '',
          ok: false,
          error: {
            code: 'not_found',
            message: `Activity ${converted.id} was not found.`,
            retryable: false,
          },
        });
      }
      expect(deleted).toEqual({
        requestId: '',
        ok: false,
        error: {
          code: 'not_found',
          message: 'Activity not found.',
          retryable: false,
        },
      });
      expect(automationService.runNow).not.toHaveBeenCalled();
      expect(automationService.update).not.toHaveBeenCalled();
      expect(automationService.delete).not.toHaveBeenCalled();
    });

    it('keeps a converted Orchestrator automation’s own pipeline behind Orchestrator access', async (): Promise<void> => {
      const converted = {
        ...activity('converted-advisor', ownedPipelineAction),
        executionContext: 'personal',
      };
      standsFor(converted, { type: 'app_advisor_prompt', prompt: 'Review' });
      automationService.list.mockResolvedValue({
        activities: [converted],
        recentRuns: [],
      });
      mockReadPipelineLocalMetadata.mockReturnValue({
        ownerAutomationId: converted.id,
      });
      const stored = {
        info: { id: 'owned-1', name: converted.name, source: 'user' },
        content: { name: converted.name, jobs: {} },
      };
      const found = { success: true, data: stored };
      jest
        .mocked(pipelineStore.getPipeline)
        .mockReturnValue(
          found as unknown as ReturnType<typeof pipelineStore.getPipeline>,
        );

      setAppAdvisorProjectAgentAccess({ mode: 'disabled', selectedOwners: [] });
      const hidden = await loadAgentPipelineById('owned-1', runtime);
      const deleted = await dispatchAgentResourceAction(
        { type: 'pipeline.delete', pipelineId: 'owned-1' },
        runtime,
      );
      setAppAdvisorProjectAgentAccess({ mode: 'enabled', selectedOwners: [] });
      const visible = await loadAgentPipelineById('owned-1', runtime);

      expect(hidden).toBeNull();
      expect(deleted).toMatchObject({
        ok: false,
        error: { code: 'not_found' },
      });
      expect(visible).toBe(stored);
    });

    it('keeps a converted Orchestrator automation hidden after its pipeline is edited out of the chat shape', async (): Promise<void> => {
      // An unrelated pipeline edit: the projection keeps the stored action.
      const converted = {
        ...activity('converted-advisor', {
          ...ownedPipelineAction,
          inputs: { bot_id: 'app_advisor' },
        }),
        executionContext: 'personal',
      };
      automationService.list.mockResolvedValue({
        activities: [converted],
        recentRuns: [],
      });
      mockReadPipelineLocalMetadata.mockReturnValue({
        ownerAutomationId: converted.id,
      });
      const stored = {
        info: { id: 'owned-1', name: converted.name, source: 'user' },
        content: { name: converted.name, env: { EXTRA: '1' }, jobs: {} },
      };
      const found = { success: true, data: stored };
      jest
        .mocked(pipelineStore.getPipeline)
        .mockReturnValue(
          found as unknown as ReturnType<typeof pipelineStore.getPipeline>,
        );
      setAppAdvisorProjectAgentAccess({ mode: 'disabled', selectedOwners: [] });

      const pipeline = await loadAgentPipelineById('owned-1', runtime);
      const fetched = await dispatchAgentResourceAction(
        { type: 'automation.get', id: converted.id },
        runtime,
      );

      expect(pipeline).toBeNull();
      expect(fetched).toMatchObject({
        ok: false,
        error: { code: 'not_found' },
      });
    });

    it('refuses changing a converted session prompt to another action type', async (): Promise<void> => {
      const converted = {
        ...activity('converted-session', ownedPipelineAction),
        executionContext: 'personal',
      };
      standsFor(converted, {
        type: 'worktree_session_prompt',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        prompt: 'Continue',
      });
      automationService.list.mockResolvedValue({
        activities: [converted],
        recentRuns: [],
      });

      const response = await dispatchAgentResourceAction(
        {
          type: 'automation.update',
          id: converted.id,
          patch: {
            action: {
              type: 'standalone_prompt',
              chatProjectId: 'cowork-1',
              prompt: 'Continue elsewhere',
            },
          },
        },
        runtime,
      );

      expect(response).toEqual({
        requestId: '',
        ok: false,
        error: {
          code: 'validation_failed',
          message: WORKTREE_SESSION_PROMPT_ACTION_CHANGE_POLICY_ERROR,
          retryable: false,
        },
      });
      expect(mockUpdateAutomationForAgent).not.toHaveBeenCalled();
    });

    it('rechecks a converted session prompt’s policy in the queued update guard', async (): Promise<void> => {
      const native = activity('converted-later', {
        type: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        prompt: 'Continue',
      });
      const converted = {
        ...native,
        action: ownedPipelineAction,
        executionContext: 'personal',
      };
      automationService.list.mockResolvedValue({
        activities: [native],
        recentRuns: [],
      });
      mockResolveAutomationTargetOwner.mockResolvedValue({ kind: 'personal' });
      // Converted while the update waited in the service queue.
      automationService.update.mockImplementation(
        async (
          _request: unknown,
          authorize:
            | ((fresh: ScheduledActivity) => Promise<boolean>)
            | undefined,
        ) => {
          standsFor(converted, {
            type: 'worktree_session_prompt',
            workspaceId: 'workspace-1',
            worktreeId: 'worktree-1',
            chatId: 'chat-1',
            prompt: 'Continue',
          });
          const allowed = authorize ? await authorize(converted) : true;
          return allowed
            ? { ok: true, activity: converted }
            : { ok: false, error: 'Refused.' };
        },
      );

      const response = await dispatchAgentResourceAction(
        {
          type: 'automation.update',
          id: native.id,
          patch: {
            action: {
              type: 'standalone_prompt',
              chatProjectId: 'cowork-1',
              prompt: 'Continue elsewhere',
            },
          },
        },
        runtime,
      );

      expect(response).toEqual({
        requestId: '',
        ok: false,
        error: {
          code: 'validation_failed',
          message: WORKTREE_SESSION_PROMPT_ACTION_CHANGE_POLICY_ERROR,
          retryable: false,
        },
      });
    });
  });

  it('allows Advisor automations when access is enabled', async (): Promise<void> => {
    setAppAdvisorProjectAgentAccess({ mode: 'enabled', selectedOwners: [] });
    const existing = activity('enabled-advisor-activity');
    automationService.list.mockResolvedValue({
      activities: [existing],
      recentRuns: [],
    });
    automationService.create.mockResolvedValue({ ok: true });
    automationService.update.mockResolvedValue({
      ok: true,
      activity: { ...existing, name: 'Updated Advisor review' },
    });

    const response = await dispatchAgentResourceAction(
      {
        type: 'automation.create',
        input: {
          name: 'Advisor review',
          schedule: {
            kind: 'one_time',
            runAt: '2026-08-05T00:00:00.000Z',
            timezone: 'local',
          },
          action: { type: 'app_advisor_prompt', prompt: 'Review changes' },
        },
      },
      runtime,
    );

    expect(response.ok).toBe(true);
    expect(automationService.create).toHaveBeenCalledTimes(1);
    const updated = await dispatchAgentResourceAction(
      {
        type: 'automation.update',
        id: existing.id,
        patch: { name: 'Updated Advisor review' },
      },
      runtime,
    );
    const runNow = await dispatchAgentResourceAction(
      { type: 'automation.run_now', id: existing.id },
      runtime,
    );
    const deleted = await dispatchAgentResourceAction(
      { type: 'automation.delete', id: existing.id },
      runtime,
    );
    expect(updated.ok).toBe(true);
    expect(runNow.ok).toBe(true);
    expect(deleted.ok).toBe(true);
    expect(automationService.update).toHaveBeenCalledWith(
      { id: existing.id, name: 'Updated Advisor review' },
      expect.any(Function),
      { kind: 'personal' },
      AGENT_AUTHORED,
    );
    expect(automationService.runNow).toHaveBeenCalledWith(
      { id: existing.id },
      expect.any(Function),
      { kind: 'personal' },
    );
    expect(automationService.delete).toHaveBeenCalledWith(
      { id: existing.id },
      expect.any(Function),
      { kind: 'personal' },
    );
    expect(mockResolveProjectSavedOwner).toHaveBeenCalledWith({
      projectId: runtime.projectId,
      worktreeId: runtime.worktreeId,
    });
  });

  it('allows a selected saved owner and rejects disallowed or stale organization owners', async (): Promise<void> => {
    setAppAdvisorProjectAgentAccess({
      mode: 'selected-owners',
      selectedOwners: [
        { kind: 'organization', organizationId: 'org-selected' },
      ],
    });
    mockResolveProjectSavedOwner.mockResolvedValue({
      kind: 'organization',
      organizationId: 'org-selected',
    });
    automationService.create.mockResolvedValue({ ok: true });

    const allowed = await dispatchAgentResourceAction(
      {
        type: 'automation.create',
        input: {
          name: 'Allowed',
          schedule: {
            kind: 'one_time',
            runAt: '2026-08-05T00:00:00.000Z',
            timezone: 'local',
          },
          action: { type: 'app_advisor_prompt', prompt: 'Review' },
        },
      },
      runtime,
    );

    expect(allowed.ok).toBe(true);
    expect(automationService.create).toHaveBeenCalledTimes(1);

    mockResolveProjectSavedOwner.mockResolvedValue({
      kind: 'organization',
      organizationId: 'org-not-selected',
    });
    const disallowedSelection = await dispatchAgentResourceAction(
      {
        type: 'automation.create',
        input: {
          name: 'Unselected organization',
          schedule: {
            kind: 'one_time',
            runAt: '2026-08-05T00:00:00.000Z',
            timezone: 'local',
          },
          action: { type: 'app_advisor_prompt', prompt: 'Review' },
        },
      },
      runtime,
    );

    expect(disallowedSelection).toEqual({
      requestId: '',
      ok: false,
      error: {
        code: 'advisor_access_disabled',
        message: ADVISOR_ACCESS_DISABLED_MESSAGE,
        retryable: false,
      },
    });

    setAppAdvisorProjectAgentAccess({
      mode: 'selected-owners',
      selectedOwners: [{ kind: 'organization', organizationId: 'org-stale' }],
    });
    mockResolveProjectSavedOwner.mockResolvedValue({
      kind: 'organization',
      organizationId: 'org-current',
    });
    const staleSelection = await dispatchAgentResourceAction(
      {
        type: 'automation.create',
        input: {
          name: 'Stale selection',
          schedule: {
            kind: 'one_time',
            runAt: '2026-08-05T00:00:00.000Z',
            timezone: 'local',
          },
          action: { type: 'app_advisor_prompt', prompt: 'Review' },
        },
      },
      runtime,
    );

    expect(staleSelection).toEqual({
      requestId: '',
      ok: false,
      error: {
        code: 'advisor_access_disabled',
        message: ADVISOR_ACCESS_DISABLED_MESSAGE,
        retryable: false,
      },
    });
    expect(automationService.create).toHaveBeenCalledTimes(1);
  });

  it('uses the trusted runtime owner rather than a caller-supplied target', async (): Promise<void> => {
    setAppAdvisorProjectAgentAccess({
      mode: 'selected-owners',
      selectedOwners: [{ kind: 'organization', organizationId: 'org-input' }],
    });
    mockResolveProjectSavedOwner.mockImplementation((target) =>
      Promise.resolve(
        target.projectId === 'caller-supplied-project'
          ? { kind: 'organization', organizationId: 'org-input' }
          : { kind: 'organization', organizationId: 'org-runtime' },
      ),
    );
    const input = {
      name: 'Spoofed target',
      projectId: 'caller-supplied-project',
      schedule: {
        kind: 'one_time' as const,
        runAt: '2026-08-05T00:00:00.000Z',
        timezone: 'local' as const,
      },
      action: { type: 'app_advisor_prompt' as const, prompt: 'Review' },
    };

    const response = await dispatchAgentResourceAction(
      { type: 'automation.create', input },
      runtime,
    );

    expect(response).toEqual({
      requestId: '',
      ok: false,
      error: {
        code: 'advisor_access_disabled',
        message: ADVISOR_ACCESS_DISABLED_MESSAGE,
        retryable: false,
      },
    });
    expect(mockResolveProjectSavedOwner).toHaveBeenCalledWith({
      projectId: 'trusted-project',
      worktreeId: 'trusted-worktree',
    });
    expect(automationService.create).not.toHaveBeenCalled();
  });

  it('uses the disabled response for denied create, update, conversion, and run-now actions', async (): Promise<void> => {
    setAppAdvisorProjectAgentAccess({ mode: 'disabled', selectedOwners: [] });
    const existing = activity('advisor-activity');
    const ordinary = activity('ordinary-activity', ordinaryAction());
    automationService.list.mockResolvedValue({
      activities: [existing, ordinary],
      recentRuns: [],
    });

    const create = await dispatchAgentResourceAction(
      {
        type: 'automation.create',
        input: {
          name: 'Denied create',
          schedule: {
            kind: 'one_time',
            runAt: '2026-08-05T00:00:00.000Z',
            timezone: 'local',
          },
          action: { type: 'app_advisor_prompt', prompt: 'Review' },
        },
      },
      runtime,
    );
    const updateExistingAdvisor = await dispatchAgentResourceAction(
      {
        type: 'automation.update',
        id: existing.id,
        patch: { name: 'Metadata-only update' },
      },
      runtime,
    );
    const conversionToAdvisor = await dispatchAgentResourceAction(
      {
        type: 'automation.update',
        id: ordinary.id,
        patch: {
          action: { type: 'app_advisor_prompt', prompt: 'Review' },
        },
      },
      runtime,
    );
    const runNow = await dispatchAgentResourceAction(
      { type: 'automation.run_now', id: existing.id },
      runtime,
    );

    for (const response of [
      create,
      updateExistingAdvisor,
      conversionToAdvisor,
      runNow,
    ]) {
      expect(response).toEqual({
        requestId: '',
        ok: false,
        error: {
          code: 'advisor_access_disabled',
          message: ADVISOR_ACCESS_DISABLED_MESSAGE,
          retryable: false,
        },
      });
    }
    expect(automationService.create).not.toHaveBeenCalled();
    expect(automationService.update).not.toHaveBeenCalled();
    expect(automationService.runNow).not.toHaveBeenCalled();
  });

  it('refuses converting an Orchestrator automation back to native without access (CAN-4551 7c)', async (): Promise<void> => {
    setAppAdvisorProjectAgentAccess({ mode: 'disabled', selectedOwners: [] });
    const converted = activity('converted-advisor', {
      type: 'worktree_pipeline',
      target: { kind: 'global' },
      pipelineId: 'owned-1',
      pipelineSource: 'user',
    });
    automationService.list.mockResolvedValue({
      activities: [converted],
      recentRuns: [],
    });
    // The save would convert it back to the Orchestrator prompt it stands for.
    mockUpdateAutomationForAgent.mockImplementationOnce(
      async (_request, writer) => {
        const { authorizeNative } = writer as {
          authorizeNative?: (action: unknown) => Promise<boolean>;
        };
        const allowed = authorizeNative
          ? await authorizeNative({ type: 'app_advisor_prompt', prompt: 'x' })
          : true;
        return allowed
          ? { ok: true, activity: converted }
          : { ok: false, error: 'Activity not found.' };
      },
    );

    const response = await dispatchAgentResourceAction(
      {
        type: 'automation.update',
        id: converted.id,
        patch: {
          schedule: {
            kind: 'one_time',
            runAt: '2026-08-05T00:00:00.000Z',
            timezone: 'local',
          },
        },
      },
      runtime,
    );

    expect(response).toEqual({
      requestId: '',
      ok: false,
      error: {
        code: 'advisor_access_disabled',
        message: ADVISOR_ACCESS_DISABLED_MESSAGE,
        retryable: false,
      },
    });
  });

  it('rechecks App Advisor access in the serialized update guard', async (): Promise<void> => {
    setAppAdvisorProjectAgentAccess({ mode: 'enabled', selectedOwners: [] });
    const existing = activity('advisor-access-revoked-during-update');
    automationService.list.mockResolvedValue({
      activities: [existing],
      recentRuns: [],
    });
    automationService.update.mockImplementation(
      async (
        request: { id: string },
        authorize: ((fresh: ScheduledActivity) => Promise<boolean>) | undefined,
        callerContext: WorkspaceContext | undefined,
      ) => {
        void request;
        void callerContext;
        setAppAdvisorProjectAgentAccess({
          mode: 'disabled',
          selectedOwners: [],
        });
        const allowed = authorize ? await authorize(existing) : true;
        return allowed
          ? { ok: true, activity: existing }
          : { ok: false, error: 'Activity not found.' };
      },
    );

    const response = await dispatchAgentResourceAction(
      {
        type: 'automation.update',
        id: existing.id,
        patch: { name: 'Updated after revocation' },
      },
      runtime,
    );

    expect(response).toEqual({
      requestId: '',
      ok: false,
      error: {
        code: 'advisor_access_disabled',
        message: ADVISOR_ACCESS_DISABLED_MESSAGE,
        retryable: false,
      },
    });
  });

  it('fails closed with owner-unknown wording and leaves non-Advisor actions available', async (): Promise<void> => {
    setAppAdvisorProjectAgentAccess({ mode: 'disabled', selectedOwners: [] });
    mockResolveProjectSavedOwner.mockResolvedValue({ kind: 'unknown' });
    automationService.list.mockResolvedValue({
      activities: [],
      recentRuns: [],
    });
    automationService.create.mockResolvedValue({ ok: true });

    const denied = await dispatchAgentResourceAction(
      {
        type: 'automation.create',
        input: {
          name: 'Unknown owner',
          schedule: {
            kind: 'one_time',
            runAt: '2026-08-05T00:00:00.000Z',
            timezone: 'local',
          },
          action: { type: 'app_advisor_prompt', prompt: 'Review' },
        },
      },
      runtime,
    );
    const ordinary = await dispatchAgentResourceAction(
      {
        type: 'automation.create',
        input: {
          name: 'Ordinary automation',
          schedule: {
            kind: 'one_time',
            runAt: '2026-08-05T00:00:00.000Z',
            timezone: 'local',
          },
          action: ordinaryAction(),
        },
      },
      runtime,
    );

    expect(denied).toEqual({
      requestId: '',
      ok: false,
      error: {
        code: 'advisor_access_disabled',
        message: OWNER_UNKNOWN_MESSAGE,
        retryable: false,
      },
    });
    expect(ordinary).toEqual({
      requestId: '',
      ok: false,
      error: {
        code: 'owner_context_unavailable',
        message: AUTOMATION_OWNER_UNKNOWN_MESSAGE,
        retryable: false,
      },
    });
    expect(automationService.create).not.toHaveBeenCalled();
  });

  it('does not disclose denied Advisor activity or run metadata and preserves unknown delete semantics', async (): Promise<void> => {
    setAppAdvisorProjectAgentAccess({ mode: 'disabled', selectedOwners: [] });
    const advisorActivity = activity('advisor-private');
    const nonAdvisorActivity = activity('ordinary-visible', ordinaryAction());
    const advisorRun: ScheduledActivityRun = {
      id: 'advisor-run',
      activityId: advisorActivity.id,
      activityName: 'Private Advisor activity',
      scheduledFor: '2026-08-05T13:00:00.000Z',
      manual: false,
      status: 'success',
      startedAt: '2026-08-05T13:00:00.000Z',
      completedAt: '2026-08-05T13:00:01.000Z',
    };
    const nonAdvisorRun = {
      ...advisorRun,
      id: 'ordinary-run',
      activityId: nonAdvisorActivity.id,
      activityName: nonAdvisorActivity.name,
    };
    automationService.list.mockResolvedValue({
      activities: [advisorActivity, nonAdvisorActivity],
      recentRuns: [advisorRun, nonAdvisorRun],
    });

    const list = await dispatchAgentResourceAction(
      { type: 'automation.list', includeRuns: true },
      runtime,
    );
    const listWithoutRuns = await dispatchAgentResourceAction(
      { type: 'automation.list', includeRuns: false },
      runtime,
    );
    const fetched = await dispatchAgentResourceAction(
      { type: 'automation.get', id: advisorActivity.id },
      runtime,
    );
    const disabled = await dispatchAgentResourceAction(
      { type: 'automation.disable', id: advisorActivity.id },
      runtime,
    );
    const deleted = await dispatchAgentResourceAction(
      { type: 'automation.delete', id: advisorActivity.id },
      runtime,
    );

    expect(resultObject(list.result)).toEqual({
      activities: [nonAdvisorActivity],
      recentRuns: [nonAdvisorRun],
    });
    expect(resultObject(listWithoutRuns.result)).toEqual({
      activities: [nonAdvisorActivity],
    });
    for (const response of [fetched, disabled]) {
      expect(response).toEqual({
        requestId: '',
        ok: false,
        error: {
          code: 'not_found',
          message: `Activity ${advisorActivity.id} was not found.`,
          retryable: false,
        },
      });
    }
    expect(automationService.listRuns).not.toHaveBeenCalled();
    expect(automationService.update).not.toHaveBeenCalled();
    expect(automationService.delete).not.toHaveBeenCalled();

    automationService.delete.mockResolvedValue({
      ok: false,
      error: 'Activity not found.',
    });
    const unknownDelete = await dispatchAgentResourceAction(
      { type: 'automation.delete', id: 'missing' },
      runtime,
    );
    expect(unknownDelete).toEqual({
      requestId: '',
      ok: false,
      error: {
        code: 'not_found',
        message: 'Activity not found.',
        retryable: false,
      },
    });
    expect(automationService.delete).toHaveBeenCalledWith(
      { id: 'missing' },
      expect.any(Function),
      { kind: 'personal' },
    );
    expect(deleted).toEqual(unknownDelete);
  });

  it('keeps App Advisor callers ungated', async (): Promise<void> => {
    setAppAdvisorProjectAgentAccess({ mode: 'disabled', selectedOwners: [] });
    mockResolveProjectSavedOwner.mockResolvedValue({ kind: 'none' });
    const advisorActivity = activity('advisor-activity');
    automationService.list.mockResolvedValue({
      activities: [advisorActivity],
      recentRuns: [],
    });

    const response = await dispatchAgentResourceAction(
      { type: 'automation.get', id: advisorActivity.id },
      {
        ...runtime,
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'advisor-worktree',
      },
    );
    const advisorRuntime: AgentResourceActionRuntime = {
      ...runtime,
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'advisor-worktree',
    };
    const created = await dispatchAgentResourceAction(
      {
        type: 'automation.create',
        input: {
          name: 'Advisor created',
          schedule: {
            kind: 'one_time',
            runAt: '2026-08-05T00:00:00.000Z',
            timezone: 'local',
          },
          action: { type: 'app_advisor_prompt', prompt: 'Review' },
        },
      },
      advisorRuntime,
    );
    const updated = await dispatchAgentResourceAction(
      {
        type: 'automation.update',
        id: advisorActivity.id,
        patch: { name: 'Updated Advisor activity' },
      },
      advisorRuntime,
    );
    const runNow = await dispatchAgentResourceAction(
      { type: 'automation.run_now', id: advisorActivity.id },
      advisorRuntime,
    );
    const deleted = await dispatchAgentResourceAction(
      { type: 'automation.delete', id: advisorActivity.id },
      advisorRuntime,
    );

    expect(response.ok).toBe(true);
    expect(created.ok).toBe(true);
    expect(updated.ok).toBe(true);
    expect(runNow.ok).toBe(true);
    expect(deleted.ok).toBe(true);
    expect(automationService.create).toHaveBeenCalledTimes(1);
    expect(automationService.update).toHaveBeenCalledWith(
      { id: advisorActivity.id, name: 'Updated Advisor activity' },
      expect.any(Function),
      undefined,
      AGENT_AUTHORED,
    );
    expect(automationService.runNow).toHaveBeenCalledWith(
      { id: advisorActivity.id },
      expect.any(Function),
    );
    expect(automationService.delete).toHaveBeenCalledWith(
      { id: advisorActivity.id },
      expect.any(Function),
    );
    expect(automationService.listRuns).toHaveBeenCalledTimes(1);
    expect(mockResolveProjectSavedOwner).toHaveBeenCalledWith({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'advisor-worktree',
    });
  });
});
