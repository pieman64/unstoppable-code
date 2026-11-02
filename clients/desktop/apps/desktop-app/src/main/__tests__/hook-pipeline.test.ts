import { buildWorkspaceManifest } from '../lib/workspace-source-control';
import {
  resolveProjectHooks,
  resolveWorkspaceRepoHooks,
  resolveWorkspaceRootHooks,
} from '../lib/hook-resolver';
import { getWorkspaceConfigPath } from '../lib/paths';
import { writeWorkspaceConfig } from '../lib/workspace-persistence';
import type { WorkspaceConfigFile } from '@canopy/desktop-shared/types';
import {
  getCanopyJsonPath,
  readCanopyJson,
  writeCanopyJson,
} from '../lib/canopy-json';
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): unknown => ({
    initialize: (): Promise<void> => Promise.resolve(),
    whenIdle: (): Promise<void> => Promise.resolve(),
    getState: (): unknown => ({
      context: {
        kind: 'organization',
        organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      },
    }),
  }),
}));
import { decideResourceContext } from '@canopy/desktop-shared/lib/resource-context-policy';
import type * as BackgroundContextModule from '../services/background-execution-context';
import type * as WorkspacePersistenceModule from '../lib/workspace-persistence';
import type * as PreferencesStoreModule from '../lib/preferences-store';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { DEFAULT_PREFERENCES } from '../lib/preferences-store';
import type { readWorkspaceConfigDetailed } from '../lib/workspace-persistence';
import type { ResourceContextDecision } from '@canopy/desktop-shared/lib/resource-context-policy';
import type { authorizeBackgroundExecution } from '../services/background-execution-context';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  foreignActivitySourceSnapshot,
  resetForeignActivitySources,
} from '../services/foreign-activity-sources';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type {
  Pipeline,
  PipelineData,
} from '@canopy/desktop-shared/types/pipeline';
import type { ExecutionState } from '@canopy/desktop-shared/node/pipelines/executor';
import {
  releaseExecutionReservation,
  reserveExecution,
} from '../pipelines/pipeline-execution-registry';
import { sendToWindow } from '../lib/window-send';
import { getStoredPipelineBySource } from '../pipelines/pipeline-service';
import { loadProjectPipelineFromDisk } from '../pipelines/project-pipeline-discovery';
import {
  startPipelineExecutionFromMain,
  validateProjectPipelineAccess,
} from '../pipelines/pipeline-handlers';
import {
  cancelQueuedHookPipeline,
  hookPipelineTestExports,
  listQueuedHookPipelines,
  launchHookPipeline,
} from '../lib/hook-pipeline';

const mockBackgroundAuthorize = jest.fn<
  Promise<ResourceContextDecision>,
  Parameters<typeof authorizeBackgroundExecution>
>(() => Promise.resolve({ allow: true }));
const mockDestinationRead = jest.fn<
  ReturnType<typeof readWorkspaceConfigDetailed>,
  Parameters<typeof readWorkspaceConfigDetailed>
>();
jest.mock('../lib/workspace-persistence', () => {
  const actual = jest.requireActual<typeof WorkspacePersistenceModule>(
    '../lib/workspace-persistence',
  );
  return {
    ...actual,
    readWorkspaceConfigDetailed: (
      ...args: Parameters<typeof mockDestinationRead>
    ): ReturnType<typeof readWorkspaceConfigDetailed> =>
      mockDestinationRead(...args),
  };
});
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: jest.fn(() => ({ isEnabled: jest.fn(() => true) })),
}));
jest.mock('../services/resource-context-policy-service', () => ({
  getResourceContextPolicyService: jest.fn(() => ({
    decide: jest.fn(() => Promise.resolve({ allow: true })),
  })),
}));
jest.mock('../services/background-execution-context', () => ({
  backgroundExecutionContextEnabled: (): boolean => false,
  authorizeBackgroundExecution: (
    ...args: Parameters<typeof authorizeBackgroundExecution>
  ): Promise<ResourceContextDecision> => mockBackgroundAuthorize(...args),
}));
jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));

const mockGetManagedCuratedPipeline = jest.fn();
jest.mock('../pipelines/curated-pipeline-catalog', () => ({
  // Lazy so the hoisted factory never reads the mock before its declaration runs.
  getManagedCuratedPipeline: (...args: unknown[]): unknown =>
    mockGetManagedCuratedPipeline(...args),
}));

jest.mock('../pipelines/pipeline-service', () => ({
  getStoredPipelineBySource: jest.fn(),
}));

jest.mock('../pipelines/project-pipeline-discovery', () => ({
  getCreatedAt: jest.fn(() => '2026-04-30T00:00:00.000Z'),
  getProjectPipelineId: jest.fn(
    (relativePath: string) => `project--${relativePath}`,
  ),
  loadProjectPipelineFromDisk: jest.fn(),
}));

jest.mock('../pipelines/pipeline-handlers', () => ({
  startPipelineExecutionFromMain: jest.fn(),
  validateProjectPipelineAccess: jest.fn(),
}));

