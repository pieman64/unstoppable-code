/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type {
  ScriptCompleteEvent,
  ScriptDescriptor,
  ScriptOutputEvent,
  ScriptRunRequest,
  ScriptRunResponse,
  ScriptStartedEvent,
  SingleRepoSidebarItem,
  SaveProjectScriptsRequest,
} from '@canopy/desktop-shared/types';
import type * as AcceptanceStore from '../shared-containers/acceptance-store';
import type * as FsPromises from 'node:fs/promises';

jest.mock('node:fs/promises');
// workspace.json is written atomically (CAN-3563); route the install through
// the mocked writeFile so the saves stay observable.
jest.mock('../lib/atomic-file', () => ({
  writeFileAtomically: jest.fn(
    async (
      target: string,
      data: string,
      options?: { encoding?: BufferEncoding },
    ): Promise<void> => {
      const { writeFile } =
        jest.requireMock<typeof FsPromises>('node:fs/promises');
      await writeFile(target, data, options?.encoding);
    },
  ),
}));
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    startObservedTask: jest.fn(),
    finalizeObservedTask: jest.fn(),
    observeChatEvent: jest.fn(),
    completeChatTurn: jest.fn(),
    startChatTurn: jest.fn(),
  })),
}));
jest.mock('../lib/paths', () => ({
  getWorktreeDir: jest.fn(
    (pid: string, wid: string) => `/mock/workspaces/${pid}/worktrees/${wid}`,
  ),
  getWorktreeDataDir: jest.fn(
    (pid: string, wid: string) =>
      `/mock/workspaces/${pid}/worktree-data/${wid}`,
  ),
  getWorkspaceWorktreeRepoDir: jest.fn(
    (wsId: string, wid: string, rid: string) =>
      `/mock/workspaces/${wsId}/worktrees/${wid}/repos/${rid}`,
  ),
  getWorkspaceWorktreeRootRepoDir: jest.fn(
    (wsId: string, wid: string) => `/mock/workspaces/${wsId}/worktrees/${wid}`,
  ),
  getSharedContainerRunRepoDir: jest.fn(
    (containerId: string, repoId: string) =>
      `/mock/shared-runs/${containerId}/${repoId}`,
  ),
  getWorkspaceIndexFilePath: jest.fn(() => '/mock/workspaces/index.json'),
  getProjectsFilePath: jest.fn(() => '/mock/workspaces/index.json'),
  getProjectWorktreesFilePath: jest.fn(
    (id: string) => `/mock/workspaces/${id}/worktrees.json`,
  ),
  getWorkspacesFilePath: jest.fn(() => '/mock/workspaces/index.json'),
  getWorkspaceConfigPath: jest.fn(
    (id: string) => `/mock/workspaces/${id}/workspace.json`,
  ),
  getWorkspaceWorktreesFilePath: jest.fn(
    (id: string) => `/mock/workspaces/${id}/worktrees.json`,
  ),
  getPreferencesFilePath: jest.fn(() => '/mock/preferences.json'),
  getDefaultReposDir: jest.fn(() => '/mock/repos'),
}));
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: () => boolean } => ({
    isEnabled: (): boolean => true,
  }),
}));
jest.mock('../shared-containers/acceptance-store', () => {
  const actual = jest.requireActual<typeof AcceptanceStore>(
    '../shared-containers/acceptance-store',
  );
  return {
    ...actual,
    isSharedContainerAccepted: jest.fn(() => Promise.resolve(true)),
    isSharedContainerRunAllowed: jest.fn(() => Promise.resolve(true)),
  };
});
jest.mock('../shared-containers/read/reader', () => ({
  getSharedContainerReader: jest.fn(() => ({
    store: {
      get: jest.fn(() =>
        Promise.resolve({ status: 'available', revisionId: 'revision-1' }),
      ),
    },
    readRunConfig: jest.fn(() =>
      Promise.resolve({
        commands: [
          { name: 'launch', command: 'make dev', repoId: 'published-repo' },
        ],
        requiredEnv: ['DATABASE_URL'],
      }),
    ),
  })),
}));
jest.mock('../shared-containers/run/run-copy', () => ({
  ensureSharedContainerRunCopy: jest.fn(() => Promise.resolve('/mock/run')),
  getSharedContainerRunCopyState: jest.fn(() =>
    Promise.resolve({ state: 'missing' }),
  ),
}));
jest.mock('../shared-containers/run-env-store', () => ({
  readSharedContainerRunEnvironment: jest.fn(() =>
    Promise.resolve([{ key: 'DATABASE_URL', value: 'postgres://recipient' }]),
  ),
}));
jest.mock('../lib/shared-container-run-env', () => ({
  buildSharedContainerRunEnv: jest.fn(() => ({
    PATH: '/login/bin',
    DATABASE_URL: 'postgres://recipient',
  })),
}));
jest.mock('../lib/path-safety', () => ({
  isPathInside: jest.fn(() => true),
}));
jest.mock('../lib/workspace-registry', () => ({
  registerWorkspaceTypes: jest.fn(),
  registerWorkspaceExternalPaths: jest.fn(),
}));
jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));
jest.mock('../lib/script-runner', () => ({
  isTrackedShellScriptRunning: jest.fn(() => true),
  listTrackedShellScripts: jest.fn(() => []),
  runShellScript: jest.fn(),
  stopTrackedShellScript: jest.fn(),
  drainTrackedShellScriptRunsForWorktree: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../lib/script-log-store', () => ({
  startScriptRunLog: jest.fn(
    ({
      projectId,
      worktreeId,
      script,
    }: {
      projectId: string;
      worktreeId: string;
      script: ScriptDescriptor;
    }) =>
      Promise.resolve({
        projectId,
        worktreeId,
        script,
        runId: 'run-1',
      }),
  ),
  appendScriptRunLogLines: jest.fn(() => Promise.resolve()),
  completeScriptRunLog: jest.fn(() => Promise.resolve()),
  readScriptRunLogTail: jest.fn(() =>
    Promise.resolve({ meta: null, lines: [] }),
  ),
}));
jest.mock('../services/portal-feature-event-service', () => ({
  emitPortalFeatureUpsert: jest.fn(),
}));

import { lstat, readFile, writeFile } from 'node:fs/promises';
import { registerIpcHandler } from '../ipc/register';
import { registerScriptHandlers } from '../ipc/scripts';
import {
  listWorktreeScriptEntries,
  runScript,
} from '../services/scripts-service';
import {
  type ScriptTrackingInfo,
  listTrackedShellScripts,
  runShellScript,
  stopTrackedShellScript,
  drainTrackedShellScriptRunsForWorktree,
} from '../lib/script-runner';
import {
  assertWorkspaceTargetRuntimeStartAllowed,
  resetWorkspaceTargetExclusionsForTests,
  withWorkspaceTargetRuntimePreparation,
} from '../lib/workspace-target-exclusion';
import { withSharedContainerRunLifecycle } from '../shared-containers/acceptance-store';
import {
  appendScriptRunLogLines,
  completeScriptRunLog,
  readScriptRunLogTail,
  startScriptRunLog,
} from '../lib/script-log-store';
import { resetPreferencesLoadErrorForTests } from '../lib/preferences-store';
import { emitPortalFeatureUpsert } from '../services/portal-feature-event-service';

const mockedReadFile = jest.mocked(readFile);
const mockedWriteFile = jest.mocked(writeFile);
const mockedLstat = jest.mocked(lstat);
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedRunShellScript = jest.mocked(runShellScript);
const mockedStopTrackedShellScript = jest.mocked(stopTrackedShellScript);
const mockedListTrackedShellScripts = jest.mocked(listTrackedShellScripts);
const mockedDrainTrackedShellScriptRunsForWorktree = jest.mocked(
  drainTrackedShellScriptRunsForWorktree,
);
const mockedStartScriptRunLog = jest.mocked(startScriptRunLog);
const mockedAppendScriptRunLogLines = jest.mocked(appendScriptRunLogLines);
const mockedCompleteScriptRunLog = jest.mocked(completeScriptRunLog);
const mockedReadScriptRunLogTail = jest.mocked(readScriptRunLogTail);
const mockedEmitPortalFeatureUpsert = jest.mocked(emitPortalFeatureUpsert);

