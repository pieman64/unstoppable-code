/**
 * CAN-5719 migration seam: real IPC/dispatcher/adapters, default placement,
 * unreachable-only fallback, and awaited restart cleanup over an injected
 * daemon connection. Real daemon hosts are covered by code-graph-conformance.
 */
const mockGet = jest.fn<Promise<{ client: unknown }>, [unknown, unknown]>();
jest.mock('../../canopy-runtime/electron-daemon-access', () => ({
  getElectronDaemonConnections: (): unknown => ({
    get: (caller: unknown, signal: unknown) => mockGet(caller, signal),
  }),
  getElectronDaemonFilesContext: (): Promise<unknown> =>
    Promise.resolve({ authorityId: 'local' }),
}));
jest.mock('../../canopy-runtime/electron-daemon-health', () => ({
  getElectronDaemonHealth: (): unknown => ({
    setConsumerEnabled: (): void => undefined,
    isLatched: (): boolean => mockLatched(),
    noteFallback: (): void => undefined,
  }),
}));
const mockPlatform = jest.fn<string, []>(() => 'darwin');
const mockLatched = jest.fn(() => false);
jest.mock('@canopy/core-platform', () => ({
  hostPlatformOperatingSystem: (): string => mockPlatform(),
}));
jest.mock('../../services/labs-experiments-runtime', () => ({
  getLabsExperimentsService: (): LabsExperimentsService | undefined => mockLabs,
}));
const mockWarn = jest.fn();
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: (...args: unknown[]): void => {
    mockWarn(...args);
  },
}));

// Replace host dependencies, not the IPC, dispatcher or routing adapters.
const mockFeatureEnabled = jest.fn(() => true);
const mockLocalState = jest.fn<'idle' | 'queued' | 'running', []>(() => 'idle');
const mockBridge = jest.fn(() => false);
jest.mock('../../lib/code-graph-feature-flag', () => ({
  isCodeGraphFeatureEnabled: (): boolean => mockFeatureEnabled(),
}));
jest.mock('../../lib/sidebar-items', () => ({
  readAllSidebarItems: (): Promise<unknown> =>
    Promise.resolve({
      items: [
        {
          id: 'project',
          type: 'single-repo',
          name: 'Project',
          worktrees: [{ id: 'task' }],
        },
      ],
    }),
}));
jest.mock('../build-runner', () => ({
  getCodeGraphSourceBuildState: (): string => mockLocalState(),
  setCodeGraphGenerationQueueListener: (): void => undefined,
  isCodeGraphSummaryRepairActive: (): boolean => false,
  requestCodeGraphSummaryRepair: (): Promise<void> =>
    Promise.reject(new Error('Unexpected repair')),
}));
jest.mock('../graph-builds', () => ({
  repairWorkspaceBaseCodeGraphSummary: (): Promise<void> =>
    Promise.reject(new Error('Unexpected base repair')),
}));
jest.mock('../../lib/code-graph-base-manager', () => ({
  describeCodeGraphBaseWorkspace: (): null => null,
}));
jest.mock('../../lib/code-graph-scheduler', () => ({
  isCodeGraphPerformanceSchedulerEnabled: (): boolean => false,
  runCodeGraphPerformanceBuild: (): Promise<void> =>
    Promise.reject(new Error('Unexpected scheduling')),
}));
jest.mock('../../remote-control/host/bridge-window', () => ({
  resolveRemoteBridgeSender: (): unknown => (mockBridge() ? {} : null),
}));
jest.mock('../../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntimeIfAccepting: (): null => null,
}));
jest.mock('../../lib/slow-action-tracker', () => ({
  trackSlowAction: (result: unknown): unknown => result,
}));

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { createCanopyDispatcher } from '@canopy/core-runtime';
import {
  WORKER_CODE_GRAPH_QUERY_DEFINITIONS,
  WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS,
  WORKER_CODE_GRAPH_READ_QUERY_DEFINITIONS,
  WORKER_CODE_GRAPH_WRITE_INSTRUCTION_DEFINITIONS,
  type WorkerCodeGraphBuildResult,
  type WorkerCodeGraphQueryResult,
} from '@canopy/protocol/canopy-core';
import {
  createWorkerCodeGraphAdapter,
  type DesktopCodeGraphBuildQueue,
} from '../../canopy-runtime/worker-code-graph-adapter';
import { createWorkerCodeGraphReadAdapter } from '../../canopy-runtime/worker-code-graph-read-adapter';
import { setCodeGraphReadDispatcherForTests } from '../graph-reads';
import { setCodeGraphPreferences } from '../../lib/code-graph-availability';
import { registerCodeGraphHandlers } from '../../ipc/code-graph';
import { registerLabsExperimentsHandlers } from '../../ipc/labs-experiments';

