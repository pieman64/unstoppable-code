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
import {
  copyPackageInstall,
  SHARED_PACKAGE_REVIEW_REQUIRED_MESSAGE,
  updateSharedPipelinePreservingPackage,
} from '../pipelines/pipeline-package-service';
jest.mock('../pipelines/pipeline-package-service', () => ({
  copyPackageInstall: jest.fn(() => Promise.resolve()),
  removePackageInstall: jest.fn(() => Promise.resolve()),
  SHARED_PACKAGE_REVIEW_REQUIRED_MESSAGE: 'Review package dependencies.',
  updateSharedPipelinePreservingPackage: jest.fn(),
}));
const mockGetSharedPipelineSaveImpact = jest.fn<
  Promise<SharedPipelineSaveImpact>,
  [string]
>(() => Promise.resolve({ automations: [] }));
jest.mock('../pipelines/shared-pipeline-save-impact', () => ({
  getSharedPipelineSaveImpact: (
    remoteId: string,
  ): Promise<SharedPipelineSaveImpact> =>
    mockGetSharedPipelineSaveImpact(remoteId),
}));
import { assertPipelineContext } from '../pipelines/resource-lanes';
let mockShareContextEnabled = false;
jest.mock('../pipelines/resource-lanes', () => ({
  pipelineResourceContextEnabled: jest.fn(() => mockShareContextEnabled),
  assertPipelineContext: jest.fn(() => Promise.resolve()),
}));
let mockWorkspaceContext:
  | { kind: 'personal' }
  | { kind: 'organization'; organizationId: string } = { kind: 'personal' };
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: jest.fn(() => ({
    initialize: jest.fn(() => Promise.resolve()),
    whenIdle: jest.fn(() => Promise.resolve()),
    getState: jest.fn(() => ({ context: mockWorkspaceContext })),
  })),
}));
import {
  authorizeProjectPipelineRequest,
  assertStoredPipelineContext,
  copyPipelineInstallOrigin,
  readStoredPipelineContext,
} from '../pipelines/pipeline-install-context';
jest.mock('../pipelines/pipeline-install-context', () => ({
  authorizeProjectPipelineRequest: jest.fn(),
  assertStoredPipelineContext: jest.fn(() => Promise.resolve()),
  copyPipelineInstallOrigin: jest.fn(() => Promise.resolve()),
  readStoredPipelineContext: jest.fn(() =>
    Promise.resolve({ owner: { type: 'user', id: 'me', name: null } }),
  ),
}));
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANOPY_CLOUD_DISPLAY_NAME } from '@canopy/desktop-shared/constants/canopy-cloud';

jest.mock('../skills/skill-service', () => ({
  loadSkills: jest.fn(),
  readSkillContent: jest.fn(),
  readSkillFile: jest.fn(),
  saveCustomSkill: jest.fn(),
  removeSkill: jest.fn(),
  readRawSkill: jest.fn(),
  writeRawSkill: jest.fn(),
  writeRawSkillForContext: jest.fn(),
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

jest.mock(
  '../canopy-runtime/pipeline-definition-dispatch',
  (): object =>
    jest.requireActual<{ pipelineWriteDispatchFake: object }>(
      './helpers/pipeline-write-dispatch-fake',
    ).pipelineWriteDispatchFake,
);
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
  getSharedPipelineForExecutionContext: jest.fn(),
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
  // Not degraded: approval resolution fails closed when this is non-null.
  peekPreferencesLoadError: (): null => null,
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({ disabledPipelineIds: [] }),
  ),
  updatePreferencesFile: jest.fn((updater: (value: unknown) => unknown) =>
    Promise.resolve(updater({ disabledPipelineIds: [] })),
  ),
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
// CAN-4551 7c: agent writes go through the conversion save; here it passes
// straight to the service so the policy tests read the service calls.
const mockCreateAutomationForAgent = jest.fn(
  (
    request: unknown,
    trusted: unknown,
    service: typeof automationService,
  ): unknown => service.create(request, trusted),
);
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
    ...args: Parameters<typeof mockCreateAutomationForAgent>
  ): unknown => mockCreateAutomationForAgent(...args),
  updateAutomationForAgent: (
    ...args: Parameters<typeof mockUpdateAutomationForAgent>
  ): unknown => mockUpdateAutomationForAgent(...args),
}));

const mockScopeAutomations = jest.fn(
  (list: AutomationsListResponse): Promise<AutomationsListResponse> =>
    Promise.resolve(list),
);
const mockRecordUserPipelineOwner = jest.fn();
const mockSetUserPipelineAgentAuthor = jest.fn();
const mockDeleteUserPipelineLocalMetadata = jest.fn();
jest.mock('../pipelines/pipeline-local-metadata-store', () => ({
  recordUserPipelineOwner: (...args: unknown[]): unknown =>
    mockRecordUserPipelineOwner(...args),
  setUserPipelineAgentAuthor: (...args: unknown[]): unknown =>
    mockSetUserPipelineAgentAuthor(...args),
  deleteUserPipelineLocalMetadata: (...args: unknown[]): unknown =>
    mockDeleteUserPipelineLocalMetadata(...args),
  // No pipeline here is an automation's own (CAN-4551).
  readPipelineLocalMetadata: (): object => ({}),
}));
// No activity here owns its pipeline (CAN-4551), so each is checked as stored.
jest.mock('../automations/owned-chat-projection', () => ({
  projectOwnedChatAutomation: <T>(activity: T): T => activity,
}));
const mockAgentPipelineOwnerContext = jest.fn<
  ReturnType<typeof PipelineOwnerPolicyModule.agentPipelineOwnerContext>,
  Parameters<typeof PipelineOwnerPolicyModule.agentPipelineOwnerContext>
>(() => Promise.resolve({ owner: 'personal' }));
const mockGetUserPipelineOwner = jest.fn<
  ReturnType<typeof PipelineOwnerPolicyModule.getUserPipelineOwner>,
  Parameters<typeof PipelineOwnerPolicyModule.getUserPipelineOwner>
>(() => Promise.resolve('personal'));
const mockValidatePipelineOwnerTargetsOnSave = jest.fn<
  ReturnType<
    typeof PipelineOwnerPolicyModule.validatePipelineOwnerTargetsOnSave
  >,
  Parameters<
    typeof PipelineOwnerPolicyModule.validatePipelineOwnerTargetsOnSave
  >
>(() => Promise.resolve(null));
jest.mock('../pipelines/pipeline-owner-policy', () => ({
  agentPipelineOwnerContext: (
    target: Parameters<
      typeof PipelineOwnerPolicyModule.agentPipelineOwnerContext
    >[0],
  ): ReturnType<typeof PipelineOwnerPolicyModule.agentPipelineOwnerContext> =>
    mockAgentPipelineOwnerContext(target),
  getUserPipelineOwner: (
    pipelineId: string,
  ): ReturnType<typeof PipelineOwnerPolicyModule.getUserPipelineOwner> =>
    mockGetUserPipelineOwner(pipelineId),
  validatePipelineOwnerTargetsOnSave: (
    pipeline: Parameters<
      typeof PipelineOwnerPolicyModule.validatePipelineOwnerTargetsOnSave
    >[0],
    ownerContext: Parameters<
      typeof PipelineOwnerPolicyModule.validatePipelineOwnerTargetsOnSave
    >[1],
  ): ReturnType<
    typeof PipelineOwnerPolicyModule.validatePipelineOwnerTargetsOnSave
  > => mockValidatePipelineOwnerTargetsOnSave(pipeline, ownerContext),
}));

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
import type * as PipelineOwnerPolicyModule from '../pipelines/pipeline-owner-policy';
import type {
  PipelineData,
  SharedPipelineDetail,
  SharedPipelineSaveImpact,
} from '@canopy/desktop-shared/types/pipeline';
import {
  assertCanopyCloudCapability,
  CanopyCloudClientError,
} from '../canopy-cloud/client';
import { refreshInvocableInventoryAfterMutation } from '../plugins/invocable-inventory-service';
import * as skillService from '../skills/skill-service';
import * as skillCloud from '../skills/canopy-server-client';
import * as pipelineStore from '../pipelines/pipeline-service';
import * as curatedCatalog from '../pipelines/curated-pipeline-catalog';
import * as pipelineCloud from '../pipelines/canopy-server-client';
import {
  discoverProjectPipelines,
  loadProjectPipelineFromDisk,
} from '../pipelines/project-pipeline-discovery';
import { withPipelineCrudTelemetry } from '../pipelines/instrumentation';
import { deletePipelinePluginCollectionPreferences } from '../pipelines/plugin-collection-store';
import {
  dispatchAgentResourceAction,
  loadAgentGlobalPipelineById,
  loadAgentPipelineById,
  type AgentResourceActionRuntime,
} from '../canopy-tools/resource-actions';

function pipeline(source: 'user' | 'bundled' = 'user'): PipelineData {
  return {
    info: {
      id: source === 'user' ? 'pipeline-1' : 'builtin-pipeline',
      name: 'Build',
      description: 'Build the project',
      icon: 'build',
      filename: 'build.yaml',
      createdAt: '2026-08-04T00:00:00.000Z',
      updatedAt: '2026-08-04T00:00:00.000Z',
      source,
      readonly: source === 'bundled',
      scopes: ['directory'],
      triggerTypes: ['dispatch'],
    },
    content: {
      name: 'Build',
      description: 'Build the project',
      scope: 'directory',
      on: 'dispatch',
      jobs: { build: { steps: [{ run: 'echo build' }] } },
    },
  };
}

