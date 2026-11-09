/**
 * CAN-5097 migration golden: Claude worker sessions over the real routed
 * worker.terminal port and terminal service, with a recording engine in
 * place of node-pty. The CLI is created (worker.terminal.create) and killed
 * (worker.terminal.kill) through the port.
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type * as FsPromisesModule from 'node:fs/promises';
import type * as PathsModule from '../../lib/paths';
import type * as ApprovalServiceModule from '../../approvals/approval-service';
import type * as RoutedWorkerTerminalModule from '../../terminal/routed-worker-terminal';
import type * as RecordingTerminalEngineModule from './helpers/recording-terminal-engine';
import type * as DaemonTerminalRouteModule from '../../terminal/daemon-terminal-route';
import type { RecordingTerminalEngine } from './helpers/recording-terminal-engine';
import type {
  AgentProviderAuthStatus,
  ApprovalMode,
} from '@canopy/desktop-shared/types';

const mockMkdir = jest.fn();
const mockRm = jest.fn();
const mockReadPreferencesFile = jest.fn();
interface WorkerHookBody {
  hookEventName: string;
  hookPayload: Record<string, unknown>;
}

interface RegisteredCanopyWorktreeSessionRoute {
  sessionKey?: string;
  workerMemoryToolExposure?: string;
  ledgerTools?: unknown;
  reportStructuredResultSchema?: Record<string, unknown>;
  onReportStructuredResult?: (payload: unknown) => {
    ok: boolean;
    error?: string;
  };
  hookHandler?: (body: WorkerHookBody) => Promise<unknown>;
}

const mockRegisterCanopyWorktreeSessionRoute = jest.fn<
  Promise<void>,
  [RegisteredCanopyWorktreeSessionRoute]
>();
const mockUnregisterCanopyWorktreeSessionRoute = jest.fn();
const mockUnregisterMcpProxyRoutesForSession = jest.fn();
const mockEnsureClaudeWorkspaceTrust = jest.fn();
const mockBuildClaudeTerminalLaunchConfig = jest.fn();

const mockGetClaudeWorkerRuntimeDir = jest.fn();
const mockStartObservedTask = jest.fn();
const mockFinalizeObservedTask = jest.fn();
const mockGetCachedClaudeAuthStatusObserved = jest.fn<
  Promise<AgentProviderAuthStatus>,
  [
    string,
    {
      forceAuthenticatedInvalidation?: boolean;
      forceRefresh?: boolean;
      maxAgeMs?: number;
    }?,
  ]
>(() =>
  Promise.resolve({
    authenticated: true,
    accountLabel: 'dev@example.com',
    detail: null,
    error: null,
  }),
);
const mockIsClaudeTuiWorkersEnabled = jest.fn(() => true);
const mockApprovalCheck = jest.fn(() =>
  Promise.resolve({ decision: 'allow' as const }),
);
const mockApprovalDispose = jest.fn();
const mockCreateApprovalSession = jest.fn<
  ReturnType<typeof ApprovalServiceModule.createApprovalSession>,
  Parameters<typeof ApprovalServiceModule.createApprovalSession>
>(() => ({
  get check(): typeof mockApprovalCheck {
    return mockApprovalCheck;
  },
  setMode: jest.fn(),
  reevaluatePendingApprovals: jest.fn<
    Promise<void>,
    [ApprovalMode, ApprovalMode?]
  >(() => Promise.resolve()),
  get dispose(): typeof mockApprovalDispose {
    return mockApprovalDispose;
  },
}));
const mockWorkerRuntimeRoot = join(
  tmpdir(),
  'canopy-claude-worker-session-service-test',
);

jest.mock('node:fs/promises', () => ({
  ...jest.requireActual<typeof FsPromisesModule>('node:fs/promises'),
  // Lazy wrappers: the real terminal service loads modules that bind these
  // before the test's own mock bindings initialize.
  mkdir: (...args: unknown[]): unknown => mockMkdir(...args),
  rm: (...args: unknown[]): unknown => mockRm(...args),
}));

jest.mock('../../lib/preferences-store', () => ({
  get readPreferencesFile(): typeof mockReadPreferencesFile {
    return mockReadPreferencesFile;
  },
}));

jest.mock('../../integration/claude-workspace-trust', () => ({
  get ensureClaudeWorkspaceTrust(): typeof mockEnsureClaudeWorkspaceTrust {
    return mockEnsureClaudeWorkspaceTrust;
  },
}));

jest.mock('../../integration/claude-terminal-settings', () => ({
  get buildClaudeTerminalLaunchConfig(): typeof mockBuildClaudeTerminalLaunchConfig {
    return mockBuildClaudeTerminalLaunchConfig;
  },
}));

jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<typeof PathsModule>('../../lib/paths'),
  get getClaudeWorkerRuntimeDir(): typeof mockGetClaudeWorkerRuntimeDir {
    return mockGetClaudeWorkerRuntimeDir;
  },
}));

jest.mock('../../integration/desktop-integration-server', () => ({
  getDesktopIntegrationServer: jest.fn(() => ({
    get registerCanopyWorktreeSessionRoute(): typeof mockRegisterCanopyWorktreeSessionRoute {
      return mockRegisterCanopyWorktreeSessionRoute;
    },
    get unregisterCanopyWorktreeSessionRoute(): typeof mockUnregisterCanopyWorktreeSessionRoute {
      return mockUnregisterCanopyWorktreeSessionRoute;
    },
    get unregisterMcpProxyRoutesForSession(): typeof mockUnregisterMcpProxyRoutesForSession {
      return mockUnregisterMcpProxyRoutesForSession;
    },
  })),
}));

const mockSyncClaudeTerminalTranscript = jest.fn();

jest.mock('../../integration/claude-terminal-transcript-sync', () => ({
  isAllowedClaudeTerminalTranscriptPath: jest.fn(() => true),
  get syncClaudeTerminalTranscript(): typeof mockSyncClaudeTerminalTranscript {
    return mockSyncClaudeTerminalTranscript;
  },
}));

jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    get startObservedTask(): typeof mockStartObservedTask {
      return mockStartObservedTask;
    },
    get finalizeObservedTask(): typeof mockFinalizeObservedTask {
      return mockFinalizeObservedTask;
    },
  })),
}));

jest.mock('../../auth/provider-auth-state', () => ({
  get getCachedClaudeAuthStatusObserved(): typeof mockGetCachedClaudeAuthStatusObserved {
    return mockGetCachedClaudeAuthStatusObserved;
  },
}));

jest.mock('../../lib/claude-tui-workers', () => ({
  getEffectiveClaudeWorkerConcurrencyLimit: jest.fn(
    (preferences: { workerConcurrencyLimit?: number } | null) =>
      mockIsClaudeTuiWorkersEnabled()
        ? (preferences?.workerConcurrencyLimit ?? 5)
        : 0,
  ),
  get isClaudeTuiWorkersEnabled(): typeof mockIsClaudeTuiWorkersEnabled {
    return mockIsClaudeTuiWorkersEnabled;
  },
}));

jest.mock('../../approvals/approval-service', () => ({
  createApprovalSession: (
    context: Parameters<typeof ApprovalServiceModule.createApprovalSession>[0],
  ): ReturnType<typeof ApprovalServiceModule.createApprovalSession> =>
    mockCreateApprovalSession(context),
}));

jest.mock('../../terminal/worker-terminal', () => {
  const { RoutedWorkerTerminal } = jest.requireActual<
    typeof RoutedWorkerTerminalModule
  >('../../terminal/routed-worker-terminal');
  const { createRecordingTerminalEngine } = jest.requireActual<
    typeof RecordingTerminalEngineModule
  >('./helpers/recording-terminal-engine');
  const engine = createRecordingTerminalEngine();
  return {
    workerTerminal: new RoutedWorkerTerminal(engine),
    mockEngine: engine,
  };
});
jest.mock('../../services/split-lock-service', () => ({
  assertNotSplitLocked: (): void => undefined,
}));
jest.mock('../../lib/workspace-target-exclusion', () => ({
  withWorkspaceTargetRuntimeStartReservation: (
    _project: string,
    _worktree: string,
    start: () => Promise<unknown>,
  ): Promise<unknown> => start(),
}));
jest.mock('../../terminal/persistence', () => ({
  terminalPersistenceStore: {
    getPersistedTerminalEntry: (): null => null,
    registerLiveSession: (): void => undefined,
    appendTerminalOutput: (): void => undefined,
    markTerminalExited: (): void => undefined,
  },
}));
jest.mock('../../terminal/daemon-terminal-route', () => ({
  ...jest.requireActual<typeof DaemonTerminalRouteModule>(
    '../../terminal/daemon-terminal-route',
  ),
  selectDaemonManagedTerminalTarget: jest.fn(() => Promise.resolve(null)),
  sweepOrphanedDaemonManagedTerminals: jest.fn(() => Promise.resolve()),
}));

import { TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL } from '@canopy/desktop-shared/types';
import { getBundledClaudeBinaryPath } from '../../pipelines/config-paths';
import { DefaultClaudeWorkerSessionService } from '../../integration/claude-worker-session-service';

const mockEngine = jest.requireMock<{ mockEngine: RecordingTerminalEngine }>(
  '../../terminal/worker-terminal',
).mockEngine;
const mockSelectDaemonManagedTerminalTarget = jest.mocked(
  jest.requireMock<typeof DaemonTerminalRouteModule>(
    '../../terminal/daemon-terminal-route',
  ).selectDaemonManagedTerminalTarget,
);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const WORKER = {
  kind: 'test',
  label: 'Helper',
  cwd: '/tmp/w',
  systemPrompt: 's',
  prompt: 'p',
  projectId: 'p',
  worktreeId: 'w',
};

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe('Claude worker sessions on the worker.terminal port (CAN-5097)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEngine.reset();
    mockSyncClaudeTerminalTranscript.mockResolvedValue({
      importedMessages: [],
      importedEvents: [],
      importedEventCount: 0,
      transcriptPath: '',
      compactionAppended: false,
    });
    mockMkdir.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
    mockEnsureClaudeWorkspaceTrust.mockResolvedValue(undefined);
    mockBuildClaudeTerminalLaunchConfig.mockResolvedValue({
      executable: getBundledClaudeBinaryPath(),
      args: [],
      env: {},
    });
    mockGetCachedClaudeAuthStatusObserved.mockResolvedValue({
      authenticated: true,
      accountLabel: 'dev@example.com',
      detail: null,
      error: null,
    });
    mockIsClaudeTuiWorkersEnabled.mockReturnValue(true);
    mockGetClaudeWorkerRuntimeDir.mockImplementation(
      (_projectId: string, _worktreeId: string, workerId: string) =>
        join(mockWorkerRuntimeRoot, workerId),
    );
    mockRegisterCanopyWorktreeSessionRoute.mockResolvedValue(undefined);
    mockReadPreferencesFile.mockResolvedValue({ workerConcurrencyLimit: 5 });
  });

  it('a worker session creates its managed terminal through the routed worker.terminal port', async () => {
    const service = new DefaultClaudeWorkerSessionService();
    let workerId = '';
    const run = service.runWorker({
      ...WORKER,
      onCreated: (id) => {
        workerId = id;
      },
    });
    await waitFor(() => mockEngine.creates.length === 1);

    expect(mockEngine.creates[0]).toMatchObject({
      cols: 120,
      rows: 36,
      cwd: '/tmp/w',
      managedCommand: { kind: 'claude-worker', title: 'Helper' },
    });
    await service.cancel(workerId);
    await run.catch(() => undefined);
  });

  it('cancelling a worker kills its terminal through the port with the managed cleanup signal', async () => {
    const service = new DefaultClaudeWorkerSessionService();
    let workerId = '';
    const run = service.runWorker({
      ...WORKER,
      onCreated: (id) => {
        workerId = id;
      },
    });
    await waitFor(() => mockEngine.creates.length === 1);

    await service.cancel(workerId);

    expect(mockEngine.kills).toContainEqual([
      'terminal-1',
      { signal: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL },
    ]);
    await expect(run).resolves.toMatchObject({ status: 'cancelled' });
  });
  it('a worker cancelled while its terminal started kills that terminal', async () => {
    const target = deferred<null>();
    mockSelectDaemonManagedTerminalTarget.mockImplementationOnce(
      () => target.promise,
    );
    const service = new DefaultClaudeWorkerSessionService();
    let workerId = '';
    const run = service.runWorker({
      ...WORKER,
      onCreated: (id) => {
        workerId = id;
      },
    });
    await waitFor(
      () => mockSelectDaemonManagedTerminalTarget.mock.calls.length === 1,
    );

    await service.cancel(workerId);
    target.resolve(null);
    await waitFor(() => mockEngine.kills.length === 1);

    expect(mockEngine.kills).toContainEqual([
      'terminal-1',
      { signal: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL },
    ]);
    const sessionKey =
      mockRegisterCanopyWorktreeSessionRoute.mock.calls[0]?.[0]?.sessionKey;
    expect(mockUnregisterCanopyWorktreeSessionRoute).toHaveBeenCalledWith(
      sessionKey,
    );
    await run.catch(() => undefined);
  });
});