import {
  buildCodeGraphInDaemon,
  drainDaemonCodeGraphWorktree,
  noteDaemonCodeGraphFallback,
  queryCodeGraphInDaemon,
  selectDaemonCodeGraph,
  combinedCodeGraphBuildState,
} from '../daemon-code-graph-route';

import {
  onDaemonCodeGraphRoute,
  withDaemonCodeGraphRoute,
} from '../daemon-code-graph-route-context';
import { LabsExperimentsService } from '../../services/labs-experiments-service';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { CanopyClientError } from '@canopy/core-client';
import {
  daemonUnreachableReason,
  markUnreachable,
} from '../../canopy-runtime/electron-daemon-connection';

import { createCodeGraphBuildScheduler } from '@canopy/code-graph/host/build-scheduler';
import { createCodeGraphFingerprintScheduler } from '@canopy/code-graph/host/fingerprint-scheduler';
import { cancelCodeGraphWorktreeHosts } from '@canopy/code-graph/host/worktree-build-service';
import {
  ScriptedProcessPool,
  flushMicrotasks,
} from '@canopy/code-graph/__tests__/golden/scripted-process';

let mockLabs: LabsExperimentsService | undefined;

const SCOPE = {
  kind: 'worktree' as const,
  workspaceId: 'project',
  worktreeId: 'task',
  mode: 'verified' as const,
};

function daemon(cancel: () => Promise<unknown>): {
  instructions: Array<[string, unknown]>;
} {
  const instructions: Array<[string, unknown]> = [];
  mockGet.mockResolvedValue({
    client: {
      instruction: (name: string, params: unknown): Promise<unknown> => {
        instructions.push([name, params]);
        return name === 'worker.codeGraph.builds.cancel'
          ? cancel()
          : Promise.resolve({ kind: 'worktree' });
      },
    },
  });
  return { instructions };
}

