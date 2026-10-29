import * as childResolver from '@canopy/desktop-shared/node/pipelines/executor/child-pipeline-resolver';
import type * as ReceiptsModule from '../lib/resource-install-receipts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pipelineStore from '@canopy/desktop-shared/pipelines/store';
import { pipelineContextResources } from '@canopy/desktop-shared/node/background-execution-context';
import {
  decideResourceContext,
  type InstallReceipt,
} from '@canopy/desktop-shared/lib/resource-context-policy';
import { persistedPipelineContextResources } from '../services/background-execution-context';
import type { ExecutionState } from '@canopy/desktop-shared/node/pipelines/executor';
import type { PipelineContextResource } from '@canopy/desktop-shared/node/background-execution-context';
import type { getStoredPipelineBySource } from '@canopy/desktop-shared/pipelines/store';
import {
  authorizeBackgroundExecution,
  bindEnabledHookContexts,
  describeAutomationContextMismatch,
  rebindHookExecutionContexts,
  resolveBackgroundWorkspaceContext,
  scopeAutomationsToSelectedContext,
} from '../services/background-execution-context';
import {
  APP_ADVISOR_PROJECT_ID,
  type AutomationsListResponse,
  type ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import type {
  ChatHookAction,
  HookOverrides,
} from '@canopy/desktop-shared/hooks';
import { CanopyCloudClientError } from '../canopy-cloud/client';
let mockContextEnabled = true;
let mockCurrentContext: WorkspaceContext = { kind: 'personal' };
let mockOrganizations: { id: string; name: string }[] = [];
import type {
  ResourceContextInput,
  ResourceContextDecision,
} from '@canopy/desktop-shared/lib/resource-context-policy';
import type { readWorkspaceConfigDetailed } from '../lib/workspace-persistence';
import type { ResolvedWorkspaceTarget } from '../services/workspace-target';

const mockRead = jest.fn<
  ReturnType<typeof readWorkspaceConfigDetailed>,
  Parameters<typeof readWorkspaceConfigDetailed>
>();
const mockResolveWorkspaceTarget = jest.fn<
  Promise<ResolvedWorkspaceTarget>,
  [
    string,
    {
      organizationId?: string;
      workspaceOwner?: WorkspaceContext;
      linkedPersonalCandidate?: boolean;
    },
  ]
>();
class MockWorkspaceTargetResolutionError extends Error {
  constructor(
    public readonly reason: 'unknown-provenance' | 'unsupported-target',
    public readonly transient?: true,
  ) {
    super(reason);
  }
}
const mockDecide = jest.fn<
  Promise<ResourceContextDecision>,
  [ResourceContextInput]
>(() => Promise.resolve({ allow: true }));
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: jest.fn(() => ({
    isEnabled: jest.fn(() => mockContextEnabled),
  })),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfigDetailed: (
    ...args: Parameters<typeof mockRead>
  ): ReturnType<typeof readWorkspaceConfigDetailed> => mockRead(...args),
}));
jest.mock('../services/workspace-target', () => ({
  WorkspaceTargetResolutionError: MockWorkspaceTargetResolutionError,
  resolveWorkspaceTarget: (
    ...args: Parameters<typeof mockResolveWorkspaceTarget>
  ): ReturnType<typeof mockResolveWorkspaceTarget> =>
    mockResolveWorkspaceTarget(...args),
}));
jest.mock('../lib/sidebar-items', () => ({
  readWorkspaceIndexEntry: jest.fn((id: string) =>
    Promise.resolve({ id, name: 'Website' }),
  ),
}));
jest.mock('../services/resource-context-policy-service', () => ({
  getResourceContextPolicyService: jest.fn(() => ({ decide: mockDecide })),
}));
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): unknown => ({
    initialize: (): Promise<void> => Promise.resolve(),
    whenIdle: (): Promise<void> => Promise.resolve(),
    getState: (): unknown => ({
      context: mockCurrentContext,
      organizations: mockOrganizations,
    }),
  }),
}));
let mockAccountAvailable = true;
jest.mock('../lib/canopy-cloud-account-store', () => ({
  readCanopyCloudAccountWithStatus: jest.fn(() =>
    Promise.resolve(
      mockAccountAvailable
        ? { status: 'ok', entry: { account: { id: 'account-1' } } }
        : { status: 'unavailable' },
    ),
  ),
}));
let mockReceiptDir: string | undefined;
jest.mock('../lib/resource-install-receipts', () => ({
  createResourceInstallReceiptsStore: jest.fn((accountId: string) =>
    mockReceiptDir
      ? jest
          .requireActual<
            typeof ReceiptsModule
          >('../lib/resource-install-receipts')
          .createResourceInstallReceiptsStore(accountId, mockReceiptDir)
      : { find: mockFindReceipt, findLocal: mockFindLocalReceipt },
  ),
}));

const mockFindReceipt = jest.fn<
  Promise<InstallReceipt | undefined>,
  [string, string]
>();

const mockFindLocalReceipt = jest.fn(() => Promise.resolve(undefined));

const orgA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const orgB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