const mockReadPreferencesFile = jest.fn<Promise<PreferencesData>, []>();
jest.mock('../lib/preferences-store', () => {
  const actual = jest.requireActual<typeof PreferencesStoreModule>(
    '../lib/preferences-store',
  );
  return {
    ...actual,
    readPreferencesFile: (): Promise<PreferencesData> =>
      mockReadPreferencesFile(),
  };
});

const mockedSendToWindow = jest.mocked(sendToWindow);
const mockedGetStoredPipelineBySource = jest.mocked(getStoredPipelineBySource);
const mockedLoadProjectPipelineFromDisk = jest.mocked(
  loadProjectPipelineFromDisk,
);
const mockedStartPipelineExecutionFromMain = jest.mocked(
  startPipelineExecutionFromMain,
);
const mockedValidateProjectPipelineAccess = jest.mocked(
  validateProjectPipelineAccess,
);

function buildPipeline(
  name: string,
  on: Pipeline['on'] = 'dispatch',
): Pipeline {
  return {
    name,
    on,
    jobs: {
      build: {
        steps: [
          {
            run: 'echo ok',
          },
        ],
      },
    },
  };
}

function buildPipelineData(
  id: string,
  source: 'bundled' | 'user',
): PipelineData {
  const content = buildPipeline(`${id} pipeline`);
  return {
    info: {
      id,
      name: content.name,
      description: '',
      icon: '',
      filename: `${id}.yaml`,
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
      source,
      readonly: source === 'bundled',
    },
    content,
  };
}

function buildExecutionState(args: {
  executionId: string;
  pipelineId: string;
  pipelineName: string;
  cwd: string;
}): ExecutionState {
  // A version-3 persisted state predates the newer required fields.
  const state: Partial<ExecutionState> = {
    version: 3,
    id: args.executionId,
    pipeline_id: args.pipelineId,
    pipeline_snapshot: {
      name: args.pipelineName,
      scope: ['directory'],
      jobs: {},
    },
    status: 'running',
    jobs: {},
    started_at: '2026-04-30T00:00:00.000Z',
    cwd: args.cwd,
    env: {},
    inputs: {},
  };
  return state as ExecutionState;
}

function buildLaunchArgs(
  action: Parameters<typeof launchHookPipeline>[0]['action'],
): Parameters<typeof launchHookPipeline>[0] {
  return {
    action,
    cwd: testRepo,
    projectId: 'project-a',
    worktreeId: 'worktree-a',
    env: {
      CANOPY_PR_URL: 'https://github.com/acme/repo/pull/42',
    },
    triggerSource: {
      kind: 'hook',
      hook_key: 'project:pr:create',
      hook_label: 'PR Created',
      trigger_name: 'pr:create',
      target: 'project',
      action_index: 0,
      triggered_at: '2026-04-30T00:00:00.000Z',
    },
    getWindow: () => null,
  };
}

let testRepo = '';