describe('daemon code-graph restart cleanup (CAN-5719)', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockWarn.mockReset();
    mockPlatform.mockReturnValue('darwin');
    mockLatched.mockReturnValue(false);
    mockLabs = undefined;
    setCodeGraphPreferences(undefined);
    mockFeatureEnabled.mockReturnValue(true);
  });

  it.each(['win32', 'unknown'])(
    'does not start a session on unsupported host %s for an unremembered worktree',
    async (platform) => {
      mockPlatform.mockImplementation(() => {
        if (platform === 'unknown') throw new Error('unknown host');
        return platform;
      });
      await drainDaemonCodeGraphWorktree('project', 'never-built');
      expect(mockGet).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    'awaits worktree cancellation (remembered build: %s)',
    async (remembered) => {
      let finish: () => void = () => undefined;
      let started: () => void = () => undefined;
      const cancellationStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const { instructions } = daemon(
        () =>
          new Promise((resolve) => {
            finish = (): void => resolve({ canceled: 1 });
            started();
          }),
      );
      if (remembered) await buildCodeGraphInDaemon(SCOPE);
      let drained = false;
      const draining = drainDaemonCodeGraphWorktree('project', 'task').then(
        () => {
          drained = true;
        },
      );
      await cancellationStarted;
      expect(instructions.at(-1)).toEqual([
        'worker.codeGraph.builds.cancel',
        { workspaceId: 'project', worktreeId: 'task' },
      ]);
      expect(drained).toBe(false);
      finish();
      await draining;
      expect(drained).toBe(true);
    },
  );

  it.each(['darwin', 'linux'])(
    'drains an unremembered worktree after restart on %s without Labs or graph preferences',
    async (platform) => {
      mockPlatform.mockReturnValue(platform);
      mockLatched.mockReturnValue(true);
      mockFeatureEnabled.mockReturnValue(false);
      setCodeGraphPreferences({
        mode: 'disabled',
        selectedWorkspaceIds: [],
        generationTimeoutMinutes: 1,
      });
      const { instructions } = daemon(() => Promise.resolve({ canceled: 0 }));
      await drainDaemonCodeGraphWorktree('project', 'other');
      expect(instructions).toEqual([
        [
          'worker.codeGraph.builds.cancel',
          { workspaceId: 'project', worktreeId: 'other' },
        ],
      ]);
    },
  );

  it('still drains remembered daemon work on an unsupported host', async () => {
    const { instructions } = daemon(() => Promise.resolve({ canceled: 0 }));
    await buildCodeGraphInDaemon({ ...SCOPE, worktreeId: 'remembered' });
    mockPlatform.mockReturnValue('win32');
    await drainDaemonCodeGraphWorktree('project', 'remembered');
    expect(instructions[1]).toEqual([
      'worker.codeGraph.builds.cancel',
      { workspaceId: 'project', worktreeId: 'remembered' },
    ]);
    mockGet.mockClear();
    await drainDaemonCodeGraphWorktree('project', 'remembered');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('warns and continues when the daemon cannot be reached during restart cleanup', async () => {
    mockGet.mockRejectedValue(
      markUnreachable(new Error('unreachable'), 'start_failed'),
    );
    await expect(
      drainDaemonCodeGraphWorktree('project', 'unreachable'),
    ).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it('logs a drain the daemon could not take and lets the cleanup go on', async () => {
    daemon(() =>
      Promise.reject(
        new CanopyClientError({
          kind: 'unavailable',
          code: 'worker.codeGraph.queueUnavailable',
          message: 'Queue unavailable',
          retry: { kind: 'never' },
        }),
      ),
    );
    await buildCodeGraphInDaemon({ ...SCOPE, worktreeId: 'failing' });
    await expect(
      drainDaemonCodeGraphWorktree('project', 'failing'),
    ).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    mockPlatform.mockReturnValue('win32');
    const retry = daemon(() => Promise.resolve({ canceled: 0 }));
    await drainDaemonCodeGraphWorktree('project', 'failing');
    expect(retry.instructions).toEqual([
      [
        'worker.codeGraph.builds.cancel',
        { workspaceId: 'project', worktreeId: 'failing' },
      ],
    ]);
  });

  it('reads a summary whose session dropped under it as an unreachable daemon', async () => {
    const session = new AbortController();
    const dropped = new Error('connection closed');
    mockGet.mockResolvedValue({
      client: {
        signal: session.signal,
        query: (): Promise<unknown> => {
          session.abort();
          return Promise.reject(dropped);
        },
      },
    });
    const failure = await queryCodeGraphInDaemon({
      scope: { workspaceId: 'project', worktreeId: 'task' },
      queryKind: 'ui-summary',
      read: { kind: 'summary' },
    }).catch((error: unknown) => error);
    expect(failure).toBe(dropped);
    expect(daemonUnreachableReason(failure)).toBe('connection_lost');
    expect(noteDaemonCodeGraphFallback(failure)).toBe(true);
  });

  it('keeps a refusal from a live session as the answer', async () => {
    const refused = new Error('refused');
    mockGet.mockResolvedValue({
      client: {
        signal: new AbortController().signal,
        query: (): Promise<unknown> => Promise.reject(refused),
      },
    });
    const failure = await queryCodeGraphInDaemon({
      scope: { workspaceId: 'project', worktreeId: 'task' },
      queryKind: 'ui-summary',
      read: { kind: 'summary' },
    }).catch((error: unknown) => error);
    expect(noteDaemonCodeGraphFallback(failure)).toBe(false);
  });
});

function labs(
  choices: Record<string, boolean>,
  ready: boolean,
): LabsExperimentsService {
  return new LabsExperimentsService(
    {
      choicesPath: 'choices',
      availabilityPath: 'availability',
      pendingSyncPath: 'pending',
      read: (file) =>
        file === 'choices'
          ? { version: 1, accounts: { local: choices } }
          : undefined,
      write: () => Promise.resolve(),
      availability: () => ({
        snapshot: getDefaultFeatureFlagSnapshot(
          ready ? 'not_configured' : 'initializing',
        ),
        contextIdentity: null,
        liveValues: {},
      }),
      fetchChoices: () => Promise.resolve({ choices: {} }),
      putChoice: () => Promise.resolve({}),
      diagnostic: () => undefined,
      mirror: () => undefined,
    },
    { scope: 'local', signedIn: false, ready },
  );
}

const SUMMARY = {
  scope: { workspaceId: 'project', worktreeId: 'task' },
  queryKind: 'ui-summary',
  read: { kind: 'summary' },
} as const;

const handlers = new Map<string, Parameters<typeof ipcMain.handle>[1]>();
const noRetiredExperiment: unknown = expect.not.arrayContaining([
  expect.objectContaining({ id: 'daemon-code-graph' }),
]);
let main: BrowserWindow;
let advisor: BrowserWindow;
let foreign: BrowserWindow;
const BUILD_RESULT: WorkerCodeGraphBuildResult = {
  kind: 'worktree',
  filesScanned: 1,
  filesParsed: 1,
  filesUnchanged: 0,
  filesSkipped: 0,
  filesRemoved: 0,
  parseFailures: 0,
  symbolCount: 1,
  edgeCount: 0,
  durationMs: 1,
  lastBuildAt: null,
  derivedPending: false,
  customLanguageDiagnostics: null,
  derivedWarnings: null,
};
function readAnswer(
  buildState: WorkerCodeGraphQueryResult['buildState'],
): WorkerCodeGraphQueryResult {
  return {
    presence: 'absent',
    buildState,
    result: { kind: 'readonly-summary', value: { state: 'missing' } },
  };
}
const localBuild = jest.fn(() => Promise.resolve(BUILD_RESULT));
const localQuery = jest.fn(() =>
  Promise.resolve({ ok: true as const, value: readAnswer('idle') }),
);
function invoke(
  channel: string,
  request?: unknown,
  window = main,
): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler ${channel}`);
  const event: IpcMainInvokeEvent = {
    sender: window.webContents,
    senderFrame: null,
    frameId: 1,
    processId: 1,
    type: 'frame',
    preventDefault: () => undefined,
    defaultPrevented: false,
  };
  return Promise.resolve().then((): unknown => handler(event, request));
}
beforeAll(() => {
  jest.spyOn(ipcMain, 'handle').mockImplementation((channel, handler) => {
    handlers.set(channel, handler);
  });
});
afterAll(() => {
  jest.restoreAllMocks();
});
afterEach(() => {
  setCodeGraphReadDispatcherForTests(null);
});

describe('default code-graph dispatcher route (CAN-5719)', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPlatform.mockReturnValue('darwin');
    mockLatched.mockReturnValue(false);
    mockLabs = undefined;
    mockFeatureEnabled.mockReturnValue(true);
    mockLocalState.mockReturnValue('idle');
    mockBridge.mockReturnValue(false);
    localBuild.mockClear();
    localQuery.mockClear();
    setCodeGraphPreferences(undefined);
    main = new BrowserWindow();
    advisor = new BrowserWindow();
    foreign = new BrowserWindow();
    const builds = createWorkerCodeGraphAdapter(
      (): Promise<DesktopCodeGraphBuildQueue> =>
        Promise.resolve({
          build: localBuild,
          queueStatus: () => ({ revision: 0, entries: [] }),
          reorderQueue: () => ({ revision: 0, entries: [] }),
          cancelQueueItem: () => Promise.resolve(null),
          cancelWorktree: () => Promise.resolve(0),
        }),
    );
    const reads = createWorkerCodeGraphReadAdapter(() =>
      Promise.resolve({
        query: localQuery,
        status: () => Promise.reject(new Error('Unexpected status')),
        exportSnapshot: () => Promise.reject(new Error('Unexpected snapshot')),
        importSnapshot: () => Promise.reject(new Error('Unexpected import')),
        validateLanguages: () =>
          Promise.reject(new Error('Unexpected languages')),
      }),
    );
    const dispatcher = createCanopyDispatcher({
      profile: 'worker',
      definitions: {
        queries: {
          ...WORKER_CODE_GRAPH_QUERY_DEFINITIONS,
          ...WORKER_CODE_GRAPH_READ_QUERY_DEFINITIONS,
        },
        instructions: {
          ...WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS,
          ...WORKER_CODE_GRAPH_WRITE_INSTRUCTION_DEFINITIONS,
        },
        streams: {},
      },
      handlers: {
        queries: { ...builds.queries, ...reads.queries },
        instructions: { ...builds.instructions, ...reads.instructions },
        streams: {},
      },
    });
    setCodeGraphReadDispatcherForTests(dispatcher);
    registerCodeGraphHandlers(
      {
        dispatcher,
        resolveCaller: () => ({
          principalId: 'window',
          clientInstanceId: 'desktop',
          authorityId: 'local',
          interfaceKind: 'desktop',
          grants: [],
        }),
      },
      { getMainWindow: () => main, getAppAdvisorWindow: () => advisor },
    );
  });

  it.each([
    ['darwin', {}, true],
    ['linux', {}, true],
    ['darwin', { 'daemon-code-graph': false }, true],
    ['linux', { 'daemon-code-graph': false }, false],
  ] as const)(
    'builds and separately reads through the daemon with platform %s, choices %j, Labs ready %s',
    async (platform, choices, ready) => {
      mockPlatform.mockReturnValue(platform);
      mockLabs = labs(choices, ready);
      expect(mockLabs.getSnapshot().ready).toBe(ready);
      expect(mockLabs.getSnapshot().earlyAccessEnabled).toBe(false);
      expect(
        mockLabs
          .getSnapshot()
          .experiments.some((e) => e.id === 'daemon-code-graph'),
      ).toBe(false);
      registerLabsExperimentsHandlers();
      await expect(
        invoke(IPC_CHANNELS.experimentsGetSnapshot),
      ).resolves.toMatchObject({
        experiments: noRetiredExperiment,
      });
      await expect(
        invoke(IPC_CHANNELS.experimentsSetChoice, {
          experimentId: 'daemon-code-graph',
          enabled: true,
        }),
      ).rejects.toMatchObject({
        code: 'invalid_payload',
        message: 'Unknown experiment.',
      });
      const instructions: string[] = [];
      const queries: string[] = [];
      mockGet.mockResolvedValue({
        client: {
          signal: new AbortController().signal,
          instruction: (name: string): Promise<unknown> => {
            instructions.push(name);
            return Promise.resolve(BUILD_RESULT);
          },
          query: (name: string): Promise<unknown> => {
            queries.push(name);
            return Promise.resolve(readAnswer('running'));
          },
        },
      });
      await expect(
        invoke(IPC_CHANNELS.codeGraphBuildWorktree, SUMMARY.scope),
      ).resolves.toMatchObject({
        enabled: true,
        state: 'missing',
        buildState: 'running',
      });
      expect(instructions).toEqual(['worker.codeGraph.build']);
      expect(queries).toEqual(['worker.codeGraph.query']); // Build's own summary.
      queries.length = 0;
      // Separate IPC request and route claim, not the build's returned summary.
      await expect(
        invoke(
          IPC_CHANNELS.codeGraphGetWorktreeSummary,
          SUMMARY.scope,
          advisor,
        ),
      ).resolves.toMatchObject({ state: 'missing', buildState: 'running' });
      expect(queries).toEqual(['worker.codeGraph.query']);
      expect(localBuild).not.toHaveBeenCalled();
      expect(localQuery).not.toHaveBeenCalled();
    },
  );

  it('broadcasts Labs changes without reviving the retired entry', async () => {
    mockLabs = labs({ 'daemon-code-graph': false }, true);
    const windows = jest
      .spyOn(BrowserWindow, 'getAllWindows')
      .mockReturnValue([main]);
    const send = jest.spyOn(main.webContents, 'send');
    try {
      registerLabsExperimentsHandlers();
      await expect(
        invoke(IPC_CHANNELS.experimentsSetChoice, {
          experimentId: 'early-access',
          enabled: true,
        }),
      ).resolves.toMatchObject({ earlyAccessEnabled: true });
      expect(send).toHaveBeenCalledWith(
        IPC_CHANNELS.experimentsSnapshotChanged,
        expect.objectContaining({
          earlyAccessEnabled: true,
          experiments: noRetiredExperiment,
        }),
      );
    } finally {
      send.mockRestore();
      windows.mockRestore();
    }
  });

  it.each(['foreign', 'bridge', 'destroyed', 'windows', 'latched'])(
    'keeps %s IPC on the local dispatcher',
    async (excluded) => {
      if (excluded === 'bridge') mockBridge.mockReturnValue(true);
      if (excluded === 'destroyed')
        jest.spyOn(main, 'isDestroyed').mockReturnValue(true);
      if (excluded === 'windows') mockPlatform.mockReturnValue('win32');
      if (excluded === 'latched') mockLatched.mockReturnValue(true);
      const window = excluded === 'foreign' ? foreign : main;
      await expect(
        invoke(IPC_CHANNELS.codeGraphBuildWorktree, SUMMARY.scope, window),
      ).resolves.toMatchObject({ state: 'missing', buildState: 'idle' });
      await expect(
        invoke(IPC_CHANNELS.codeGraphGetWorktreeSummary, SUMMARY.scope, window),
      ).resolves.toMatchObject({ state: 'missing', buildState: 'idle' });
      expect(localBuild).toHaveBeenCalledTimes(1);
      expect(localQuery).toHaveBeenCalledTimes(2);
      expect(mockGet).not.toHaveBeenCalled();
    },
  );

  it.each(['feature flag', 'workspace preference', 'invalid worktree'])(
    'refuses builds before contacting either host with %s off/invalid',
    async (control) => {
      if (control === 'feature flag') mockFeatureEnabled.mockReturnValue(false);
      if (control === 'workspace preference')
        setCodeGraphPreferences({
          mode: 'disabled',
          selectedWorkspaceIds: [],
          generationTimeoutMinutes: 1,
        });
      const request = {
        ...SUMMARY.scope,
        ...(control === 'invalid worktree' ? { worktreeId: 'unknown' } : {}),
      };
      await expect(
        invoke(IPC_CHANNELS.codeGraphBuildWorktree, request),
      ).resolves.toMatchObject({
        ok: false,
        code:
          control === 'invalid worktree' ? 'invalid-request' : 'unavailable',
      });
      expect(mockGet).not.toHaveBeenCalled();
      expect(localBuild).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['running', 'idle', 'running'],
    ['queued', 'running', 'running'],
  ] as const)(
    'summaries combine local %s and daemon %s as %s',
    async (local, remote, expected) => {
      mockLocalState.mockReturnValue(local);
      mockGet.mockResolvedValue({
        client: {
          signal: new AbortController().signal,
          query: () => Promise.resolve(readAnswer(remote)),
        },
      });
      await expect(
        invoke(IPC_CHANNELS.codeGraphGetWorktreeSummary, SUMMARY.scope),
      ).resolves.toMatchObject({ buildState: expected });
      expect(localQuery).not.toHaveBeenCalled();
    },
  );

  it('keeps reached read refusals but falls back if the read session drops', async () => {
    const session = new AbortController();
    const refused = new CanopyClientError({
      kind: 'resource_exhausted',
      code: 'worker.codeGraph.read.busy',
      message: 'Busy',
      retry: { kind: 'same_request' },
    });
    mockGet.mockResolvedValue({
      client: {
        signal: session.signal,
        query: () => Promise.reject(refused),
      },
    });
    await expect(
      invoke(IPC_CHANNELS.codeGraphGetWorktreeSummary, SUMMARY.scope),
    ).resolves.toMatchObject({
      ok: false,
      code: 'internal',
      readFailure: 'busy',
    });
    expect(localQuery).not.toHaveBeenCalled();
    mockGet.mockResolvedValue({
      client: {
        signal: session.signal,
        query: () => {
          session.abort();
          return Promise.reject(new Error('connection closed'));
        },
      },
    });
    await expect(
      invoke(IPC_CHANNELS.codeGraphGetWorktreeSummary, SUMMARY.scope),
    ).resolves.toMatchObject({ state: 'missing' });
    expect(localQuery).toHaveBeenCalledTimes(1);
  });

  it('falls back through IPC only for unreachable, never for a reached refusal', async () => {
    const refused = new CanopyClientError({
      kind: 'failed_precondition',
      code: 'worker.codeGraph.unavailable',
      message: 'Disabled',
      retry: { kind: 'never' },
    });
    mockGet.mockRejectedValue(refused);
    await expect(
      invoke(IPC_CHANNELS.codeGraphBuildWorktree, SUMMARY.scope),
    ).resolves.toMatchObject({ ok: false, code: 'unavailable' });
    expect(localBuild).not.toHaveBeenCalled();
    mockGet.mockRejectedValue(
      markUnreachable(new Error('offline'), 'start_failed'),
    );
    await expect(
      invoke(IPC_CHANNELS.codeGraphBuildWorktree, SUMMARY.scope),
    ).resolves.toMatchObject({ state: 'missing' });
    expect(localBuild).toHaveBeenCalledTimes(1);
    expect(localQuery).toHaveBeenCalledTimes(1);
    await expect(
      invoke(IPC_CHANNELS.codeGraphGetWorktreeSummary, SUMMARY.scope),
    ).resolves.toMatchObject({ state: 'missing' });
    expect(localQuery).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['win32', { localWindow: true }, false],
    ['unknown', { localWindow: true }, false],
    ['darwin', { localWindow: false }, false],
    ['darwin', undefined, false],
    ['linux', { localWindow: true }, true],
  ] as const)(
    'keeps excluded caller/platform/health in process (%s, %j, latched %s)',
    async (platform, context, latched) => {
      mockPlatform.mockImplementation(() => {
        if (platform === 'unknown') throw new Error('unknown platform');
        return platform;
      });
      mockLatched.mockReturnValue(latched);
      const remote = jest.fn(() => Promise.resolve('daemon'));
      await expect(
        withDaemonCodeGraphRoute(selectDaemonCodeGraph(context), () =>
          onDaemonCodeGraphRoute(remote, () => Promise.resolve('local')),
        ),
      ).resolves.toEqual({ daemon: false, value: 'local' });
      expect(remote).not.toHaveBeenCalled();
      expect(mockGet).not.toHaveBeenCalled();
    },
  );

  it('does not lend an async route to subsequent scheduled work, including after fallback', async () => {
    for (const unreachable of [false, true]) {
      const offline = new Error('offline');
      markUnreachable(offline, 'start_failed');
      const remote = jest.fn(() =>
        unreachable ? Promise.reject(offline) : Promise.resolve('daemon'),
      );
      let runLater: () => Promise<string> = () =>
        Promise.reject(new Error('not scheduled'));
      await withDaemonCodeGraphRoute(true, async () => {
        await onDaemonCodeGraphRoute(remote, () => Promise.resolve('fallback'));
        // This promise inherits the request's AsyncLocalStorage context.
        const gate = new Promise<void>((resolve) => {
          runLater = (): Promise<string> => {
            resolve();
            return later;
          };
        });
        const later = gate.then(() =>
          onDaemonCodeGraphRoute(remote, () =>
            Promise.resolve('scheduled-local'),
          ),
        );
      });
      await expect(runLater()).resolves.toBe('scheduled-local');
      expect(remote).toHaveBeenCalledTimes(1);
    }
  });

  it('falls back on unreachable but propagates a reached typed refusal', async () => {
    const local = jest.fn(() => Promise.resolve('fallback'));
    const refused = new CanopyClientError({
      kind: 'unavailable',
      code: 'worker.codeGraph.queueUnavailable',
      message: 'Queue unavailable',
      retry: { kind: 'never' },
    });
    await expect(
      withDaemonCodeGraphRoute(true, () =>
        onDaemonCodeGraphRoute(() => Promise.reject(refused), local),
      ),
    ).rejects.toMatchObject({ payload: refused.payload });
    expect(local).not.toHaveBeenCalled();
    const offline = new Error('offline');
    markUnreachable(offline, 'start_failed');
    await expect(
      withDaemonCodeGraphRoute(true, () =>
        onDaemonCodeGraphRoute(() => Promise.reject(offline), local),
      ),
    ).resolves.toEqual({ daemon: false, value: 'fallback' });
    expect(local).toHaveBeenCalledTimes(1);
  });

  it.each(['idle', 'queued', 'running'] as const)(
    'combines both hosts with local %s',
    (local) => {
      const rank = { idle: 0, queued: 1, running: 2 };
      for (const daemon of ['idle', 'queued', 'running'] as const) {
        expect(combinedCodeGraphBuildState(local, daemon)).toBe(
          rank[local] >= rank[daemon] ? local : daemon,
        );
      }
    },
  );
});

describe('cleanup across answered-but-still-exiting graph hosts (CAN-5683)', () => {
  it.each([false, true])(
    'holds cleanup until fingerprint and build exit (derived tail: %s)',
    async (derivedPending) => {
      const pool = new ScriptedProcessPool();
      pool.exitOnKill = false;
      const fingerprints = createCodeGraphFingerprintScheduler({
        resolveGitExecutable: () => Promise.resolve('/git'),
        launchFingerprintHost: () => pool.fork(),
        applyProcessPriority: () => undefined,
        leaveBackgroundPolicy: () => undefined,
        timeoutMs: () => 60_000,
      });
      const builds = createCodeGraphBuildScheduler({
        launchBuildHost: () => pool.fork(),
        trackBuildHost: () => undefined,
        applyProcessPriority: () => undefined,
        leaveBackgroundPolicy: () => undefined,
        isWorkspaceAvailable: () => true,
        generationTimeoutMs: () => 60_000,
        concurrencyCap: () => 1,
        worktreeDbPath: () => '/graph/graph.db',
        withWorktreeClosed: (_workspace, _worktree, work) => work(),
        resolveSummaryRepairPlace: () =>
          Promise.reject(new Error('No repair in cleanup')),
        readSummaryProjection: () =>
          Promise.resolve({
            ok: false,
            error: new Error('No read in cleanup'),
          }),
      });
      builds.testHooks.setBackgroundBuildInterTaskDelayMs(0);
      const key = 'project/exiting';
      mockPlatform.mockReturnValue('darwin');
      const { instructions } = daemon(async () => {
        await cancelCodeGraphWorktreeHosts(key, { fingerprints, builds });
        return { canceled: 0 };
      });
      try {
        const fingerprint = fingerprints.run(key, [
          { repoId: 'repo', rootPath: '/graph' },
        ]);
        await flushMicrotasks();
        const fingerprintHost = pool.process(1);
        fingerprintHost.reply({ ok: true, fingerprint: 'fp' });
        await fingerprint;
        const build = builds.runBuild(key, {
          dbPath: '/graph/graph.db',
          worktreeRootPath: '/graph',
          resourcesDir: '/resources',
          repositories: [{ repoId: 'repo', rootPath: '/graph' }],
          options: {},
        });
        await flushMicrotasks();
        const buildHost = pool.process(2);
        buildHost.reply({
          ok: true,
          derivedPending,
          result: {
            filesScanned: 1,
            filesParsed: 1,
            filesDeleted: 0,
            symbolCount: 1,
            edgeCount: 0,
            durationMs: 1,
          },
        });
        await build;
        expect(fingerprintHost.exited).toBe(false);
        expect(buildHost.exited).toBe(false);
        let cleanupContinued = false;
        const cleanup = drainDaemonCodeGraphWorktree('project', 'exiting').then(
          () => {
            cleanupContinued = true;
          },
        );
        await flushMicrotasks();
        expect(instructions).toEqual([
          [
            'worker.codeGraph.builds.cancel',
            { workspaceId: 'project', worktreeId: 'exiting' },
          ],
        ]);
        // Both kills must land together, not leave the writer running behind
        // a fingerprint host that has answered but still holds its process.
        expect(fingerprintHost.killed).toBe(true);
        expect(buildHost.killed).toBe(true);
        expect(cleanupContinued).toBe(false);
        fingerprintHost.exit();
        await flushMicrotasks();
        expect(cleanupContinued).toBe(false);
        buildHost.exit();
        await cleanup;
        expect(cleanupContinued).toBe(true);
      } finally {
        pool.exitAll();
        await Promise.all([fingerprints.shutdown(), builds.cancelAll()]);
      }
    },
  );
});