it('resolves a bound Cowork workspace to its organization context', async () => {
  mockRead.mockResolvedValue({
    authority: 'ok',
    ownerMalformed: false,
    config: {
      version: 1,
      type: 'cowork',
      repos: [],
      owner: {
        type: 'organization',
        organizationId: orgA,
        projectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        instanceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        bindingGeneration: 1,
      },
    },
  });
  mockResolveWorkspaceTarget.mockImplementationOnce((_projectId, options) => ({
    workspaceId: 'cowork-org-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    workspaceOwner: options.workspaceOwner ?? { kind: 'personal' },
    linkedPersonalCandidate: options.linkedPersonalCandidate ?? false,
  }));

  await expect(
    resolveBackgroundWorkspaceContext(
      'cowork-org-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    ),
  ).resolves.toBe(`org:${orgA}`);
});

let mockBuiltInPlugins = ['builtin-security'];
let mockSkills: Array<{ sourceId: string; name: string }> = [];
jest.mock('../plugins/plugin-service', () => ({
  loadMarketplaces: jest.fn(() =>
    Promise.resolve({
      success: true,
      data: {
        marketplaces: [
          {
            id: 'builtin/app',
            builtIn: true,
            plugins: mockBuiltInPlugins.map((name) => ({ name, facets: {} })),
          },
        ],
      },
    }),
  ),
}));
jest.mock('../skills/skill-service', () => ({
  loadSkills: jest.fn(() => ({ success: true, data: mockSkills })),
}));

it('authorizes the bundled review plugin collection under strict background policy', async () => {
  mockRead.mockResolvedValue({
    authority: 'ok',
    ownerMalformed: false,
    config: { type: 'single-repo', repos: [] },
  });
  mockDecide.mockImplementation((input) =>
    Promise.resolve(decideResourceContext(input)),
  );
  const resources = pipelineContextResources(
    {
      jobs: { review: { steps: [{ run: 'echo review' }] } },
      plugin_collections: [
        {
          id: 'security',
          name: 'Security',
          defaults: [
            {
              type: 'plugin',
              marketplace: { type: 'builtin', id: 'app' },
              plugin_name: 'builtin-security',
              required: true,
            },
          ],
        },
      ],
    },
    { type: 'system' },
  );
  expect(
    await authorizeBackgroundExecution('personal', resources, {
      projectId: 'workspace',
    }),
  ).toEqual({ allow: true });
});

beforeEach((): void => {
  mockContextEnabled = true;
  mockCurrentContext = { kind: 'personal' };
  mockOrganizations = [];
  mockRead.mockReset();
  mockDecide.mockClear();
  mockResolveWorkspaceTarget.mockReset();
  mockResolveWorkspaceTarget.mockImplementation(
    (_projectId, options): Promise<ResolvedWorkspaceTarget> =>
      Promise.resolve({
        workspaceOwner: options.workspaceOwner,
        linkedOrganizationIds: [],
      }),
  );
});
it('authorizes a global destination without resolving workspace ownership', async (): Promise<void> => {
  mockDecide.mockImplementation((input) =>
    Promise.resolve(decideResourceContext(input)),
  );
  expect(
    await authorizeBackgroundExecution(
      `org:${orgA}`,
      [{ owner: { type: 'system' } }],
      { scope: 'global' },
    ),
  ).toEqual({ allow: true });
  expect(mockRead).not.toHaveBeenCalled();
  expect(mockResolveWorkspaceTarget).not.toHaveBeenCalled();
  const input = mockDecide.mock.calls.at(-1)?.[0];
  expect(input?.target).toBeUndefined();
  expect(input?.invocation.context).toEqual({
    kind: 'organization',
    organizationId: orgA,
  });
});
it.each([{ shareScope: 'private' }, { type: 'system' }])(
  'denies a portable resource targeting another organization: %j',
  async (owner): Promise<void> => {
    mockRead.mockResolvedValue({
      authority: 'ok',
      ownerMalformed: false,
      config: {
        repos: [],
        owner: {
          type: 'organization',
          organizationId: orgB,
          projectId: orgB,
          instanceId: orgB,
          bindingGeneration: 1,
        },
      },
    });
    expect(
      await authorizeBackgroundExecution(`org:${orgA}`, [{ owner }], {
        projectId: 'workspace-b',
      }),
    ).toEqual({ allow: false, reason: 'context-mismatch' });
  },
);
it('allows an organization-bound run to target a linked Personal workspace', async (): Promise<void> => {
  mockRead.mockResolvedValue({
    authority: 'ok',
    ownerMalformed: false,
    config: { type: 'single-repo', repos: [] },
  });
  mockResolveWorkspaceTarget.mockResolvedValue({
    workspaceOwner: { kind: 'personal' },
    linkedOrganizationIds: [orgA],
  });
  mockDecide.mockImplementation((input) =>
    Promise.resolve(decideResourceContext(input)),
  );
  expect(
    await authorizeBackgroundExecution(
      `org:${orgA}`,
      [{ owner: { type: 'system' } }],
      { projectId: 'personal' },
    ),
  ).toEqual({ allow: true });
  expect(mockResolveWorkspaceTarget).toHaveBeenCalledWith('personal', {
    organizationId: orgA,
    linkedPersonalCandidate: true,
    workspaceOwner: { kind: 'personal' },
  });
  expect(mockDecide).toHaveBeenCalledWith(
    expect.objectContaining({
      target: {
        workspaceOwner: { kind: 'personal' },
        linkedOrganizationIds: [orgA],
      },
    }),
  );
});

it('keeps an unlinked Personal background destination as a context mismatch', async (): Promise<void> => {
  mockRead.mockResolvedValue({
    authority: 'ok',
    ownerMalformed: false,
    config: { type: 'single-repo', repos: [] },
  });
  expect(
    await authorizeBackgroundExecution(
      `org:${orgA}`,
      [{ owner: { type: 'system' } }],
      { projectId: 'personal' },
    ),
  ).toEqual({ allow: false, reason: 'context-mismatch' });
  expect(mockDecide).not.toHaveBeenCalled();
});

it('keeps an unknown linked audience transient for background retries', async (): Promise<void> => {
  mockRead.mockResolvedValue({
    authority: 'ok',
    ownerMalformed: false,
    config: { type: 'single-repo', repos: [] },
  });
  mockResolveWorkspaceTarget.mockRejectedValue(
    new MockWorkspaceTargetResolutionError('unknown-provenance', true),
  );
  expect(
    await authorizeBackgroundExecution(
      `org:${orgA}`,
      [{ owner: { type: 'system' } }],
      { projectId: 'personal' },
    ),
  ).toEqual({
    allow: false,
    reason: 'unknown-provenance',
    transient: true,
  });
});
it('denies unreadable destination ownership', async (): Promise<void> => {
  mockRead.mockResolvedValue({
    authority: 'unreadable',
    ownerMalformed: false,
    config: { repos: [] },
  });
  expect(
    await authorizeBackgroundExecution(
      'personal',
      [{ owner: { type: 'system' } }],
      { projectId: 'unreadable' },
    ),
  ).toEqual({ allow: false, reason: 'unknown-provenance' });
});
it.each([
  {
    label: 'a cloud outage',
    error: new CanopyCloudClientError('network-error', 'offline'),
    expected: { allow: false, reason: 'unknown-provenance', transient: true },
  },
  {
    label: 'any other failure',
    error: new Error('broken'),
    expected: { allow: false, reason: 'unknown-provenance' },
  },
])(
  'reports $label during verification accordingly',
  async ({ error, expected }): Promise<void> => {
    mockRead.mockResolvedValue({
      authority: 'ok',
      ownerMalformed: false,
      config: { repos: [] },
    });
    mockDecide.mockRejectedValueOnce(error);
    expect(
      await authorizeBackgroundExecution(
        'personal',
        [{ owner: { shareScope: 'private' } }],
        { projectId: 'personal' },
      ),
    ).toEqual(expected);
  },
);
it('reports an unreadable account store for a stored definition as temporary', async (): Promise<void> => {
  mockRead.mockResolvedValue({
    authority: 'ok',
    ownerMalformed: false,
    config: { repos: [] },
  });
  mockAccountAvailable = false;
  try {
    expect(
      await authorizeBackgroundExecution(
        'personal',
        [
          {
            owner: { shareScope: 'private' },
            storedPipelineId: 'stored-pipeline',
            requiresHostAuthorization: true,
          },
        ],
        { projectId: 'personal' },
      ),
    ).toEqual({ allow: false, reason: 'unknown-provenance', transient: true });
  } finally {
    mockAccountAvailable = true;
  }
});
it('passes the trusted destination owner to each resource decision', async (): Promise<void> => {
  mockRead.mockResolvedValue({
    authority: 'ok',
    ownerMalformed: false,
    config: { repos: [] },
  });
  expect(
    await authorizeBackgroundExecution(
      'personal',
      [{ owner: { type: 'system' } }, { owner: { shareScope: 'private' } }],
      { projectId: 'personal' },
    ),
  ).toEqual({ allow: true });
  expect(mockDecide).toHaveBeenCalledTimes(2);
  for (const [input] of mockDecide.mock.calls)
    expect(input.target).toEqual({
      workspaceOwner: { kind: 'personal' },
      linkedOrganizationIds: [],
    });
});

it('runs App Advisor in the invoking organization context', async (): Promise<void> => {
  mockDecide.mockImplementation((input) =>
    Promise.resolve(decideResourceContext(input)),
  );
  expect(
    await authorizeBackgroundExecution(
      `org:${orgA}`,
      [{ owner: { type: 'system' } }],
      { projectId: APP_ADVISOR_PROJECT_ID },
    ),
  ).toEqual({ allow: true });
  expect(mockRead).not.toHaveBeenCalled();
  expect(mockDecide).toHaveBeenCalledWith(
    expect.objectContaining({
      target: {
        workspaceOwner: { kind: 'organization', organizationId: orgA },
        linkedOrganizationIds: [],
      },
    }),
  );
});

it('still checks App Advisor resources against the invoking context', async (): Promise<void> => {
  mockDecide.mockResolvedValueOnce({
    allow: false,
    reason: 'context-mismatch',
  });
  expect(
    await authorizeBackgroundExecution(
      `org:${orgA}`,
      [{ owner: { shareScope: 'private' } }],
      { projectId: APP_ADVISOR_PROJECT_ID },
    ),
  ).toEqual({ allow: false, reason: 'context-mismatch' });
});

describe('scopeAutomationsToSelectedContext', () => {
  const now = '2026-05-28T12:00:00.000Z';
  function scheduled(
    id: string,
    action: ScheduledActivity['action'],
  ): ScheduledActivity {
    return {
      version: 1,
      id,
      name: id,
      enabled: true,
      schedule: { kind: 'one_time', runAt: now, timezone: 'local' },
      action,
      createdAt: now,
      updatedAt: now,
      failureCount: 0,
    };
  }
  const list: AutomationsListResponse = {
    activities: [
      scheduled('advisor', { type: 'app_advisor_prompt', prompt: 'Hi' }),
      scheduled('org-a', {
        type: 'worktree_prompt',
        workspaceId: 'org-a-project',
        prompt: 'Go',
      }),
      scheduled('org-b', {
        type: 'worktree_prompt',
        workspaceId: 'org-b-project',
        prompt: 'Go',
      }),
      scheduled('personal', {
        type: 'standalone_prompt',
        chatProjectId: 'personal-chats',
        prompt: 'Go',
      }),
      scheduled('unreadable', {
        type: 'worktree_prompt',
        workspaceId: 'gone-project',
        prompt: 'Go',
      }),
    ],
    recentRuns: [
      {
        id: 'run-personal',
        activityId: 'personal',
        activityName: 'personal',
        scheduledFor: now,
        manual: true,
        status: 'success',
        startedAt: now,
      },
      {
        id: 'run-org-a',
        activityId: 'org-a',
        activityName: 'org-a',
        scheduledFor: now,
        manual: true,
        status: 'success',
        startedAt: now,
      },
    ],
  };

  beforeEach((): void => {
    mockRead.mockImplementation(
      (id): ReturnType<typeof readWorkspaceConfigDetailed> => {
        if (id === 'gone-project')
          return Promise.resolve({
            authority: 'unreadable',
            ownerMalformed: false,
            config: { repos: [] },
          });
        const organizationId =
          id === 'org-a-project'
            ? orgA
            : id === 'org-b-project'
              ? orgB
              : undefined;
        return Promise.resolve({
          authority: 'ok',
          ownerMalformed: false,
          config: {
            repos: [],
            ...(organizationId
              ? {
                  owner: {
                    type: 'organization',
                    organizationId,
                    projectId: id,
                    instanceId: id,
                    bindingGeneration: 1,
                  },
                }
              : {}),
          },
        });
      },
    );
  });

  it('keeps the selected organization, App Advisor and unresolved targets', async (): Promise<void> => {
    mockCurrentContext = { kind: 'organization', organizationId: orgA };
    const scoped = await scopeAutomationsToSelectedContext(list);
    expect(scoped.activities.map((activity) => activity.id)).toEqual([
      'advisor',
      'org-a',
      'unreadable',
    ]);
    expect(scoped.recentRuns.map((run) => run.id)).toEqual(['run-org-a']);
  });

  it('keeps Personal targets under Personal', async (): Promise<void> => {
    const scoped = await scopeAutomationsToSelectedContext(list);
    expect(scoped.activities.map((activity) => activity.id)).toEqual([
      'advisor',
      'personal',
      'unreadable',
    ]);
  });

  it('resolves each destination once', async (): Promise<void> => {
    mockCurrentContext = { kind: 'organization', organizationId: orgA };
    const shared = {
      type: 'worktree_prompt',
      workspaceId: 'org-a-project',
      prompt: 'Go',
    } as const;
    const scoped = await scopeAutomationsToSelectedContext({
      activities: [
        scheduled('first', shared),
        scheduled('second', shared),
        scheduled('other', {
          type: 'worktree_prompt',
          workspaceId: 'org-b-project',
          prompt: 'Go',
        }),
      ],
      recentRuns: [],
    });
    expect(scoped.activities.map((activity) => activity.id)).toEqual([
      'first',
      'second',
    ]);
    expect(mockRead.mock.calls.map(([id]) => id)).toEqual([
      'org-a-project',
      'org-b-project',
    ]);
  });

  it('leaves the list unchanged while org projects are off', async (): Promise<void> => {
    mockContextEnabled = false;
    mockCurrentContext = { kind: 'organization', organizationId: orgA };
    await expect(scopeAutomationsToSelectedContext(list)).resolves.toBe(list);
    expect(mockRead).not.toHaveBeenCalled();
  });
});

describe('describeAutomationContextMismatch', () => {
  const orgProjectAction = {
    type: 'worktree_prompt',
    workspaceId: 'org-b-project',
    prompt: 'Go',
  } as const;

  beforeEach((): void => {
    mockRead.mockResolvedValue({
      authority: 'ok',
      ownerMalformed: false,
      config: {
        repos: [],
        owner: {
          type: 'organization',
          organizationId: orgB,
          projectId: 'org-b-project',
          instanceId: 'org-b-project',
          bindingGeneration: 1,
        },
      },
    });
  });

  it('says "an organization" for an unnamed organization when Personal is bound', async (): Promise<void> => {
    await expect(
      describeAutomationContextMismatch(orgProjectAction, 'personal'),
    ).resolves.toEqual({
      targetName: 'Website',
      targetContext: 'an organization',
      boundContext: 'Personal',
    });
  });

  it('says "another organization" when both sides are organizations', async (): Promise<void> => {
    mockOrganizations = [{ id: orgA, name: 'Acme' }];
    await expect(
      describeAutomationContextMismatch(orgProjectAction, `org:${orgA}`),
    ).resolves.toEqual({
      targetName: 'Website',
      targetContext: 'another organization',
      boundContext: 'Acme',
    });
  });
});

it('resolves replay provenance without replacing the persisted snapshot or cwd', (): void => {
  const state: ExecutionState = {
    version: 1,
    id: 'source',
    pipeline_id: 'parent',
    pipeline_snapshot: {
      name: 'Original',
      plugin_collections: [{ id: 'review', name: 'Review', defaults: [] }],
      jobs: {
        build: {
          steps: [
            { uses: 'builtin/run-pipeline', with: { pipeline: 'child.yml' } },
          ],
        },
      },
    },
    status: 'success',
    jobs: {},
    plugin_collection_preferences: {
      review: {
        disabledDefaultKeys: [],
        extraSelections: { collectionIds: [], pluginRefs: [], skillRefs: [] },
      },
    },
    model_alias_preferences: {},
    resolved_plugin_collections: {
      review: {
        selections: { collectionIds: [], pluginRefs: [], skillRefs: [] },
        unresolvedRequiredDefaults: [],
        missingOptionalDefaults: [],
      },
    },
    cwd: '/source/cwd',
    repo_path: '/source/repo',
    inputs: {},
    env: {},
    started_at: '2026-01-01T00:00:00Z',
    pipeline_preference_locator: {
      type: 'stored',
      source: 'user',
      value: 'parent',
    },
  };
  const lookup = jest.fn<
    ReturnType<typeof getStoredPipelineBySource>,
    Parameters<typeof getStoredPipelineBySource>
  >(() => ({
    success: true,
    data: {
      info: {
        id: 'parent',
        name: 'Changed',
        source: 'user',
        path: '/storage/parent.yml',
        remoteId: 'receipt-id',
      },
      content: { name: 'Changed', jobs: {} },
    },
  }));
  const resources = persistedPipelineContextResources(state, lookup);
  expect(lookup).toHaveBeenCalledWith('user', 'parent');
  expect(resources[0]).toMatchObject({
    owner: { shareScope: 'private' },
    storedPipelineId: 'receipt-id',
  });
  expect(
    resources.find((resource) => resource.capabilities)?.capabilities?.location,
  ).toMatchObject({
    preferencesResolved: true,
    pluginCollectionPreferences: state.plugin_collection_preferences,
    modelAliasPreferences: state.model_alias_preferences,
    resolvedPluginCollections: state.resolved_plugin_collections,
  });
  const child = resources.find((resource) => resource.childPipeline);
  expect(child?.parentPipelineId).toBe('parent');
  expect(child?.childPipeline).toMatchObject({
    cwd: '/source/cwd',
    repoPath: '/source/repo',
    pipelineRef: 'child.yml',
  });
});

it('requires a current owner lookup for a saved shared pipeline and preserves children', (): void => {
  const state: ExecutionState = {
    version: 1,
    id: 'shared-run',
    pipeline_id: 'shared:canopy-cloud:remote-1',
    pipeline_snapshot: {
      name: 'Saved definition',
      jobs: {
        review: {
          steps: [
            { uses: 'builtin/run-pipeline', with: { pipeline: 'child.yml' } },
          ],
        },
      },
    },
    status: 'paused',
    jobs: {},
    cwd: '/run',
    inputs: {},
    env: {},
    started_at: '2026-01-01T00:00:00Z',
    execution_context: `org:${orgA}`,
    pipeline_preference_locator: {
      type: 'shared',
      value: 'canopy-cloud:remote-1',
    },
  };
  const lookup = jest.fn<
    ReturnType<typeof getStoredPipelineBySource>,
    Parameters<typeof getStoredPipelineBySource>
  >();
  const resources = persistedPipelineContextResources(state, lookup);
  expect(resources[0]).toEqual({
    owner: undefined,
    requiresHostAuthorization: true,
    capabilities: { sharedPipeline: { remoteId: 'remote-1' } },
  });
  expect(
    resources.some(
      (resource) => resource.childPipeline?.pipelineRef === 'child.yml',
    ),
  ).toBe(true);
  expect(lookup).not.toHaveBeenCalled();
  state.shared_pipeline_source = {
    type: 'shared',
    serverId: 'canopy-cloud',
    serverName: 'Cloud',
    remoteId: 'remote-1',
    cachedPipelinePath: '/run/shared-pipeline.yaml',
    fetchedAt: '2026-01-01T00:00:00Z',
  };
  expect(persistedPipelineContextResources(state, lookup)[0]).toEqual(
    resources[0],
  );
  state.shared_pipeline_source.remoteId = 'different';
  expect(persistedPipelineContextResources(state, lookup)[0]).toEqual({
    owner: undefined,
  });
  state.pipeline_preference_locator = {
    type: 'shared',
    value: 'other-server:remote-1',
  };
  expect(persistedPipelineContextResources(state, lookup)[0]).toEqual({
    owner: undefined,
  });
  state.pipeline_preference_locator = {
    type: 'shared',
    value: 'canopy-cloud:../bad',
  };
  expect(persistedPipelineContextResources(state, lookup)[0]).toEqual({
    owner: undefined,
  });
  state.pipeline_preference_locator = { type: 'shared', value: 'broken' };
  expect(persistedPipelineContextResources(state, lookup)[0]).toEqual({
    owner: undefined,
  });
  state.pipeline_preference_locator = undefined;
  expect(persistedPipelineContextResources(state, lookup)[0]).toEqual({
    owner: undefined,
  });
});

it('restores curated replay only for a matching captured source', async (): Promise<void> => {
  const state: ExecutionState = {
    version: 1,
    id: 'curated-run',
    pipeline_id: 'curated:review',
    pipeline_snapshot: { name: 'Saved', jobs: {} },
    status: 'paused',
    jobs: {},
    cwd: '/run',
    inputs: {},
    env: {},
    started_at: '2026-01-01T00:00:00Z',
    pipeline_preference_locator: {
      type: 'stored',
      source: 'curated',
      value: 'curated:review',
      contentHash: 'hash',
    },
  };
  const lookup = jest.fn<
    ReturnType<typeof getStoredPipelineBySource>,
    Parameters<typeof getStoredPipelineBySource>
  >();
  expect(persistedPipelineContextResources(state, lookup)[0]).toEqual({
    owner: undefined,
  });
  state.curated_pipeline_source = {
    key: 'review',
    contentHash: 'hash',
    revision: 1,
    cachedPipelinePath: '/run/curated.yaml',
  };
  expect(persistedPipelineContextResources(state, lookup)[0]).toEqual({
    owner: { type: 'system' },
  });
  mockDecide.mockImplementation((input) =>
    Promise.resolve(decideResourceContext(input, { strict: true })),
  );
  expect(
    await authorizeBackgroundExecution(
      `org:${orgA}`,
      persistedPipelineContextResources(state, lookup),
      { scope: 'global' },
    ),
  ).toEqual({ allow: true });
  state.curated_pipeline_source.key = 'other';
  expect(persistedPipelineContextResources(state, lookup)[0]).toEqual({
    owner: undefined,
  });
  expect(lookup).not.toHaveBeenCalled();
});

it.each([false, true])(
  'retains installed organization provenance when receipt=%s',
  async (installed): Promise<void> => {
    mockRead.mockResolvedValue({
      authority: 'ok',
      ownerMalformed: false,
      config: { repos: [] },
    });
    const receipt: InstallReceipt = {
      family: 'pipelines',
      remoteId: 'local-id',
      shareScope: 'organization',
      ownerContext: { kind: 'organization', organizationId: orgA },
      hash: 'a'.repeat(64),
      authorizedAt: '2026-09-24T00:00:00Z',
    };
    mockFindReceipt.mockResolvedValue(installed ? receipt : undefined);
    mockDecide.mockImplementation(
      (input): Promise<ResourceContextDecision> =>
        Promise.resolve(decideResourceContext(input, { strict: true })),
    );
    const decision = await authorizeBackgroundExecution(
      'personal',
      [{ owner: { shareScope: 'private' }, storedPipelineId: 'local-id' }],
      { projectId: 'personal' },
    );
    expect(mockFindReceipt).toHaveBeenCalledWith('pipelines', 'local-id');
    expect(decision).toEqual(
      installed
        ? { allow: false, reason: 'context-mismatch' }
        : { allow: true },
    );
    if (installed)
      expect(mockDecide.mock.calls.at(-1)?.[0].resource.provenance).toEqual(
        receipt,
      );
  },
);

it('uses the on-disk pipelines receipt for background authorization', async (): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'canopy-pipeline-receipt-'));
  mockReceiptDir = dir;
  try {
    const store = jest
      .requireActual<typeof ReceiptsModule>('../lib/resource-install-receipts')
      .createResourceInstallReceiptsStore('account-1', dir);
    const receipt: InstallReceipt = {
      family: 'pipelines',
      remoteId: 'installed-remote',
      localResourceIds: ['installed-local'],
      shareScope: 'organization',
      ownerContext: { kind: 'organization', organizationId: orgA },
      hash: 'a'.repeat(64),
      authorizedAt: '2026-09-24T00:00:00Z',
    };
    await store.record(receipt);
    mockDecide.mockImplementation((input) =>
      Promise.resolve(decideResourceContext(input, { strict: true })),
    );
    const resources: PipelineContextResource[] = [
      {
        owner: { shareScope: 'private' },
        storedPipelineId: 'installed-remote',
        requiresHostAuthorization: true,
      },
    ];
    expect(
      await authorizeBackgroundExecution(`org:${orgA}`, resources, {
        scope: 'global',
      }),
    ).toEqual({ allow: true });
    expect(
      await authorizeBackgroundExecution('personal', resources, {
        scope: 'global',
      }),
    ).toEqual({ allow: false, reason: 'context-mismatch' });
    expect(
      await authorizeBackgroundExecution(`org:${orgB}`, resources, {
        scope: 'global',
      }),
    ).toEqual({ allow: false, reason: 'context-mismatch' });
    // Membership is checked by the policy service after the on-disk receipt
    // is passed to it; model its current-account response here.
    mockDecide.mockImplementation((input) =>
      Promise.resolve(
        input.resource.provenance?.ownerContext.kind === 'organization'
          ? { allow: false, reason: 'access-removed' }
          : decideResourceContext(input, { strict: true }),
      ),
    );
    expect(
      await authorizeBackgroundExecution(`org:${orgA}`, resources, {
        scope: 'global',
      }),
    ).toEqual({ allow: false, reason: 'access-removed' });
    const missing: PipelineContextResource[] = [
      {
        owner: undefined,
        storedPipelineId: 'missing',
        requiresHostAuthorization: true,
      },
    ];
    expect(
      await authorizeBackgroundExecution(`org:${orgA}`, missing, {
        scope: 'global',
      }),
    ).toEqual({ allow: false, reason: 'unknown-provenance' });
  } finally {
    mockReceiptDir = undefined;
    await rm(dir, { recursive: true, force: true });
  }
});