describe('hook-pipeline', () => {
  it('preserves a single-repo plugin selection overlay while repairing its binding', async (): Promise<void> => {
    const owner: NonNullable<WorkspaceConfigFile['owner']> = {
      type: 'organization',
      organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      instanceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      bindingGeneration: 1,
    };
    const selections = {
      collectionIds: ['review-tools'],
      skillRefs: [],
      pluginRefs: [],
    };
    const config: WorkspaceConfigFile = {
      version: 1,
      type: 'single-repo',
      repoPath: testRepo,
      repos: [],
      owner,
      hooks: {
        'pr:create': [
          {
            type: 'chat',
            prompt: 'Review the PR',
            model: 'old-model',
            localPluginSelectionOverlay: true,
            localPluginSelectionOverlayKey: 'chat:Review the PR',
            pluginSelections: selections,
          },
        ],
      },
    };
    await writeWorkspaceConfig('project-a', config, { ownership: 'replace' });
    await writeCanopyJson(testRepo, {
      version: 1,
      hooks: {
        'pr:create': [
          { type: 'chat', prompt: 'Review the PR', model: 'new-model' },
        ],
      },
    });
    const result = await resolveProjectHooks({
      id: 'project-a',
      ...config,
      repoPath: testRepo,
    });
    expect(result['pr:create']?.actions).toEqual([
      expect.objectContaining({
        type: 'chat',
        model: 'new-model',
        pluginSelections: selections,
        executionContext: `org:${owner.organizationId}`,
      }),
    ]);
  });

  it.each(['project', 'root', 'repo'] as const)(
    'repairs an inherited unbound organization hook durably before dispatch (%s)',
    async (scope): Promise<void> => {
      const owner: NonNullable<WorkspaceConfigFile['owner']> = {
        type: 'organization',
        organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        instanceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        bindingGeneration: 1,
      };
      const config: WorkspaceConfigFile = {
        version: 1,
        type: scope === 'project' ? 'single-repo' : 'multi-repo',
        repoPath: testRepo,
        sourceRepoPath: testRepo,
        repos: [{ id: 'repo-a', name: 'Repo A', repoPath: testRepo }],
        owner,
      };
      await writeWorkspaceConfig('project-a', config, { ownership: 'replace' });
      await writeCanopyJson(testRepo, {
        version: 1,
        hooks: {
          'pr:create': [{ type: 'pipeline', source: 'bundled', id: 'review' }],
        },
      });
      const project = {
        id: 'project-a',
        ...config,
        repoPath: testRepo,
        hooks: config.hooks,
      };
      const resolve = async (): Promise<
        Awaited<ReturnType<typeof resolveProjectHooks>>
      > =>
        scope === 'project'
          ? resolveProjectHooks(project)
          : scope === 'root'
            ? resolveWorkspaceRootHooks('project-a')
            : resolveWorkspaceRepoHooks('project-a', 'repo-a');
      const resolved = await resolve();
      const action = resolved['pr:create']?.actions?.[0];
      expect(action).toMatchObject({
        executionContext: `org:${owner.organizationId}`,
      });
      if (action?.type !== 'pipeline')
        throw new Error('Expected pipeline action');
      const persisted: unknown = JSON.parse(
        await readFile(getWorkspaceConfigPath('project-a'), 'utf8'),
      );
      expect(persisted).toHaveProperty(
        scope === 'repo' ? 'repos.0.hooks.pr:create.0' : 'hooks.pr:create.0',
        {
          type: 'pipeline',
          source: 'bundled',
          id: 'review',
          executionContext: `org:${owner.organizationId}`,
          localExecutionContextOverlay: true,
        },
      );
      expect(await readCanopyJson(testRepo)).toEqual({
        version: 1,
        hooks: {
          'pr:create': [{ type: 'pipeline', source: 'bundled', id: 'review' }],
        },
      });
      expect((await resolve())['pr:create']?.actions?.[0]).toEqual(action);
      mockDestinationRead.mockResolvedValue({
        authority: 'ok',
        ownerMalformed: false,
        memoryMalformed: false,
        config,
      });
      const actual = jest.requireActual<typeof BackgroundContextModule>(
        '../services/background-execution-context',
      );
      mockBackgroundAuthorize.mockImplementation(
        actual.authorizeBackgroundExecution,
      );
      mockedGetStoredPipelineBySource.mockReturnValue({
        success: true,
        data: buildPipelineData('review', 'bundled'),
      });
      await launchHookPipeline(buildLaunchArgs(action));
      expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalledTimes(1);
    },
  );
  it.each([false, true])(
    'resolves bundled hook capabilities and saved preferences when queued=%s',
    async (queued): Promise<void> => {
      const data = buildPipelineData('review', 'bundled');
      data.content.plugin_collections = [
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
      ];
      mockedGetStoredPipelineBySource.mockReturnValue({ success: true, data });
      if (queued) reserveExecution('active-test');
      const result = await launchHookPipeline(
        buildLaunchArgs({ type: 'pipeline', source: 'bundled', id: 'review' }),
      );
      if (queued) {
        expect(result.status).toBe('queued');
        releaseExecutionReservation('active-test');
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(mockBackgroundAuthorize).toHaveBeenCalledWith(
        undefined,
        expect.arrayContaining([
          expect.objectContaining({
            capabilities: {
              pipeline: data.content,
              location: expect.objectContaining({
                pipelinePreferenceLocator: {
                  type: 'stored',
                  source: 'bundled',
                  value: 'review',
                },
              }) as unknown,
            },
          }),
        ]),
        { projectId: 'project-a', worktreeId: 'worktree-a' },
        undefined,
      );
      expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalledTimes(1);
    },
  );

  it('retains the enable-time organization binding through source conversion and dispatch', async (): Promise<void> => {
    const actual = jest.requireActual<typeof BackgroundContextModule>(
      '../services/background-execution-context',
    );
    const hooks = await actual.bindEnabledHookContexts(
      {
        'pr:create': [{ type: 'pipeline', source: 'bundled', id: 'review' }],
      },
      undefined,
    );
    const converted = await buildWorkspaceManifest({
      version: 1,
      type: 'single-repo',
      repos: [],
      hooks,
    });
    await writeCanopyJson(testRepo, converted.manifest);
    const manifest = await readCanopyJson(testRepo);
    expect(JSON.stringify(manifest)).not.toContain('executionContext');
    expect(await readFile(getCanopyJsonPath(testRepo), 'utf8')).not.toMatch(
      /executionContext|localExecutionContextOverlay/,
    );
    const resolved = await resolveWorkspaceRootHooks('project-a', {
      localConfig: {
        ...converted.localConfig,
        sourceRepoPath: testRepo,
        // Resolution and dispatch describe the same organization-owned scope.
        owner: {
          type: 'organization',
          organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          instanceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          bindingGeneration: 1,
        },
      },
    });
    const action = resolved['pr:create']?.actions?.[0];
    expect(action).toMatchObject({
      executionContext: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
    if (action?.type !== 'pipeline')
      throw new Error('Expected resolved pipeline hook');
    mockDestinationRead.mockResolvedValue({
      authority: 'ok',
      ownerMalformed: false,
      memoryMalformed: false,
      config: {
        version: 1,
        type: 'single-repo',
        repos: [],
        owner: {
          type: 'organization',
          organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          instanceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          bindingGeneration: 1,
        },
      },
    });
    mockBackgroundAuthorize.mockImplementation(
      actual.authorizeBackgroundExecution,
    );
    await launchHookPipeline(buildLaunchArgs(action));
    expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalledTimes(1);
  });

  it.each(['other-org', 'unreadable'])(
    'denies a hook destination with %s ownership',
    async (mode): Promise<void> => {
      mockDestinationRead.mockResolvedValue({
        authority: mode === 'unreadable' ? 'unreadable' : 'ok',
        ownerMalformed: false,
        memoryMalformed: false,
        config: {
          version: 1,
          type: 'single-repo',
          repos: [],
          owner: {
            type: 'organization',
            organizationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            projectId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            instanceId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            bindingGeneration: 1,
          },
        },
      });
      const actual = jest.requireActual<typeof BackgroundContextModule>(
        '../services/background-execution-context',
      );
      mockBackgroundAuthorize.mockImplementation(
        actual.authorizeBackgroundExecution,
      );
      mockedGetStoredPipelineBySource.mockReturnValue({
        success: true,
        data: buildPipelineData('test', 'bundled'),
      });
      await expect(
        launchHookPipeline(
          buildLaunchArgs({
            type: 'pipeline',
            source: 'bundled',
            id: 'test',
            executionContext: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          }),
        ),
      ).rejects.toThrow(
        mode === 'unreadable'
          ? "Couldn't confirm where something this uses came from"
          : 'This is in a different Personal or organization context',
      );
      expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
    },
  );

  it('denies an ineligible bound hook before dispatch', async (): Promise<void> => {
    mockedGetStoredPipelineBySource.mockReturnValue({
      success: true,
      data: buildPipelineData('test', 'bundled'),
    });
    mockBackgroundAuthorize.mockResolvedValueOnce({
      allow: false,
      reason: 'unknown-provenance',
    });
    await expect(
      launchHookPipeline(
        buildLaunchArgs({
          type: 'pipeline',
          source: 'bundled',
          id: 'test',
          executionContext: 'personal',
        }),
      ),
    ).rejects.toThrow("Couldn't confirm where something this uses came from");
    expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
  });

  it('reports retry guidance for a transient hook authorization failure', async (): Promise<void> => {
    mockedGetStoredPipelineBySource.mockReturnValue({
      success: true,
      data: buildPipelineData('test', 'bundled'),
    });
    mockBackgroundAuthorize.mockResolvedValueOnce({
      allow: false,
      reason: 'unknown-provenance',
      transient: true,
    });
    await expect(
      launchHookPipeline(
        buildLaunchArgs({
          type: 'pipeline',
          source: 'bundled',
          id: 'test',
          executionContext: 'personal',
        }),
      ),
    ).rejects.toThrow(
      "Couldn't check access to what this run uses. Try again in a moment.",
    );
    expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
  });

  it('materializes an undownloaded curated hook and preserves its stored identity', async () => {
    const data = buildPipelineData('curated:review', 'bundled');
    data.info.curatedContentHash = 'a'.repeat(64);
    mockGetManagedCuratedPipeline.mockResolvedValue(data);
    await launchHookPipeline(
      buildLaunchArgs({
        type: 'pipeline',
        source: 'curated',
        id: 'curated:review',
      }),
    );
    expect(mockGetManagedCuratedPipeline).toHaveBeenCalledWith(
      'curated:review',
    );
    expect(mockedGetStoredPipelineBySource).not.toHaveBeenCalled();
    const startArgs = mockedStartPipelineExecutionFromMain.mock.calls[0]?.[0];
    expect(startArgs?.pipeline).toEqual(data.content);
    expect(startArgs?.options.pipelinePreferenceLocator).toEqual({
      type: 'stored',
      source: 'curated',
      value: 'curated:review',
      contentHash: 'a'.repeat(64),
    });
  });

  beforeEach(async (): Promise<void> => {
    testRepo = await mkdtemp(join(tmpdir(), 'hook-pipeline-'));
    resetForeignActivitySources();
    mockBackgroundAuthorize.mockReset().mockResolvedValue({ allow: true });
    hookPipelineTestExports.resetQueueForTests();
    mockedSendToWindow.mockReset();
    mockedGetStoredPipelineBySource.mockReset();
    mockedLoadProjectPipelineFromDisk.mockReset();
    mockedValidateProjectPipelineAccess.mockReset();
    mockedStartPipelineExecutionFromMain.mockReset();
    mockedStartPipelineExecutionFromMain.mockImplementation((args) => {
      const executionId = args.options.executionId;
      if (!executionId) {
        throw new Error('Expected executionId');
      }
      releaseExecutionReservation(executionId);
      return Promise.resolve({
        success: true,
        data: buildExecutionState({
          executionId,
          pipelineId: args.options.pipelineId,
          pipelineName: args.pipeline.name,
          cwd: args.options.cwd ?? testRepo,
        }),
      });
    });
    mockedGetStoredPipelineBySource.mockImplementation((source, id) => ({
      success: true,
      data: buildPipelineData(id, source),
    }));
    mockedLoadProjectPipelineFromDisk.mockResolvedValue(
      buildPipeline('project pipeline'),
    );
    mockedValidateProjectPipelineAccess.mockResolvedValue({
      success: true,
      data: {
        filePath: join(testRepo, '.canopy/pipelines/review.yaml'),
        rootDir: join(testRepo, '.canopy/pipelines'),
      },
    });
    releaseExecutionReservation('active-test');
    mockReadPreferencesFile.mockReset().mockResolvedValue(DEFAULT_PREFERENCES);
  });

  afterEach(async () => {
    mockBackgroundAuthorize.mockReset().mockResolvedValue({ allow: true });
    hookPipelineTestExports.resetQueueForTests();
    releaseExecutionReservation('active-test');
    await rm(testRepo, { recursive: true, force: true });
  });

  // ECW-9091 review round 8. `triggerSource` and `initiationSource` are
  // independent fields. Only the former was set here, so every consumer reading
  // `initiation_source` — including the step-runner's AI Credits attendedness
  // check — saw `undefined` and treated a hook run as interactive, letting an
  // unattended hook pipeline spend a credits-only user's balance.
  it('marks a hook-launched pipeline as hook-initiated', async () => {
    await launchHookPipeline(
      buildLaunchArgs({ type: 'pipeline', source: 'bundled', id: 'review' }),
    );

    const call = mockedStartPipelineExecutionFromMain.mock.calls[0]?.[0];
    expect(call?.options.initiationSource).toBe('hook');
    expect(call?.options.initiator).toEqual({ kind: 'hook' });
    expect(call?.options.triggerSource?.kind).toBe('hook');
  });

  describe('Codex speed', () => {
    function preferencesWithCodexDefault(
      codex: PreferencesData['providerModelConfigDefaults']['codex'],
      codexFastModeDefaultEnabled = false,
    ): PreferencesData {
      return {
        ...DEFAULT_PREFERENCES,
        providerModelConfigDefaults: { codex },
        codexFastModeDefaultEnabled,
      };
    }

    function launchedModelConfig(): unknown {
      return mockedStartPipelineExecutionFromMain.mock.calls[0]?.[0].options
        .modelConfig;
    }

    it.each([
      ['an explicit false', { fastMode: false }, 'standard'],
      ['an explicit true', { fastMode: true }, 'fast'],
    ] as const)(
      'lets %s on the hook win over an Ultra fast Codex default',
      async (_label, modelConfig, speed): Promise<void> => {
        mockReadPreferencesFile.mockResolvedValue(
          preferencesWithCodexDefault({ speed: 'ultrafast', fastMode: false }),
        );

        await launchHookPipeline(
          buildLaunchArgs({
            type: 'pipeline',
            source: 'bundled',
            id: 'review',
            modelConfig,
          }),
        );

        expect(launchedModelConfig()).toEqual({
          speed,
          fastMode: speed === 'fast',
        });
      },
    );

    it.each([
      ['Regular', { speed: 'standard', fastMode: false }, 'standard'],
      ['Fast', { speed: 'fast', fastMode: true }, 'fast'],
    ] as const)(
      'inherits a %s Codex default exactly when the hook sets no speed',
      async (_label, codex, speed): Promise<void> => {
        mockReadPreferencesFile.mockResolvedValue(
          preferencesWithCodexDefault(codex),
        );

        await launchHookPipeline(
          buildLaunchArgs({
            type: 'pipeline',
            source: 'bundled',
            id: 'review',
          }),
        );

        expect(launchedModelConfig()).toEqual({
          speed,
          fastMode: speed === 'fast',
        });
      },
    );

    it('reads the deprecated hook boolean and legacy default preference', async (): Promise<void> => {
      mockReadPreferencesFile.mockResolvedValue(
        preferencesWithCodexDefault(undefined, true),
      );

      await launchHookPipeline(
        buildLaunchArgs({ type: 'pipeline', source: 'bundled', id: 'review' }),
      );
      await launchHookPipeline(
        buildLaunchArgs({
          type: 'pipeline',
          source: 'bundled',
          id: 'review',
          codexFastMode: false,
        }),
      );

      expect(
        mockedStartPipelineExecutionFromMain.mock.calls.map(
          (call) => call[0].options.modelConfig,
        ),
      ).toEqual([
        { speed: 'fast', fastMode: true },
        { speed: 'standard', fastMode: false },
      ]);
    });

    it.each([false, true])(
      'rejects an Ultra fast hook before resolving or launching when queued=%s',
      async (queued): Promise<void> => {
        if (queued) reserveExecution('active-test');

        await expect(
          launchHookPipeline(
            buildLaunchArgs({
              type: 'pipeline',
              source: 'bundled',
              id: 'review',
              modelConfig: { speed: 'ultrafast' },
            }),
          ),
        ).rejects.toThrow(
          'Workflow hooks do not support Ultra fast. Choose Regular or Fast.',
        );

        expect(mockedGetStoredPipelineBySource).not.toHaveBeenCalled();
        expect(mockBackgroundAuthorize).not.toHaveBeenCalled();
        expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
        expect(listQueuedHookPipelines()).toEqual([]);
        expect(mockedSendToWindow).not.toHaveBeenCalled();
      },
    );

    it.each([false, true])(
      'rejects an inherited Ultra fast Codex default before launching when queued=%s',
      async (queued): Promise<void> => {
        mockReadPreferencesFile.mockResolvedValue(
          preferencesWithCodexDefault({ speed: 'ultrafast', fastMode: false }),
        );
        if (queued) reserveExecution('active-test');

        await expect(
          launchHookPipeline(
            buildLaunchArgs({
              type: 'pipeline',
              source: 'bundled',
              id: 'review',
            }),
          ),
        ).rejects.toThrow(
          'Workflow hooks do not support Ultra fast. Choose Regular or Fast for this hook, or change the Codex default speed.',
        );

        expect(mockedGetStoredPipelineBySource).not.toHaveBeenCalled();
        expect(mockBackgroundAuthorize).not.toHaveBeenCalled();
        expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
        expect(listQueuedHookPipelines()).toEqual([]);
        expect(mockedSendToWindow).not.toHaveBeenCalled();
      },
    );
  });

  it('resolves bundled and local pipelines by source', async () => {
    await launchHookPipeline(
      buildLaunchArgs({
        type: 'pipeline',
        source: 'bundled',
        id: 'review',
      }),
    );
    await launchHookPipeline(
      buildLaunchArgs({
        type: 'pipeline',
        source: 'local',
        id: 'review',
      }),
    );

    expect(mockedGetStoredPipelineBySource).toHaveBeenNthCalledWith(
      1,
      'bundled',
      'review',
    );
    expect(mockedGetStoredPipelineBySource).toHaveBeenNthCalledWith(
      2,
      'user',
      'review',
    );
    expect(
      mockedStartPipelineExecutionFromMain.mock.calls[0]?.[0].options
        .pipelinePreferenceLocator,
    ).toEqual({
      type: 'stored',
      source: 'bundled',
      value: 'review',
    });
    expect(
      mockedStartPipelineExecutionFromMain.mock.calls[1]?.[0].options
        .pipelinePreferenceLocator,
    ).toEqual({
      type: 'stored',
      source: 'user',
      value: 'review',
    });
  });

  it('resolves project pipelines through project access validation', async () => {
    await mkdir(join(testRepo, '.canopy/pipelines'), { recursive: true });
    await writeFile(
      join(testRepo, '.canopy/pipelines/review.yaml'),
      'name: review',
    );

    await launchHookPipeline(
      buildLaunchArgs({
        type: 'pipeline',
        source: 'project',
        id: 'review.yaml',
      }),
    );

    expect(mockedValidateProjectPipelineAccess).toHaveBeenCalledWith({
      id: 'project--review.yaml',
      cwd: testRepo,
      filePath: join(testRepo, '.canopy/pipelines/review.yaml'),
    });
    expect(mockedLoadProjectPipelineFromDisk).toHaveBeenCalledWith(
      join(testRepo, '.canopy/pipelines/review.yaml'),
    );
  });

  it.each([false, true])(
    'authorizes Personal project-file hooks when queued=%s',
    async (queued): Promise<void> => {
      await mkdir(join(testRepo, '.canopy/pipelines'), { recursive: true });
      await writeFile(
        join(testRepo, '.canopy/pipelines/review.yaml'),
        'name: review',
      );
      mockBackgroundAuthorize.mockImplementation((_context, resources) => {
        return Promise.resolve(
          resources.every((resource) => resource.owner !== undefined)
            ? { allow: true }
            : { allow: false, reason: 'unknown-provenance' },
        );
      });
      if (queued) reserveExecution('active-test');
      const launch = launchHookPipeline(
        buildLaunchArgs({
          type: 'pipeline',
          source: 'project',
          id: 'review.yaml',
        }),
      );
      if (queued) {
        await launch;
        releaseExecutionReservation('active-test');
        await new Promise<void>((resolve) => setImmediate(resolve));
      } else await expect(launch).resolves.toMatchObject({ status: 'started' });
      expect(mockBackgroundAuthorize).toHaveBeenCalledWith(
        undefined,
        [{ owner: { shareScope: 'private' } }],
        { projectId: 'project-a', worktreeId: 'worktree-a' },
        undefined,
      );
      expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    'runs a locally authored user hook under strict policy when queued=%s',
    async (queued): Promise<void> => {
      mockedGetStoredPipelineBySource.mockReturnValue({
        success: true,
        data: buildPipelineData('local-review', 'user'),
      });
      mockBackgroundAuthorize.mockImplementation(
        (executionContext, resources) => {
          for (const resource of resources) {
            const decision = decideResourceContext(
              {
                resource,
                invocation: {
                  mode: 'background',
                  context: { kind: 'personal' },
                  executionContext,
                },
              },
              { strict: true },
            );
            if (!decision.allow) return Promise.resolve(decision);
          }
          return Promise.resolve({ allow: true });
        },
      );
      if (queued) reserveExecution('active-test');
      const result = await launchHookPipeline(
        buildLaunchArgs({
          type: 'pipeline',
          source: 'local',
          id: 'local-review',
        }),
      );
      if (queued) {
        expect(result.status).toBe('queued');
        releaseExecutionReservation('active-test');
        await new Promise<void>((resolve) => setImmediate(resolve));
      } else expect(result.status).toBe('started');
      expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalledTimes(1);
      expect(mockBackgroundAuthorize).toHaveBeenCalledWith(
        undefined,
        [
          {
            owner: { shareScope: 'private' },
            storedPipelineId: 'local-review',
          },
        ],
        { projectId: 'project-a', worktreeId: 'worktree-a' },
        undefined,
      );
    },
  );

  it('fails immediately when dispatch trigger is absent', async () => {
    mockedGetStoredPipelineBySource.mockReturnValueOnce({
      success: true,
      data: {
        ...buildPipelineData('review', 'bundled'),
        content: buildPipeline('review pipeline', 'plan_ready'),
      },
    });

    await expect(
      launchHookPipeline(
        buildLaunchArgs({
          type: 'pipeline',
          source: 'bundled',
          id: 'review',
        }),
      ),
    ).rejects.toThrow(
      'Workflow "review pipeline" does not define a dispatch trigger',
    );
    expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
  });

  it('interpolates inputs before execution', async () => {
    mockedGetStoredPipelineBySource.mockReturnValueOnce({
      success: true,
      data: {
        ...buildPipelineData('review', 'bundled'),
        content: buildPipeline('review pipeline', {
          dispatch: {
            inputs: {
              pr_url: {
                required: false,
              },
            },
          },
        }),
      },
    });

    await launchHookPipeline(
      buildLaunchArgs({
        type: 'pipeline',
        source: 'bundled',
        id: 'review',
        inputs: {
          pr_url: '{{CANOPY_PR_URL}}',
        },
      }),
    );

    expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalledTimes(1);
    expect(
      mockedStartPipelineExecutionFromMain.mock.calls[0]?.[0].options.inputs,
    ).toEqual({
      pr_url: 'https://github.com/acme/repo/pull/42',
    });
  });

  it('treats blank optional dispatch inputs as unset before validation', async () => {
    mockedGetStoredPipelineBySource.mockReturnValueOnce({
      success: true,
      data: {
        ...buildPipelineData('review', 'bundled'),
        content: buildPipeline('review pipeline', {
          dispatch: {
            inputs: {
              pr_url: {
                required: false,
              },
              enable_review: {
                required: false,
                type: 'boolean',
                default: true,
              },
              required_review: {
                required: true,
                type: 'boolean',
              },
            },
          },
        }),
      },
    });

    await launchHookPipeline(
      buildLaunchArgs({
        type: 'pipeline',
        source: 'bundled',
        id: 'review',
        inputs: {
          pr_url: '{{CANOPY_PR_URL}}',
          enable_review: '',
          required_review: 'false',
        },
      }),
    );

    expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalledTimes(1);
    expect(
      mockedStartPipelineExecutionFromMain.mock.calls[0]?.[0].options.inputs,
    ).toEqual({
      pr_url: 'https://github.com/acme/repo/pull/42',
      required_review: 'false',
    });
  });

  it('validates required dispatch inputs before queueing', async () => {
    mockedGetStoredPipelineBySource.mockReturnValueOnce({
      success: true,
      data: {
        ...buildPipelineData('review', 'bundled'),
        content: buildPipeline('review pipeline', {
          dispatch: {
            inputs: {
              pr_url: {
                required: true,
              },
            },
          },
        }),
      },
    });

    await expect(
      launchHookPipeline(
        buildLaunchArgs({
          type: 'pipeline',
          source: 'bundled',
          id: 'review',
        }),
      ),
    ).rejects.toThrow('Workflow input "pr_url" is required');
    expect(mockedSendToWindow).not.toHaveBeenCalled();
    expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
  });

  it('treats empty required CANOPY placeholder inputs as missing', async () => {
    mockedGetStoredPipelineBySource.mockReturnValueOnce({
      success: true,
      data: {
        ...buildPipelineData('review', 'bundled'),
        content: buildPipeline('review pipeline', {
          dispatch: {
            inputs: {
              pr_url: {
                required: true,
              },
            },
          },
        }),
      },
    });

    const launchArgs = buildLaunchArgs({
      type: 'pipeline',
      source: 'bundled',
      id: 'review',
      inputs: {
        pr_url: '{{CANOPY_PR_URL}}',
      },
    });
    launchArgs.env = {};

    await expect(launchHookPipeline(launchArgs)).rejects.toThrow(
      'Workflow input "pr_url" is required',
    );
    expect(mockedSendToWindow).not.toHaveBeenCalled();
    expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'resolves project-only child pipelines during hook preflight (queued=%s)',
    async (queued): Promise<void> => {
      const data = buildPipelineData('parent', 'bundled');
      data.content.jobs = {
        run: {
          steps: [
            { uses: 'builtin/run-pipeline', with: { pipeline: 'child' } },
          ],
        },
      };
      mockedGetStoredPipelineBySource.mockReturnValue({ success: true, data });
      await mkdir(join(testRepo, '.canopy/pipelines'), { recursive: true });
      await writeFile(
        join(testRepo, '.canopy/pipelines/child.yaml'),
        'name: Child\non: dispatch\njobs: {}\n',
      );
      const { resolveChildPipeline } =
        await import('@canopy/desktop-shared/node/pipelines/executor/child-pipeline-resolver');
      mockBackgroundAuthorize.mockImplementation(
        async (_context, resources): Promise<ResourceContextDecision> => {
          const child = resources.find(
            (resource) => resource.childPipeline,
          )?.childPipeline;
          if (!child) throw new Error('Missing child descriptor');
          try {
            await resolveChildPipeline(child);
            return { allow: true };
          } catch {
            return { allow: false, reason: 'unknown-provenance' };
          }
        },
      );
      if (queued) reserveExecution('active-test');
      const result = await launchHookPipeline(
        buildLaunchArgs({
          type: 'pipeline',
          source: 'bundled',
          id: 'parent',
          executionContext: 'personal',
        }),
      );
      if (queued) {
        expect(result.status).toBe('queued');
        releaseExecutionReservation('active-test');
        for (
          let attempt = 0;
          attempt < 50 &&
          mockedStartPipelineExecutionFromMain.mock.calls.length === 0;
          attempt += 1
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalledTimes(1);
    },
  );

  it('revalidates a queued hook when capacity becomes available', async (): Promise<void> => {
    reserveExecution('active-test');
    await launchHookPipeline(
      buildLaunchArgs({
        type: 'pipeline',
        source: 'bundled',
        id: 'review',
        executionContext: 'personal',
      }),
    );
    mockBackgroundAuthorize.mockResolvedValueOnce({
      allow: false,
      reason: 'access-removed',
    });
    releaseExecutionReservation('active-test');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
    const deniedError: unknown = expect.stringContaining(
      'You no longer have access to something this uses.',
    );
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      expect.any(String),
      expect.objectContaining({
        type: 'failed',
        error: deniedError,
      }),
    );
    expect(listQueuedHookPipelines()).toEqual([]);
  });

  it('queues FIFO when concurrency is disallowed and active executions exist', async () => {
    reserveExecution('active-test');

    const first = await launchHookPipeline(
      buildLaunchArgs({
        type: 'pipeline',
        source: 'bundled',
        id: 'first',
      }),
    );
    const second = await launchHookPipeline(
      buildLaunchArgs({
        type: 'pipeline',
        source: 'bundled',
        id: 'second',
      }),
    );

    expect(first.status).toBe('queued');
    expect(second.status).toBe('queued');
    expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();

    releaseExecutionReservation('active-test');
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalledTimes(2);
    expect(
      mockedStartPipelineExecutionFromMain.mock.calls[0]?.[0].options
        .pipelineId,
    ).toBe('first');
    expect(
      mockedStartPipelineExecutionFromMain.mock.calls[1]?.[0].options
        .pipelineId,
    ).toBe('second');
  });

  it.each(['cancelled', 'started', 'failed'] as const)(
    'bridges the reserved execution identity from queued to %s without a window',
    async (outcome): Promise<void> => {
      reserveExecution('active-test');
      const queued = await launchHookPipeline(
        buildLaunchArgs({ type: 'pipeline', source: 'bundled', id: 'review' }),
      );
      if (queued.status !== 'queued') throw new Error('Expected queued launch');
      const operation = foreignActivitySourceSnapshot().operations[0];
      expect(operation).toMatchObject({ source: 'pipeline', active: true });
      expect(operation?.operationId).not.toBe(queued.queueId);
      expect(listQueuedHookPipelines()).toEqual([
        expect.objectContaining({
          queueId: queued.queueId,
          executionId: operation?.operationId,
        }),
      ]);
      if (outcome === 'cancelled') cancelQueuedHookPipeline(queued.queueId);
      else {
        if (outcome === 'failed')
          mockedStartPipelineExecutionFromMain.mockResolvedValueOnce({
            success: false,
            error: 'Admission failed',
          });
        releaseExecutionReservation('active-test');
        await new Promise((resolve): void => {
          setTimeout(resolve, 0);
        });
        expect(
          mockedStartPipelineExecutionFromMain.mock.calls[0]?.[0].options
            .executionId,
        ).toBe(operation?.operationId);
      }
      expect(foreignActivitySourceSnapshot().operations).toEqual([
        expect.objectContaining({
          operationId: operation?.operationId,
          active: outcome === 'started',
        }),
      ]);
      if (outcome !== 'started')
        expect(foreignActivitySourceSnapshot().operations[0]?.resultToken).toBe(
          `${operation?.operationId}:${outcome}`,
        );
    },
  );

  it('removes cancelled queued entries immediately', async () => {
    reserveExecution('active-test');

    const queued = await launchHookPipeline(
      buildLaunchArgs({
        type: 'pipeline',
        source: 'bundled',
        id: 'review',
      }),
    );

    expect(queued.status).toBe('queued');
    if (queued.status !== 'queued') {
      throw new Error('Expected queued pipeline launch result');
    }

    expect(listQueuedHookPipelines()).toHaveLength(1);
    cancelQueuedHookPipeline(queued.queueId);
    expect(listQueuedHookPipelines()).toEqual([]);
  });

  it('starts immediately when allowPipelineConcurrency is true', async () => {
    reserveExecution('active-test');

    const result = await launchHookPipeline(
      buildLaunchArgs({
        type: 'pipeline',
        source: 'bundled',
        id: 'review',
        allowPipelineConcurrency: true,
      }),
    );

    expect(result.status).toBe('started');
    expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalledTimes(1);
  });
});