function sharedPipeline(): SharedPipelineDetail {
  return {
    id: 'shared-pipeline',
    name: 'Shared build',
    description: 'Remote build',
    icon: 'build',
    version: '1',
    triggerTypes: ['dispatch'],
    scopes: ['directory'],
    createdBy: { id: 'me', name: 'Me' },
    shareScope: 'private',
    owner: { type: 'user', id: 'me', name: 'Me' },
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    contentHash: 'fixture-content-hash',
    canUpdate: true,
    canDelete: true,
    rawPipeline:
      'name: Shared build\ndescription: Remote build\nscope: directory\non: dispatch\njobs:\n  build:\n    steps:\n      - run: echo build\n',
  };
}

function activity(
  action: ScheduledActivity['action'] = {
    type: 'app_advisor_prompt',
    prompt: 'secret prompt',
  },
): ScheduledActivity {
  return {
    version: 1,
    id: 'activity-1',
    name: 'Daily review',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action,
    ifCommand: 'secret command',
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    nextRunAt: '2026-08-05T13:00:00.000Z',
    failureCount: 0,
  };
}

function resumeAction(): ScheduledActivity['action'] {
  return {
    type: 'pipeline_execution_resume',
    executionId: 'execution-1',
    statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
    provider: 'claude',
    purpose: 'usage_limit_resume',
    pipelineName: 'Release',
    projectId: 'project-1',
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

describe('agent resource actions', () => {
  const getWindow = jest.fn(() => null);
  const runtime: AgentResourceActionRuntime = {
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
    cwd: '/repo',
    executionScope: 'directory',
    getWindow,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSharedPipelineSaveImpact.mockResolvedValue({ automations: [] });
    mockShareContextEnabled = false;
    mockWorkspaceContext = { kind: 'personal' };
    mockResolveProjectSavedOwner.mockResolvedValue({ kind: 'personal' });
    mockResolveAutomationTargetOwner.mockResolvedValue({ kind: 'personal' });
    mockIsMissingAutomationTarget.mockResolvedValue(false);
    jest.mocked(copyPackageInstall).mockReset().mockResolvedValue();
    jest.mocked(assertCanopyCloudCapability).mockResolvedValue();
    mockIsClaudeTuiChatsEnabled.mockReturnValue(true);
    jest.mocked(pipelineStore.listPipelines).mockReturnValue({
      success: true,
      data: [pipeline().info],
    });
    jest.mocked(pipelineStore.getPipeline).mockReturnValue({
      success: true,
      data: pipeline(),
    });
    jest.mocked(pipelineCloud.listSharedPipelines).mockResolvedValue({
      data: [],
      nextCursor: null,
    });
    automationService.list.mockResolvedValue({
      activities: [activity()],
      recentRuns: [],
    });
    automationService.listRuns.mockResolvedValue({
      runs: [],
      nextCursor: null,
      totalCount: 0,
    });
  });

  it('fills a missing organization share target from the selected context', async () => {
    mockShareContextEnabled = true;
    mockWorkspaceContext = {
      kind: 'organization',
      organizationId: 'org-selected',
    };
    jest.mocked(pipelineStore.getPipeline).mockReturnValue({
      success: true,
      data: {
        ...pipeline(),
        content: {
          ...pipeline().content,
          jobs: {
            build: {
              steps: [
                {
                  uses: 'builtin/agent-prompt',
                  with: { prompt: 'Build the project.' },
                },
              ],
            },
          },
        },
      },
    });
    jest
      .mocked(pipelineCloud.createSharedPipeline)
      .mockResolvedValue(sharedPipeline());

    const response = await dispatchAgentResourceAction(
      {
        type: 'pipeline.share',
        pipelineId: 'pipeline-1',
        shareScope: 'organization',
      },
      runtime,
    );

    expect(response).toMatchObject({ ok: true });
    expect(pipelineCloud.createSharedPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        shareScope: 'organization',
        organizationId: 'org-selected',
      }),
    );
  });

  it('refuses an organization share without an organization context', async () => {
    jest.mocked(pipelineStore.getPipeline).mockReturnValue({
      success: true,
      data: {
        ...pipeline(),
        content: {
          ...pipeline().content,
          jobs: {
            build: {
              steps: [
                {
                  uses: 'builtin/agent-prompt',
                  with: { prompt: 'Build the project.' },
                },
              ],
            },
          },
        },
      },
    });
    jest
      .mocked(pipelineCloud.createSharedPipeline)
      .mockResolvedValue(sharedPipeline());

    const response = await dispatchAgentResourceAction(
      {
        type: 'pipeline.share',
        pipelineId: 'pipeline-1',
        shareScope: 'organization',
      },
      runtime,
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'surface_unavailable',
        message:
          'Choose an organization from the context switcher above the account in the sidebar, or pass organizationId, to share with an organization.',
      },
    });
    expect(pipelineCloud.createSharedPipeline).not.toHaveBeenCalled();
  });

  it('does not fill from a selected context while organization scoping is off', async () => {
    mockWorkspaceContext = {
      kind: 'organization',
      organizationId: 'org-selected',
    };
    jest.mocked(pipelineStore.getPipeline).mockReturnValue({
      success: true,
      data: pipeline(),
    });

    const response = await dispatchAgentResourceAction(
      {
        type: 'pipeline.share',
        pipelineId: 'pipeline-1',
        shareScope: 'organization',
      },
      runtime,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable' },
    });
    expect(pipelineCloud.createSharedPipeline).not.toHaveBeenCalled();
  });

  it('denies an Advisor skill read before accessing content', async () => {
    mockAssertSkillContext.mockRejectedValueOnce(
      new Error('Skill unavailable (context-mismatch)'),
    );
    const result = await dispatchAgentResourceAction(
      { type: 'skills.read', sourceId: 'custom:app', skillName: 'org-a' },
      runtime,
    );
    expect(result).toMatchObject({ ok: false });
    expect(skillService.readSkillContent).not.toHaveBeenCalled();
  });

  it('honors local skill list limits above the shared API ceiling', async () => {
    jest.mocked(skillService.loadSkills).mockReturnValue({
      success: true,
      data: Array.from({ length: 150 }, (_, index) => ({
        name: `skill-${index}`,
        sourceId: 'custom:app',
        description: '',
        source: 'custom',
        installedAt: '',
        updatedAt: '',
        updateAvailable: false,
        custom: true,
      })),
    });

    const response = await dispatchAgentResourceAction(
      { type: 'skills.list', limit: 150 },
      runtime,
    );

    expect(response).toMatchObject({ ok: true });
    expect(resultObject(response.result)).toMatchObject({ returned: 150 });
  });

  it('creates a custom skill, refreshes inventory, and emits an installed receipt', async () => {
    jest.mocked(skillService.saveCustomSkill).mockResolvedValue({
      success: true,
      data: { name: 'review' },
    });

    const response = await dispatchAgentResourceAction(
      {
        type: 'skills.create_custom',
        name: 'review',
        description: 'Review changes',
        body: 'Instructions',
      },
      runtime,
    );

    expect(response).toMatchObject({ ok: true });
    expect(refreshInvocableInventoryAfterMutation).toHaveBeenCalledWith(
      'agent:skills:create-custom',
    );
    expect(resultObject(response.result).agentArtifacts).toEqual([
      expect.objectContaining({
        kind: 'skill',
        operation: 'skills.create_custom',
        sourceId: 'custom:app',
        installedName: 'review',
      }),
    ]);
    expect(getWindow).not.toHaveBeenCalled();
  });

  it('normalizes stale shared-skill content hashes', async () => {
    jest.mocked(skillCloud.getSharedSkill).mockResolvedValue({
      id: 'skill-1',
      name: 'Review',
      description: '',
      rawSkill: 'raw',
      contentHash: 'old',
      shareScope: 'private',
      owner: { type: 'user', id: 'me', name: 'Me' },
      createdBy: { id: 'me', name: 'Me', email: null },
      createdAt: '2026-08-04T00:00:00.000Z',
      updatedAt: '2026-08-04T00:00:00.000Z',
      canUpdate: true,
      canDelete: true,
      publicShare: null,
    });
    jest.mocked(skillService.loadSkills).mockReturnValue({
      success: true,
      data: [
        {
          name: 'review',
          sourceId: 'custom:app',
          description: '',
          source: 'custom',
          installedAt: '',
          updatedAt: '',
          updateAvailable: false,
          custom: true,
        },
      ],
    });
    jest.mocked(skillService.readRawSkill).mockResolvedValue('raw');
    jest
      .mocked(skillCloud.updateSharedSkill)
      .mockRejectedValue(
        new CanopyCloudClientError('http-error', 'content hash is stale', 409),
      );

    const response = await dispatchAgentResourceAction(
      {
        type: 'skills.update_shared',
        skillId: 'skill-1',
        name: 'review',
      },
      runtime,
    );
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'stale_content_hash', retryable: false },
    });
  });

  it('keeps rename aliases source-qualified and refreshes the skill inventory', async () => {
    jest.mocked(skillService.readSkillContent).mockReturnValue({
      success: true,
      data: {
        frontmatter: {
          name: 'review-old',
          description: 'Review changes',
          model: 'fast',
          priority: 2,
          enabled: true,
          ignored: { nested: true },
        },
        body: 'Instructions',
      },
    });
    jest.mocked(skillService.saveCustomSkill).mockResolvedValue({
      success: true,
      data: { name: 'review-new' },
    });

    const response = await dispatchAgentResourceAction(
      {
        type: 'skills.update_custom',
        originalName: 'review-old',
        name: 'review-new',
      },
      runtime,
    );

    expect(skillService.saveCustomSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        originalName: 'review-old',
        name: 'review-new',
      }),
      {
        preservedMetadata: {
          name: 'review-old',
          description: 'Review changes',
          model: 'fast',
          priority: 2,
          enabled: true,
          ignored: { nested: true },
        },
      },
    );
    expect(refreshInvocableInventoryAfterMutation).toHaveBeenCalledWith(
      'agent:skills:update-custom',
    );
    expect(resultObject(response.result).agentArtifacts).toEqual([
      expect.objectContaining({
        dedupeKey: 'canopy:skill:installed:custom%3Aapp:review-new',
        aliases: ['canopy:skill:installed:custom%3Aapp:review-old'],
      }),
    ]);
  });

  it('enforces shared-skill ownership before deletion', async () => {
    jest.mocked(skillCloud.getSharedSkill).mockResolvedValue({
      id: 'skill-1',
      name: 'Review',
      description: '',
      rawSkill: 'raw',
      contentHash: 'hash',
      shareScope: 'private',
      owner: { type: 'user', id: 'other', name: 'Other' },
      createdBy: { id: 'other', name: 'Other', email: null },
      createdAt: '2026-08-04T00:00:00.000Z',
      updatedAt: '2026-08-04T00:00:00.000Z',
      canUpdate: false,
      canDelete: false,
      publicShare: null,
    });

    const response = await dispatchAgentResourceAction(
      {
        type: 'skills.delete_shared',
        skillId: 'skill-1',
      },
      runtime,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'authorization_conflict' },
    });
    expect(skillCloud.deleteSharedSkill).not.toHaveBeenCalled();
  });

  it.each(['origin', 'package'])(
    'preserves duplicate provenance when %s copying fails and deletion is unavailable',
    async (stage): Promise<void> => {
      mockShareContextEnabled = true;
      jest.mocked(pipelineStore.getPipeline).mockReturnValue({
        success: true,
        data: {
          ...pipeline(),
          content: { name: 'Build', on: 'dispatch', jobs: {} },
        },
      });
      let receiptId: string | undefined;
      const undo = jest.fn<Promise<void>, []>(() => {
        receiptId = undefined;
        return Promise.resolve();
      });
      jest
        .mocked(copyPipelineInstallOrigin)
        .mockImplementationOnce((_source, id, onRollback): Promise<void> => {
          receiptId = id;
          onRollback?.(undo);
          return stage === 'origin'
            ? Promise.reject(new Error('origin copy failed'))
            : Promise.resolve();
        });
      jest
        .mocked(pipelineStore.savePipeline)
        .mockImplementationOnce((input) => ({
          success: true,
          data: { ...pipeline().info, id: input.id ?? 'unbound-copy' },
        }));
      jest
        .mocked(pipelineStore.deletePipeline)
        .mockReturnValue({ success: false, error: 'deletion failed' });
      if (stage === 'package')
        jest
          .mocked(copyPackageInstall)
          .mockRejectedValueOnce(new Error('package copy failed'));
      const response = await dispatchAgentResourceAction(
        { type: 'pipeline.duplicate', pipelineId: 'pipeline-1' },
        runtime,
      );
      expect(response).toMatchObject({ ok: false });
      if (stage === 'origin') {
        expect(pipelineStore.savePipeline).not.toHaveBeenCalled();
        expect(undo).toHaveBeenCalledTimes(1);
      } else {
        expect(response.error?.message).toContain(
          'package copy failed; deletion failed',
        );
        expect(receiptId).toBeDefined();
        expect(undo).not.toHaveBeenCalled();
        expect(pipelineStore.savePipeline).toHaveBeenCalledWith(
          expect.objectContaining({ id: receiptId }),
          { id: receiptId },
        );
      }
    },
  );

  it('keeps bundled pipelines read-only', async () => {
    jest.mocked(pipelineStore.getPipeline).mockReturnValue({
      success: true,
      data: pipeline('bundled'),
    });
    const response = await dispatchAgentResourceAction(
      {
        type: 'pipeline.delete',
        pipelineId: 'builtin-pipeline',
      },
      runtime,
    );
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'read_only_source' },
    });
    expect(pipelineStore.deletePipeline).not.toHaveBeenCalled();
  });

  it('cleans plugin preferences after direct and post-share deletion', async () => {
    mockShareContextEnabled = true;
    jest.mocked(pipelineStore.getPipeline).mockReturnValue({
      success: true,
      data: {
        ...pipeline(),
        content: {
          ...pipeline().content,
          jobs: {
            build: {
              steps: [
                {
                  uses: 'builtin/agent-prompt',
                  with: { prompt: 'Build the project.' },
                },
              ],
            },
          },
        },
      },
    });
    jest.mocked(pipelineStore.deletePipeline).mockReturnValue({
      success: true,
    });
    jest
      .mocked(pipelineCloud.createSharedPipeline)
      .mockResolvedValue(sharedPipeline());

    const deleted = await dispatchAgentResourceAction(
      { type: 'pipeline.delete', pipelineId: 'pipeline-1' },
      runtime,
    );
    const shared = await dispatchAgentResourceAction(
      {
        type: 'pipeline.share',
        pipelineId: 'pipeline-1',
        shareScope: 'organization',
        organizationId: 'org-selected',
        deleteLocal: true,
      },
      runtime,
    );

    jest.mocked(pipelineStore.savePipeline).mockImplementation((input) => ({
      success: true,
      data: { ...pipeline().info, id: input.id ?? 'copy' },
    }));
    const duplicated = await dispatchAgentResourceAction(
      { type: 'pipeline.duplicate', pipelineId: 'pipeline-1' },
      runtime,
    );
    expect(duplicated).toMatchObject({ ok: true });
    expect(copyPipelineInstallOrigin).toHaveBeenCalledWith(
      'pipeline-1',
      expect.any(String),
      expect.any(Function),
    );
    expect(pipelineCloud.createSharedPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePipeline: { kind: 'stored', id: 'pipeline-1' },
      }),
    );

    expect(deleted).toMatchObject({ ok: true });
    // A legacy `deleteLocal: true` is accepted and ignored: sharing keeps the
    // local pipeline, and only the explicit `pipeline.delete` deletes.
    expect(shared).toMatchObject({
      ok: true,
      result: { localDeleted: false },
    });
    const anyDeleteLocalError: unknown = expect.anything();
    expect(shared).not.toMatchObject({
      result: { deleteLocalError: anyDeleteLocalError },
    });
    expect(pipelineStore.deletePipeline).toHaveBeenCalledTimes(1);
    expect(deletePipelinePluginCollectionPreferences).toHaveBeenCalledTimes(1);
    expect(deletePipelinePluginCollectionPreferences).toHaveBeenCalledWith({
      type: 'stored',
      source: 'user',
      value: 'pipeline-1',
    });
  });

  it('creates a validated pipeline and emits a resource receipt', async () => {
    jest.mocked(pipelineStore.savePipeline).mockReturnValue({
      success: true,
      data: pipeline().info,
    });
    const response = await dispatchAgentResourceAction(
      {
        type: 'pipeline.create',
        rawYaml:
          'name: Build\ndescription: Build the project\nscope: directory\non: dispatch\njobs:\n  build:\n    steps:\n      - uses: builtin/agent-prompt\n        with:\n          prompt: Review the project build.\n',
      },
      runtime,
    );
    expect(response).toMatchObject({ ok: true });
    expect(resultObject(response.result).agentArtifacts).toEqual([
      expect.objectContaining({
        kind: 'pipeline',
        operation: 'pipeline.create',
        localId: 'pipeline-1',
      }),
    ]);
    expect(withPipelineCrudTelemetry).toHaveBeenCalledWith(
      { action: 'create', source: 'user' },
      expect.any(Function),
    );
  });

  describe('agent global pipeline loading', () => {
    const ORG = 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

    it("authorizes a stored pipeline against the run's owner, not the selected context", async () => {
      mockShareContextEnabled = true;
      mockWorkspaceContext = { kind: 'personal' };
      jest
        .mocked(pipelineStore.getPipeline)
        .mockReturnValue({ success: true, data: pipeline() });

      await expect(
        loadAgentGlobalPipelineById('pipeline-1', ORG),
      ).resolves.toMatchObject({ info: { id: 'pipeline-1' } });
      expect(readStoredPipelineContext).toHaveBeenCalledWith('pipeline-1', ORG);
      expect(assertPipelineContext).toHaveBeenCalledWith(
        { owner: { type: 'user', id: 'me', name: null } },
        undefined,
        ORG,
      );
      expect(assertStoredPipelineContext).not.toHaveBeenCalled();
    });

    it("loads a shared pipeline for the run's owner, not the selected context", async () => {
      mockShareContextEnabled = true;
      mockWorkspaceContext = { kind: 'personal' };
      const owner = {
        type: 'organization',
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        name: 'Organization',
      } as const;
      jest
        .mocked(pipelineCloud.getSharedPipelineForExecutionContext)
        .mockResolvedValue({ ...sharedPipeline(), owner });

      await expect(
        loadAgentGlobalPipelineById('shared:canopy-cloud:shared-pipeline', ORG),
      ).resolves.toMatchObject({ info: { source: 'shared' } });
      expect(
        pipelineCloud.getSharedPipelineForExecutionContext,
      ).toHaveBeenCalledWith('shared-pipeline');
      expect(pipelineCloud.getSharedPipeline).not.toHaveBeenCalled();
      expect(assertPipelineContext).toHaveBeenCalledWith(
        { owner },
        undefined,
        ORG,
      );
    });

    it("refuses a stored pipeline outside the run's owner", async () => {
      mockShareContextEnabled = true;
      jest
        .mocked(pipelineStore.getPipeline)
        .mockReturnValue({ success: true, data: pipeline() });
      jest
        .mocked(assertPipelineContext)
        .mockRejectedValueOnce(
          new Error('Pipeline unavailable (context-mismatch)'),
        );

      await expect(
        loadAgentGlobalPipelineById('pipeline-1', ORG),
      ).rejects.toThrow('context-mismatch');
    });
  });

  describe('pipeline owner and agent marker', () => {
    const CREATE_YAML =
      'name: Build\nscope: global\non: dispatch\njobs:\n  build:\n    steps:\n      - uses: builtin/agent-prompt\n        with:\n          prompt: Review.\n';
    const ORG = 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const anyString: unknown = expect.any(String);
    const AUTHOR = {
      chat: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
      recordedAt: anyString,
    };

    beforeEach(() => {
      mockRecordUserPipelineOwner.mockClear();
      mockSetUserPipelineAgentAuthor.mockClear();
      mockDeleteUserPipelineLocalMetadata.mockClear();
      mockAgentPipelineOwnerContext.mockClear();
      mockGetUserPipelineOwner.mockClear();
      mockValidatePipelineOwnerTargetsOnSave.mockClear();
      mockAgentPipelineOwnerContext.mockResolvedValue({ owner: ORG });
      mockValidatePipelineOwnerTargetsOnSave.mockResolvedValue(null);
    });

    it("records the runtime project's owner and the agent marker on create", async () => {
      jest.mocked(pipelineStore.savePipeline).mockReturnValue({
        success: true,
        data: pipeline().info,
      });

      const response = await dispatchAgentResourceAction(
        { type: 'pipeline.create', rawYaml: CREATE_YAML },
        runtime,
      );

      expect(response).toMatchObject({ ok: true });
      expect(mockAgentPipelineOwnerContext).toHaveBeenCalledWith(runtime);
      expect(mockValidatePipelineOwnerTargetsOnSave).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Build' }),
        ORG,
      );
      expect(mockRecordUserPipelineOwner).toHaveBeenCalledWith(
        'pipeline-1',
        ORG,
      );
      expect(mockSetUserPipelineAgentAuthor).toHaveBeenCalledWith(
        'pipeline-1',
        AUTHOR,
      );
    });

    it('refuses a create whose literal target another owner holds', async () => {
      mockValidatePipelineOwnerTargetsOnSave.mockResolvedValue(
        "Project `other` isn't available to this pipeline",
      );

      const response = await dispatchAgentResourceAction(
        { type: 'pipeline.create', rawYaml: CREATE_YAML },
        runtime,
      );

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'validation_failed',
          message: "Project `other` isn't available to this pipeline",
        },
      });
      expect(pipelineStore.savePipeline).not.toHaveBeenCalled();
      expect(mockSetUserPipelineAgentAuthor).not.toHaveBeenCalled();
    });

    it('refuses an agent send-agent-message step that changes an existing chat', async () => {
      const yaml = (chatLine: string): string =>
        `name: Build\nscope: global\non: dispatch\njobs:\n  build:\n    steps:\n      - uses: builtin/send-agent-message\n        with:\n          project_id: p\n          task_id: t\n${chatLine}          text: Report\n          model: opus\n`;
      jest.mocked(pipelineStore.savePipeline).mockReturnValue({
        success: true,
        data: pipeline().info,
      });

      const refused = await dispatchAgentResourceAction(
        { type: 'pipeline.create', rawYaml: yaml('          chat_id: c\n') },
        runtime,
      );
      expect(refused).toMatchObject({
        ok: false,
        error: {
          code: 'validation_failed',
          message:
            "Agent-authored pipelines cannot change an existing chat's model, plan mode, approval mode, or plugins.",
        },
      });
      expect(pipelineStore.savePipeline).not.toHaveBeenCalled();

      // Without a chat the model seeds a new chat, which the agent may choose.
      const allowed = await dispatchAgentResourceAction(
        { type: 'pipeline.create', rawYaml: yaml('') },
        runtime,
      );
      expect(allowed).toMatchObject({ ok: true });
      expect(pipelineStore.savePipeline).toHaveBeenCalledTimes(1);
    });

    it("refuses a create when the project's owner can't be read", async () => {
      mockAgentPipelineOwnerContext.mockResolvedValue({
        refusal: 'Owner unknown',
      });

      const response = await dispatchAgentResourceAction(
        { type: 'pipeline.create', rawYaml: CREATE_YAML },
        runtime,
      );

      expect(response).toMatchObject({
        ok: false,
        error: { code: 'validation_failed', message: 'Owner unknown' },
      });
      expect(pipelineStore.savePipeline).not.toHaveBeenCalled();
    });

    it('keeps the stored owner and sets the marker on update', async () => {
      mockGetUserPipelineOwner.mockResolvedValue(ORG);
      jest.mocked(pipelineStore.getPipeline).mockReturnValue({
        success: true,
        data: pipeline(),
      });
      jest.mocked(pipelineStore.updatePipeline).mockReturnValue({
        success: true,
        data: pipeline().info,
      });

      const response = await dispatchAgentResourceAction(
        { type: 'pipeline.update', pipelineId: 'pipeline-1', name: 'Renamed' },
        runtime,
      );

      expect(response).toMatchObject({ ok: true });
      expect(mockGetUserPipelineOwner).toHaveBeenCalledWith('pipeline-1');
      expect(mockValidatePipelineOwnerTargetsOnSave).toHaveBeenCalledWith(
        expect.anything(),
        ORG,
      );
      expect(mockRecordUserPipelineOwner).not.toHaveBeenCalled();
      expect(mockSetUserPipelineAgentAuthor).toHaveBeenCalledWith(
        'pipeline-1',
        AUTHOR,
      );
    });

    it('removes local metadata on delete', async () => {
      jest.mocked(pipelineStore.getPipeline).mockReturnValue({
        success: true,
        data: pipeline(),
      });
      jest.mocked(pipelineStore.deletePipeline).mockReturnValue({
        success: true,
      });

      const response = await dispatchAgentResourceAction(
        { type: 'pipeline.delete', pipelineId: 'pipeline-1' },
        runtime,
      );
      expect(response).toMatchObject({ ok: true });
      expect(mockDeleteUserPipelineLocalMetadata).toHaveBeenCalledWith(
        'pipeline-1',
      );
    });
  });

  it('rejects explicitly empty pipeline YAML updates', async () => {
    const response = await dispatchAgentResourceAction(
      {
        type: 'pipeline.update',
        pipelineId: 'pipeline-1',
        rawYaml: '',
      },
      runtime,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(pipelineStore.updatePipeline).not.toHaveBeenCalled();
  });

  it.each(['pipeline.create', 'pipeline.update'] as const)(
    'rejects shell run steps from %s',
    async (type) => {
      const response = await dispatchAgentResourceAction(
        type === 'pipeline.create'
          ? {
              type,
              rawYaml:
                'name: Unsafe\nscope: directory\non: dispatch\njobs:\n  build:\n    steps:\n      - run: printenv\n',
            }
          : {
              type,
              pipelineId: 'pipeline-1',
              rawYaml:
                'name: Unsafe\nscope: directory\non: dispatch\njobs:\n  build:\n    steps:\n      - run: printenv\n',
            },
        runtime,
      );

      expect(response).toMatchObject({
        ok: false,
        error: { code: 'validation_failed' },
      });
      expect(response.error?.message).toContain(
        'cannot include shell run steps',
      );
      expect(pipelineStore.savePipeline).not.toHaveBeenCalled();
      expect(pipelineStore.updatePipeline).not.toHaveBeenCalled();
    },
  );

  it('rejects shell run steps from pipeline.duplicate', async () => {
    const response = await dispatchAgentResourceAction(
      { type: 'pipeline.duplicate', pipelineId: 'pipeline-1' },
      runtime,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(response.error?.message).toContain('cannot include shell run steps');
    expect(pipelineStore.savePipeline).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'authorizes agent project duplication before Personal export (org=%s)',
    async (organization): Promise<void> => {
      mockShareContextEnabled = true;
      const project = {
        ...pipeline().info,
        id: 'project--child.yaml',
        source: 'project' as const,
        filePath: '/repo/child.yaml',
      };
      jest
        .mocked(pipelineStore.getPipeline)
        .mockReturnValue({ success: false });
      jest.mocked(discoverProjectPipelines).mockResolvedValue([project]);
      jest.mocked(loadProjectPipelineFromDisk).mockResolvedValue({
        name: 'Child',
        on: 'dispatch',
        jobs: {
          build: {
            steps: [
              { uses: 'builtin/agent-prompt', with: { prompt: 'Build.' } },
            ],
          },
        },
      });
      jest.mocked(pipelineStore.savePipeline).mockImplementation((input) => ({
        success: true,
        data: { ...pipeline().info, id: input.id ?? 'copy' },
      }));
      jest.mocked(authorizeProjectPipelineRequest).mockResolvedValue({
        projectId: runtime.projectId,
        owner: {
          type: organization ? 'organization' : 'user',
          id: organization ? 'org-a' : 'local',
          name: null,
        },
      });
      const result = await dispatchAgentResourceAction(
        { type: 'pipeline.duplicate', pipelineId: project.id },
        runtime,
      );
      expect(result.ok).toBe(!organization);
      expect(authorizeProjectPipelineRequest).toHaveBeenCalled();
      expect(copyPipelineInstallOrigin).not.toHaveBeenCalled();
      if (organization)
        expect(pipelineStore.savePipeline).not.toHaveBeenCalled();
    },
  );

  it('rejects sharing project pipelines with shell run steps', async () => {
    const projectPipeline = {
      ...pipeline().info,
      id: 'project--unsafe.yaml',
      filename: 'unsafe.yaml',
      source: 'project' as const,
      readonly: true,
      filePath: '/repo/.canopy/pipelines/unsafe.yaml',
    };
    jest.mocked(pipelineStore.getPipeline).mockReturnValue({
      success: false,
      error: 'not found',
    });
    jest.mocked(discoverProjectPipelines).mockResolvedValue([projectPipeline]);
    jest
      .mocked(loadProjectPipelineFromDisk)
      .mockResolvedValue(pipeline().content);

    const response = await dispatchAgentResourceAction(
      {
        type: 'pipeline.share',
        pipelineId: projectPipeline.id,
        shareScope: 'organization',
        organizationId: 'org-selected',
      },
      runtime,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(response.error?.message).toContain('cannot include shell run steps');
    expect(pipelineCloud.createSharedPipeline).not.toHaveBeenCalled();
  });

  it('rejects shell run steps from pipeline.update_shared YAML', async () => {
    jest
      .mocked(pipelineCloud.getSharedPipeline)
      .mockResolvedValue(sharedPipeline());

    const response = await dispatchAgentResourceAction(
      {
        type: 'pipeline.update_shared',
        remoteId: 'shared-pipeline',
        rawYaml:
          'name: Unsafe\nscope: directory\non: dispatch\njobs:\n  build:\n    steps:\n      - run: printenv\n',
      },
      runtime,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(response.error?.message).toContain('cannot include shell run steps');
    expect(pipelineCloud.updateSharedPipeline).not.toHaveBeenCalled();
    expect(updateSharedPipelinePreservingPackage).not.toHaveBeenCalled();
  });

  it('reports package review refusals as readable validation failures', async () => {
    jest
      .mocked(pipelineCloud.getSharedPipeline)
      .mockResolvedValue(sharedPipeline());
    jest
      .mocked(updateSharedPipelinePreservingPackage)
      .mockRejectedValue(new Error(SHARED_PACKAGE_REVIEW_REQUIRED_MESSAGE));

    const response = await dispatchAgentResourceAction(
      {
        type: 'pipeline.update_shared',
        remoteId: 'shared-pipeline',
      },
      runtime,
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'validation_failed',
        message: SHARED_PACKAGE_REVIEW_REQUIRED_MESSAGE,
      },
    });
  });

  it('preserves the selected repository in project pipeline receipts', async () => {
    const projectPipeline = {
      ...pipeline().info,
      id: 'project--child.yaml',
      filename: 'child.yaml',
      source: 'project' as const,
      readonly: true,
      filePath: '/workspace/child/.canopy/pipelines/child.yaml',
    };
    jest.mocked(pipelineStore.getPipeline).mockReturnValue({
      success: false,
      error: 'not found',
    });
    jest.mocked(discoverProjectPipelines).mockResolvedValue([projectPipeline]);
    jest
      .mocked(loadProjectPipelineFromDisk)
      .mockResolvedValue(pipeline().content);

    const response = await dispatchAgentResourceAction(
      {
        type: 'pipeline.set_enabled',
        pipelineId: projectPipeline.id,
        enabled: true,
      },
      {
        ...runtime,
        cwd: '/workspace/child',
        repoId: 'child-repo',
      },
    );

    expect(discoverProjectPipelines).toHaveBeenCalledWith('/workspace/child');
    expect(resultObject(response.result).agentArtifacts).toEqual([
      expect.objectContaining({
        navigationTarget: {
          kind: 'pipeline_editor',
          pipelineId: projectPipeline.id,
          source: 'project',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          repoId: 'child-repo',
        },
      }),
    ]);
  });

  it('rejects pipeline files outside the scoped project', async () => {
    const response = await dispatchAgentResourceAction(
      {
        type: 'pipeline.create',
        yamlFilePath: '../outside.yaml',
      },
      runtime,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(pipelineStore.savePipeline).not.toHaveBeenCalled();
  });

  it('rejects pipeline file symlinks that escape the scoped project', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'canopy-workspace-'));
    const external = await mkdtemp(join(tmpdir(), 'canopy-external-'));
    const externalPipeline = join(external, 'outside.yaml');
    const workspaceLink = join(workspace, 'linked.yaml');
    await writeFile(
      externalPipeline,
      'name: External\nscope: directory\non: dispatch\njobs: {}\n',
    );
    await symlink(externalPipeline, workspaceLink);

    try {
      const response = await dispatchAgentResourceAction(
        { type: 'pipeline.create', yamlFilePath: 'linked.yaml' },
        { ...runtime, cwd: workspace },
      );

      expect(response).toMatchObject({
        ok: false,
        error: { code: 'validation_failed' },
      });
      expect(pipelineStore.savePipeline).not.toHaveBeenCalled();
    } finally {
      await Promise.all([
        rm(workspace, { recursive: true, force: true }),
        rm(external, { recursive: true, force: true }),
      ]);
    }
  }, 15_000);

  it('does not reshare a shared pipeline cache entry', async () => {
    jest
      .mocked(pipelineCloud.getSharedPipeline)
      .mockResolvedValue(sharedPipeline());

    const response = await dispatchAgentResourceAction(
      {
        type: 'pipeline.share',
        pipelineId: 'shared:canopy-cloud:shared-pipeline',
        shareScope: 'organization',
        organizationId: 'org-selected',
      },
      runtime,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(pipelineCloud.createSharedPipeline).not.toHaveBeenCalled();
  });

  it('resolves a curated identity through managed storage and rejects local mutation', async () => {
    const data = pipeline('bundled');
    data.info = {
      ...data.info,
      id: 'curated:reviewed',
      source: 'curated',
      readonly: true,
    };
    jest
      .mocked(curatedCatalog.getManagedCuratedPipeline)
      .mockResolvedValue(data);
    expect(await loadAgentPipelineById(data.info.id, runtime)).toEqual(data);
    expect(pipelineStore.getPipeline).not.toHaveBeenCalled();
    expect(
      await dispatchAgentResourceAction(
        { type: 'pipeline.update', pipelineId: data.info.id, name: 'Changed' },
        runtime,
      ),
    ).toMatchObject({ ok: false, error: { code: 'read_only_source' } });
    expect(pipelineStore.updatePipeline).not.toHaveBeenCalled();
  });

  it.each(['shared', 'stored'])(
    'binds Advisor %s pipeline reads to the agent project',
    async (source): Promise<void> => {
      mockShareContextEnabled = true;
      jest.mocked(pipelineCloud.getSharedPipeline).mockResolvedValue({
        ...sharedPipeline(),
        owner: { type: 'organization', id: 'org-a', name: 'Organization' },
      });
      const check =
        source === 'shared'
          ? jest.mocked(assertPipelineContext)
          : jest.mocked(assertStoredPipelineContext);
      check.mockImplementation(
        (_resource, projectId): Promise<void> =>
          projectId === 'personal'
            ? Promise.reject(
                new Error('Workflow unavailable (context-mismatch)'),
              )
            : Promise.resolve(),
      );
      try {
        await expect(
          loadAgentPipelineById(
            source === 'shared'
              ? 'shared:canopy-cloud:shared-pipeline'
              : 'pipeline-1',
            { ...runtime, projectId: 'personal' },
          ),
        ).rejects.toThrow('Workflow unavailable (context-mismatch)');
      } finally {
        check.mockResolvedValue();
      }
    },
  );

  it('uses brand-derived display metadata for shared pipelines', async () => {
    jest
      .mocked(pipelineCloud.getSharedPipeline)
      .mockResolvedValue(sharedPipeline());

    const response = await loadAgentPipelineById(
      'shared:canopy-cloud:shared-pipeline',
      runtime,
    );

    expect(response).toMatchObject({
      info: {
        serverName: CANOPY_CLOUD_DISPLAY_NAME,
      },
    });
  });

  it.each([
    ['pipeline.update_shared', 'pipeline-1'],
    ['pipeline.update_shared', 'shared:other-server:shared-pipeline'],
    ['pipeline.update_shared', 'shared:canopy-cloud:'],
    ['pipeline.delete_shared', 'pipeline-1'],
    ['pipeline.delete_shared', 'shared:other-server:shared-pipeline'],
    ['pipeline.delete_shared', 'shared:canopy-cloud:'],
  ] as const)(
    'rejects %s with a non-current shared pipeline id',
    async (type, pipelineId) => {
      const response = await dispatchAgentResourceAction(
        { type, pipelineId },
        runtime,
      );

      expect(response).toMatchObject({
        ok: false,
        error: { code: 'validation_failed' },
      });
      expect(pipelineCloud.getSharedPipeline).not.toHaveBeenCalled();
      expect(pipelineCloud.updateSharedPipeline).not.toHaveBeenCalled();
      expect(updateSharedPipelinePreservingPackage).not.toHaveBeenCalled();
      expect(pipelineCloud.deleteSharedPipeline).not.toHaveBeenCalled();
    },
  );

  it('accepts an explicit raw remote id for shared pipeline mutations', async () => {
    jest
      .mocked(pipelineCloud.getSharedPipeline)
      .mockResolvedValue(sharedPipeline());
    jest.mocked(pipelineCloud.deleteSharedPipeline).mockResolvedValue();

    const response = await dispatchAgentResourceAction(
      { type: 'pipeline.delete_shared', remoteId: 'shared-pipeline' },
      runtime,
    );

    expect(response).toMatchObject({ ok: true });
    expect(pipelineCloud.getSharedPipeline).toHaveBeenCalledWith(
      'shared-pipeline',
    );
    expect(pipelineCloud.deleteSharedPipeline).toHaveBeenCalledWith(
      'shared-pipeline',
    );
  });

  it.each(['pipeline.update_shared', 'pipeline.delete_shared'] as const)(
    'rejects conflicting identifiers for %s',
    async (type) => {
      const response = await dispatchAgentResourceAction(
        {
          type,
          pipelineId: 'shared:canopy-cloud:shared-pipeline',
          remoteId: 'different-pipeline',
        },
        runtime,
      );

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'validation_failed',
          message:
            'remoteId and pipelineId must identify the same shared pipeline.',
        },
      });
      expect(pipelineCloud.getSharedPipeline).not.toHaveBeenCalled();
      expect(pipelineCloud.updateSharedPipeline).not.toHaveBeenCalled();
      expect(updateSharedPipelinePreservingPackage).not.toHaveBeenCalled();
      expect(pipelineCloud.deleteSharedPipeline).not.toHaveBeenCalled();
    },
  );

  it('adds a calm approval note to non-interactive shared pipeline updates', async () => {
    jest
      .mocked(pipelineCloud.getSharedPipeline)
      .mockResolvedValue(sharedPipeline());
    jest
      .mocked(updateSharedPipelinePreservingPackage)
      .mockResolvedValue(sharedPipeline());
    mockGetSharedPipelineSaveImpact.mockResolvedValue({
      automations: [
        { id: 'automation-1', name: 'Daily review', kind: 'installed' },
      ],
    });

    const response = await dispatchAgentResourceAction(
      { type: 'pipeline.update_shared', remoteId: 'shared-pipeline' },
      runtime,
    );

    expect(response).toMatchObject({
      ok: true,
      result: {
        message:
          'People using this pipeline in their automations will need to approve your changes before they run again.',
      },
    });
  });

  it.each(['pipeline.update_shared', 'pipeline.delete_shared'] as const)(
    'accepts agreeing identifiers for %s',
    async (type) => {
      jest
        .mocked(pipelineCloud.getSharedPipeline)
        .mockResolvedValue(sharedPipeline());
      jest
        .mocked(pipelineCloud.updateSharedPipeline)
        .mockResolvedValue(sharedPipeline());
      jest
        .mocked(updateSharedPipelinePreservingPackage)
        .mockResolvedValue(sharedPipeline());
      jest.mocked(pipelineCloud.deleteSharedPipeline).mockResolvedValue();

      const response = await dispatchAgentResourceAction(
        {
          type,
          pipelineId: 'shared:canopy-cloud:shared-pipeline',
          remoteId: 'shared-pipeline',
        },
        runtime,
      );

      expect(response).toMatchObject({ ok: true });
      expect(pipelineCloud.getSharedPipeline).toHaveBeenCalledTimes(1);
      expect(pipelineCloud.getSharedPipeline).toHaveBeenCalledWith(
        'shared-pipeline',
      );
      if (type === 'pipeline.update_shared') {
        expect(updateSharedPipelinePreservingPackage).toHaveBeenCalledWith(
          'shared-pipeline',
          expect.any(String),
          expect.objectContaining({ id: 'shared-pipeline' }),
        );
        expect(pipelineCloud.updateSharedPipeline).not.toHaveBeenCalled();
      } else {
        expect(pipelineCloud.deleteSharedPipeline).toHaveBeenCalledWith(
          'shared-pipeline',
        );
      }
    },
  );

  it('creates and updates agent automations through the conversion save (CAN-4551 7c)', async () => {
    const created = activity({
      type: 'standalone_prompt',
      chatProjectId: runtime.projectId,
      prompt: 'Organize notes',
    });
    // Agents can't edit an automation with an If Command gate.
    delete created.ifCommand;
    automationService.create.mockResolvedValue({ ok: true, activity: created });
    automationService.update.mockResolvedValue({ ok: true, activity: created });
    mockListAutomations.mockResolvedValue({
      activities: [created],
      recentRuns: [],
    });
    const input = {
      name: created.name,
      schedule: created.schedule,
      action: created.action,
    };
    await dispatchAgentResourceAction(
      { type: 'automation.create', input },
      runtime,
    );
    await dispatchAgentResourceAction(
      {
        type: 'automation.update',
        id: created.id,
        patch: { name: 'Renamed' },
      },
      runtime,
    );
    const agentAuthor: unknown = expect.objectContaining({
      chat: {
        projectId: runtime.projectId,
        worktreeId: runtime.worktreeId,
        chatId: runtime.chatId,
      },
    });
    expect(mockCreateAutomationForAgent).toHaveBeenCalledWith(
      input,
      expect.objectContaining({ agentAuthor }),
      automationService,
    );
    expect(mockUpdateAutomationForAgent).toHaveBeenCalledWith(
      { id: created.id, name: 'Renamed' },
      expect.objectContaining({ agentAuthor }),
      automationService,
    );
  });

  it('forwards headless declarations to the canonical writer and surfaces its refusal', async () => {
    const input = {
      name: 'Restricted pipeline',
      enabled: false,
      schedule: {
        kind: 'cron' as const,
        expression: '0 9 * * *',
        timezone: 'local' as const,
      },
      action: {
        type: 'worktree_pipeline' as const,
        workspaceId: 'workspace-1',
        pipelineId: 'review',
        pipelineSource: 'user' as const,
      },
      targetRequirement: { contexts: ['cowork' as const] },
    };
    automationService.create.mockResolvedValue({
      ok: false,
      error: 'Choose a Chats project in the automation editor.',
    });
    const response = await dispatchAgentResourceAction(
      { type: 'automation.create', input },
      runtime,
    );
    const anyGuard: unknown = expect.any(Function);
    const anyString: unknown = expect.any(String);
    expect(automationService.create).toHaveBeenCalledWith(input, {
      authorize: anyGuard,
      agentAuthor: {
        chat: {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        },
        recordedAt: anyString,
      },
    });
    expect(response).toMatchObject({
      ok: false,
      error: { message: 'Choose a Chats project in the automation editor.' },
    });
  });

  it('lists automations globally and blocks generic session-prompt creation', async () => {
    const ownedActivity = activity({
      type: 'worktree_prompt',
      workspaceId: runtime.projectId,
      prompt: 'Review changes',
    });
    const otherOwnerActivity = {
      ...ownedActivity,
      id: 'activity-other-owner',
      action: {
        type: 'worktree_prompt' as const,
        workspaceId: 'other-project',
        prompt: 'Review another project',
      },
    };
    const unknownOwnerActivity = {
      ...ownedActivity,
      id: 'activity-unknown-owner',
      action: {
        type: 'worktree_prompt' as const,
        workspaceId: 'unknown-project',
        prompt: 'Review a project with an unknown owner',
      },
    };
    const ownedRun: ScheduledActivityRun = {
      id: 'run-owned',
      activityId: ownedActivity.id,
      activityName: ownedActivity.name,
      scheduledFor: '2026-08-05T13:00:00.000Z',
      manual: false,
      status: 'success',
      startedAt: '2026-08-05T13:00:00.000Z',
      completedAt: '2026-08-05T13:00:01.000Z',
    };
    const otherOwnerRun = {
      ...ownedRun,
      id: 'run-other-owner',
      activityId: otherOwnerActivity.id,
      activityName: otherOwnerActivity.name,
    };
    const unknownOwnerRun = {
      ...ownedRun,
      id: 'run-unknown-owner',
      activityId: unknownOwnerActivity.id,
      activityName: unknownOwnerActivity.name,
    };
    automationService.list.mockResolvedValue({
      activities: [ownedActivity, otherOwnerActivity, unknownOwnerActivity],
      recentRuns: [ownedRun, otherOwnerRun, unknownOwnerRun],
    });
    mockResolveAutomationTargetOwner.mockImplementation((target) =>
      Promise.resolve(
        target.projectId === 'other-project'
          ? { kind: 'organization', organizationId: 'org-other' }
          : target.projectId === 'unknown-project'
            ? { kind: 'unknown' }
            : { kind: 'personal' },
      ),
    );
    const listed = await dispatchAgentResourceAction(
      { type: 'automation.list', includeRuns: true },
      runtime,
    );
    expect(resultObject(listed.result).activities).toEqual([ownedActivity]);
    expect(resultObject(listed.result).recentRuns).toEqual([ownedRun]);
    expect(automationService.listForContext).toHaveBeenCalledWith({
      kind: 'personal',
    });
    expect(mockScopeAutomations).not.toHaveBeenCalled();

    const blocked = await dispatchAgentResourceAction(
      {
        type: 'automation.create',
        input: {
          name: 'Continue',
          schedule: {
            kind: 'one_time',
            runAt: '2026-08-05T00:00:00.000Z',
            timezone: 'local',
          },
          action: {
            type: 'worktree_session_prompt',
            workspaceId: runtime.projectId,
            worktreeId: 'other-worktree',
            chatId: 'other-chat',
            prompt: 'Continue',
          },
        },
      },
      runtime,
    );
    expect(blocked).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(automationService.create).not.toHaveBeenCalled();
  });

  it("owns an agent's global pipeline automation by the caller project's owner", async () => {
    mockResolveProjectSavedOwner.mockResolvedValue({
      kind: 'organization',
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    mockAgentPipelineOwnerContext.mockResolvedValueOnce({
      owner: 'org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    automationService.create.mockResolvedValue({ ok: false, error: 'stop' });
    const input = {
      name: 'Digest',
      schedule: {
        kind: 'cron' as const,
        expression: '0 9 * * 1',
        timezone: 'local' as const,
      },
      action: {
        type: 'worktree_pipeline' as const,
        target: { kind: 'global' as const },
        pipelineId: 'digest',
        pipelineSource: 'user' as const,
      },
    };
    await dispatchAgentResourceAction(
      { type: 'automation.create', input },
      runtime,
    );
    expect(mockAgentPipelineOwnerContext).toHaveBeenCalledWith(runtime);
    expect(automationService.create).toHaveBeenCalledWith(
      input,
      expect.objectContaining({
        owner: 'org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    );
  });

  it('refuses a global pipeline automation whose owner is not the caller project owner', async () => {
    // The caller's owner changed after the pipeline owner was resolved.
    mockAgentPipelineOwnerContext.mockResolvedValueOnce({
      owner: 'org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    const response = await dispatchAgentResourceAction(
      {
        type: 'automation.create',
        input: {
          name: 'Digest',
          schedule: {
            kind: 'cron',
            expression: '0 9 * * 1',
            timezone: 'local',
          },
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'global' },
            pipelineId: 'digest',
            pipelineSource: 'user',
          },
        },
      },
      runtime,
    );
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(automationService.create).not.toHaveBeenCalled();
  });

  it("shows a project agent only the global pipeline automations of its project's owner", async () => {
    const globalAction: ScheduledActivity['action'] = {
      type: 'worktree_pipeline',
      target: { kind: 'global' },
      pipelineId: 'digest',
      pipelineSource: 'user',
    };
    const owned = {
      ...activity(globalAction),
      id: 'global-owned',
      executionContext: 'personal',
    };
    const otherOwner = {
      ...activity(globalAction),
      id: 'global-other-owner',
      executionContext: 'org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };
    automationService.list.mockResolvedValue({
      activities: [owned, otherOwner],
      recentRuns: [],
    });
    const listed = await dispatchAgentResourceAction(
      { type: 'automation.list', includeRuns: false },
      runtime,
    );
    expect(resultObject(listed.result).activities).toEqual([owned]);
    const hidden = await dispatchAgentResourceAction(
      { type: 'automation.run_now', id: otherOwner.id },
      runtime,
    );
    expect(hidden).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(automationService.runNow).not.toHaveBeenCalled();
  });

  it('refuses a global pipeline automation when the caller project owner is unknown', async () => {
    mockAgentPipelineOwnerContext.mockResolvedValueOnce({
      refusal: 'Owner unknown.',
    });
    const response = await dispatchAgentResourceAction(
      {
        type: 'automation.create',
        input: {
          name: 'Digest',
          schedule: {
            kind: 'cron',
            expression: '0 9 * * 1',
            timezone: 'local',
          },
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'global' },
            pipelineId: 'digest',
            pipelineSource: 'user',
          },
        },
      },
      runtime,
    );
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'validation_failed', message: 'Owner unknown.' },
    });
    expect(automationService.create).not.toHaveBeenCalled();
  });

  it('refuses an agent automation that names its own owner', async () => {
    const response = await dispatchAgentResourceAction(
      {
        type: 'automation.create',
        input: {
          name: 'Nightly',
          schedule: {
            kind: 'one_time',
            runAt: '2026-08-05T00:00:00.000Z',
            timezone: 'local',
          },
          action: {
            type: 'worktree_pipeline',
            workspaceId: 'workspace-1',
            pipelineId: 'review',
            pipelineSource: 'user',
          },
          executionContext: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        },
      },
      runtime,
    );
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(automationService.create).not.toHaveBeenCalled();
  });

  it('evaluates automation interface feature flags at the main boundary', async () => {
    mockIsClaudeTuiChatsEnabled.mockReturnValue(false);

    const response = await dispatchAgentResourceAction(
      {
        type: 'automation.create',
        input: {
          name: 'Terminal review',
          schedule: {
            kind: 'one_time',
            runAt: '2026-08-05T00:00:00.000Z',
            timezone: 'local',
          },
          action: {
            type: 'worktree_prompt',
            workspaceId: 'workspace-1',
            prompt: 'Review changes',
            interfaceMode: 'auto',
          },
        },
      },
      runtime,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(automationService.create).not.toHaveBeenCalled();
  });

  it.each(['running', 'failure', 'skipped'] as const)(
    'emits a run receipt for a returned %s run without an activity envelope',
    async (status) => {
      const saved = { ...activity(), ifCommand: undefined };
      automationService.list.mockResolvedValue({
        activities: [saved],
        recentRuns: [],
      });
      automationService.runNow.mockResolvedValue({
        ok: true,
        run: {
          id: 'run-1',
          activityId: saved.id,
          activityName: saved.name,
          status,
          scheduledFor: saved.createdAt,
          startedAt: saved.createdAt,
          manual: true,
          error: 'private raw error',
        },
      });
      const response = await dispatchAgentResourceAction(
        { type: 'automation.run_now', id: saved.id },
        runtime,
      );
      expect(resultObject(response.result).agentArtifacts).toEqual([
        expect.objectContaining({
          kind: 'automation_run',
          runId: 'run-1',
          status,
          navigationTarget: {
            kind: 'automation_editor',
            activityId: saved.id,
            section: 'runs',
            runId: 'run-1',
          },
        }),
      ]);
      expect(
        JSON.stringify(resultObject(response.result).agentArtifacts),
      ).not.toContain('private raw error');
    },
  );

  it('summarizes effective automation changes without identifiers or no-op fields', async () => {
    const before = { ...activity(), ifCommand: undefined };
    automationService.list.mockResolvedValue({
      activities: [before],
      recentRuns: [],
    });
    automationService.update.mockResolvedValue({
      ok: true,
      activity: {
        ...before,
        name: 'Updated',
        updatedAt: '2026-08-05T00:00:00.000Z',
      },
    });
    const response = await dispatchAgentResourceAction(
      {
        type: 'automation.update',
        id: before.id,
        patch: { name: 'Updated', enabled: before.enabled },
      },
      runtime,
    );
    expect(resultObject(response.result).agentArtifacts).toEqual([
      expect.objectContaining({ kind: 'automation', changedFields: ['name'] }),
    ]);
    automationService.update.mockResolvedValue({ ok: true, activity: before });
    const noop = await dispatchAgentResourceAction(
      {
        type: 'automation.update',
        id: before.id,
        patch: { enabled: before.enabled },
      },
      runtime,
    );
    expect(
      JSON.stringify(resultObject(noop.result).agentArtifacts),
    ).not.toContain('"changedFields"');
  });

  it.each([true, false])(
    'requires pipeline execution ownership for a co-receipt (owned=%s)',
    async (owned) => {
      const saved = {
        ...activity(),
        ifCommand: undefined,
        action: {
          type: 'worktree_pipeline',
          workspaceId: 'project-1',
          pipelineId: 'pipeline-1',
        } satisfies ScheduledActivity['action'],
      };
      automationService.list.mockResolvedValue({
        activities: [saved],
        recentRuns: [],
      });
      automationService.runNow.mockResolvedValue({
        ok: true,
        run: {
          id: 'run-1',
          activityId: saved.id,
          activityName: saved.name,
          status: 'success',
          scheduledFor: saved.createdAt,
          startedAt: saved.createdAt,
          manual: true,
          result: {
            pipelineExecutionId: 'execution-1',
            ...(owned
              ? { projectId: 'project-1', worktreeId: 'worktree-1' }
              : {}),
          },
        },
      });
      const response = await dispatchAgentResourceAction(
        { type: 'automation.run_now', id: saved.id },
        runtime,
      );
      const receipts = resultObject(response.result).agentArtifacts;
      expect(receipts).toEqual(
        owned
          ? [
              expect.objectContaining({
                kind: 'automation_run',
                status: 'success',
              }),
              expect.objectContaining({
                kind: 'pipeline_run',
                initialStatus: 'pending',
              }),
            ]
          : [expect.objectContaining({ kind: 'automation_run' })],
      );
    },
  );

  it('emits no new receipt for rejected invocations or deletes', async () => {
    const saved = { ...activity(), ifCommand: undefined };
    automationService.list.mockResolvedValue({
      activities: [saved],
      recentRuns: [],
    });
    automationService.runNow.mockResolvedValue({
      ok: false,
      error: 'Failed to dispatch',
    });
    const failed = await dispatchAgentResourceAction(
      { type: 'automation.run_now', id: saved.id },
      runtime,
    );
    expect(failed.ok).toBe(false);
    expect(failed.result).toBeUndefined();
    automationService.delete.mockResolvedValue({ ok: true, activity: saved });
    const removed = await dispatchAgentResourceAction(
      { type: 'automation.delete', id: saved.id },
      runtime,
    );
    expect(resultObject(removed.result)).not.toHaveProperty('agentArtifacts');
  });

  it('blocks agent automation commands on create, update, and run now', async () => {
    const create = await dispatchAgentResourceAction(
      {
        type: 'automation.create',
        input: {
          name: 'Unsafe gate',
          schedule: {
            kind: 'one_time',
            runAt: '2026-08-05T00:00:00.000Z',
            timezone: 'local',
          },
          action: { type: 'app_advisor_prompt', prompt: 'Continue' },
          ifCommand: 'touch /tmp/agent-command',
        },
      },
      runtime,
    );
    const update = await dispatchAgentResourceAction(
      {
        type: 'automation.update',
        id: 'activity-1',
        patch: { ifCommand: 'touch /tmp/agent-command' },
      },
      runtime,
    );
    const runNow = await dispatchAgentResourceAction(
      { type: 'automation.run_now', id: 'activity-1' },
      runtime,
    );

    for (const response of [create, update, runNow]) {
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'validation_failed' },
      });
    }
    expect(automationService.create).not.toHaveBeenCalled();
    expect(automationService.update).not.toHaveBeenCalled();
    expect(automationService.runNow).not.toHaveBeenCalled();
  });

  it('blocks lifecycle updates that preserve an existing If Command', async () => {
    const updateAction: Parameters<typeof dispatchAgentResourceAction>[0] = {
      type: 'automation.update',
      id: 'activity-1',
      patch: {
        schedule: {
          kind: 'cron',
          expression: '0 * * * *',
          timezone: 'local',
        },
      },
    };
    // Keep this intentionally malformed runtime input: the current public
    // action type no longer includes the legacy interval trigger.
    Reflect.set(updateAction.patch, 'schedule', {
      kind: 'interval',
      every: 1,
      unit: 'hours',
    });
    const response = await dispatchAgentResourceAction(updateAction, runtime);

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(automationService.update).not.toHaveBeenCalled();
  });

  it('blocks pipeline-resume automation creation, retargeting, and immediate runs', async () => {
    const create = await dispatchAgentResourceAction(
      {
        type: 'automation.create',
        input: {
          name: 'Resume release',
          schedule: {
            kind: 'one_time',
            runAt: '2026-08-05T00:00:00.000Z',
            timezone: 'local',
          },
          action: resumeAction(),
        },
      },
      runtime,
    );
    automationService.list
      .mockResolvedValueOnce({ activities: [activity()], recentRuns: [] })
      .mockResolvedValueOnce({
        activities: [{ ...activity(resumeAction()), ifCommand: undefined }],
        recentRuns: [],
      });
    const update = await dispatchAgentResourceAction(
      {
        type: 'automation.update',
        id: 'activity-1',
        patch: { action: resumeAction() },
      },
      runtime,
    );
    const runNow = await dispatchAgentResourceAction(
      { type: 'automation.run_now', id: 'activity-1' },
      runtime,
    );

    for (const response of [create, update, runNow]) {
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'validation_failed' },
      });
      expect(response.error?.message).toContain('Pipeline resume activities');
    }
    expect(automationService.create).not.toHaveBeenCalled();
    expect(automationService.update).not.toHaveBeenCalled();
    expect(automationService.runNow).not.toHaveBeenCalled();
  });

  it('blocks lifecycle updates to persisted pipeline-resume activities', async () => {
    automationService.list.mockResolvedValue({
      activities: [{ ...activity(resumeAction()), ifCommand: undefined }],
      recentRuns: [],
    });

    const response = await dispatchAgentResourceAction(
      {
        type: 'automation.update',
        id: 'activity-1',
        patch: { enabled: true },
      },
      runtime,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(automationService.update).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'blocks attributed schedule action edits at initial and fresh authorization (fresh=%s)',
    async (fresh) => {
      const sessionAction: ScheduledActivity['action'] = {
        type: 'worktree_session_prompt',
        workspaceId: runtime.projectId,
        worktreeId: 'other-worktree',
        chatId: 'other-chat',
        prompt: 'Original',
        purpose: 'scheduled_send',
      };
      const scheduled: ScheduledActivity = {
        ...activity(sessionAction),
        ifCommand: undefined,
        agentScheduledSend: {
          version: 1,
          agentSent: {
            sender: {
              kind: 'project',
              projectType: 'code',
              projectId: runtime.projectId,
              taskId: runtime.worktreeId,
              chatId: runtime.chatId,
            },
            chatTitle: 'Origin',
            projectLabel: 'Source',
          },
          provenance: {
            version: 1,
            capturedAt: '2026-10-17T00:00:00.000Z',
            acceptedInputId: 'capture',
            sender: {
              kind: 'project',
              projectType: 'code',
              projectId: runtime.projectId,
              taskId: runtime.worktreeId,
              chatId: runtime.chatId,
            },
            owner: { kind: 'personal' },
          },
        },
      };
      automationService.list.mockResolvedValue({
        activities: [
          fresh ? { ...scheduled, agentScheduledSend: undefined } : scheduled,
        ],
        recentRuns: [],
      });
      if (fresh) {
        automationService.update.mockImplementationOnce(
          async (
            _request: unknown,
            authorize: (current: ScheduledActivity) => Promise<boolean>,
          ) => {
            expect(await authorize(scheduled)).toBe(false);
            return { ok: false, error: 'Activity not found.' };
          },
        );
      }
      const response = await dispatchAgentResourceAction(
        {
          type: 'automation.update',
          id: scheduled.id,
          patch: { action: { ...sessionAction, prompt: 'Changed' } },
        },
        runtime,
      );
      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'validation_failed',
          message:
            'Agent-scheduled messages keep their sender. Edit them on the Automations page, or cancel and schedule a new one.',
        },
      });
      if (!fresh) expect(automationService.update).not.toHaveBeenCalled();
      else expect(automationService.update).toHaveBeenCalledTimes(1);
    },
  );

  it('allows disabling a protected session prompt and never receipts raw command or prompt content', async () => {
    const protectedActivity = activity({
      type: 'worktree_session_prompt',
      workspaceId: runtime.projectId,
      worktreeId: 'other-worktree',
      chatId: 'other-chat',
      prompt: 'secret prompt',
    });
    automationService.list.mockResolvedValue({
      activities: [protectedActivity],
      recentRuns: [],
    });
    automationService.update.mockResolvedValue({
      ok: true,
      activity: { ...protectedActivity, enabled: false },
    });

    const response = await dispatchAgentResourceAction(
      {
        type: 'automation.disable',
        id: protectedActivity.id,
      },
      runtime,
    );
    expect(response.ok).toBe(true);
    const serialized = JSON.stringify(
      resultObject(response.result).agentArtifacts,
    );
    expect(serialized).not.toContain('secret prompt');
    expect(serialized).not.toContain('secret command');
    expect(serialized).toContain('"ifCommandConfigured":true');
  });

  it('lists only the selected context automations but still gets any id', async () => {
    mockResolveProjectSavedOwner.mockResolvedValue({ kind: 'none' });
    const outside = { ...activity(), id: 'activity-2', name: 'Elsewhere' };
    automationService.list.mockResolvedValue({
      activities: [activity(), outside],
      recentRuns: [],
    });
    mockScopeAutomations.mockImplementationOnce((list) =>
      Promise.resolve({
        ...list,
        activities: list.activities.filter(
          (candidate) => candidate.id !== 'activity-2',
        ),
      }),
    );
    automationService.listRuns.mockResolvedValue({
      runs: [],
      nextCursor: null,
      totalCount: 0,
    });

    const listed = await dispatchAgentResourceAction(
      { type: 'automation.list', includeRuns: false },
      runtime,
    );
    expect(resultObject(listed.result).activities).toEqual([
      expect.objectContaining({ id: 'activity-1' }),
    ]);

    const fetched = await dispatchAgentResourceAction(
      { type: 'automation.get', id: 'activity-2' },
      runtime,
    );
    expect(fetched).toMatchObject({
      ok: true,
      result: { activity: { id: 'activity-2' } },
    });

    const unknownTargetActivity = activity({
      type: 'pipeline_execution_resume',
      executionId: 'execution-unknown-target',
      statusReasonIds: [],
      provider: 'claude',
      purpose: 'usage_limit_resume',
      pipelineName: 'Release',
    });
    automationService.list.mockResolvedValue({
      activities: [unknownTargetActivity],
      recentRuns: [],
    });
    const unknownTarget = await dispatchAgentResourceAction(
      { type: 'automation.get', id: unknownTargetActivity.id },
      runtime,
    );

    expect(unknownTarget).toMatchObject({
      ok: true,
      result: { activity: { id: unknownTargetActivity.id } },
    });
  });

  it('returns only the selected automation recent runs from automation.get', async () => {
    const otherActivity = { ...activity(), id: 'activity-2', name: 'Other' };
    // `automation.get` now pages the durable per-automation run archive
    // (ECW-8684) instead of filtering the capped `recentRuns` hot window.
    const archivedRuns: ScheduledActivityRun[] = [
      {
        id: 'run-1',
        activityId: 'activity-1',
        activityName: 'Daily review',
        scheduledFor: '2026-08-05T13:00:00.000Z',
        manual: false,
        status: 'success',
        startedAt: '2026-08-05T13:00:00.000Z',
        completedAt: '2026-08-05T13:00:01.000Z',
      },
      {
        id: 'run-2',
        activityId: 'activity-2',
        activityName: 'Other',
        scheduledFor: '2026-08-05T14:00:00.000Z',
        manual: false,
        status: 'running',
        startedAt: '2026-08-05T14:00:00.000Z',
      },
    ];
    automationService.list.mockResolvedValue({
      activities: [activity(), otherActivity],
      recentRuns: archivedRuns,
    });
    automationService.listRuns.mockImplementation(
      ({ activityId }: { activityId: string }) => {
        const runs = archivedRuns.filter(
          (run) => run.activityId === activityId,
        );
        return Promise.resolve({
          runs,
          nextCursor: null,
          totalCount: runs.length,
        });
      },
    );

    const response = await dispatchAgentResourceAction(
      { type: 'automation.get', id: 'activity-1' },
      runtime,
    );

    expect(response).toMatchObject({
      ok: true,
      result: {
        activity: { id: 'activity-1' },
        recentRuns: [{ id: 'run-1', activityId: 'activity-1' }],
      },
    });
  });

  it('normalizes missing Cloud capabilities', async () => {
    jest
      .mocked(assertCanopyCloudCapability)
      .mockRejectedValue(
        new CanopyCloudClientError(
          'unsupported-capability',
          'skills are unsupported',
        ),
      );
    const response = await dispatchAgentResourceAction(
      { type: 'skills.list_shared' },
      runtime,
    );
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'missing_capability' },
    });
  });

  it('normalizes missing Cloud authentication and missing resources', async () => {
    jest
      .mocked(assertCanopyCloudCapability)
      .mockRejectedValueOnce(
        new CanopyCloudClientError(
          'cloud-not-configured',
          'Cloud account is not configured',
        ),
      );
    const auth = await dispatchAgentResourceAction(
      { type: 'skills.read_shared', skillId: 'skill-1' },
      runtime,
    );
    const missing = await dispatchAgentResourceAction(
      { type: 'automation.get', id: 'missing' },
      runtime,
    );

    expect(auth).toMatchObject({
      ok: false,
      error: { code: 'authentication_failed' },
    });
    expect(missing).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });
});