it('retains a local overlay binding across saves and captures again only after disabling', async (): Promise<void> => {
  const previous: HookOverrides = {
    'pr:create': [
      {
        type: 'pipeline',
        source: 'bundled',
        id: 'review',
        executionContext: `org:${orgA}`,
        localExecutionContextOverlay: true,
      },
    ],
  };
  const next: HookOverrides = {
    'pr:create': [
      {
        type: 'pipeline',
        source: 'bundled',
        id: 'review',
        executionContext: 'untrusted',
      },
    ],
  };
  mockCurrentContext = { kind: 'organization', organizationId: orgB };
  const saved = await bindEnabledHookContexts(next, previous);
  expect(saved?.['pr:create']?.[0]).toMatchObject({
    executionContext: `org:${orgA}`,
  });
  const rebound = await bindEnabledHookContexts(next, { 'pr:create': null });
  expect(rebound?.['pr:create']?.[0]).toMatchObject({
    executionContext: `org:${orgB}`,
  });
});

it('captures and retains an execution context for chat hooks', async (): Promise<void> => {
  const previousAction: ChatHookAction & { executionContext: string } = {
    type: 'chat',
    prompt: 'Review the pull request',
    executionContext: `org:${orgA}`,
  };
  const previous: HookOverrides = {
    'pr:create': [previousAction],
  };
  const next: HookOverrides = {
    'pr:create': [
      {
        type: 'chat',
        prompt: 'Review the pull request',
      },
    ],
  };
  mockCurrentContext = { kind: 'organization', organizationId: orgB };

  const saved = await bindEnabledHookContexts(next, previous);

  expect(saved?.['pr:create']?.[0]).toMatchObject({
    executionContext: `org:${orgA}`,
  });
  const rebound = await bindEnabledHookContexts(next, { 'pr:create': null });
  expect(rebound?.['pr:create']?.[0]).toMatchObject({
    executionContext: `org:${orgB}`,
  });
});