type HandlerFn = (...args: unknown[]) => Promise<unknown>;
type RunShellScriptArgs = Parameters<typeof runShellScript>[0];
let runHandler: HandlerFn;
let saveProjectScriptsHandler: HandlerFn;
let stopHandler: HandlerFn;
let cancelWorktreeSetupHandler: HandlerFn;

function getPathString(pathArg: unknown): string {
  return String(pathArg);
}

function createMissingFileError(pathStr: string): Error & { code: string } {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, open '${pathStr}'`),
    { code: 'ENOENT' },
  );
}

function makeProject(
  overrides: Partial<SingleRepoSidebarItem> = {},
): SingleRepoSidebarItem {
  return {
    type: 'single-repo',
    id: 'project-1',
    name: 'Test Project',
    repoPath: '/home/user/repo',
    color: '#ff0000',
    collapsed: false,
    order: 0,
    worktrees: [],
    ...overrides,
  };
}

function makeWorkspaceIndexJson(
  workspaces: Array<Record<string, unknown>>,
  version: number = 1,
): string {
  return JSON.stringify({ version, workspaces });
}

function makeWorkspaceConfigJson(
  config: Record<string, unknown>,
  version: number = 1,
): string {
  return JSON.stringify({ version, ...config });
}

function mockSidebarItems(items: SingleRepoSidebarItem[]): void {
  mockedReadFile.mockImplementation((pathArg) => {
    const pathStr = getPathString(pathArg);
    if (pathStr === '/mock/workspaces/index.json') {
      return Promise.resolve(
        makeWorkspaceIndexJson(
          items.map((project) => ({
            id: project.id,
            name: project.name,
            type: 'single-repo',
            color: project.color,
            collapsed: project.collapsed,
            order: project.order,
          })),
        ),
      );
    }
    const workspaceConfigMatch = pathStr.match(
      /^\/mock\/workspaces\/([^/]+)\/workspace\.json$/,
    );
    if (workspaceConfigMatch) {
      const project = items.find((item) => item.id === workspaceConfigMatch[1]);
      if (!project) {
        return Promise.reject(new Error(`Unknown project: ${pathStr}`));
      }
      return Promise.resolve(
        makeWorkspaceConfigJson({
          type: 'single-repo',
          repoPath: project.repoPath,
          repos: [],
          scripts: project.scripts,
        }),
      );
    }
    if (pathStr.includes('worktrees.json')) {
      return Promise.resolve(JSON.stringify({ version: 1, worktrees: [] }));
    }
    if (pathStr.includes('preferences.json')) {
      return Promise.resolve(JSON.stringify({ version: 1 }));
    }
    if (pathStr.endsWith('/canopy.json')) {
      return Promise.reject(createMissingFileError(pathStr));
    }
    if (pathStr.endsWith('/conductor.json')) {
      return Promise.reject(createMissingFileError(pathStr));
    }
    return Promise.reject(new Error(`Unexpected readFile path: ${pathStr}`));
  });
}

const fakeEvent = { sender: { send: jest.fn() } };

beforeEach(() => {
  jest.clearAllMocks();
  // A fixture without a preferences object latches failed recovery for the
  // process; each test needs its own preferences lifetime.
  resetPreferencesLoadErrorForTests();
  mockedLstat.mockResolvedValue({
    isDirectory: (): boolean => true,
    isSymbolicLink: (): boolean => false,
  } as Awaited<ReturnType<typeof lstat>>);

  registerScriptHandlers({
    // These suites never read script definitions through core.
    dispatcher: {
      query: (): never => {
        throw new Error('The script handler tests dispatch no core query.');
      },
    },
    resolveCaller: (): never => {
      throw new Error('The script handler tests resolve no IPC caller.');
    },
  });

  const calls = mockedRegisterIpcHandler.mock.calls;
  runHandler = calls.find(([ch]) => ch === 'script:run')![1] as HandlerFn;
  saveProjectScriptsHandler = calls.find(
    ([ch]) => ch === 'project:save-scripts',
  )![1] as HandlerFn;
  stopHandler = calls.find(([ch]) => ch === 'script:stop')![1] as HandlerFn;
  cancelWorktreeSetupHandler = calls.find(
    ([ch]) => ch === 'script:cancel-worktree-setup',
  )![1] as HandlerFn;
});

describe('scripts IPC handlers', () => {
  describe('normalizeScript', () => {
    it('strips empty/whitespace-only scripts when saving', async () => {
      mockSidebarItems([makeProject()]);

      const request: SaveProjectScriptsRequest = {
        projectId: 'project-1',
        scripts: {
          setup: '   ',
          teardown: '',
        },
      };

      await saveProjectScriptsHandler(fakeEvent, request);

      const writeCall = mockedWriteFile.mock.calls.find(
        ([p]) => p === '/mock/workspaces/project-1/workspace.json',
      );
      expect(writeCall).toBeDefined();
      const written = JSON.parse(writeCall![1] as string) as {
        scripts?: Record<string, string>;
      };
      expect(written.scripts).toBeUndefined();
    });
  });

  describe('script:run NOOP behavior', () => {
    it('returns NOOP_SUCCESS when no setup script is configured', async () => {
      mockSidebarItems([makeProject({ scripts: undefined })]);

      const request: ScriptRunRequest = {
        target: 'project',
        scriptName: 'setup',
        projectId: 'project-1',
        worktreeId: 'wt-1',
      };

      const result = (await runHandler(
        fakeEvent,
        request,
      )) as ScriptRunResponse;

      expect(result).toEqual({
        success: true,
        exitCode: 0,
        output: '',
        timedOut: false,
        durationMs: 0,
      });
      expect(mockedRunShellScript).not.toHaveBeenCalled();
    });

    it('returns NOOP_SUCCESS when no teardown script is configured', async () => {
      mockSidebarItems([makeProject({ scripts: { setup: 'npm install' } })]);

      const request: ScriptRunRequest = {
        target: 'project',
        scriptName: 'teardown',
        projectId: 'project-1',
        worktreeId: 'wt-1',
      };

      const result = (await runHandler(
        fakeEvent,
        request,
      )) as ScriptRunResponse;

      expect(result.success).toBe(true);
      expect(mockedRunShellScript).not.toHaveBeenCalled();
    });

    it('returns NOOP_SUCCESS for teardown when the worktree directory is gone', async () => {
      mockSidebarItems([
        makeProject({ scripts: { teardown: 'npm run teardown' } }),
      ]);
      mockedLstat.mockImplementation((pathArg) =>
        String(pathArg) === '/mock/workspaces/project-1/worktrees/wt-1'
          ? Promise.reject(
              Object.assign(new Error('missing worktree'), { code: 'ENOENT' }),
            )
          : Promise.resolve({
              isDirectory: (): boolean => true,
              isSymbolicLink: (): boolean => false,
            } as Awaited<ReturnType<typeof lstat>>),
      );
      mockedRunShellScript.mockResolvedValue({
        success: true,
        exitCode: 0,
        output: 'ran',
        timedOut: false,
        durationMs: 1,
      });

      await expect(
        runScript({
          target: 'project',
          scriptName: 'teardown',
          projectId: 'project-1',
          worktreeId: 'wt-1',
        }),
      ).resolves.toEqual({
        success: true,
        exitCode: 0,
        output: '',
        timedOut: false,
        durationMs: 0,
      });
      expect(mockedRunShellScript).not.toHaveBeenCalled();
    });
  });

  describe('script:run execution', () => {
    describe('shared-container execution', () => {
      const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
        process,
        'platform',
      );

      beforeAll(() => {
        Object.defineProperty(process, 'platform', {
          configurable: true,
          value: 'darwin',
        });
      });

      afterAll(() => {
        if (originalPlatformDescriptor) {
          Object.defineProperty(
            process,
            'platform',
            originalPlatformDescriptor,
          );
        }
      });

      it('runs only a published shared-container command in its declared repo', async () => {
        mockedRunShellScript.mockResolvedValue({
          success: true,
          exitCode: 0,
          output: 'started',
          timedOut: false,
          durationMs: 2,
        });

        const result = await runScript({
          target: 'shared-container',
          scriptName: 'launch',
          containerId: 'container-1',
        });

        expect(result.success).toBe(true);
        expect(mockedRunShellScript).toHaveBeenCalledWith(
          expect.objectContaining({
            cwd: '/mock/shared-runs/container-1/published-repo',
            script: 'make dev',
            env: {
              PATH: '/login/bin',
              DATABASE_URL: 'postgres://recipient',
            },
          }),
        );
        expect(mockedReadFile).not.toHaveBeenCalledWith(
          expect.stringContaining('/mock/shared-runs/'),
          expect.anything(),
        );
      });

      it('holds the run lifecycle until a shared process is registered', async () => {
        let markRunnerCalled!: () => void;
        const runnerCalled = new Promise<void>((resolve) => {
          markRunnerCalled = resolve;
        });
        let completeRun!: (response: ScriptRunResponse) => void;
        const completion = new Promise<ScriptRunResponse>((resolve) => {
          completeRun = resolve;
        });
        let onProcessStarted: (() => void) | undefined;
        mockedRunShellScript.mockImplementation((options) => {
          onProcessStarted = (
            options as RunShellScriptArgs & { onProcessStarted?: () => void }
          ).onProcessStarted;
          markRunnerCalled();
          return completion;
        });

        const running = runScript({
          target: 'shared-container',
          scriptName: 'launch',
          containerId: 'container-1',
        });
        await runnerCalled;
        let teardownEntered = false;
        const teardown = withSharedContainerRunLifecycle(
          'container-1',
          (): Promise<void> => {
            teardownEntered = true;
            return Promise.resolve();
          },
        );
        await Promise.resolve();

        expect(teardownEntered).toBe(false);
        expect(onProcessStarted).toBeDefined();
        onProcessStarted?.();
        await teardown;
        expect(teardownEntered).toBe(true);
        completeRun({
          success: true,
          exitCode: 0,
          output: 'started',
          timedOut: false,
          durationMs: 2,
        });
        await expect(running).resolves.toMatchObject({ success: true });
      });

      it('refuses a shared-container command the publisher did not publish', async () => {
        // A refusal must reject: resolving `null` here would surface as a
        // successful no-op run in the viewer's run sheet.
        await expect(
          runScript({
            target: 'shared-container',
            scriptName: 'setup',
            containerId: 'container-1',
          }),
        ).rejects.toThrow('did not publish that command');
        expect(mockedRunShellScript).not.toHaveBeenCalled();
      });

      it('refuses a published shared-container command when its run-copy repo is absent', async () => {
        mockedLstat.mockRejectedValueOnce(
          Object.assign(new Error('missing run repo'), { code: 'ENOENT' }),
        );

        await expect(
          runScript({
            target: 'shared-container',
            scriptName: 'launch',
            containerId: 'container-1',
          }),
        ).rejects.toThrow('run-copy repository is unavailable');
        expect(mockedRunShellScript).not.toHaveBeenCalled();
      });
    });

    it.each(['setup', 'launch', 'teardown'] as const)(
      'keeps %s lifecycle monitoring while selecting a reachable runner',
      async (scriptName) => {
        mockSidebarItems([
          makeProject({
            scripts: {
              [scriptName]: {
                command: `npm run ${scriptName}`,
                interactive: true,
              },
            },
          }),
        ]);
        mockedRunShellScript.mockResolvedValue({
          success: true,
          exitCode: 0,
          output: 'done',
          timedOut: false,
          durationMs: 10,
        });

        await runScript({
          target: 'project',
          scriptName,
          projectId: 'project-1',
          worktreeId: 'wt-1',
        });

        const runOptions = mockedRunShellScript.mock.calls[0]?.[0];
        expect(runOptions?.interactive).toBe(scriptName !== 'teardown');
        if (scriptName !== 'teardown') {
          expect(runOptions?.timeoutSeconds).toBeNull();
        }
        expect(runOptions?.tracking?.scriptKey).toBe(`project:${scriptName}`);
        expect(runOptions?.tracking?.script?.interactive).toBe(true);
      },
    );

    it('passes timeout preference to runShellScript', async () => {
      mockedReadFile.mockImplementation((pathArg) => {
        const pathStr = getPathString(pathArg);
        if (pathStr.includes('preferences.json')) {
          return Promise.resolve(
            JSON.stringify({
              version: 1,
              preferences: { scriptTimeoutMinutes: 10 },
            }),
          );
        }
        if (pathStr === '/mock/workspaces/index.json') {
          return Promise.resolve(
            makeWorkspaceIndexJson([
              {
                id: 'project-1',
                name: 'Test',
                type: 'single-repo',
                color: '#000',
                collapsed: false,
                order: 0,
              },
            ]),
          );
        }
        if (pathStr === '/mock/workspaces/project-1/workspace.json') {
          return Promise.resolve(
            makeWorkspaceConfigJson({
              type: 'single-repo',
              repoPath: '/repo',
              repos: [],
              scripts: {
                setup: 'npm install',
              },
            }),
          );
        }
        if (pathStr.includes('worktrees.json')) {
          return Promise.resolve(JSON.stringify({ version: 1, worktrees: [] }));
        }
        if (pathStr.endsWith('/canopy.json')) {
          return Promise.reject(createMissingFileError(pathStr));
        }
        if (pathStr.endsWith('/conductor.json')) {
          return Promise.reject(createMissingFileError(pathStr));
        }
        return Promise.reject(
          new Error(`Unexpected readFile path: ${pathStr}`),
        );
      });

      mockedRunShellScript.mockResolvedValue({
        success: true,
        exitCode: 0,
        output: 'done',
        timedOut: false,
        durationMs: 500,
      });

      const request: ScriptRunRequest = {
        target: 'project',
        scriptName: 'setup',
        projectId: 'project-1',
        worktreeId: 'wt-1',
      };

      await runHandler(fakeEvent, request);

      const runArgs = mockedRunShellScript.mock.calls[0]?.[0] as
        | RunShellScriptArgs
        | undefined;
      expect(runArgs?.script).toBe('npm install');
      expect(runArgs?.timeoutSeconds).toBe(600);
      expect(runArgs?.tracking).toEqual(
        expect.objectContaining({
          projectId: 'project-1',
          worktreeId: 'wt-1',
          scriptKey: 'project:setup',
        }),
      );
      expect(runArgs?.env).toEqual(
        expect.objectContaining({
          CANOPY_WORKSPACE_ID: 'project-1',
          CANOPY_WORKTREE_NAME: 'wt-1',
          CONDUCTOR_WORKSPACE_NAME: 'wt-1',
          CANOPY_WORKTREE_DATA_DIR:
            '/mock/workspaces/project-1/worktree-data/wt-1',
        }),
      );
      expect(runArgs?.env?.CANOPY_WORKSPACE_CHILD_REPO_ID).toBeUndefined();
    });

    it('propagates failure with output and timedOut flag', async () => {
      mockSidebarItems([makeProject({ scripts: { setup: 'npm test' } })]);

      const failureResponse: ScriptRunResponse = {
        success: false,
        exitCode: 1,
        output: 'Error: test failed\nat test.js:42',
        timedOut: false,
        durationMs: 2000,
      };
      mockedRunShellScript.mockResolvedValue(failureResponse);

      const request: ScriptRunRequest = {
        target: 'project',
        scriptName: 'setup',
        projectId: 'project-1',
        worktreeId: 'wt-1',
      };

      const result = (await runHandler(
        fakeEvent,
        request,
      )) as ScriptRunResponse;

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('Error: test failed');
    });

    it('emits failed run and renderer completion when execution rejects', async () => {
      mockSidebarItems([makeProject({ scripts: { setup: 'npm test' } })]);
      mockedRunShellScript.mockRejectedValue(new Error('spawn failed'));
      const onRunUpdate = jest.fn();
      const onRendererStarted = jest.fn<void, [ScriptStartedEvent]>();
      const onRendererComplete = jest.fn<void, [ScriptCompleteEvent]>();

      await expect(
        runScript(
          {
            target: 'project',
            scriptName: 'setup',
            projectId: 'project-1',
            worktreeId: 'wt-1',
          },
          { onRunUpdate, onRendererStarted, onRendererComplete },
        ),
      ).rejects.toThrow('spawn failed');

      expect(onRendererStarted).toHaveBeenCalledTimes(1);
      expect(onRunUpdate).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'failed' }),
      );
      const completeEvent = onRendererComplete.mock.calls[0]?.[0];
      expect(completeEvent?.result.success).toBe(false);
    });

    it('keeps renderer started and complete paired when run-log start fails', async () => {
      mockSidebarItems([makeProject({ scripts: { setup: 'npm test' } })]);
      mockedStartScriptRunLog.mockRejectedValueOnce(
        new Error('log unavailable'),
      );
      mockedRunShellScript.mockResolvedValue({
        success: true,
        exitCode: 0,
        output: '',
        timedOut: false,
        durationMs: 1,
      });
      const events: string[] = [];

      await runScript(
        {
          target: 'project',
          scriptName: 'setup',
          projectId: 'project-1',
          worktreeId: 'wt-1',
        },
        {
          onRendererStarted: () => events.push('started'),
          onRendererComplete: () => events.push('complete'),
        },
      );

      expect(events).toEqual(['started', 'complete']);
    });

    it('signals execution start only after the initial run update', async () => {
      mockSidebarItems([makeProject({ scripts: { setup: 'npm test' } })]);
      const order: string[] = [];
      mockedRunShellScript.mockImplementation((options) => {
        order.push('process-started');
        options.onProcessStarted?.();
        return new Promise<never>(() => undefined);
      });
      let markStarted: () => void = (): void => undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });

      void runScript(
        {
          target: 'project',
          scriptName: 'setup',
          projectId: 'project-1',
          worktreeId: 'wt-1',
        },
        {
          onRunUpdate: () => order.push('run-update'),
          onExecutionStarted: () => {
            order.push('started');
            markStarted();
          },
        },
      );
      await started;

      expect(order).toEqual(['run-update', 'process-started', 'started']);
    });

    it('refuses a run whose script changed after the caller checked it', async () => {
      mockSidebarItems([makeProject({ scripts: { setup: 'npm test' } })]);
      mockedRunShellScript.mockResolvedValue({
        success: true,
        exitCode: 0,
        output: '',
        timedOut: false,
        durationMs: 1,
      });
      const request: ScriptRunRequest = {
        target: 'project',
        scriptName: 'setup',
        projectId: 'project-1',
        worktreeId: 'wt-1',
      };

      await expect(
        runScript(request, {
          expectedScript: { command: 'npm run approved', interactive: false },
        }),
      ).rejects.toThrow('changed after it was checked');
      expect(mockedRunShellScript).not.toHaveBeenCalled();

      // The approved command under a different shell is refused too.
      await expect(
        runScript(request, {
          expectedScript: {
            command: 'npm test',
            interactive: false,
            shell: { mac: 'bash', windows: 'powershell' },
          },
        }),
      ).rejects.toThrow('changed after it was checked');
      expect(mockedRunShellScript).not.toHaveBeenCalled();

      await expect(
        runScript(request, {
          expectedScript: { command: 'npm test', interactive: false },
        }),
      ).resolves.toMatchObject({ success: true });
      expect(mockedRunShellScript).toHaveBeenCalledWith(
        expect.objectContaining({ script: 'npm test' }),
      );
    });

    it('does not signal execution start when the process fails to launch', async () => {
      mockSidebarItems([makeProject({ scripts: { setup: 'npm test' } })]);
      // A spawn failure resolves the run without starting a process.
      mockedRunShellScript.mockResolvedValue({
        success: false,
        exitCode: 1,
        output: 'spawn ENOENT',
        timedOut: false,
        durationMs: 0,
      });
      const onExecutionStarted = jest.fn();

      const response = await runScript(
        {
          target: 'project',
          scriptName: 'setup',
          projectId: 'project-1',
          worktreeId: 'wt-1',
        },
        { onExecutionStarted },
      );

      expect(response.success).toBe(false);
      expect(onExecutionStarted).not.toHaveBeenCalled();
    });

    it('propagates timedOut flag from runShellScript', async () => {
      mockSidebarItems([makeProject({ scripts: { setup: 'sleep 999' } })]);

      mockedRunShellScript.mockResolvedValue({
        success: false,
        exitCode: null,
        output: '',
        timedOut: true,
        durationMs: 300000,
      });

      const request: ScriptRunRequest = {
        target: 'project',
        scriptName: 'setup',
        projectId: 'project-1',
        worktreeId: 'wt-1',
      };

      const result = (await runHandler(
        fakeEvent,
        request,
      )) as ScriptRunResponse;

      expect(result.success).toBe(false);
      expect(result.timedOut).toBe(true);
    });

    it('persists manual project runs', async () => {
      mockSidebarItems([makeProject({ scripts: { setup: 'npm install' } })]);
      mockedRunShellScript.mockImplementation((options) => {
        options.onChunk?.(['line 1', 'line 2']);
        return Promise.resolve({
          success: true,
          exitCode: 0,
          output: 'line 1\nline 2',
          timedOut: false,
          durationMs: 50,
        });
      });

      await runHandler(fakeEvent, {
        target: 'project',
        scriptName: 'setup',
        projectId: 'project-1',
        worktreeId: 'wt-1',
      });

      expect(mockedStartScriptRunLog).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-1',
          worktreeId: 'wt-1',
        }),
      );
      expect(mockedAppendScriptRunLogLines).toHaveBeenCalledWith(
        expect.objectContaining({
          lines: ['line 1', 'line 2'],
        }),
      );
      expect(mockedCompleteScriptRunLog).toHaveBeenCalled();
      const completeArg = mockedCompleteScriptRunLog.mock.calls[0]?.[0] as
        | { response: ScriptRunResponse }
        | undefined;
      expect(completeArg).toBeDefined();
      if (!completeArg) {
        throw new Error('Expected completeScriptRunLog to be called');
      }
      expect(completeArg.response.success).toBe(true);
      expect(completeArg.response.durationMs).toBe(50);
    });

    it('threads devServerPattern through manual project run descriptors and output events', async () => {
      const devServerPattern = {
        pattern: 'Local:\\s+(https?://\\S+)',
        label: 'Local',
      };
      mockSidebarItems([
        makeProject({
          scripts: {
            launch: {
              command: 'npm run dev',
              devServerPattern,
            },
          },
        }),
      ]);
      mockedRunShellScript.mockImplementation((options) => {
        options.onChunk?.(['Local: http://localhost:3000']);
        return Promise.resolve({
          success: true,
          exitCode: 0,
          output: 'Local: http://localhost:3000',
          timedOut: false,
          durationMs: 50,
        });
      });

      await runHandler(fakeEvent, {
        target: 'project',
        scriptName: 'launch',
        projectId: 'project-1',
        worktreeId: 'wt-1',
      });

      const startCall = mockedStartScriptRunLog.mock.calls[0]?.[0];
      expect(startCall?.script.devServerPattern).toEqual(devServerPattern);
      const outputCall = fakeEvent.sender.send.mock.calls.find(
        ([channel]) => channel === 'script:output',
      ) as unknown as [string, ScriptOutputEvent] | undefined;
      expect(outputCall?.[1].script.command).toBe('');
      expect(outputCall?.[1].script.devServerPattern).toEqual(devServerPattern);
    });

    it('treats script log persistence as best-effort', async () => {
      mockSidebarItems([makeProject({ scripts: { setup: 'npm install' } })]);
      mockedStartScriptRunLog.mockRejectedValueOnce(
        new Error('disk unavailable'),
      );
      mockedRunShellScript.mockResolvedValue({
        success: true,
        exitCode: 0,
        output: 'done',
        timedOut: false,
        durationMs: 25,
      });

      const result = (await runHandler(fakeEvent, {
        target: 'project',
        scriptName: 'setup',
        projectId: 'project-1',
        worktreeId: 'wt-1',
      })) as ScriptRunResponse;

      expect(result.success).toBe(true);
      const runArgs = mockedRunShellScript.mock.calls[0]?.[0] as
        | RunShellScriptArgs
        | undefined;
      expect(runArgs?.tracking).toEqual(
        expect.objectContaining({
          projectId: 'project-1',
          worktreeId: 'wt-1',
          scriptKey: 'project:setup',
          logRef: undefined,
        }),
      );
      expect(mockedAppendScriptRunLogLines).not.toHaveBeenCalled();
      expect(mockedCompleteScriptRunLog).not.toHaveBeenCalled();
    });
  });

  describe('launch script phase', () => {
    it('returns NOOP_SUCCESS when no launch script is configured', async () => {
      mockSidebarItems([makeProject({ scripts: undefined })]);

      const request: ScriptRunRequest = {
        target: 'project',
        scriptName: 'launch',
        projectId: 'project-1',
        worktreeId: 'wt-1',
      };

      const result = (await runHandler(
        fakeEvent,
        request,
      )) as ScriptRunResponse;

      expect(result).toEqual({
        success: true,
        exitCode: 0,
        output: '',
        timedOut: false,
        durationMs: 0,
      });
      expect(mockedRunShellScript).not.toHaveBeenCalled();
    });

    it('executes launch script when configured', async () => {
      mockSidebarItems([makeProject({ scripts: { launch: 'npm run build' } })]);

      mockedRunShellScript.mockResolvedValue({
        success: true,
        exitCode: 0,
        output: 'done',
        timedOut: false,
        durationMs: 1200,
      });

      const request: ScriptRunRequest = {
        target: 'project',
        scriptName: 'launch',
        projectId: 'project-1',
        worktreeId: 'wt-1',
      };

      const result = (await runHandler(
        fakeEvent,
        request,
      )) as ScriptRunResponse;

      expect(result.success).toBe(true);
      const runArgs = mockedRunShellScript.mock.calls[0]?.[0] as
        | RunShellScriptArgs
        | undefined;
      expect(runArgs?.script).toBe('npm run build');
      expect(runArgs?.tracking).toEqual(
        expect.objectContaining({
          projectId: 'project-1',
          worktreeId: 'wt-1',
          scriptKey: 'project:launch',
        }),
      );
      expect(runArgs?.env).toEqual(
        expect.objectContaining({
          CANOPY_WORKSPACE_ID: 'project-1',
          CANOPY_WORKTREE_NAME: 'wt-1',
          CONDUCTOR_WORKSPACE_NAME: 'wt-1',
          CANOPY_WORKTREE_DATA_DIR:
            '/mock/workspaces/project-1/worktree-data/wt-1',
        }),
      );
      expect(runArgs?.env?.CANOPY_WORKSPACE_CHILD_REPO_ID).toBeUndefined();
    });

    it('executes launch script from conductor.json when higher-priority sources are absent', async () => {
      mockedReadFile.mockImplementation((pathArg) => {
        const pathStr = getPathString(pathArg);
        if (pathStr === '/mock/workspaces/index.json') {
          return Promise.resolve(
            makeWorkspaceIndexJson([
              {
                id: 'project-1',
                name: 'Test',
                type: 'single-repo',
                color: '#000',
                collapsed: false,
                order: 0,
              },
            ]),
          );
        }
        if (pathStr === '/mock/workspaces/project-1/workspace.json') {
          return Promise.resolve(
            makeWorkspaceConfigJson({
              type: 'single-repo',
              repoPath: '/repo',
              repos: [],
            }),
          );
        }
        if (pathStr.includes('worktrees.json')) {
          return Promise.resolve(JSON.stringify({ version: 1, worktrees: [] }));
        }
        if (pathStr.includes('preferences.json')) {
          return Promise.resolve(JSON.stringify({ version: 1 }));
        }
        if (pathStr.endsWith('/canopy.json')) {
          return Promise.reject(createMissingFileError(pathStr));
        }
        if (pathStr.endsWith('/conductor.json')) {
          return Promise.resolve(
            JSON.stringify({
              scripts: {
                run: 'npm run legacy-dev',
              },
            }),
          );
        }
        return Promise.reject(
          new Error(`Unexpected readFile path: ${pathStr}`),
        );
      });

      mockedRunShellScript.mockResolvedValue({
        success: true,
        exitCode: 0,
        output: 'started',
        timedOut: false,
        durationMs: 250,
      });

      const request: ScriptRunRequest = {
        target: 'project',
        scriptName: 'launch',
        projectId: 'project-1',
        worktreeId: 'wt-1',
      };

      const result = (await runHandler(
        fakeEvent,
        request,
      )) as ScriptRunResponse;

      expect(result.success).toBe(true);
      const runArgs = mockedRunShellScript.mock.calls[0]?.[0] as
        | RunShellScriptArgs
        | undefined;
      expect(runArgs?.script).toBe('npm run legacy-dev');
      expect(runArgs?.tracking).toEqual(
        expect.objectContaining({
          projectId: 'project-1',
          worktreeId: 'wt-1',
          scriptKey: 'project:launch',
        }),
      );
    });

    it('executes launch script from the current worktree conductor.json', async () => {
      mockedReadFile.mockImplementation((pathArg) => {
        const pathStr = getPathString(pathArg);
        if (pathStr === '/mock/workspaces/index.json') {
          return Promise.resolve(
            makeWorkspaceIndexJson([
              {
                id: 'project-1',
                name: 'Test',
                type: 'single-repo',
                color: '#000',
                collapsed: false,
                order: 0,
              },
            ]),
          );
        }
        if (pathStr === '/mock/workspaces/project-1/workspace.json') {
          return Promise.resolve(
            makeWorkspaceConfigJson({
              type: 'single-repo',
              repoPath: '/repo',
              repos: [],
            }),
          );
        }
        if (pathStr.includes('worktrees.json')) {
          return Promise.resolve(JSON.stringify({ version: 1, worktrees: [] }));
        }
        if (pathStr.includes('preferences.json')) {
          return Promise.resolve(JSON.stringify({ version: 1 }));
        }
        if (
          pathStr === '/mock/workspaces/project-1/worktrees/wt-1/conductor.json'
        ) {
          return Promise.resolve(
            JSON.stringify({
              scripts: {
                run: 'pnpm dev:worktree',
              },
            }),
          );
        }
        if (pathStr.endsWith('/canopy.json')) {
          return Promise.reject(createMissingFileError(pathStr));
        }
        if (pathStr.endsWith('/conductor.json')) {
          return Promise.reject(createMissingFileError(pathStr));
        }
        return Promise.reject(
          new Error(`Unexpected readFile path: ${pathStr}`),
        );
      });

      mockedRunShellScript.mockResolvedValue({
        success: true,
        exitCode: 0,
        output: 'started',
        timedOut: false,
        durationMs: 250,
      });

      const request: ScriptRunRequest = {
        target: 'project',
        scriptName: 'launch',
        projectId: 'project-1',
        worktreeId: 'wt-1',
      };

      const result = (await runHandler(
        fakeEvent,
        request,
      )) as ScriptRunResponse;

      expect(result.success).toBe(true);
      const runArgs = mockedRunShellScript.mock.calls[0]?.[0] as
        | RunShellScriptArgs
        | undefined;
      expect(runArgs?.script).toBe('pnpm dev:worktree');
      expect(runArgs?.cwd).toBe('/mock/workspaces/project-1/worktrees/wt-1');
      expect(runArgs?.tracking).toEqual(
        expect.objectContaining({
          projectId: 'project-1',
          worktreeId: 'wt-1',
          scriptKey: 'project:launch',
        }),
      );
    });

    it('passes timeoutSeconds null for launch to disable timeout', async () => {
      mockedReadFile.mockImplementation((pathArg) => {
        const pathStr = getPathString(pathArg);
        if (pathStr.includes('preferences.json')) {
          return Promise.resolve(
            JSON.stringify({
              version: 1,
              preferences: { scriptTimeoutMinutes: 10 },
            }),
          );
        }
        if (pathStr === '/mock/workspaces/index.json') {
          return Promise.resolve(
            makeWorkspaceIndexJson([
              {
                id: 'project-1',
                name: 'Test',
                type: 'single-repo',
                color: '#000',
                collapsed: false,
                order: 0,
              },
            ]),
          );
        }
        if (pathStr === '/mock/workspaces/project-1/workspace.json') {
          return Promise.resolve(
            makeWorkspaceConfigJson({
              type: 'single-repo',
              repoPath: '/repo',
              repos: [],
              scripts: {
                launch: 'npm start',
              },
            }),
          );
        }
        if (pathStr.includes('worktrees.json')) {
          return Promise.resolve(JSON.stringify({ version: 1, worktrees: [] }));
        }
        if (pathStr.endsWith('/canopy.json')) {
          return Promise.reject(createMissingFileError(pathStr));
        }
        if (pathStr.endsWith('/conductor.json')) {
          return Promise.reject(createMissingFileError(pathStr));
        }
        return Promise.reject(
          new Error(`Unexpected readFile path: ${pathStr}`),
        );
      });

      mockedRunShellScript.mockResolvedValue({
        success: true,
        exitCode: 0,
        output: 'running',
        timedOut: false,
        durationMs: 100,
      });

      const request: ScriptRunRequest = {
        target: 'project',
        scriptName: 'launch',
        projectId: 'project-1',
        worktreeId: 'wt-1',
      };

      await runHandler(fakeEvent, request);

      expect(mockedRunShellScript).toHaveBeenCalledWith(
        expect.objectContaining({
          timeoutSeconds: null,
        }),
      );
    });
  });

  describe('workspace-repo launch script phase', () => {
    function mockWorkspaceRepo(
      repoOverrides: Record<string, unknown> = {},
    ): void {
      mockedReadFile.mockImplementation((pathArg) => {
        const pathStr = getPathString(pathArg);
        if (pathStr.includes('workspace.json')) {
          return Promise.resolve(
            makeWorkspaceConfigJson({
              type: 'multi-repo',
              sourceRepoPath: '/repos/workspace-root',
              repos: [
                {
                  id: 'repo-a',
                  name: 'Repo A',
                  repoPath: '/repos/repo-a',
                  scripts: repoOverrides,
                },
              ],
            }),
          );
        }
        if (pathStr.includes('preferences.json')) {
          return Promise.resolve(JSON.stringify({ version: 1 }));
        }
        if (pathStr.endsWith('/canopy.json')) {
          return Promise.reject(createMissingFileError(pathStr));
        }
        if (pathStr.endsWith('/conductor.json')) {
          return Promise.reject(createMissingFileError(pathStr));
        }
        return Promise.reject(
          new Error(`Unexpected readFile path: ${pathStr}`),
        );
      });
    }

    it('returns NOOP_SUCCESS when no launch script is configured', async () => {
      mockWorkspaceRepo({});

      const request: ScriptRunRequest = {
        target: 'workspace-repo',
        scriptName: 'launch',
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        repoId: 'repo-a',
      };

      const result = (await runHandler(
        fakeEvent,
        request,
      )) as ScriptRunResponse;

      expect(result).toEqual({
        success: true,
        exitCode: 0,
        output: '',
        timedOut: false,
        durationMs: 0,
      });
      expect(mockedRunShellScript).not.toHaveBeenCalled();
    });

    it('executes launch script when configured', async () => {
      mockWorkspaceRepo({ launch: 'npm run dev' });

      mockedRunShellScript.mockResolvedValue({
        success: true,
        exitCode: 0,
        output: 'started',
        timedOut: false,
        durationMs: 800,
      });

      const request: ScriptRunRequest = {
        target: 'workspace-repo',
        scriptName: 'launch',
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        repoId: 'repo-a',
      };

      const result = (await runHandler(
        fakeEvent,
        request,
      )) as ScriptRunResponse;

      expect(result.success).toBe(true);
      const runArgs = mockedRunShellScript.mock.calls[0]?.[0] as
        | RunShellScriptArgs
        | undefined;
      expect(runArgs?.script).toBe('npm run dev');
      expect(runArgs?.tracking).toEqual(
        expect.objectContaining({
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          scriptKey: 'workspace-repo:repo-a:launch',
        }),
      );
      expect(runArgs?.env).toEqual(
        expect.objectContaining({
          CANOPY_WORKSPACE_ID: 'ws-1',
          CANOPY_WORKTREE_NAME: 'wt-1',
          CONDUCTOR_WORKSPACE_NAME: 'wt-1',
          CANOPY_WORKTREE_DATA_DIR: '/mock/workspaces/ws-1/worktree-data/wt-1',
          CANOPY_WORKSPACE_CHILD_REPO_ID: 'repo-a',
        }),
      );
    });

    it('resolves launch script from the child worktree checkout conductor.json', async () => {
      mockedReadFile.mockImplementation((pathArg) => {
        const pathStr = getPathString(pathArg);
        if (pathStr.includes('workspace.json')) {
          return Promise.resolve(
            makeWorkspaceConfigJson({
              type: 'multi-repo',
              sourceRepoPath: '/repos/workspace-root',
              repos: [
                {
                  id: 'repo-a',
                  name: 'Repo A',
                  repoPath: '/repos/repo-a',
                },
              ],
            }),
          );
        }
        if (pathStr.includes('preferences.json')) {
          return Promise.resolve(JSON.stringify({ version: 1 }));
        }
        if (pathStr === '/mock/workspaces/ws-1/worktrees/wt-1/canopy.json') {
          return Promise.resolve(JSON.stringify({ version: 1, repos: [] }));
        }
        if (
          pathStr ===
          '/mock/workspaces/ws-1/worktrees/wt-1/repos/repo-a/conductor.json'
        ) {
          return Promise.resolve(
            JSON.stringify({
              scripts: {
                run: 'pnpm dev:worktree',
              },
            }),
          );
        }
        if (pathStr.endsWith('/canopy.json')) {
          return Promise.reject(createMissingFileError(pathStr));
        }
        if (pathStr.endsWith('/conductor.json')) {
          return Promise.reject(createMissingFileError(pathStr));
        }
        return Promise.reject(
          new Error(`Unexpected readFile path: ${pathStr}`),
        );
      });

      mockedRunShellScript.mockResolvedValue({
        success: true,
        exitCode: 0,
        output: 'started',
        timedOut: false,
        durationMs: 800,
      });

      const request: ScriptRunRequest = {
        target: 'workspace-repo',
        scriptName: 'launch',
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        repoId: 'repo-a',
      };

      const result = (await runHandler(
        fakeEvent,
        request,
      )) as ScriptRunResponse;

      expect(result.success).toBe(true);
      const runArgs = mockedRunShellScript.mock.calls[0]?.[0] as
        | RunShellScriptArgs
        | undefined;
      expect(runArgs?.script).toBe('pnpm dev:worktree');
      expect(runArgs?.cwd).toBe(
        '/mock/workspaces/ws-1/worktrees/wt-1/repos/repo-a',
      );
      expect(runArgs?.tracking).toEqual(
        expect.objectContaining({
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          scriptKey: 'workspace-repo:repo-a:launch',
        }),
      );
    });

    it('persists manual workspace-repo runs', async () => {
      mockWorkspaceRepo({ launch: 'npm run dev' });
      mockedRunShellScript.mockImplementation((options) => {
        options.onChunk?.(['repo line']);
        return Promise.resolve({
          success: true,
          exitCode: 0,
          output: 'repo line',
          timedOut: false,
          durationMs: 75,
        });
      });

      await runHandler(fakeEvent, {
        target: 'workspace-repo',
        scriptName: 'launch',
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        repoId: 'repo-a',
      });

      const startCall = mockedStartScriptRunLog.mock.calls[0]?.[0];
      expect(startCall?.projectId).toBe('ws-1');
      expect(startCall?.worktreeId).toBe('wt-1');
      expect(startCall?.script.scriptKey).toBe('workspace-repo:repo-a:launch');
      expect(mockedAppendScriptRunLogLines).toHaveBeenCalledWith(
        expect.objectContaining({
          lines: ['repo line'],
        }),
      );
    });

    it('threads child repo devServerPattern without leaking workspace-root patterns', async () => {
      const repoPattern = [
        { pattern: 'Repo:\\s+(https?://\\S+)', label: 'Repo' },
        'https?://127\\.0\\.0\\.1:\\d+\\S*',
      ];
      mockedReadFile.mockImplementation((pathArg) => {
        const pathStr = getPathString(pathArg);
        if (pathStr.includes('workspace.json')) {
          return Promise.resolve(
            makeWorkspaceConfigJson({
              type: 'multi-repo',
              sourceRepoPath: '/repos/workspace-root',
              repos: [
                {
                  id: 'repo-a',
                  name: 'Repo A',
                  repoPath: '/repos/repo-a',
                  scripts: {
                    launch: {
                      command: 'npm run dev',
                      devServerPattern: repoPattern,
                    },
                  },
                },
              ],
              scripts: {
                launch: {
                  command: 'npm run root',
                  devServerPattern: 'Root:\\s+(https?://\\S+)',
                },
              },
            }),
          );
        }
        if (pathStr.includes('preferences.json')) {
          return Promise.resolve(JSON.stringify({ version: 1 }));
        }
        if (pathStr.endsWith('/canopy.json')) {
          return Promise.reject(createMissingFileError(pathStr));
        }
        if (pathStr.endsWith('/conductor.json')) {
          return Promise.reject(createMissingFileError(pathStr));
        }
        return Promise.reject(
          new Error(`Unexpected readFile path: ${pathStr}`),
        );
      });
      mockedRunShellScript.mockResolvedValue({
        success: true,
        exitCode: 0,
        output: 'started',
        timedOut: false,
        durationMs: 800,
      });

      await runHandler(fakeEvent, {
        target: 'workspace-repo',
        scriptName: 'launch',
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        repoId: 'repo-a',
      });

      const startCall = mockedStartScriptRunLog.mock.calls[0]?.[0];
      expect(startCall?.script).toEqual(
        expect.objectContaining({
          scriptKey: 'workspace-repo:repo-a:launch',
          devServerPattern: repoPattern,
        }),
      );
    });
  });

  describe('workspace-root manual lifecycle', () => {
    it('persists workspace-root runs', async () => {
      mockedReadFile.mockImplementation((pathArg) => {
        const pathStr = getPathString(pathArg);
        if (pathStr.includes('workspace.json')) {
          return Promise.resolve(
            makeWorkspaceConfigJson({
              type: 'multi-repo',
              sourceRepoPath: '/repos/workspace-root',
              repos: [],
              scripts: {
                'before-setup': 'echo preparing',
              },
            }),
          );
        }
        if (pathStr.includes('preferences.json')) {
          return Promise.resolve(JSON.stringify({ version: 1 }));
        }
        if (pathStr.endsWith('/canopy.json')) {
          return Promise.reject(createMissingFileError(pathStr));
        }
        if (pathStr.endsWith('/conductor.json')) {
          return Promise.reject(createMissingFileError(pathStr));
        }
        return Promise.reject(
          new Error(`Unexpected readFile path: ${pathStr}`),
        );
      });

      mockedRunShellScript.mockImplementation((options) => {
        options.onChunk?.(['root line']);
        return Promise.resolve({
          success: true,
          exitCode: 0,
          output: 'root line',
          timedOut: false,
          durationMs: 25,
        });
      });

      await runHandler(fakeEvent, {
        target: 'workspace-root',
        scriptName: 'before-setup',
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
      });

      expect(mockedStartScriptRunLog).toHaveBeenCalled();
      const startArg = mockedStartScriptRunLog.mock.calls[0][0];
      expect(startArg.projectId).toBe('ws-1');
      expect(startArg.worktreeId).toBe('wt-1');
      expect(startArg.script.scriptKey).toBe('workspace-root:before-setup');
      expect(mockedAppendScriptRunLogLines).toHaveBeenCalledWith(
        expect.objectContaining({
          lines: ['root line'],
        }),
      );
      const runArgs = mockedRunShellScript.mock.calls[0]?.[0] as
        | RunShellScriptArgs
        | undefined;
      expect(runArgs?.env).toEqual(
        expect.objectContaining({
          CANOPY_WORKSPACE_ID: 'ws-1',
          CANOPY_WORKTREE_NAME: 'wt-1',
          CONDUCTOR_WORKSPACE_NAME: 'wt-1',
          CANOPY_WORKTREE_DATA_DIR: '/mock/workspaces/ws-1/worktree-data/wt-1',
        }),
      );
      expect(runArgs?.env?.CANOPY_WORKSPACE_CHILD_REPO_ID).toBeUndefined();
    });

    it('threads workspace-root devServerPattern without leaking child repo patterns', async () => {
      const rootPattern = 'Root:\\s+(https?://\\S+)';
      mockedReadFile.mockImplementation((pathArg) => {
        const pathStr = getPathString(pathArg);
        if (pathStr.includes('workspace.json')) {
          return Promise.resolve(
            makeWorkspaceConfigJson({
              type: 'multi-repo',
              sourceRepoPath: '/repos/workspace-root',
              repos: [
                {
                  id: 'repo-a',
                  name: 'Repo A',
                  repoPath: '/repos/repo-a',
                  scripts: {
                    'before-setup': {
                      command: 'npm run repo',
                      devServerPattern: 'Repo:\\s+(https?://\\S+)',
                    },
                  },
                },
              ],
              scripts: {
                'before-setup': {
                  command: 'echo preparing',
                  devServerPattern: rootPattern,
                },
              },
            }),
          );
        }
        if (pathStr.includes('preferences.json')) {
          return Promise.resolve(JSON.stringify({ version: 1 }));
        }
        if (pathStr.endsWith('/canopy.json')) {
          return Promise.reject(createMissingFileError(pathStr));
        }
        if (pathStr.endsWith('/conductor.json')) {
          return Promise.reject(createMissingFileError(pathStr));
        }
        return Promise.reject(
          new Error(`Unexpected readFile path: ${pathStr}`),
        );
      });
      mockedRunShellScript.mockResolvedValue({
        success: true,
        exitCode: 0,
        output: 'root',
        timedOut: false,
        durationMs: 25,
      });

      await runHandler(fakeEvent, {
        target: 'workspace-root',
        scriptName: 'before-setup',
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
      });

      const startArg = mockedStartScriptRunLog.mock.calls[0][0];
      expect(startArg.script).toEqual(
        expect.objectContaining({
          scriptKey: 'workspace-root:before-setup',
          devServerPattern: rootPattern,
        }),
      );
    });
  });

  describe('script:stop', () => {
    it('stops the tracked script for the requested worktree', async () => {
      mockedStopTrackedShellScript.mockResolvedValue({
        response: {
          success: false,
          exitCode: null,
          output: '',
          timedOut: false,
          durationMs: 10,
        },
        tracking: {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          scriptKey: 'project:setup',
          logRef: {
            projectId: 'project-1',
            worktreeId: 'wt-1',
            script: {
              scriptKey: 'project:setup',
              scriptName: 'setup',
              label: 'Setup',
              command: 'npm install',
              lifecycle: 'setup',
              target: 'project',
            },
            runId: 'run-1',
          },
        },
      });

      await stopHandler(fakeEvent, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        scriptKey: 'project:setup',
      });

      expect(mockedStopTrackedShellScript).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'wt-1',
        scriptKey: 'project:setup',
      });
      const [channel, event] = fakeEvent.sender.send.mock.calls[0] as [
        string,
        ScriptCompleteEvent,
      ];
      expect(channel).toBe('script:complete');
      expect(event.projectId).toBe('project-1');
      expect(event.worktreeId).toBe('wt-1');
      expect(event.invocation).toBe('manual-run');
      expect(event.result.success).toBe(false);
      expect(event.result.exitCode).toBeNull();
      expect(event.script.scriptKey).toBe('project:setup');
      const completeCall = mockedCompleteScriptRunLog.mock.calls[0]?.[0] as
        | { ref: { runId: string }; response: ScriptRunResponse }
        | undefined;
      expect(completeCall?.ref.runId).toBe('run-1');
      expect(completeCall?.response.exitCode).toBeNull();
    });

    it('emits script complete when the tracked script has no log ref', async () => {
      mockedStopTrackedShellScript.mockResolvedValue({
        response: {
          success: false,
          exitCode: null,
          output: '',
          timedOut: false,
          durationMs: 10,
        },
        tracking: {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          scriptKey: 'project:setup',
          script: {
            scriptKey: 'project:setup',
            scriptName: 'setup',
            label: 'Setup',
            command: 'npm install',
            lifecycle: 'setup',
            target: 'project',
          },
          invocation: 'manual-run',
        },
      });

      await stopHandler(fakeEvent, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        scriptKey: 'project:setup',
      });

      expect(mockedCompleteScriptRunLog).not.toHaveBeenCalled();
      const [channel, event] = fakeEvent.sender.send.mock.calls[0] as [
        string,
        ScriptCompleteEvent,
      ];
      expect(channel).toBe('script:complete');
      expect(event.projectId).toBe('project-1');
      expect(event.worktreeId).toBe('wt-1');
      expect(event.invocation).toBe('manual-run');
      expect(event.result.exitCode).toBeNull();
      expect(event.script.scriptKey).toBe('project:setup');
    });
  });

  describe('script:cancel-worktree-setup', () => {
    const setupScript = {
      scriptKey: 'workspace-repo:api:setup',
      scriptName: 'setup',
      label: 'Setup',
      command: 'npm install',
      lifecycle: 'setup',
      target: 'workspace-repo',
    } satisfies ScriptDescriptor;

    // Stands in for the runner's registry: every concrete run of the
    // worktree, including runs that share a script key.
    function trackRunningScripts(runs: ScriptTrackingInfo[]): void {
      mockedListTrackedShellScripts.mockReturnValue(runs);
      mockedDrainTrackedShellScriptRunsForWorktree.mockImplementation(
        (target, shouldDrain) =>
          Promise.resolve(
            runs
              .filter(
                (run) =>
                  run.projectId === target.projectId &&
                  run.worktreeId === target.worktreeId &&
                  shouldDrain(run),
              )
              .map((tracking) => ({
                response: {
                  success: false,
                  exitCode: null,
                  output: '',
                  timedOut: false,
                  durationMs: 10,
                },
                tracking,
              })),
          ),
      );
    }

    beforeEach(() => {
      resetWorkspaceTargetExclusionsForTests();
      trackRunningScripts([]);
    });

    it.each([
      ['a manual run started first', ['manual-run', 'automatic-setup']],
      ['the setup run started first', ['automatic-setup', 'manual-run']],
    ] as const)(
      'ends the setup run and a manual run of the same script, and no other script, when %s',
      async (_order, invocations) => {
        const launchScript = {
          ...setupScript,
          scriptKey: 'workspace-root:launch',
          scriptName: 'launch',
        } satisfies ScriptDescriptor;
        trackRunningScripts([
          {
            projectId: 'workspace-1',
            worktreeId: 'wt-1',
            scriptKey: 'workspace-root:before-setup',
            runId: 'run-before-setup',
            invocation: 'workspace-lifecycle',
          },
          ...invocations.map((invocation) => ({
            projectId: 'workspace-1',
            worktreeId: 'wt-1',
            scriptKey: setupScript.scriptKey,
            runId: `run-${invocation}`,
            script: setupScript,
            invocation,
          })),
          {
            projectId: 'workspace-1',
            worktreeId: 'wt-1',
            scriptKey: launchScript.scriptKey,
            runId: 'run-launch',
            script: launchScript,
            invocation: 'manual-run',
          },
          // Another worktree's setup of the launch script must not make this
          // worktree's launch run a setup sibling.
          {
            projectId: 'workspace-1',
            worktreeId: 'wt-2',
            scriptKey: launchScript.scriptKey,
            runId: 'run-other-worktree',
            script: launchScript,
            invocation: 'automatic-setup',
          },
        ]);

        await cancelWorktreeSetupHandler(fakeEvent, {
          projectId: 'workspace-1',
          worktreeId: 'wt-1',
        });

        // A stop by script key would miss a setup run hidden behind a manual
        // run of the same script, and would not end its process group.
        expect(mockedStopTrackedShellScript).not.toHaveBeenCalled();
        const completed = fakeEvent.sender.send.mock.calls.map(
          ([channel, event]: [string, ScriptCompleteEvent]) => [
            channel,
            event.runId,
          ],
        );
        expect(completed).toEqual(
          invocations.map((invocation) => [
            'script:complete',
            `run-${invocation}`,
          ]),
        );
      },
    );

    it('reports a cancelled run to the portal only when it is still the latest run of its script', async () => {
      trackRunningScripts([
        {
          projectId: 'workspace-1',
          worktreeId: 'wt-1',
          scriptKey: setupScript.scriptKey,
          runId: 'run-automatic-setup',
          script: setupScript,
          invocation: 'automatic-setup',
        },
      ]);
      const latestRunOfTheKey = (runId: string): void => {
        mockedReadScriptRunLogTail.mockResolvedValueOnce({
          meta: {
            version: 1,
            runId,
            script: setupScript,
            invocation: 'manual-run',
            status: 'success',
            startedAt: '2026-10-12T00:00:00.000Z',
            updatedAt: '2026-10-12T00:00:00.000Z',
            exitCode: null,
            timedOut: false,
            durationMs: 0,
          },
          lines: [],
        });
      };
      const cancelledRunIds = (): string[] =>
        mockedEmitPortalFeatureUpsert.mock.calls.map(
          ([event]) => event.entity.localId,
        );

      // A newer run of the same script, since finished, owns the latest log.
      latestRunOfTheKey('run-manual-run');
      await cancelWorktreeSetupHandler(fakeEvent, {
        projectId: 'workspace-1',
        worktreeId: 'wt-1',
      });
      expect(cancelledRunIds()).toEqual([]);

      latestRunOfTheKey('run-automatic-setup');
      await cancelWorktreeSetupHandler(fakeEvent, {
        projectId: 'workspace-1',
        worktreeId: 'wt-1',
      });
      expect(cancelledRunIds()).toEqual(['run-automatic-setup']);
    });

    it('keeps the remaining setup steps from starting', async () => {
      let continueSetup = (): void => undefined;
      const nextStep = withWorkspaceTargetRuntimePreparation(
        'workspace-1',
        'wt-1',
        async (): Promise<void> => {
          await new Promise<void>((resolve) => {
            continueSetup = resolve;
          });
          assertWorkspaceTargetRuntimeStartAllowed('workspace-1', 'wt-1');
        },
      );

      await cancelWorktreeSetupHandler(fakeEvent, {
        projectId: 'workspace-1',
        worktreeId: 'wt-1',
      });
      continueSetup();

      await expect(nextStep).rejects.toThrow('setup was cancelled');
      // Only the cancelled setup is fenced: other starts stay allowed.
      expect(() =>
        assertWorkspaceTargetRuntimeStartAllowed('workspace-1', 'wt-1'),
      ).not.toThrow();
    });

    it('still resolves when the setup scripts fail to drain', async () => {
      mockedDrainTrackedShellScriptRunsForWorktree.mockRejectedValue(
        new Error('stuck'),
      );

      await expect(
        cancelWorktreeSetupHandler(fakeEvent, {
          projectId: 'project-1',
          worktreeId: 'wt-1',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('normalizeScript for launch scripts', () => {
    it('strips empty launch scripts when saving', async () => {
      mockSidebarItems([makeProject()]);

      const request: SaveProjectScriptsRequest = {
        projectId: 'project-1',
        scripts: {
          launch: '   ',
        },
      };

      await saveProjectScriptsHandler(fakeEvent, request);

      const writeCall = mockedWriteFile.mock.calls.find(
        ([p]) => p === '/mock/workspaces/project-1/workspace.json',
      );
      expect(writeCall).toBeDefined();
      const written = JSON.parse(writeCall![1] as string) as {
        scripts?: Record<string, string>;
      };
      expect(written.scripts).toBeUndefined();
    });
  });
});

describe('listWorktreeScriptEntries', () => {
  it('resolves configured project scripts with run requests without running them', async () => {
    mockSidebarItems([
      makeProject({
        scripts: {
          test: 'npm test',
          wizard: { command: 'npx wizard', interactive: true },
          launch: null,
        },
      }),
    ]);

    const entries = await listWorktreeScriptEntries({
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });

    expect(entries).toEqual([
      {
        descriptor: {
          scriptKey: 'project:test',
          scriptName: 'test',
          label: 'Test',
          command: 'npm test',
          lifecycle: 'custom',
          target: 'project',
        },
        request: {
          target: 'project',
          scriptName: 'test',
          projectId: 'project-1',
          worktreeId: 'wt-1',
        },
      },
      {
        descriptor: {
          scriptKey: 'project:wizard',
          scriptName: 'wizard',
          label: 'Wizard',
          command: 'npx wizard',
          lifecycle: 'custom',
          target: 'project',
          interactive: true,
        },
        request: {
          target: 'project',
          scriptName: 'wizard',
          projectId: 'project-1',
          worktreeId: 'wt-1',
        },
      },
    ]);
    expect(mockedRunShellScript).not.toHaveBeenCalled();
    expect(mockedStartScriptRunLog).not.toHaveBeenCalled();
  });

  it('returns no scripts for an unknown project', async () => {
    mockSidebarItems([makeProject()]);

    await expect(
      listWorktreeScriptEntries({ projectId: 'missing', worktreeId: 'wt-1' }),
    ).resolves.toEqual([]);
  });
});