it('leaves flag-off hook save bytes unchanged', async (): Promise<void> => {
  mockContextEnabled = false;
  const hooks: HookOverrides = {
    'pr:create': [{ type: 'pipeline', source: 'bundled', id: 'review' }],
  };
  const before = JSON.stringify(hooks);
  expect(JSON.stringify(await bindEnabledHookContexts(hooks, undefined))).toBe(
    before,
  );
});

it('rebinds only chat and pipeline hooks in the previous or unbound context', (): void => {
  const pluginOverlay = {
    type: 'chat' as const,
    prompt: 'Overlay',
    localPluginSelectionOverlay: true,
    localPluginSelectionOverlayKey: 'overlay-key',
  };
  const hooks: HookOverrides = {
    'pr:merge': [pluginOverlay],
    'pr:create': [
      { type: 'chat', prompt: 'Moved', executionContext: 'personal' },
      { type: 'pipeline', source: 'bundled', id: 'unbound' },
      {
        type: 'pipeline',
        source: 'bundled',
        id: 'other',
        executionContext: 'org:other',
      },
      { type: 'command', command: 'npm test' },
    ],
  };

  expect(
    rebindHookExecutionContexts(
      hooks,
      'personal',
      'org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'workspace-root',
    ),
  ).toEqual(['workspace-root:pr:create:0', 'workspace-root:pr:create:1']);
  expect(hooks['pr:create']).toEqual([
    {
      type: 'chat',
      prompt: 'Moved',
      executionContext: 'org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
    {
      type: 'pipeline',
      source: 'bundled',
      id: 'unbound',
      executionContext: 'org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
    {
      type: 'pipeline',
      source: 'bundled',
      id: 'other',
      executionContext: 'org:other',
    },
    { type: 'command', command: 'npm test' },
  ]);
  // A plugin-selection overlay has no binding of its own to move.
  expect(hooks['pr:merge']).toEqual([pluginOverlay]);
});

it.each(['user', 'bundled'])(
  'allows ownerless stored %s children of a Personal parent in strict background mode',
  async (source): Promise<void> => {
    if (source !== 'user' && source !== 'bundled')
      throw new Error('Unexpected source');
    const child = { name: 'Child', jobs: {} };
    const resolve = jest
      .spyOn(childResolver, 'resolveChildPipeline')
      .mockResolvedValue({
        pipeline: child,
        pipelineId: 'child',
        preferenceLocator: { type: 'stored', source, value: 'child' },
      });
    const stored = jest
      .spyOn(pipelineStore, 'getStoredPipelineBySource')
      .mockReturnValue({
        success: true,
        data: {
          content: child,
          info: {
            id: 'child',
            name: 'Child',
            source,
            path: '/stored/child.yaml',
          },
        },
      });
    const graph = pipelineContextResources(
      {
        jobs: {
          build: {
            steps: [
              { uses: 'builtin/run-pipeline', with: { pipeline: 'child' } },
            ],
          },
        },
      },
      { shareScope: 'private' },
    );
    const owners: unknown[] = [];
    try {
      mockRead.mockResolvedValue({
        authority: 'ok',
        ownerMalformed: false,
        config: { repos: [] },
      });
      mockFindReceipt.mockResolvedValue(undefined);
      mockDecide.mockImplementation(
        (input): Promise<ResourceContextDecision> => {
          owners.push(input.resource.owner);
          return Promise.resolve(
            decideResourceContext(input, { strict: true }),
          );
        },
      );
      expect(
        await authorizeBackgroundExecution('personal', graph, {
          projectId: 'personal',
        }),
      ).toEqual({ allow: true });
      expect(owners.at(-1)).toEqual(
        source === 'user' ? { shareScope: 'private' } : { type: 'system' },
      );
    } finally {
      resolve.mockRestore();
      stored.mockRestore();
    }
  },
);

it('refuses continuation after the workspace is reassigned following preflight', async (): Promise<void> => {
  const workspaceRead: Awaited<ReturnType<typeof readWorkspaceConfigDetailed>> =
    {
      authority: 'ok',
      ownerMalformed: false,
      config: {
        repos: [],
        owner: {
          type: 'organization',
          organizationId: orgA,
          projectId: orgA,
          instanceId: orgA,
          bindingGeneration: 1,
        },
      },
    };
  mockRead.mockResolvedValue(workspaceRead);
  mockDecide.mockResolvedValue({ allow: true });
  const binding = await resolveBackgroundWorkspaceContext('workspace');
  const resources = [{ owner: { shareScope: 'private' } }];
  expect(
    await authorizeBackgroundExecution(binding, resources, {
      projectId: 'workspace',
    }),
  ).toEqual({ allow: true });
  if (!workspaceRead.config.owner)
    throw new Error('Expected organization owner');
  workspaceRead.config.owner.organizationId = orgB;
  expect(
    await authorizeBackgroundExecution(binding, resources, {
      projectId: 'workspace',
    }),
  ).toEqual({ allow: false, reason: 'context-mismatch' });
});

describe('watcher delivery to a chat with selected capabilities', () => {
  // Regression: a chat running a custom skill with a built-in plugin selected
  // started the bundled review pipeline with an inline watcher. Delivery rebuilt
  // this exact resource list and denied it as unverifiable, stranding the chat.
  const selections = {
    collectionIds: [],
    skillRefs: [{ sourceId: 'custom:app', skillName: 'speed-run' }],
    pluginRefs: [{ marketplaceId: 'builtin/app', pluginName: 'builtin-gh' }],
  };
  const securityCollection = {
    id: 'security',
    name: 'Security',
    defaults: [
      {
        type: 'plugin' as const,
        marketplace: { type: 'builtin' as const, id: 'app' },
        plugin_name: 'builtin-security',
        required: true,
      },
    ],
  };
  function reviewRun(
    locator: ExecutionState['pipeline_preference_locator'],
  ): ExecutionState {
    return {
      version: 1,
      id: 'review-run',
      pipeline_id: 'bundled-review',
      pipeline_snapshot: {
        name: 'Review',
        scope: ['worktree'],
        plugin_collections: [securityCollection],
        jobs: {},
      },
      status: 'success',
      jobs: {},
      job_definitions: {},
      job_groups: {},
      pending_pauses: [],
      status_reasons: [],
      resolved_plugin_collections: {
        security: {
          selections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [
              { marketplaceId: 'builtin/app', pluginName: 'builtin-security' },
            ],
          },
          unresolvedRequiredDefaults: [],
          missingOptionalDefaults: [],
        },
      },
      cwd: '/worktree',
      inputs: {},
      env: {},
      started_at: '2026-09-25T15:01:24.664Z',
      pipeline_preference_locator: locator,
    };
  }
  const lookup = jest.fn<
    ReturnType<typeof getStoredPipelineBySource>,
    Parameters<typeof getStoredPipelineBySource>
  >((source, id) => ({
    success: true,
    data: {
      info: {
        id,
        name: 'Review',
        description: '',
        filename: `${id}.yml`,
        icon: '',
        source,
        readonly: source === 'bundled',
        createdAt: '2026-09-25T00:00:00.000Z',
        updatedAt: '2026-09-25T00:00:00.000Z',
      },
      content: { name: 'Review', on: { dispatch: {} }, jobs: {} },
    },
  }));
  function watcherResources(
    run: ExecutionState,
    selected: typeof selections = selections,
  ): PipelineContextResource[] {
    return [
      { owner: { shareScope: 'private' } },
      {
        owner: undefined,
        requiresHostAuthorization: true,
        capabilities: { selections: selected },
      },
      ...persistedPipelineContextResources(run, lookup),
    ];
  }
  const bundledLocator = {
    type: 'stored' as const,
    source: 'bundled' as const,
    value: 'bundled-review',
  };

  beforeEach((): void => {
    mockRead.mockResolvedValue({
      authority: 'ok',
      ownerMalformed: false,
      config: { version: 1, type: 'single-repo', repos: [] },
    });
    mockDecide.mockImplementation((input) =>
      Promise.resolve(decideResourceContext(input)),
    );
    mockFindReceipt.mockResolvedValue(undefined);
    mockSkills = [{ sourceId: 'custom:app', name: 'speed-run' }];
    mockBuiltInPlugins = ['builtin-gh', 'builtin-security'];
    mockAccountAvailable = true;
  });
  afterAll((): void => {
    mockSkills = [];
    mockBuiltInPlugins = ['builtin-security'];
    mockAccountAvailable = true;
  });

  it('authorizes a bundled run delivered to a chat with a custom skill and a built-in plugin', async (): Promise<void> => {
    expect(
      await authorizeBackgroundExecution(
        'personal',
        watcherResources(reviewRun(bundledLocator)),
        { projectId: 'workspace', worktreeId: 'worktree' },
      ),
    ).toEqual({ allow: true });
  });

  it('authorizes local capabilities while the account store is unavailable', async (): Promise<void> => {
    mockAccountAvailable = false;
    expect(
      await authorizeBackgroundExecution(
        'personal',
        watcherResources(reviewRun(bundledLocator)),
        { projectId: 'workspace', worktreeId: 'worktree' },
      ),
    ).toEqual({ allow: true });
  });

  it('denies a selected skill that is no longer installed', async (): Promise<void> => {
    expect(
      await authorizeBackgroundExecution(
        'personal',
        watcherResources(reviewRun(bundledLocator), {
          ...selections,
          skillRefs: [{ sourceId: 'custom:app', skillName: 'removed' }],
        }),
        { projectId: 'workspace', worktreeId: 'worktree' },
      ),
    ).toEqual({ allow: false, reason: 'missing-dependency' });
  });

  it('denies a run whose stored definition cannot be located', async (): Promise<void> => {
    expect(
      await authorizeBackgroundExecution(
        'personal',
        watcherResources(reviewRun(undefined)),
        { projectId: 'workspace', worktreeId: 'worktree' },
      ),
    ).toEqual({ allow: false, reason: 'unknown-provenance' });
  });
});
